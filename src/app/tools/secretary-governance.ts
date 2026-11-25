/** 零执行秘书专属治理工具组：受控记忆召回、M0 溯源提议、M6 账本流转与沉淀作者面。 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { telemetryToSpineInput, validateDepositDraft, writeDepositDraftPackage, type DepositDraft } from '../../authoring/index.ts'
import { createAdaptiveDispatchGate, createChangedPathsGate, createVerifyRerunGate } from '../../judgement/gates/index.ts'
import { auditRequires, loadDepositPackage, type AnyGateDef, type ParamSpec, type Point, type Verdict } from '../../judgement/index.ts'
import { assembleMemoryPrompt, memoryTaintOf, readMemoryPage, resolveMemoryRelPath, type MemoryScope } from '../../memory/index.ts'
import { runHistoricalReplay, type ReplayCase, type ReplayGateFn } from '../../rsi/index.ts'
import type { GovernanceRuntime } from '../governance.ts'
import { tool, type Tool } from './tool.ts'

const SourceRefSchema = z.object({ seq: z.number(), id: z.string() }).strict()
const RecallSchema = z.object({
  query: z.string().default(''), recent_messages: z.array(z.string()).optional(),
  budgets: z.object({ residentMaxChars: z.number().optional(), triggeredMaxChars: z.number().optional(),
    retrievedMaxChars: z.number().optional(), attentionMaxChars: z.number().optional() }).strict().optional(),
}).strict()

// 移除 user_ruling/user_direct、override_tombstone 与自由 author，防止提示注入伪造老板权威。
const ProposeSchema = z.object({
  mode: z.enum(['propose', 'tombstone']).default('propose'), layer: z.enum(['m1', 'm2', 'm3']),
  slug: z.string().optional(), workspace_key: z.string().optional(), source_ref: SourceRefSchema,
  statement: z.string().optional(), scope: z.string().optional(), source_type: z.enum(['session', 'inference']).optional(),
  topic_key: z.string().optional(), clearance: z.enum(['public', 'workspace', 'private']).optional(),
  m2_kind: z.enum(['preference', 'veto', 'shared_event', 'internal_moniker', 'correction_repair']).optional(),
  resident: z.boolean().optional(), importance: z.number().optional(),
  verbatim_quote: z.string().optional(), evidence_text: z.string().optional(),
  trigger_keys: z.object({ primary: z.array(z.string()), secondary: z.array(z.string()).optional(),
    logic: z.enum(['AND_ANY', 'AND_ALL', 'NOT_ANY', 'NOT_ALL']).optional() }).strict().optional(),
  entry_id: z.string().optional(), reason: z.string().optional(),
}).strict()

const LedgerSchema = z.object({
  mode: z.enum(['list', 'transition']).default('list'),
  status: z.enum(['pending', 'asked', 'approved', 'dismissed', 'expired']).optional(),
  id: z.string().optional(), next_status: z.enum(['asked', 'approved', 'dismissed']).optional(), source_ref: SourceRefSchema.optional(),
}).strict()

const DraftSchema = z.object({
  id: z.string(), name: z.string().optional(), version: z.number().optional(), author: z.string().optional(),
  scope: z.string().optional(),
  kind: z.enum(['gate', 'standing-order', 'evaluator', 'counter-rule']).optional(), level: z.enum(['object', 'meta']).optional(),
  point: z.string().optional(), requires: z.array(z.string()).optional(), params: z.record(z.string(), z.unknown()).optional(),
  exceptions: z.array(z.string()).optional(), repairHint: z.string().optional(), intent: z.string().optional(), rubricBody: z.string().optional(),
  enforce: z.boolean().optional(), stage: z.enum(['shadow', 'observe', 'enforce', 'retired']).optional(),
  mandateCeiling: z.enum(['L0', 'L1', 'L2', 'L3']).optional(), actionClass: z.enum(['observe', 'block', 'side-effecting']).optional(),
  mandateRef: z.string().optional(), action: z.object({ name: z.string(), params: z.unknown().optional() }).strict().optional(),
  trigger: z.object({ on: z.string().optional(), workspace: z.string().optional(), globs: z.array(z.string()).optional(),
    mode: z.enum(['always', 'on-event', 'scheduled-sweep']).optional(), signal: z.string().optional() }).strict().optional(),
  origin: z.object({ kind: z.enum(['user-authored', 'friction-mined', 'forked']), refs: z.array(z.string()).optional() }).strict().optional(),
  cases: z.array(z.object({ name: z.string(), expected: z.enum(['allow', 'deny', 'unmeasured']), ctx: z.unknown(),
    expectedCause: z.string().optional(), note: z.string().optional() }).strict()).optional(),
  unansweredSlots: z.array(z.string()).optional(),
}).strict()

const DepositSchema = z.object({
  mode: z.enum(['validate', 'replay', 'install_shadow']), draft: DraftSchema,
  cases: z.array(z.object({ id: z.string(), family: z.string(), input: z.unknown(),
    expectedOutcome: z.enum(['defect', 'clean', 'unknown']), tokens: z.number().optional(), durationMs: z.number().optional() }).strict()).optional(),
}).strict()

const stripUndefined = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function normalizeDraft(raw: z.infer<typeof DraftSchema>): DepositDraft {
  return {
    id: raw.id, name: raw.name ?? raw.id, version: raw.version ?? 1, author: 'secretary',
    scope: (raw.scope as DepositDraft['scope']) ?? 'private', kind: raw.kind ?? 'gate', level: raw.level ?? 'object',
    point: raw.point ?? 'verify.preflight',
    trigger: { on: raw.trigger?.on ?? 'completion.claimed', mode: raw.trigger?.mode ?? 'on-event',
      ...(raw.trigger?.workspace ? { workspace: raw.trigger.workspace } : {}),
      ...(raw.trigger?.globs ? { globs: raw.trigger.globs } : {}), ...(raw.trigger?.signal ? { signal: raw.trigger.signal } : {}) },
    requires: raw.requires ?? [], params: (raw.params ?? {}) as DepositDraft['params'], exceptions: raw.exceptions ?? [],
    repairHint: raw.repairHint ?? '', intent: raw.intent ?? '', rubricBody: raw.rubricBody ?? '',
    actionClass: raw.actionClass ?? 'observe', origin: raw.origin ?? { kind: 'user-authored' },
    cases: (raw.cases ?? []) as DepositDraft['cases'],
    ...(raw.enforce !== undefined ? { enforce: raw.enforce } : {}), ...(raw.stage ? { stage: raw.stage } : {}),
    ...(raw.mandateCeiling ? { mandateCeiling: raw.mandateCeiling } : {}), ...(raw.mandateRef ? { mandateRef: raw.mandateRef } : {}),
    ...(raw.action ? { action: raw.action } : {}), ...(raw.unansweredSlots ? { unansweredSlots: raw.unansweredSlots } : {}),
  }
}

function extractDefaultParams(specs: Readonly<Record<string, ParamSpec>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, spec] of Object.entries(specs ?? {})) {
    if (spec && typeof spec === 'object' && 'default' in spec && spec.default !== undefined) out[k] = spec.default
  }
  return out
}

function buildStandaloneGateFn(draft: DepositDraft): (ctx: unknown) => Verdict | Promise<Verdict> {
  const bound = extractDefaultParams(draft.params)
  if (draft.id === 'verify.changed-paths') return ctx => createChangedPathsGate(bound).gate(ctx as never)
  if (draft.id === 'verify.rerun') return ctx => createVerifyRerunGate(bound).gate(ctx as never)
  if (draft.id === 'ticket.adaptive-dispatch') return ctx => createAdaptiveDispatchGate(bound).gate(ctx as never)
  return ctx => {
    const audit = auditRequires(ctx, draft.requires)
    return audit.ok
      ? { kind: 'unmeasured', cause: 'no-evidence', detail: `草稿 "${draft.id}" 尚未绑定已注册判据实现` }
      : { kind: 'unmeasured', cause: 'missing-input', detail: `缺少必需输入路径: ${audit.missing.join(', ')}` }
  }
}

function buildReplayGate(gov: GovernanceRuntime, draft: DepositDraft): ReplayGateFn<unknown> {
  if (draft.id === 'verify.changed-paths' || draft.id === 'verify.rerun' || draft.id === 'ticket.adaptive-dispatch') {
    return buildStandaloneGateFn(draft)
  }
  if (gov.registry.list().some(g => g.kind === 'gate' && g.id === draft.id)) {
    return async (ctx): Promise<Verdict> => {
      const ev = await gov.registry.evaluate(draft.point as Point, ctx as never)
      const hit = [...ev.ran, ...ev.observed].find(r => r.id === draft.id)
      if (!hit) return { kind: 'unmeasured', cause: 'no-evidence', detail: `判据 "${draft.id}" 未产生执行记录` }
      if (hit.outcome === 'allow') return { kind: 'allow' }
      if (hit.outcome === 'deny') return { kind: 'deny', blockers: [hit.detail || 'denied'] }
      if (hit.outcome === 'skipped') return { kind: 'unmeasured', cause: 'all-skipped', detail: hit.detail || '判据条件不适用被跳过' }
      return { kind: 'unmeasured', cause: 'no-evidence', detail: hit.detail || 'unmeasured' }
    }
  }
  return buildStandaloneGateFn(draft)
}

/** 构造挂入秘书主会话的 4 个结构化治理工具（零文件/shell 执行权且禁自称老板权威）。 */
export function secretaryGovernanceTools(gov: GovernanceRuntime): Tool[] {
  return [
    tool({
      name: 'orchestrator_memory_recall',
      description: 'Recall secretary memory and M6 attention.',
      schema: RecallSchema,
      execute: async args => {
        const res = await gov.memoryRepoLock.run(() => assembleMemoryPrompt({
          dir: gov.memoryDir, caller: { role: 'secretary', maxClearance: 'private' }, query: args.query,
          ...(args.recent_messages ? { recentMessages: args.recent_messages } : {}),
          ...(args.budgets ? { budgets: args.budgets } : {}), now: gov.nowDate(),
        }))
        const droppedIds = [...res.receipt.resident.droppedIds, ...res.receipt.triggered.droppedIds,
          ...res.receipt.retrieved.droppedIds, ...res.receipt.attention.droppedIds]
        if (droppedIds.length > 0) {
          gov.appender.append({
            id: `mem:recall:dropped:${randomUUID()}`, at: gov.nowDate().toISOString(), stream: 'memory:recall',
            type: 'memory.recall.dropped', source: { kind: 'secretary', ref: 'orchestrator_memory_recall' },
            evidence: [], taint: 'trusted', payload: { query: args.query, droppedIds, receipt: res.receipt },
          })
        }
        return stripUndefined({ text: res.text, attention: res.attentionItems, receipt: res.receipt, droppedIds })
      },
    }),
    tool({
      name: 'orchestrator_memory_propose',
      description: 'Propose or tombstone M1-M3 memory with M0 source_ref.',
      schema: ProposeSchema,
      execute: async args => {
        const env = await gov.readSpineEnvelope(args.source_ref)
        if (!env) return { kind: 'rejected', reason: 'unknown-source-ref', detail: `source_ref 未在事件脊中确认: seq=${args.source_ref.seq}` }
        if (args.mode === 'tombstone') {
          if (!args.entry_id?.trim() || !args.reason?.trim()) throw new Error('tombstone mode requires entry_id and reason')
          if (args.layer === 'm2') return { kind: 'rejected', reason: 'forbidden', detail: '禁止秘书工具对 M2 条目打墓碑' }
          const rel = resolveMemoryRelPath({ layer: args.layer, ...(args.slug ? { slug: args.slug } : {}), ...(args.workspace_key ? { workspaceKey: args.workspace_key } : {}) })
          const page = await gov.memoryRepoLock.run(() => readMemoryPage(gov.memoryDir, rel))
          const hit = page?.layer !== 'm6' ? page?.entries.find(e => e.id === args.entry_id) : undefined
          if (hit && (hit.sourceType === 'user_ruling' || hit.sourceType === 'user_direct')) {
            return { kind: 'rejected', reason: 'forbidden', detail: '禁止秘书工具对老板直述或裁决条目打墓碑' }
          }
          const res = await gov.memory.tombstone({
            target: { layer: args.layer, ...(args.slug ? { slug: args.slug } : {}), ...(args.workspace_key ? { workspaceKey: args.workspace_key } : {}) },
            entryId: args.entry_id, reason: args.reason, sourceRef: args.source_ref, author: 'secretary',
          })
          return stripUndefined({ kind: 'tombstoned', ...res })
        }
        if (!args.statement?.trim() || !args.scope?.trim()) throw new Error('propose mode requires statement and scope')
        if (args.layer === 'm2' && env.taint === 'untrusted') {
          return { kind: 'rejected', reason: 'forbidden', detail: '禁止使用 untrusted 来源事件写入 M2 记忆' }
        }
        const res = await gov.memory.propose({
          layer: args.layer, ...(args.slug ? { slug: args.slug } : {}), ...(args.workspace_key ? { workspaceKey: args.workspace_key } : {}),
          statement: args.statement, scope: args.scope as MemoryScope, sourceType: args.source_type ?? 'session', sourceRef: args.source_ref,
          author: 'secretary', taint: memoryTaintOf(env.taint), overrideTombstone: false,
          ...(args.topic_key ? { topicKey: args.topic_key } : {}), ...(args.clearance ? { clearance: args.clearance } : {}),
          ...(args.m2_kind ? { m2Kind: args.m2_kind } : {}), ...(args.resident !== undefined ? { resident: args.resident } : {}),
          ...(args.importance !== undefined ? { importance: args.importance } : {}), ...(args.verbatim_quote ? { verbatimQuote: args.verbatim_quote } : {}),
          ...(args.evidence_text ? { evidenceText: args.evidence_text } : {}), ...(args.trigger_keys ? { triggerKeys: args.trigger_keys } : {}),
        })
        return stripUndefined(res)
      },
    }),
    tool({
      name: 'orchestrator_attention_ledger',
      description: 'List or transition M6 ledger items.',
      schema: LedgerSchema,
      execute: async args => {
        const page = await gov.memoryRepoLock.run(() => readMemoryPage(gov.memoryDir, 'm6/ledger.md'))
        if (args.mode === 'list') {
          if (!page || page.layer !== 'm6') return { revision: 0, items: [] }
          return stripUndefined({ revision: page.revision, items: args.status ? page.items.filter(i => i.status === args.status) : page.items })
        }
        if (!args.id?.trim() || !args.next_status || !args.source_ref) throw new Error('transition mode requires id, next_status, and source_ref')
        const env = await gov.readSpineEnvelope(args.source_ref)
        if (!env) return { ok: false, reason: 'unknown-source-ref', detail: `source_ref 未在事件脊中确认: seq=${args.source_ref.seq}` }
        if ((args.next_status === 'approved' || args.next_status === 'dismissed') && env.type !== 'escalation.ruled') {
          return { ok: false, reason: 'ruling-source-required', detail: 'approved/dismissed 必须绑定真实 escalation.ruled 事件' }
        }
        const cur = page?.layer === 'm6' ? page.items.find(i => i.id === args.id) : undefined
        if (cur && (cur.status === 'approved' || cur.status === 'dismissed' || cur.status === 'expired')) {
          return { ok: false, reason: 'already-resolved', detail: `M6 事项 ${args.id} 已处于终态 ${cur.status}` }
        }
        const action = args.next_status === 'asked' ? 'ask' : args.next_status === 'approved' ? 'approve' : 'dismiss'
        const res = await gov.memory.transitionAttention({ id: args.id, action }, 'secretary')
        return stripUndefined({ ok: true, item: res.item, ...(res.commit ? { commit: res.commit } : {}) })
      },
    }),
    tool({
      name: 'orchestrator_deposit_author',
      description: 'Validate, replay, or shadow-install DepositDraft.',
      schema: DepositSchema,
      execute: async args => {
        const draft = normalizeDraft(args.draft), nowIso = gov.nowDate().toISOString(), draftId = draft.id.trim() || 'invalid'
        const emit = (ev: Parameters<typeof telemetryToSpineInput>[0]) => gov.appender.append(telemetryToSpineInput(ev))
        if (args.mode === 'validate') {
          const res = validateDepositDraft(draft)
          if (!res.ok && res.gate === 'machine') emit({ id: `authoring:admission_rejected:${draftId}:${randomUUID().slice(0, 8)}`, kind: 'admission_rejected', draftId, at: nowIso, actorId: 'secretary', ruleId: res.violations[0]!.ruleId, field: res.violations[0]!.field, reason: res.violations[0]!.reason })
          return stripUndefined(res)
        }
        if (args.mode === 'replay') {
          const cases: ReplayCase[] = args.cases ?? draft.cases.map((c, i) => ({
            id: c.name || `case-${i}`, family: draft.point || 'draft', input: c.ctx,
            expectedOutcome: c.expected === 'deny' ? 'defect' : c.expected === 'allow' ? 'clean' : 'unknown',
          }))
          const report = await runHistoricalReplay(buildReplayGate(gov, draft), cases)
          emit({ id: `authoring:replay_viewed:${draftId}:${randomUUID().slice(0, 8)}`, kind: 'replay_viewed', draftId, at: nowIso, actorId: 'secretary', catches: report.catches, falseBlocks: report.falseBlocks, misses: report.misses, totalCases: report.totalCases })
          return stripUndefined(report)
        }
        const check = validateDepositDraft(draft)
        if (!check.ok) {
          if (check.gate === 'machine') emit({ id: `authoring:admission_rejected:${draftId}:${randomUUID().slice(0, 8)}`, kind: 'admission_rejected', draftId, at: nowIso, actorId: 'secretary', ruleId: check.violations[0]!.ruleId, field: check.violations[0]!.field, reason: check.violations[0]!.reason })
          return stripUndefined({ installed: false, validation: check })
        }
        const shadowDraft: DepositDraft = { ...check.draft, stage: 'shadow', enforce: false }
        const written = await writeDepositDraftPackage(join(gov.stateDir, 'deposits'), shadowDraft)
        const loaded = await loadDepositPackage(written.packageDir)
        if (!loaded.admission.admitted) throw new Error(`影子包准入异常: ${loaded.admission.violations.map(v => v.reason).join('; ')}`)
        const existing = gov.registry.list().find(g => g.id === shadowDraft.id)
        if (existing && existing.stage !== 'shadow') throw new Error(`禁止影子安装包覆盖非 shadow 阶段判据: ${shadowDraft.id}`)
        let registeredInShadow = false
        if (loaded.admission.manifest.kind === 'gate' || loaded.admission.manifest.kind === 'counter-rule') {
          if (existing) gov.registry.unregister(shadowDraft.id)
          gov.registry.register({
            kind: 'gate', id: shadowDraft.id, version: shadowDraft.version, point: (loaded.admission.manifest.point ?? shadowDraft.point) as Point,
            description: shadowDraft.intent || shadowDraft.name, placement: { timing: 'pre', enforce: false },
            requires: shadowDraft.requires, gate: buildStandaloneGateFn(shadowDraft),
          } as AnyGateDef, 'shadow')
          registeredInShadow = true
        }
        emit({ id: `authoring:shadow_installed:${shadowDraft.id}:${randomUUID().slice(0, 8)}`, kind: 'shadow_installed', draftId: shadowDraft.id, version: shadowDraft.version, at: nowIso, actorId: 'secretary' })
        return stripUndefined({ installed: true, stage: 'shadow', enforce: false, registeredInShadow, ...written })
      },
    }),
  ]
}
