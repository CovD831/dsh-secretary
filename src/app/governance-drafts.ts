/** 治理草稿箱与桌面/像素办公室裁决分流落地（安全校验、幂等防重与 shadow 安装）。 */
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
  validateAndNormalizePlaybook, validateDeclarativeRule, type AnyGateDef, type DeclarativeRule, type MandateBinding,
  type ParamSpec, type PlaybookSpec, type Point, type RegistryEntry, type Verdict,
} from '../judgement/index.ts'
import type { AttentionItem, WriteResult } from '../memory/index.ts'
import { collectOnlineRsiSnapshot } from '../rsi/index.ts'
import { redactValue } from '../spine/index.ts'
import type { GovernanceRuntime } from './governance.ts'
import { syncDepositsAndLedger } from './governance-ops.ts'
import type { FourWayAttribution, RulingItem } from './ruling-queue.ts'

/** 安全校验候选 ID 并从状态目录/内置沉淀目录加载未注册候选条目（防目录穿越与软链）。 */
export async function loadSafeCandidateEntry(dirs: readonly string[], candidateId: string): Promise<RegistryEntry | undefined> {
  if (!SAFE_DRAFT_ID_RE.test(candidateId) || candidateId.includes('..')) throw new Error(`非法 candidateId "${candidateId}"`)
  for (const dir of dirs) {
    const dirSt = await lstat(dir).catch(() => undefined)
    if (!dirSt || !dirSt.isDirectory() || dirSt.isSymbolicLink()) continue
    const dirReal = await realpath(dir), pkgDir = resolve(dirReal, candidateId)
    const pkgSt = await lstat(pkgDir).catch(() => undefined)
    if (!pkgSt || !pkgSt.isDirectory() || pkgSt.isSymbolicLink()) continue
    const rel = relative(dirReal, await realpath(pkgDir))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    const loaded = await loadDepositPackage(pkgDir).catch(() => undefined)
    if (loaded?.admission.admitted) return loaded.admission.manifest.rule || loaded.admission.manifest.kind === 'standing-order' ? compileDeclarativeEntry(loaded.admission.manifest) : undefined
  }
  return undefined
}
const SAFE_DRAFT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const ATTRIBUTION_MAP: Readonly<Record<FourWayAttribution, AttributionCategory>> = {
  missing_rule: 'gate_gap', wrong_rule: 'exec_mistake', unmeasurable: 'env_transient', rule_conflict: 'mandate_unclear',
}
const appliedRulings = new WeakMap<GovernanceRuntime, Set<string>>()

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

