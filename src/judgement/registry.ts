import { auditRequires } from './requires.ts'
import {
  BASE_SCOPES, ISOLATION_CEILINGS,
  type ActionClass, type EvaluatorDef, type IsolationCeiling, type IsolationTier,
  type JudgementRegistry, type Placement, type Point, type PointCatalog,
  type PointEvaluation, type ProofRecord, type ProofRequirement, type RegistryEntry,
  type RunEntry, type SignalName, type Stage, type StandingOrderDef,
  type UnmeasuredCause, type Verdict,
} from './types.ts'

export interface JudgementRegistryOptions {
  readonly onEvaluated?: (ev: PointEvaluation) => unknown
  readonly scopes?: readonly string[]
  readonly isolationCeilings?: IsolationCeiling
  readonly proofs?: readonly ProofRecord[]
}

export interface ExtendedJudgementRegistry extends JudgementRegistry {
  recordProof(proof: ProofRecord): void
  getProof(subjectId: string): ProofRecord | undefined
  unregister(id: string): boolean
  list(): readonly { id: string; kind: RegistryEntry['kind']; version: number; stage: Stage; point?: Point }[]
}

interface RuntimeGate {
  kind: 'gate'; id: string; version: number; point: Point; description: string; side?: 'hard' | 'soft'
  placement: Placement; requires: readonly string[]; appliesTo?: (ctx: unknown) => boolean
  gate: (ctx: unknown) => Verdict | Promise<Verdict>
  acceptance?: readonly [string, ...string[]]; proof?: ProofRequirement
}

interface RuntimeOrder {
  kind: 'standing-order'; id: string; version: number; description: string
  trigger: { signal: string; match?: Record<string, unknown> }
  action: { name: string; params: unknown }
  mandate: { strength: string; scope: string; ceiling: ActionClass; isolation: IsolationTier; policyVersion: string }
}

type StoredEntry =
  | { kind: 'gate'; entry: RuntimeGate; stage: Stage }
  | { kind: 'standing-order'; entry: StandingOrderDef; stage: Stage }
  | { kind: 'evaluator'; entry: EvaluatorDef; stage: Stage }

type GateOutcome =
  | { outcome: 'skipped'; skip: 'not-applicable' }
  | { outcome: 'allow'; produced?: Readonly<Record<string, unknown>> }
  | { outcome: 'deny'; blockers: string[] }
  | { outcome: 'unmeasured'; cause: UnmeasuredCause; detail: string; disposition?: 'refuse' | 'tolerate' }

const VALID_STAGES = new Set<Stage>(['shadow', 'observe', 'enforce', 'retired'])
const VALID_ACTIONS = new Set<ActionClass>(['read', 'draft', 'local-write', 'commit', 'push-branch', 'outward-post', 'merge'])
const VALID_ISOLATIONS = new Set<IsolationTier>(['I1', 'I2', 'I3', 'I4', 'I5'])
const VALID_CAUSES = new Set<UnmeasuredCause>(['missing-input', 'shell-blind', 'timeout', 'parse-failed', 'threw', 'all-skipped', 'evaluator-stale', 'no-evidence', 'no-sandbox'])
const HARD_UNMEASURED_CAUSES = new Set<UnmeasuredCause>(['missing-input', 'shell-blind', 'timeout', 'parse-failed', 'threw', 'all-skipped', 'evaluator-stale', 'no-sandbox'])

export function isValidScopeStage(point: unknown, allowedScopes: ReadonlySet<string>): point is `${string}.${string}` {
  if (typeof point !== 'string' || /\s/.test(point)) return false
  const dot = point.indexOf('.')
  const scope = dot > 0 ? point.slice(0, dot) : ''
  const stage = dot > 0 ? point.slice(dot + 1) : ''
  return Boolean(scope && stage && !stage.startsWith('.') && !stage.endsWith('.') && !stage.includes('..') && allowedScopes.has(scope))
}

