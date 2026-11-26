/** 治理草稿箱、桌面裁决分流落地、常驻巡检（standing-order）与 M0 分片缓存查询。 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  routeEscalationRuling, telemetryToSpineInput, toMemoryProposal, validateDepositDraft, writeDepositDraftPackage,
  type AttributionCategory, type DepositDraft, type DepositFixtureCase, type DraftValidationResult,
  type EscalationRouteResult, type EscalationRuling,
} from '../authoring/index.ts'
import {
  RESERVED_BUILTIN_DEPOSIT_IDS, auditRequires, compileDeclarativeEntry, evaluateCompiledEntry, loadDepositPackage,
  parseDepositMarkdown, validateDeclarativeRule, type AnyGateDef, type DeclarativeRule, type MandateBinding,
  type ParamSpec, type Point, type RegistryEntry, type Verdict,
} from '../judgement/index.ts'
import type { AttentionItem, WriteResult } from '../memory/index.ts'
import { readCachedShardEvents } from '../projection/shard-cache.ts'
import { collectOnlineRsiSnapshot, readM0Events } from '../rsi/index.ts'
import { redactValue, type SourceRef, type SpineEnvelope } from '../spine/index.ts'
import type { GovernanceRuntime } from './governance.ts'
import { syncDepositsAndLedger } from './governance-ops.ts'
import type { FourWayAttribution, RulingItem } from './ruling-queue.ts'
import type { Store } from './store.ts'

const SHARD_NAME_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const SAFE_DRAFT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const ATTRIBUTION_MAP: Readonly<Record<FourWayAttribution, AttributionCategory>> = {
  missing_rule: 'gate_gap', wrong_rule: 'exec_mistake', unmeasurable: 'env_transient', rule_conflict: 'mandate_unclear',
}

export interface DepositDraftEntry {
  readonly id: string; readonly source: 'disk' | 'online-rsi'; readonly filePath?: string; readonly draft: DepositDraft
  readonly ready: boolean; readonly validation: DraftValidationResult; readonly ruleIssues: readonly { ruleId: string; field: string; reason: string; repairHint: string }[]
}
export interface AdoptDepositDraftInput {
  readonly draftId?: string; readonly draft?: Record<string, unknown>; readonly cases?: readonly DepositFixtureCase[]
  readonly overrides?: Record<string, unknown>; readonly installShadow?: boolean; readonly actorId?: string
}
export type AdoptDepositDraftResult =
  | { readonly ok: false; readonly reason: string; readonly validation?: DraftValidationResult; readonly ruleIssues?: readonly unknown[] }
  | { readonly ok: true; readonly id: string; readonly filePath?: string; readonly installed: boolean; readonly stage?: 'shadow'
      readonly enforce?: false; readonly packageDir?: string; readonly draft: DepositDraft; readonly validation: DraftValidationResult }
export interface PatrolRunReport { readonly checkedTickets: number; readonly evaluated: number; readonly reminded: number }

const sanitizeDraftId = (rawId: string) =>
  rawId.replace(/\.{2,}/g, '-').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'friction-captured'

async function assertNotSymlink(target: string): Promise<void> {
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error(`拒绝访问符号链接路径: ${target}`) }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
}

async function writeSafeDraftJson(stateDir: string, draftId: string, content: unknown): Promise<string> {
  if (!SAFE_DRAFT_ID_RE.test(draftId) || draftId.includes('..')) throw new Error(`非法沉淀草稿 id: ${draftId}`)
  const draftsRoot = resolve(stateDir, 'deposit-drafts')
  await assertNotSymlink(draftsRoot)
  await mkdir(draftsRoot, { recursive: true })
  const rootReal = await realpath(draftsRoot)
  const target = resolve(rootReal, `${draftId}.json`)
  const rel = relative(rootReal, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`沉淀草稿路径越界: ${draftId}`)
  await assertNotSymlink(target)
  await writeFile(target, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
  return target
}

/** 结合 SQLite 与 `defaultShardCache` 只读分片缓存按 SourceRef 精准读取单条 M0 事件信封。 */
export async function readSpineEnvelopeFromStore(
  store: Pick<Store, 'db'>, memoryDir: string, closed: boolean, ref: SourceRef,
): Promise<SpineEnvelope<Record<string, unknown>> | undefined> {
  if (!ref || !Number.isSafeInteger(ref.seq) || ref.seq <= 0 || typeof ref.id !== 'string' || !ref.id.trim()) return undefined
  if (!closed) {
    const row = store.db.prepare('SELECT id, value FROM event_spine WHERE seq = ?').get(ref.seq) as { id?: string; value?: string } | undefined
    if (row) return row.id === ref.id && row.value ? JSON.parse(row.value) as SpineEnvelope<Record<string, unknown>> : undefined
  }
  const m0Dir = join(memoryDir, 'm0')
  let shards: string[]
  try { shards = (await readdir(m0Dir)).filter(n => SHARD_NAME_RE.test(n)).sort() } catch { return undefined }
  for (let i = shards.length - 1; i >= 0; i--) {
    const events = await readCachedShardEvents(join(m0Dir, shards[i]!))
    for (let j = events.length - 1; j >= 0; j--) {
      if (events[j]!.seq === ref.seq) return events[j]!.id === ref.id ? (events[j] as SpineEnvelope<Record<string, unknown>>) : undefined
    }
    if (events.length > 0 && events[events.length - 1]!.seq < ref.seq) return undefined
  }
  return undefined
}

