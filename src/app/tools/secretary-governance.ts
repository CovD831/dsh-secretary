/** 零执行秘书专属治理工具组：受控记忆召回、M0 溯源提议、M6 账本流转与沉淀作者面。 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import {
  telemetryToSpineInput, validateDepositDraft, writeDepositDraftPackage, type DepositDraft,
} from '../../authoring/index.ts'
import {
  createAdaptiveDispatchGate, createChangedPathsGate, createVerifyRerunGate,
} from '../../judgement/gates/index.ts'
import { auditRequires, type ParamSpec, type Point, type Verdict } from '../../judgement/index.ts'
import { assembleMemoryPrompt, readMemoryPage, type MemoryScope } from '../../memory/index.ts'
import { runHistoricalReplay, type ReplayCase, type ReplayGateFn } from '../../rsi/index.ts'
import type { GovernanceRuntime } from '../governance.ts'
import { tool, type Tool } from './tool.ts'

const SourceRefSchema = z.object({ seq: z.number().int().positive(), id: z.string().min(1) }).strict()
const RecallArgsSchema = z.object({
  query: z.string().default(''),
  recent_messages: z.array(z.string()).max(20).optional(),
  budgets: z.object({
    residentMaxChars: z.number().int().positive().optional(),
    triggeredMaxChars: z.number().int().positive().optional(),
    retrievedMaxChars: z.number().int().positive().optional(),
    attentionMaxChars: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict()

const ProposeArgsSchema = z.object({
  mode: z.enum(['propose', 'tombstone']).default('propose'),
  layer: z.enum(['m1', 'm2', 'm3']),
  slug: z.string().optional(),
  workspace_key: z.string().optional(),
  source_ref: SourceRefSchema,
  statement: z.string().optional(),
  scope: z.string().optional(),
  source_type: z.enum(['user_direct', 'user_ruling', 'session', 'external_doc', 'inference']).optional(),
  topic_key: z.string().optional(),
  clearance: z.enum(['public', 'workspace', 'private']).optional(),
  m2_kind: z.enum(['preference', 'veto', 'shared_event', 'internal_moniker', 'correction_repair']).optional(),
  resident: z.boolean().optional(),
  importance: z.number().min(0).max(10).optional(),
  verbatim_quote: z.string().optional(),
  evidence_text: z.string().optional(),
  trigger_keys: z.object({
    primary: z.array(z.string()),
    secondary: z.array(z.string()).optional(),
    logic: z.enum(['AND_ANY', 'AND_ALL', 'NOT_ANY', 'NOT_ALL']).optional(),
  }).strict().optional(),
  override_tombstone: z.boolean().optional(),
  invalidation_reason: z.string().optional(),
  entry_id: z.string().optional(),
  reason: z.string().optional(),
  author: z.string().optional(),
}).strict()

const LedgerArgsSchema = z.object({
  mode: z.enum(['list', 'transition']).default('list'),
  status: z.enum(['pending', 'asked', 'approved', 'dismissed', 'expired']).optional(),
  id: z.string().optional(),
  next_status: z.enum(['asked', 'approved', 'dismissed']).optional(),
  source_ref: SourceRefSchema.optional(),
  author: z.string().optional(),
}).strict()

const DepositArgsSchema = z.object({
  mode: z.enum(['validate', 'replay', 'install_shadow']),
  draft: z.record(z.string(), z.unknown()),
  cases: z.array(z.object({
    id: z.string().min(1), family: z.string().min(1), input: z.unknown(),
    expectedOutcome: z.enum(['defect', 'clean', 'unknown']),
    tokens: z.number().optional(), durationMs: z.number().optional(),
  }).strict()).optional(),
}).strict()

const stripUndefined = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function extractDefaultParams(specs: Readonly<Record<string, ParamSpec>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, spec] of Object.entries(specs ?? {})) {
    if (spec && typeof spec === 'object' && 'default' in spec && spec.default !== undefined) out[k] = spec.default
  }
  return out
}

function buildReplayGate(gov: GovernanceRuntime, draft: DepositDraft): ReplayGateFn<unknown> {
  const bound = extractDefaultParams(draft.params)
  if (draft.id === 'verify.changed-paths') return ctx => createChangedPathsGate(bound).gate(ctx as never)
  if (draft.id === 'verify.rerun') return ctx => createVerifyRerunGate(bound).gate(ctx as never)
  if (draft.id === 'ticket.adaptive-dispatch') return ctx => createAdaptiveDispatchGate(bound).gate(ctx as never)
  if (gov.registry.list().some(g => g.kind === 'gate' && g.id === draft.id)) {
    return async (ctx): Promise<Verdict> => {
      const ev = await gov.registry.evaluate(draft.point as Point, ctx as never)
      const hit = [...ev.ran, ...ev.observed].find(r => r.id === draft.id)
      if (!hit) return ev.verdict
      if (hit.outcome === 'allow' || hit.outcome === 'skipped') return { kind: 'allow' }
      if (hit.outcome === 'deny') return { kind: 'deny', blockers: [hit.detail || 'denied'] }
      return { kind: 'unmeasured', cause: 'no-evidence', detail: hit.detail || 'unmeasured' }
    }
  }
  return (ctx): Verdict => {
    const audit = auditRequires(ctx, draft.requires ?? [])
    return audit.ok
      ? { kind: 'unmeasured', cause: 'no-evidence', detail: `草稿 "${draft.id}" 尚未绑定已注册判据实现` }
      : { kind: 'unmeasured', cause: 'missing-input', detail: `缺少必需输入路径: ${audit.missing.join(', ')}` }
  }
}

/** 构造挂入秘书主会话的 4 个结构化治理工具（不暴露任何文件或 shell 执行能力）。 */
export function secretaryGovernanceTools(gov: GovernanceRuntime): Tool[] {
  return [
    tool({
      name: 'orchestrator_memory_recall',
      description: 'Recall secretary memory and M6 attention.',
      schema: z.object({ query: z.string().default('') }).loose(),
      execute: async raw => {
        const args = RecallArgsSchema.parse(raw)
        const res = await assembleMemoryPrompt({
          dir: gov.memoryDir, caller: { role: 'secretary', maxClearance: 'private' }, query: args.query,
          ...(args.recent_messages ? { recentMessages: args.recent_messages } : {}),
          ...(args.budgets ? { budgets: args.budgets } : {}), now: gov.nowDate(),
        })
        const droppedIds = [
          ...res.receipt.resident.droppedIds, ...res.receipt.triggered.droppedIds,
          ...res.receipt.retrieved.droppedIds, ...res.receipt.attention.droppedIds,
        ]
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
      schema: z.object({ layer: z.enum(['m1', 'm2', 'm3']), source_ref: z.unknown() }).loose(),
      execute: async raw => {
        const args = ProposeArgsSchema.parse(raw)
        if (args.mode === 'tombstone') {
          if (!args.entry_id?.trim() || !args.reason?.trim()) throw new Error('tombstone mode requires entry_id and reason')
          const res = await gov.memory.tombstone({
            target: { layer: args.layer, ...(args.slug ? { slug: args.slug } : {}), ...(args.workspace_key ? { workspaceKey: args.workspace_key } : {}) },
            entryId: args.entry_id, reason: args.reason, sourceRef: args.source_ref, author: args.author ?? 'secretary',
          })
          return stripUndefined({ kind: 'tombstoned', ...res })
        }
        if (!args.statement?.trim() || !args.scope?.trim() || !args.source_type) {
          throw new Error('propose mode requires statement, scope, and source_type')
        }
        const res = await gov.memory.propose({
          layer: args.layer, ...(args.slug ? { slug: args.slug } : {}), ...(args.workspace_key ? { workspaceKey: args.workspace_key } : {}),
          statement: args.statement, scope: args.scope as MemoryScope, sourceType: args.source_type, sourceRef: args.source_ref,
          author: args.author ?? 'secretary', ...(args.topic_key ? { topicKey: args.topic_key } : {}),
          ...(args.clearance ? { clearance: args.clearance } : {}), ...(args.m2_kind ? { m2Kind: args.m2_kind } : {}),
          ...(args.resident !== undefined ? { resident: args.resident } : {}), ...(args.importance !== undefined ? { importance: args.importance } : {}),
          ...(args.verbatim_quote ? { verbatimQuote: args.verbatim_quote } : {}), ...(args.evidence_text ? { evidenceText: args.evidence_text } : {}),
          ...(args.trigger_keys ? { triggerKeys: args.trigger_keys } : {}),
          ...(args.override_tombstone !== undefined ? { overrideTombstone: args.override_tombstone } : {}),
          ...(args.invalidation_reason ? { invalidationReason: args.invalidation_reason } : {}),
        })
        return stripUndefined(res)
      },
    }),
    tool({
      name: 'orchestrator_attention_ledger',
      description: 'List or transition M6 ledger items.',
      schema: z.object({ mode: z.enum(['list', 'transition']).default('list') }).loose(),
      execute: async raw => {
        const args = LedgerArgsSchema.parse(raw)
        if (args.mode === 'list') {
          const page = await gov.memoryRepoLock.run(() => readMemoryPage(gov.memoryDir, 'm6/ledger.md'))
          if (!page || page.layer !== 'm6') return { revision: 0, items: [] }
          const items = args.status ? page.items.filter(i => i.status === args.status) : page.items
          return stripUndefined({ revision: page.revision, items })
        }
        if (!args.id?.trim() || !args.next_status || !args.source_ref) {
          throw new Error('transition mode requires id, next_status, and source_ref')
        }
        if (!(await gov.resolveSpineRef(args.source_ref))) {
          return { ok: false, reason: 'unknown-source-ref', detail: `source_ref 未在事件脊中确认: seq=${args.source_ref.seq}` }
        }
        const action = args.next_status === 'asked' ? 'ask' : args.next_status === 'approved' ? 'approve' : 'dismiss'
        const res = await gov.memory.transitionAttention({ id: args.id, action }, args.author ?? 'secretary')
        return stripUndefined({ ok: true, item: res.item, ...(res.commit ? { commit: res.commit } : {}) })
      },
    }),
    tool({
      name: 'orchestrator_deposit_author',
      description: 'Validate, replay, or shadow-install DepositDraft.',
      schema: z.object({ mode: z.enum(['validate', 'replay', 'install_shadow']), draft: z.unknown() }).loose(),
      execute: async raw => {
        const args = DepositArgsSchema.parse(raw)
        const draft = args.draft as unknown as DepositDraft
        const nowIso = gov.nowDate().toISOString()
        const draftId = typeof draft.id === 'string' && draft.id.trim() ? draft.id : 'invalid'
        const actorId = typeof draft.author === 'string' && draft.author.trim() ? draft.author : 'secretary'
        if (args.mode === 'validate') {
          const res = validateDepositDraft(draft)
          if (!res.ok && res.gate === 'machine') {
            gov.appender.append(telemetryToSpineInput({
              id: `authoring:admission_rejected:${draftId}:${randomUUID().slice(0, 8)}`,
              kind: 'admission_rejected', draftId, at: nowIso, actorId,
              ruleId: res.violations[0]!.ruleId, field: res.violations[0]!.field, reason: res.violations[0]!.reason,
            }))
          }
          return stripUndefined(res)
        }
        if (args.mode === 'replay') {
          const cases: ReplayCase[] = args.cases ?? (Array.isArray(draft.cases) ? draft.cases.map((c, i) => ({
            id: c.name || `case-${i}`, family: draft.point || 'draft', input: c.ctx,
            expectedOutcome: c.expected === 'deny' ? 'defect' : c.expected === 'allow' ? 'clean' : 'unknown',
          })) : [])
          const report = await runHistoricalReplay(buildReplayGate(gov, draft), cases)
          gov.appender.append(telemetryToSpineInput({
            id: `authoring:replay_viewed:${draftId}:${randomUUID().slice(0, 8)}`,
            kind: 'replay_viewed', draftId, at: nowIso, actorId,
            catches: report.catches, falseBlocks: report.falseBlocks, misses: report.misses, totalCases: report.totalCases,
          }))
          return stripUndefined(report)
        }
        const check = validateDepositDraft(draft)
        if (!check.ok) {
          if (check.gate === 'machine') {
            gov.appender.append(telemetryToSpineInput({
              id: `authoring:admission_rejected:${draftId}:${randomUUID().slice(0, 8)}`,
              kind: 'admission_rejected', draftId, at: nowIso, actorId,
              ruleId: check.violations[0]!.ruleId, field: check.violations[0]!.field, reason: check.violations[0]!.reason,
            }))
          }
          return stripUndefined({ installed: false, validation: check })
        }
        const shadowDraft: DepositDraft = { ...check.draft, stage: 'shadow', enforce: false }
        const written = await writeDepositDraftPackage(join(gov.stateDir, 'deposits'), shadowDraft)
        gov.appender.append(telemetryToSpineInput({
          id: `authoring:shadow_installed:${shadowDraft.id}:${randomUUID().slice(0, 8)}`,
          kind: 'shadow_installed', draftId: shadowDraft.id, version: shadowDraft.version, at: nowIso, actorId,
        }))
        return stripUndefined({ installed: true, stage: 'shadow', enforce: false, ...written })
      },
    }),
  ]
}