function assertScopeStage(point: unknown, allowedScopes: ReadonlySet<string>, owner: string): string {
  if (!isValidScopeStage(point, allowedScopes)) throw new Error(`${owner} 插入点 "${String(point)}" 非法，必须为已知 scope.stage`)
  return point
}

function assertVerdictShape(raw: unknown, id: string): Verdict {
  if (!raw || typeof raw !== 'object') throw new Error(`判据 "${id}" 返回了非法裁决对象`)
  const v = raw as Record<string, unknown>
  if (v['kind'] === 'allow') return raw as Verdict
  if (v['kind'] === 'deny') {
    const blockers = v['blockers']
    if (!Array.isArray(blockers) || blockers.length === 0 || blockers.some(b => typeof b !== 'string' || b.trim() === '')) {
      throw new Error(`判据 "${id}" 返回 deny 时必须附带非空 blocker`)
    }
    return raw as Verdict
  }
  if (v['kind'] === 'unmeasured') {
    if (typeof v['cause'] !== 'string' || !VALID_CAUSES.has(v['cause'] as UnmeasuredCause) || typeof v['detail'] !== 'string' || v['detail'].trim() === '') {
      throw new Error(`判据 "${id}" 返回 unmeasured 时必须给出合法 cause 与非空 detail`)
    }
    if (v['disposition'] !== undefined && v['disposition'] !== 'refuse' && v['disposition'] !== 'tolerate') throw new Error(`判据 "${id}" 返回了未知 disposition`)
    return raw as Verdict
  }
  throw new Error(`判据 "${id}" 返回了未知裁决类型 "${String(v['kind'])}"`)
}

function parseEvalKey(key: string): { id: string; version: number } | undefined {
  const m = /^(.+)@v(\d+(?:\.\d+)?)$/.exec(key)
  if (!m) return undefined
  const version = Number(m[2])
  return Number.isFinite(version) ? { id: m[1]!, version } : undefined
}

function checkProofStaleness(gate: RuntimeGate, proofs: ReadonlyMap<string, ProofRecord>, entries: ReadonlyMap<string, StoredEntry>): string | undefined {
  const req = gate.proof
  if (!req) return undefined
  const proof = proofs.get(gate.id)
  if (!proof) return `要求评估器 "${req.evaluator}" 证明，但未登记 ProofRecord`
  if (proof.subject.id !== gate.id || proof.subject.version !== gate.version) return 'ProofRecord 主体版本与当前判据版本不一致'
  const parsed = parseEvalKey(proof.evaluator)
  if (!parsed || parsed.id !== req.evaluator) return `ProofRecord 评估器 "${proof.evaluator}" 与要求 "${req.evaluator}" 不匹配`
  if (req.minVersion !== undefined && parsed.version < req.minVersion) return `ProofRecord 版本 v${parsed.version} 低于 minVersion v${req.minVersion}`
  const regEval = entries.get(req.evaluator)
  if (regEval?.kind === 'evaluator' && regEval.stage !== 'retired' && regEval.entry.version > parsed.version) {
    return `评估器 "${req.evaluator}" 已升版至 v${regEval.entry.version}，原证明 v${parsed.version} 已过期`
  }
  if (proof.reading.verdict !== 'effective') return `评估器读数为 "${proof.reading.verdict}"，未达 effective`
  if (!Number.isFinite(proof.reading.probability)) return '评估概率非有限数字'
  if (req.minProbability !== undefined && (!Number.isFinite(req.minProbability) || proof.reading.probability < req.minProbability)) {
    return `评估概率 ${proof.reading.probability} 低于阈值 ${req.minProbability}`
  }
  return undefined
}