/** 将桌面/像素办公室已完成裁决按四分法归因接通 `routeEscalationRuling` 并落地草稿或 M2/M3/M6 记忆。 */
export async function applyDecidedRuling(
  gov: GovernanceRuntime, item: RulingItem,
): Promise<{ routed?: EscalationRouteResult; draftPath?: string; memoryWrite?: WriteResult; attentionItem?: AttentionItem } | undefined> {
  if (item.status !== 'decided' || !item.ruledRef || (item.captureAsRule !== true && !item.attribution)) return undefined
  const attribution: AttributionCategory = item.attribution ? ATTRIBUTION_MAP[item.attribution] : 'gate_gap'
  const decidedAt = item.decidedAt ?? gov.nowDate().toISOString()
  const ruling: EscalationRuling = {
    escalationId: item.id, ticketId: item.ticketId ?? `ruling:${item.id}`, operatorOpenId: item.actorId ?? 'boss',
    decision: item.decision ?? 'approve', attribution, decidedAt, sourceRef: item.ruledRef,
    ...(item.note ? { note: item.note } : {}), ...(item.captureAsRule !== undefined ? { captureAsRule: item.captureAsRule } : {}),
  }
  const workspace = item.workspace ?? (item.ticketId ? gov.storeRef.tickets.get(item.ticketId)?.execution?.workspace : undefined)
  const routed = routeEscalationRuling(ruling, workspace ? { workspace } : {})
  if (routed.route === 'deposit-draft') {
    const safeId = sanitizeDraftId(routed.draft.id)
    const { value: cleanDraft } = redactValue({ ...routed.draft, id: safeId })
    const draftPath = await writeSafeDraftJson(gov.stateDir, safeId, cleanDraft)
    gov.appender.append(telemetryToSpineInput({
      id: `authoring:draft_created:${safeId}:${item.id}`, kind: 'draft_created', draftId: safeId,
      depositKind: cleanDraft.kind, scope: cleanDraft.scope, at: decidedAt, actorId: ruling.operatorOpenId,
    }))
    return { routed, draftPath }
  }
  if (routed.route === 'workspace-memory-proposal' && !workspace) {
    const q = `待确认工作区归属（工单 ${ruling.ticketId} 裁决 ${ruling.escalationId}）：${ruling.note?.trim() || '请指定目标 M3 工作区'}`
    const attentionItem = (await gov.memory.upsertAttention({ kind: 'verification', question: q, sourceRefs: [item.ruledRef], delaySeen: 1, seenCount: 1 }, ruling.operatorOpenId)).item
    return { routed, attentionItem }
  }
  if (routed.route === 'workspace-memory-proposal' || routed.route === 'user-ruling-memory-proposal') {
    const memoryWrite = await gov.memory.propose(toMemoryProposal(routed, workspace ? { workspaceId: workspace } : {}))
    if (memoryWrite.kind === 'accepted') gov.ftsIndex.rebuild().catch(() => undefined)
    return { routed, memoryWrite }
  }
  return { routed }
}