/** 将桌面/像素办公室已完成裁决按四分法归因接通 `routeEscalationRuling` 并幂等落地草稿或 M2/M3/M6 记忆。 */
export async function applyDecidedRuling(
  gov: GovernanceRuntime, item: RulingItem,
): Promise<{ routed?: EscalationRouteResult; draftPath?: string; memoryWrite?: WriteResult; attentionItem?: AttentionItem } | undefined> {
  if (item.status !== 'decided' || !item.ruledRef || (item.captureAsRule !== true && !item.attribution)) return undefined
  let seen = appliedRulings.get(gov)
  if (!seen) { seen = new Set(); appliedRulings.set(gov, seen) }
  const appliedEventId = `desktop:applied:${item.id}`
  if (seen.has(item.id) || gov.storeRef.db.prepare('SELECT 1 FROM event_spine WHERE id = ? LIMIT 1').get(appliedEventId)) return undefined
  seen.add(item.id)

  const attribution: AttributionCategory = item.attribution ? ATTRIBUTION_MAP[item.attribution] : 'gate_gap'
  const decidedAt = item.decidedAt ?? gov.nowDate().toISOString()
  const ruling: EscalationRuling = {
    escalationId: item.id, ticketId: item.ticketId ?? `ruling:${item.id}`, operatorOpenId: item.actorId ?? 'boss',
    decision: item.decision ?? 'approve', attribution, decidedAt, sourceRef: item.ruledRef,
    ...(item.note ? { note: item.note } : {}), ...(item.captureAsRule !== undefined ? { captureAsRule: item.captureAsRule } : {}),
  }
  const workspace = item.workspace ?? (item.ticketId ? gov.storeRef.tickets.get(item.ticketId)?.execution?.workspace : undefined)
  const routed = routeEscalationRuling(ruling, workspace ? { workspace } : {})
  const recordApplied = () => gov.appender.append({
    id: appliedEventId, at: decidedAt, stream: item.ticketId ? `ticket:${item.ticketId}` : `ruling:${item.id}`,
    type: 'escalation.applied', causationId: item.ruledRef!.id, source: { kind: 'system', ref: 'governance.ruling' },
    evidence: [{ kind: 'event', ref: item.ruledRef!.id }], taint: 'trusted',
    payload: { escalationId: item.id, ruledRef: item.ruledRef, route: routed.route },
  })
  if (routed.route === 'deposit-draft') {
    const safeId = sanitizeDraftId(routed.draft.id)
    const { value: cleanDraft } = redactValue({ ...routed.draft, id: safeId })
    const draftPath = await writeSafeDraftJson(gov.stateDir, safeId, cleanDraft)
    gov.appender.append(telemetryToSpineInput({
      id: `authoring:draft_created:${safeId}:${item.id}`, kind: 'draft_created', draftId: safeId,
      depositKind: cleanDraft.kind, scope: cleanDraft.scope, at: decidedAt, actorId: ruling.operatorOpenId,
    }))
    recordApplied()
    return { routed, draftPath }
  }
  if (routed.route === 'workspace-memory-proposal' && !workspace) {
    const q = `待确认工作区归属（工单 ${ruling.ticketId} 裁决 ${ruling.escalationId}）：${ruling.note?.trim() || '请指定目标 M3 工作区'}`
    const attentionItem = (await gov.memory.upsertAttention({ kind: 'verification', question: q, sourceRefs: [item.ruledRef], delaySeen: 1, seenCount: 1 }, ruling.operatorOpenId)).item
    recordApplied()
    return { routed, attentionItem }
  }
  if (routed.route === 'workspace-memory-proposal' || routed.route === 'user-ruling-memory-proposal') {
    const memoryWrite = await gov.memory.propose(toMemoryProposal(routed, workspace ? { workspaceId: workspace } : {}))
    if (memoryWrite.kind === 'accepted') await gov.ftsIndex.rebuild().catch(() => undefined)
    recordApplied()
    return { routed, memoryWrite }
  }
  recordApplied()
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
      ...(trig['match'] && typeof trig['match'] === 'object' && !Array.isArray(trig['match']) ? { match: trig['match'] as Record<string, unknown> } : {}),
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
    ...(raw['playbook'] && typeof raw['playbook'] === 'object' ? { playbook: raw['playbook'] as PlaybookSpec } : {}),
    ...(raw['rule'] && typeof raw['rule'] === 'object' ? { rule: raw['rule'] as DeclarativeRule } : {}),
    ...(typeof raw['measures'] === 'string' && raw['measures'].trim() ? { measures: raw['measures'] } : {}),
    ...(raw['mandate'] && typeof raw['mandate'] === 'object' ? { mandate: raw['mandate'] as MandateBinding } : {}),
  }
}

function inspectDraft(draft: DepositDraft, raw?: Record<string, unknown>) {
  const validation = validateDepositDraft(draft)
  const pbIssues = raw?.['playbook'] !== undefined
    ? validateAndNormalizePlaybook(raw['playbook'], '').issues.map(i => ({ ruleId: 'invalid-playbook', field: i.field, reason: i.reason, repairHint: '修正 playbook 配置' }))
    : []
  const ruleIssues = [
    ...pbIssues,
    ...(raw?.['rule'] !== undefined
      ? validateDeclarativeRule(raw['rule']).map(i => ({ ruleId: 'invalid-declarative-rule', field: i.field, reason: i.reason, repairHint: '修正零代码声明式 rule 配置' }))
      : []),
  ]
  return { validation, ruleIssues, ready: validation.ok && ruleIssues.length === 0 }
}