function validateGate(gate: RuntimeGate, allowedScopes: ReadonlySet<string>): void {
  assertScopeStage(gate.point, allowedScopes, `判据 "${gate.id}"`)
  if (typeof gate.description !== 'string' || gate.description.trim() === '') throw new Error(`判据 "${gate.id}" 缺少 description`)
  if (typeof gate.gate !== 'function') throw new Error(`判据 "${gate.id}" 缺少 gate 函数`)
  if (gate.side !== undefined && gate.side !== 'hard' && gate.side !== 'soft') throw new Error(`判据 "${gate.id}" 的 side 非法`)
  if (!Array.isArray(gate.requires) || gate.requires.some(r => typeof r !== 'string' || r.trim() === '')) throw new Error(`判据 "${gate.id}" 的 requires 必须为非空路径数组`)
  const p = gate.placement
  if (!p || typeof p !== 'object' || (p.timing !== 'pre' && p.timing !== 'post') || typeof p.enforce !== 'boolean') throw new Error(`判据 "${gate.id}" 的 placement 非法`)
  if (p.timing === 'post' && p.enforce) throw new Error(`判据 "${gate.id}" 禁止将事后口 (post) 设为 enforce: true`)
  if (gate.acceptance !== undefined) {
    const acc = gate.acceptance
    if (!Array.isArray(acc) || acc.length === 0 || (acc as readonly unknown[]).some(a => typeof a !== 'string' || a.trim() === '')) {
      throw new Error(`判据 "${gate.id}" 的 acceptance 必须为非空字符串数组`)
    }
  }
  if (gate.proof !== undefined) {
    const proof = gate.proof
    if (typeof proof.evaluator !== 'string' || proof.evaluator.trim() === '') throw new Error(`判据 "${gate.id}" 的 proof.evaluator 必须为非空字符串`)
  }
}

function validateOrder(order: RuntimeOrder, ceilings: IsolationCeiling): void {
  if (typeof order.description !== 'string' || order.description.trim() === '') throw new Error(`常设令 "${order.id}" 缺少 description`)
  if (!order.trigger || typeof order.trigger.signal !== 'string' || order.trigger.signal.trim() === '') throw new Error(`常设令 "${order.id}" 缺少 trigger.signal`)
  if (order.trigger.match !== undefined && (order.trigger.match === null || typeof order.trigger.match !== 'object' || Array.isArray(order.trigger.match))) {
    throw new Error(`常设令 "${order.id}" 的 trigger.match 必须为等值对象，禁止表达式字符串`)
  }
  if (!order.action || typeof order.action.name !== 'string' || order.action.name.trim() === '') throw new Error(`常设令 "${order.id}" 缺少 action.name`)
  const m = order.mandate
  if (!m || typeof m !== 'object') throw new Error(`常设令 "${order.id}" 必须绑定 MandateBinding`)
  if ((m.strength !== 'explicit' && m.strength !== 'inferred') || typeof m.scope !== 'string' || m.scope.trim() === '' || typeof m.policyVersion !== 'string' || m.policyVersion.trim() === '') {
    throw new Error(`常设令 "${order.id}" 的 mandate 字段不完整`)
  }
  if (!VALID_ISOLATIONS.has(m.isolation) || !VALID_ACTIONS.has(m.ceiling)) throw new Error(`常设令 "${order.id}" 的隔离档或动作上限非法`)
  if (!ceilings[m.isolation].includes(m.ceiling)) {
    throw new Error(`常设令 "${order.id}" 动作 "${m.ceiling}" 越过隔离档 ${m.isolation} 上限（允许：${ceilings[m.isolation].join(', ')}）`)
  }
}