function normalizeRawDraft(raw: Record<string, unknown>): DepositDraft {
  const id = typeof raw['id'] === 'string' && raw['id'].trim() ? raw['id'].trim() : 'draft-unnamed'
  const trig = (raw['trigger'] && typeof raw['trigger'] === 'object' ? raw['trigger'] : {}) as Record<string, unknown>
  const str = (k: string, fb: string) => typeof raw[k] === 'string' && (raw[k] as string).trim() ? raw[k] as string : fb
  return {
    id, name: str('name', id), version: typeof raw['version'] === 'number' ? raw['version'] : 1, author: str('author', 'boss'),
    scope: str('scope', 'private') as DepositDraft['scope'], kind: str('kind', 'gate') as DepositDraft['kind'],
    level: str('level', 'object') as DepositDraft['level'], point: str('point', 'verify.preflight'),
    trigger: {
      on: typeof trig['on'] === 'string' && trig['on'].trim() ? trig['on'] : 'completion.claimed',
      mode: (typeof trig['mode'] === 'string' ? trig['mode'] : 'on-event') as 'always' | 'on-event' | 'scheduled-sweep',
      ...(typeof trig['workspace'] === 'string' ? { workspace: trig['workspace'] } : {}),
      ...(Array.isArray(trig['globs']) ? { globs: trig['globs'] as string[] } : {}),
      ...(typeof trig['signal'] === 'string' ? { signal: trig['signal'] } : {}),
    },
    requires: Array.isArray(raw['requires']) ? raw['requires'] as string[] : [],
    params: (raw['params'] && typeof raw['params'] === 'object' ? raw['params'] : {}) as DepositDraft['params'],
    exceptions: Array.isArray(raw['exceptions']) ? raw['exceptions'] as string[] : [],
    repairHint: typeof raw['repairHint'] === 'string' ? raw['repairHint'] : '',
    intent: typeof raw['intent'] === 'string' ? raw['intent'] : '', rubricBody: typeof raw['rubricBody'] === 'string' ? raw['rubricBody'] : '',
    actionClass: str('actionClass', 'observe') as DepositDraft['actionClass'],
    origin: (raw['origin'] && typeof raw['origin'] === 'object' ? raw['origin'] : { kind: 'user-authored' }) as DepositDraft['origin'],
    cases: Array.isArray(raw['cases']) ? raw['cases'] as DepositFixtureCase[] : [],
    ...(raw['enforce'] !== undefined ? { enforce: Boolean(raw['enforce']) } : {}),
    ...(typeof raw['stage'] === 'string' ? { stage: raw['stage'] as DepositDraft['stage'] } : {}),
    ...(typeof raw['mandateCeiling'] === 'string' ? { mandateCeiling: raw['mandateCeiling'] as DepositDraft['mandateCeiling'] } : {}),
    ...(typeof raw['mandateRef'] === 'string' ? { mandateRef: raw['mandateRef'] } : {}),
    ...(raw['action'] && typeof raw['action'] === 'object' ? { action: raw['action'] as DepositDraft['action'] } : {}),
    ...(Array.isArray(raw['unansweredSlots']) ? { unansweredSlots: raw['unansweredSlots'] as string[] } : {}),
  }
}