/** 列出 `<stateDir>/deposit-drafts/*.json` 草稿及可选合并在线 RSI 候选（同 ID 以磁盘为准，防软链逃逸）。 */
export async function listDepositDrafts(
  gov: GovernanceRuntime,
  options: { includeOnlineCandidates?: boolean; collectionMode?: 'production' | 'e2e' } = {},
): Promise<DepositDraftEntry[]> {
  const draftsDir = resolve(gov.stateDir, 'deposit-drafts')
  const byId = new Map<string, DepositDraftEntry>()
  const dirStat = await lstat(draftsDir).catch(() => undefined)
  if (dirStat && dirStat.isDirectory() && !dirStat.isSymbolicLink()) {
    const rootReal = await realpath(draftsDir)
    const files = (await readdir(rootReal)).filter(n => n.endsWith('.json')).sort()
    for (const name of files) {
      const filePath = resolve(rootReal, name)
      try {
        const st = await lstat(filePath)
        if (!st.isFile() || st.isSymbolicLink()) continue
        const rel = relative(rootReal, await realpath(filePath))
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
        const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
        const draft = normalizeRawDraft(raw)
        byId.set(draft.id, { id: draft.id, source: 'disk', filePath, draft, ...inspectDraft(draft, raw) })
      } catch { continue }
    }
  }
  if (options.includeOnlineCandidates !== false) {
    const mode = options.collectionMode ?? (process.env['DSH_RSI_COLLECTION_MODE'] === 'e2e' ? 'e2e' : 'production')
    const workspaceDirs = Object.fromEntries(gov.workspaces.list().map(w => [w.id, w.repository]))
    const snap = await collectOnlineRsiSnapshot({ db: gov.storeRef.db, memoryDir: gov.memoryDir, collectionMode: mode, workspaceDirs }).catch(() => undefined)
    for (const cand of snap?.candidateDrafts ?? []) {
      if (!byId.has(cand.id)) byId.set(cand.id, { id: cand.id, source: 'online-rsi', draft: cand, ...inspectDraft(cand) })
    }
  }
  return [...byId.values()]
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
        return audit.ok ? { kind: 'unmeasured', cause: 'no-evidence', detail: `草稿 "${draft.id}" 尚未绑定已注册判据实现` }
          : { kind: 'unmeasured', cause: 'missing-input', detail: `缺少必需输入路径: ${audit.missing.join(', ')}` }
      }
  const shadowEnforce = draft.kind === 'counter-rule' ? false : draft.enforce
  return {
    kind: 'gate', id: draft.id, version: draft.version, point: draft.point as Point,
    description: draft.intent || draft.name, placement: { timing: 'pre', enforce: shadowEnforce ?? true }, requires: draft.requires, gate: gateFn,
  } as AnyGateDef
}

/** 认领草稿或在线 RSI 候选，保存至草稿箱并可选校验与预编译后安装为 `shadow` 沉淀包。 */
export async function adoptDepositDraft(gov: GovernanceRuntime, input: AdoptDepositDraftInput): Promise<AdoptDepositDraftResult> {
  let baseRaw: Record<string, unknown> | undefined = input.draft ? { ...input.draft } : undefined
  if (!baseRaw && input.draftId) {
    const found = (await listDepositDrafts(gov, { includeOnlineCandidates: true }))
      .find(d => d.id === input.draftId || sanitizeDraftId(d.id) === sanitizeDraftId(input.draftId!))
    if (found?.filePath) { await assertNotSymlink(found.filePath); baseRaw = JSON.parse(await readFile(found.filePath, 'utf8')) as Record<string, unknown> }
    else if (found) baseRaw = found.draft as unknown as Record<string, unknown>
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
  const shadowEnforce = draft.kind === 'counter-rule' ? false : draft.enforce
  const shadowDraft: DepositDraft = { ...draft, stage: 'shadow', ...(shadowEnforce !== undefined ? { enforce: shadowEnforce } : {}) }
  let compiledEntry: RegistryEntry | undefined
  if (redactedRaw['rule'] !== undefined || shadowDraft.kind === 'standing-order') {
    compiledEntry = compileDeclarativeEntry({
      id: shadowDraft.id, version: shadowDraft.version, kind: shadowDraft.kind, trust: 'owner', cases: 'cases/',
      prose: shadowDraft.intent, params: shadowDraft.params, requires: shadowDraft.requires,
      ...(shadowDraft.kind === 'gate' || shadowDraft.kind === 'counter-rule' ? { point: shadowDraft.point as Point } : {}),
      stage: 'shadow', ...(shadowEnforce !== undefined ? { enforce: shadowEnforce } : {}), actionClass: shadowDraft.actionClass,
      ...(redactedRaw['rule'] !== undefined ? { rule: redactedRaw['rule'] as DeclarativeRule } : {}),
      ...(redactedRaw['mandate'] ? { mandate: redactedRaw['mandate'] as MandateBinding } : {}),
    })
  }
  const written = await writeDepositDraftPackage(join(gov.stateDir, 'deposits'), shadowDraft)
  const loaded = await loadDepositPackage(written.packageDir)
  if (!loaded.admission.admitted) return { ok: false, reason: `影子包准入异常: ${loaded.admission.violations.map(v => v.reason).join('; ')}` }
  if (existing) gov.registry.unregister(safeId)
  if (compiledEntry) gov.registry.register(compiledEntry, 'shadow')
  else if (loaded.admission.manifest.kind === 'gate' || loaded.admission.manifest.kind === 'counter-rule') {
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