async function runSingleGate(gate: RuntimeGate, stage: Stage, ctx: unknown, proofs: ReadonlyMap<string, ProofRecord>, entries: ReadonlyMap<string, StoredEntry>): Promise<GateOutcome> {
  if (typeof gate.appliesTo === 'function') {
    let applies = false
    try { applies = gate.appliesTo(ctx) === true } catch (err) {
      return { outcome: 'unmeasured', cause: 'threw', detail: `[${gate.id}] appliesTo 抛错：${err instanceof Error ? err.message : String(err)}` }
    }
    if (!applies) return { outcome: 'skipped', skip: 'not-applicable' }
  }
  const audit = auditRequires(ctx, gate.requires)
  if (!audit.ok) return { outcome: 'unmeasured', cause: 'missing-input', detail: `[${gate.id}] 缺少必需输入路径：${audit.missing.join(', ')}` }
  if (stage !== 'shadow') {
    const stale = checkProofStaleness(gate, proofs, entries)
    if (stale !== undefined) return { outcome: 'unmeasured', cause: 'evaluator-stale', detail: `[${gate.id}] ${stale}` }
  }
  try {
    const v = assertVerdictShape(await gate.gate(ctx), gate.id)
    if (v.kind === 'allow') return { outcome: 'allow', ...(v.produced ? { produced: v.produced } : {}) }
    if (v.kind === 'deny') return { outcome: 'deny', blockers: v.blockers.map(b => `[${gate.id}] ${b}`) }
    return { outcome: 'unmeasured', cause: v.cause, detail: `[${gate.id}] ${v.detail}`, ...(v.disposition ? { disposition: v.disposition } : {}) }
  } catch (err) {
    return { outcome: 'unmeasured', cause: 'threw', detail: `[${gate.id}] 执行抛错：${err instanceof Error ? err.message : String(err)}` }
  }
}

function dispatchOnEvaluated(cb: ((ev: PointEvaluation) => unknown) | undefined, ev: PointEvaluation): void {
  if (!cb) return
  try {
    const out = cb(ev)
    if (out !== null && typeof out === 'object' && typeof (out as { catch?: unknown }).catch === 'function') void (out as Promise<unknown>).catch(() => {})
  } catch { /* 旁路记账失败绝不影响主流程裁决 */ }
}