function inspectDraft(draft: DepositDraft, raw?: Record<string, unknown>) {
  const validation = validateDepositDraft(draft)
  const ruleIssues = raw?.['rule'] !== undefined
    ? validateDeclarativeRule(raw['rule']).map(i => ({ ruleId: 'invalid-declarative-rule', field: i.field, reason: i.reason, repairHint: '修正零代码声明式 rule 配置' }))
    : []
  return { validation, ruleIssues, ready: validation.ok && ruleIssues.length === 0 }
}

/** 列出 `<stateDir>/deposit-drafts/*.json` 草稿及可选合并在线 RSI 候选（同 ID 以磁盘为准）。 */
export async function listDepositDrafts(gov: GovernanceRuntime, options: { includeOnlineCandidates?: boolean } = {}): Promise<DepositDraftEntry[]> {
  const draftsDir = join(gov.stateDir, 'deposit-drafts')
  const byId = new Map<string, DepositDraftEntry>()
  let files: string[] = []
  try { files = (await readdir(draftsDir)).filter(n => n.endsWith('.json')).sort() } catch { files = [] }
  for (const name of files) {
    const filePath = join(draftsDir, name)
    try {
      if ((await lstat(filePath)).isSymbolicLink()) continue
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
      const draft = normalizeRawDraft(raw)
      byId.set(draft.id, { id: draft.id, source: 'disk', filePath, draft, ...inspectDraft(draft, raw) })
    } catch { continue }
  }
  if (options.includeOnlineCandidates !== false) {
    const snap = await collectOnlineRsiSnapshot({ db: gov.storeRef.db, memoryDir: gov.memoryDir }).catch(() => undefined)
    for (const cand of snap?.candidateDrafts ?? []) {
      if (!byId.has(cand.id)) byId.set(cand.id, { id: cand.id, source: 'online-rsi', draft: cand, ...inspectDraft(cand) })
    }
  }
  return [...byId.values()]
}

async function mergeExtras(depositMdPath: string, raw: Record<string, unknown>): Promise<void> {
  if (raw['rule'] === undefined && !raw['measures'] && !raw['mandate']) return
  await assertNotSymlink(depositMdPath)
  const parsed = parseDepositMarkdown(await readFile(depositMdPath, 'utf8'))
  const m: Record<string, unknown> = { ...parsed.rawManifest }
  if (raw['rule'] !== undefined) m['rule'] = raw['rule']
  if (raw['measures']) m['measures'] = raw['measures']
  if (raw['mandate']) m['mandate'] = raw['mandate']
  await writeFile(depositMdPath, `---\n${JSON.stringify(m, null, 2)}\n---\n\n${parsed.prose}\n`, 'utf8')
}

function buildShadowGate(draft: DepositDraft, raw: Record<string, unknown>): AnyGateDef {
  const params = Object.fromEntries(Object.entries(draft.params ?? {}).flatMap(([k, v]) =>
    v && typeof v === 'object' && 'default' in v && (v as ParamSpec).default !== undefined ? [[k, (v as ParamSpec).default]] : []))
  const gateFn = raw['rule'] !== undefined
    ? (ctx: unknown) => evaluateCompiledEntry(compileDeclarativeEntry({
        id: draft.id, version: draft.version, kind: draft.kind, trust: 'owner', cases: 'cases/',
        prose: draft.intent, params: draft.params, requires: draft.requires, point: draft.point as Point,
        actionClass: draft.actionClass, rule: raw['rule'] as DeclarativeRule,
      }, params), ctx)
    : (ctx: unknown): Verdict => {
        const audit = auditRequires(ctx, draft.requires)
        return audit.ok
          ? { kind: 'unmeasured', cause: 'no-evidence', detail: `草稿 "${draft.id}" 尚未绑定已注册判据实现` }
          : { kind: 'unmeasured', cause: 'missing-input', detail: `缺少必需输入路径: ${audit.missing.join(', ')}` }
      }
  return {
    kind: 'gate', id: draft.id, version: draft.version, point: draft.point as Point,
    description: draft.intent || draft.name, placement: { timing: 'pre', enforce: false }, requires: draft.requires, gate: gateFn,
  } as AnyGateDef
}