/** 创建可扩展 `scope.stage` 判局注册表。 */
export function createJudgementRegistry(options: JudgementRegistryOptions = {}): ExtendedJudgementRegistry {
  const allowedScopes = new Set<string>([...BASE_SCOPES, ...(options.scopes ?? [])])
  const ceilings = options.isolationCeilings ?? ISOLATION_CEILINGS
  const entries = new Map<string, StoredEntry>()
  const proofs = new Map<string, ProofRecord>()
  for (const p of options.proofs ?? []) proofs.set(p.subject.id, p)

  return {
    register(entry: RegistryEntry, stage: Stage): void {
      if (!VALID_STAGES.has(stage)) throw new Error(`注册阶段 "${String(stage)}" 非法`)
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.trim() === '') throw new Error('注册条目必须提供非空 id')
      if (typeof entry.version !== 'number' || !Number.isFinite(entry.version) || entry.version < 0) throw new Error(`条目 "${entry.id}" 必须提供合法数字 version`)
      if (entries.has(entry.id)) throw new Error(`条目 "${entry.id}" 已存在，禁止重复注册`)
      if (entry.kind === 'gate') {
        const g = entry as unknown as RuntimeGate
        validateGate(g, allowedScopes)
        entries.set(entry.id, { kind: 'gate', entry: g, stage })
      } else if (entry.kind === 'standing-order') {
        validateOrder(entry as unknown as RuntimeOrder, ceilings)
        entries.set(entry.id, { kind: 'standing-order', entry: entry as unknown as StandingOrderDef, stage })
      } else if (entry.kind === 'evaluator') {
        if (typeof entry.measures !== 'string' || entry.measures.trim() === '' || typeof entry.evaluate !== 'function') throw new Error(`评估器 "${entry.id}" 缺少 measures 或 evaluate`)
        entries.set(entry.id, { kind: 'evaluator', entry, stage })
      } else throw new Error(`未知条目类型 "${String((entry as { kind?: unknown }).kind)}"`)
    },

    recordProof(proof: ProofRecord): void {
      if (!proof || !proof.subject?.id || !parseEvalKey(proof.evaluator)) throw new Error('ProofRecord 格式非法')
      if (proof.reading.verdict !== 'unmeasured' && !Number.isFinite(proof.reading.probability)) throw new Error('ProofRecord probability 必须为有限数字')
      proofs.set(proof.subject.id, proof)
    },

    getProof: (subjectId: string) => proofs.get(subjectId),
    unregister: (id: string) => { proofs.delete(id); return entries.delete(id) },

    standingOrders(signal: SignalName): readonly StandingOrderDef[] {
      const matched: StandingOrderDef[] = []
      for (const item of entries.values()) {
        if (item.kind === 'standing-order' && item.stage !== 'retired' && item.entry.trigger.signal === signal) matched.push(item.entry)
      }
      return matched
    },

    list() {
      return [...entries.values()].map(i => ({ id: i.entry.id, kind: i.kind, version: i.entry.version, stage: i.stage, ...(i.kind === 'gate' ? { point: i.entry.point } : {}) }))
    },

    async evaluate<P extends Point>(point: P, ctx: PointCatalog[P]): Promise<PointEvaluation> {
      const checkedPoint = assertScopeStage(point, allowedScopes, 'evaluate()')
      const ran: RunEntry[] = []
      const observed: RunEntry[] = []
      const blockers: string[] = []
      const unmeasuredList: { cause: UnmeasuredCause; detail: string }[] = []
      const producedMap: Record<string, unknown> = {}
      let registered = 0, evaluated = 0, skipped = 0, enforcingRegistered = 0, enforcingEvaluated = 0

      for (const item of entries.values()) {
        if (item.kind !== 'gate' || item.stage === 'retired' || item.entry.point !== checkedPoint) continue
        const gate = item.entry
        const res = await runSingleGate(gate, item.stage, ctx, proofs, entries)
        if (item.stage === 'shadow') {
          observed.push({ id: gate.id, version: gate.version, outcome: res.outcome, ...(res.outcome === 'skipped' ? { skip: res.skip } : res.outcome === 'deny' ? { detail: res.blockers.join('; ') } : res.outcome === 'unmeasured' ? { detail: res.detail } : {}) })
          continue
        }
        registered += 1
        const enforcing = item.stage === 'enforce' && gate.placement.enforce
        if (enforcing) enforcingRegistered += 1
        if (res.outcome === 'skipped') { skipped += 1; ran.push({ id: gate.id, version: gate.version, outcome: 'skipped', skip: res.skip }); continue }
        evaluated += 1
        if (enforcing) enforcingEvaluated += 1
        if (res.outcome === 'allow') {
          ran.push({ id: gate.id, version: gate.version, outcome: 'allow' })
          if (enforcing && res.produced) producedMap[gate.id] = res.produced
        } else if (res.outcome === 'deny') {
          const detail = res.blockers.join('; ')
          ran.push({ id: gate.id, version: gate.version, outcome: 'deny', detail })
          if (enforcing) blockers.push(...res.blockers); else observed.push({ id: gate.id, version: gate.version, outcome: 'deny', detail })
        } else {
          ran.push({ id: gate.id, version: gate.version, outcome: 'unmeasured', detail: res.detail })
          const canTolerate = res.disposition === 'tolerate' && gate.side !== 'hard' && !HARD_UNMEASURED_CAUSES.has(res.cause)
          if (enforcing && !canTolerate) unmeasuredList.push({ cause: res.cause, detail: res.detail })
          else observed.push({ id: gate.id, version: gate.version, outcome: 'unmeasured', detail: res.detail })
        }
      }

      const verdict: Verdict = enforcingRegistered > 0 && enforcingEvaluated === 0
        ? { kind: 'unmeasured', cause: 'all-skipped', detail: `插入点 "${checkedPoint}" 已注册 ${enforcingRegistered} 条强制判据，但本轮全部被跳过` }
        : blockers.length > 0
          ? { kind: 'deny', blockers: blockers as [string, ...string[]] }
          : unmeasuredList.length > 0
            ? { kind: 'unmeasured', cause: unmeasuredList[0]!.cause, detail: unmeasuredList.map(u => u.detail).join('; ') }
            : Object.keys(producedMap).length > 0 ? { kind: 'allow', produced: producedMap } : { kind: 'allow' }

      const ev: PointEvaluation = { point: checkedPoint as Point, verdict, registered, evaluated, skipped, ran, observed }
      dispatchOnEvaluated(options.onEvaluated, ev)
      return ev
    },
  }
}