/** 认领草稿或在线 RSI 候选，保存至草稿箱并可选校验后安装为 `shadow` 沉淀包。 */
export async function adoptDepositDraft(gov: GovernanceRuntime, input: AdoptDepositDraftInput): Promise<AdoptDepositDraftResult> {
  let baseRaw: Record<string, unknown> | undefined = input.draft ? { ...input.draft } : undefined
  if (!baseRaw && input.draftId) {
    const found = (await listDepositDrafts(gov, { includeOnlineCandidates: true }))
      .find(d => d.id === input.draftId || sanitizeDraftId(d.id) === sanitizeDraftId(input.draftId!))
    baseRaw = found?.filePath ? JSON.parse(await readFile(found.filePath, 'utf8')) as Record<string, unknown> : found?.draft as unknown as Record<string, unknown> | undefined
  }
  if (!baseRaw) return { ok: false, reason: input.draftId ? `未找到草稿 "${input.draftId}"` : '缺少 draftId 或 draft 参数' }
  const mergedRaw: Record<string, unknown> = {
    ...baseRaw, ...(input.overrides ?? {}), ...(input.draftId && !baseRaw['id'] ? { id: input.draftId } : {}), ...(input.cases ? { cases: input.cases } : {}),
  }
  const safeId = sanitizeDraftId(String(mergedRaw['id'] ?? input.draftId ?? 'draft'))
  const { value: redactedRaw } = redactValue({ ...mergedRaw, id: safeId }) as { value: Record<string, unknown> }
  const draft = normalizeRawDraft(redactedRaw)
  const filePath = await writeSafeDraftJson(gov.stateDir, safeId, redactedRaw)
  const { validation, ruleIssues, ready } = inspectDraft(draft, redactedRaw)
  if (!input.installShadow) return { ok: true, id: safeId, filePath, installed: false, draft, validation }
  if (!ready) return { ok: false, reason: '草稿未通过机器门或证据门校验', validation, ruleIssues }
  const existing = gov.registry.list().find(g => g.id === safeId)
  if (RESERVED_BUILTIN_DEPOSIT_IDS.has(safeId) || (existing && existing.stage !== 'shadow')) {
    return { ok: false, reason: `禁止影子安装包覆盖内置保留或非 shadow 阶段判据: ${safeId}` }
  }
  const shadowDraft: DepositDraft = { ...draft, stage: 'shadow', enforce: false }
  const written = await writeDepositDraftPackage(join(gov.stateDir, 'deposits'), shadowDraft)
  await mergeExtras(written.depositMdPath, redactedRaw)
  const loaded = await loadDepositPackage(written.packageDir)
  if (!loaded.admission.admitted) return { ok: false, reason: `影子包准入异常: ${loaded.admission.violations.map(v => v.reason).join('; ')}` }
  const m = loaded.admission.manifest
  if (existing) gov.registry.unregister(safeId)
  if (m.rule || m.kind === 'standing-order') {
    gov.registry.register(compileDeclarativeEntry({
      ...m, stage: 'shadow', enforce: false,
      ...(m.kind === 'gate' || m.kind === 'counter-rule' ? { placement: { timing: 'pre', enforce: false } } : {}),
      ...(redactedRaw['mandate'] ? { mandate: redactedRaw['mandate'] as MandateBinding } : {}),
    }), 'shadow')
  } else if (m.kind === 'gate' || m.kind === 'counter-rule') {
    gov.registry.register(buildShadowGate(shadowDraft, redactedRaw), 'shadow')
  }
  await unlink(filePath).catch(() => undefined)
  await syncDepositsAndLedger(gov)
  gov.appender.append(telemetryToSpineInput({
    id: `authoring:shadow_installed:${safeId}:${randomUUID().slice(0, 8)}`, kind: 'shadow_installed',
    draftId: safeId, version: shadowDraft.version, at: gov.nowDate().toISOString(), actorId: input.actorId ?? 'boss',
  }))
  return { ok: true, id: safeId, installed: true, stage: 'shadow', enforce: false, packageDir: written.packageDir, draft: shadowDraft, validation }
}

/** 扫描未结单且有运行中 assignment 的工单，评估 `ticket.stale` 常驻巡检并按需写入 M6 温和提醒。 */
export async function runStandingOrderPatrol(gov: GovernanceRuntime, options: { maxIdleMinutes?: number } = {}): Promise<PatrolRunReport> {
  const orders = gov.registry.standingOrders('ticket.stale')
  const openTickets = gov.storeRef.tickets.list().filter(t => !t.ended && t.assignments.some(a => a.state === 'running'))
  if (orders.length === 0 || openTickets.length === 0) return { checkedTickets: openTickets.length, evaluated: 0, reminded: 0 }
  const now = gov.nowDate(), nowMs = now.getTime(), maxIdleMinutes = options.maxIdleMinutes ?? 30
  const lastEvalAt = new Map<string, number>()
  for (const ev of await readM0Events({ db: gov.storeRef.db, memoryDir: gov.memoryDir }).catch(() => [])) {
    const p = ev.payload as Record<string, unknown> | undefined
    if (ev.type === 'standing_order.evaluated' && typeof p?.['orderId'] === 'string' && typeof p?.['ticketId'] === 'string') {
      const ts = Date.parse(ev.at)
      if (Number.isFinite(ts)) lastEvalAt.set(`${p['orderId']}:${p['ticketId']}`, ts)
    }
  }
  let evaluated = 0, reminded = 0
  for (const ticket of openTickets) {
    const running = ticket.assignments.find(a => a.state === 'running')
    const lastIso = running?.idleAt ?? running?.deliveredAt ?? running?.report?.at ?? running?.startedAt ?? running?.createdAt ?? ticket.updatedAt
    const staleMinutes = Math.max(0, (nowMs - Date.parse(lastIso)) / 60_000)
    if (!Number.isFinite(staleMinutes)) continue
    for (const order of orders) {
      const prevTs = lastEvalAt.get(`${order.id}:${ticket.id}`)
      const elapsedMs = prevTs !== undefined ? Math.max(0, nowMs - prevTs) : Number.MAX_SAFE_INTEGER
      const verdict = await evaluateCompiledEntry(order as unknown as RegistryEntry, {
        signal: 'ticket.stale', elapsedMs, isolation: 'I1',
        payload: { status: 'working', ticketId: ticket.id, staleMinutes, idleExceeded: staleMinutes >= maxIdleMinutes,
          ticketOpen: !ticket.ended, completedSteps: ['verify-heartbeat-timeout', 'confirm-open-ticket'] },
      })
      evaluated += 1
    const ref = gov.appender.append({
      id: `patrol:${order.id}:${ticket.id}:${nowMs}:${evaluated}`, at: now.toISOString(), stream: `ticket:${ticket.id}`,
      type: 'standing_order.evaluated', source: { kind: 'system', ref: 'governance.patrol' },
      evidence: [{ kind: 'event', ref: `ticket:${ticket.id}` }], taint: 'trusted',
      payload: { orderId: order.id, signal: 'ticket.stale', ticketId: ticket.id, staleMinutes, elapsedMs, verdict, action: order.action },
    })
    lastEvalAt.set(`${order.id}:${ticket.id}`, nowMs)
    if (verdict.kind === 'allow' && order.action.name === 'ticket.remind') {
      reminded += 1
      await gov.memory.upsertAttention({ kind: 'verification', sourceRefs: [ref], delaySeen: 1, seenCount: 1,
        question: `工单「${ticket.title}」(${ticket.id}) 已静默 ${Math.round(staleMinutes)} 分钟，请确认是否需要介入或催办` }, 'standing-order').catch(() => undefined)
    }
    }
  }
  return { checkedTickets: openTickets.length, evaluated, reminded }
}
