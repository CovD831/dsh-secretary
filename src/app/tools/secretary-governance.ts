/** 零执行秘书专属治理工具组：受控记忆召回、M0 溯源提议、M6 账本流转与沉淀作者面。 */
import { randomUUID } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { telemetryToSpineInput, validateDepositDraft, writeDepositDraftPackage, type DepositDraft } from '../../authoring/index.ts'
import { createAdaptiveDispatchGate, createChangedPathsGate, createVerifyRerunGate } from '../../judgement/gates/index.ts'
import {
  RESERVED_BUILTIN_DEPOSIT_IDS, auditRequires, compileDeclarativeEntry, evaluateCompiledEntry, loadDepositPackage, parseDepositMarkdown,
  runDepositCases, validateDeclarativeRule, type AnyGateDef, type DeclarativeRule, type DepositManifest, type MandateBinding,
  type ParamSpec, type Point, type Verdict,
} from '../../judgement/index.ts'
import { assembleMemoryPrompt, memoryTaintOf, readMemoryPage, resolveMemoryRelPath, type MemoryScope } from '../../memory/index.ts'
import { readM0Events, runHistoricalReplay, type ReplayCase, type ReplayGateFn } from '../../rsi/index.ts'
import { redactValue } from '../../spine/redact.ts'
import type { SourceRef, SpineEnvelope } from '../../spine/index.ts'
import { listDepositDrafts } from '../governance-drafts.ts'
import type { GovernanceRuntime } from '../governance.ts'
import { DepositSchema, LedgerSchema, ProposeSchema, RecallSchema, ruleCtxHint, type RawDraft } from './secretary-governance-schemas.ts'
import { tool, type Tool } from './tool.ts'

const BUILTIN_EXECUTABLE_IDS = new Set(['ticket.adaptive-dispatch', 'verify.changed-paths', 'verify.rerun'])
const stripUndefined = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function normalizeMemoryScope(layer: 'm1' | 'm2' | 'm3', rawScope?: string, workspaceKey?: string): MemoryScope {
  const trimmed = rawScope?.trim()
  if (trimmed === 'global' || trimmed?.startsWith('person:') || trimmed?.startsWith('workspace:')) return trimmed as MemoryScope
  if (layer === 'm3' && workspaceKey?.trim()) return `workspace:${workspaceKey.trim()}`
  if (trimmed === 'boss') return 'person:boss'
  return 'global'
}

async function resolveTriggerSpineEnvelope(
  gov: GovernanceRuntime,
  triggerId: string,
): Promise<{ ref: SourceRef; env: SpineEnvelope<Record<string, unknown>> } | undefined> {
  if (gov.storeRef?.db) {
    try {
      const rows = gov.storeRef.db.prepare("SELECT value FROM event_spine WHERE type = 'trigger.received' ORDER BY seq DESC LIMIT 200").all() as { value?: string }[]
      for (const row of rows) {
        if (!row.value) continue
        const env = JSON.parse(row.value) as SpineEnvelope<Record<string, unknown>>
        if (env.payload?.['triggerId'] === triggerId) return { ref: { seq: env.seq, id: env.id }, env }
      }
    } catch { /* fall through to M0 shard scan */ }
  }
  const events = await readM0Events({ db: gov.storeRef?.db, memoryDir: gov.memoryDir }).catch(() => [])
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!
    if (ev.type === 'trigger.received' && (ev.payload as Record<string, unknown> | undefined)?.['triggerId'] === triggerId) {
      return { ref: { seq: ev.seq, id: ev.id }, env: ev as SpineEnvelope<Record<string, unknown>> }
    }
  }
  return undefined
}

function normalizeDraft(raw: RawDraft): DepositDraft {
  const cases = (raw.cases ?? []).map(c => {
    if (c.expected === 'unmeasured') return c
    const { expectedCause: _drop, ...rest } = c
    return rest
  }) as DepositDraft['cases']
  return {
    id: raw.id, name: raw.name ?? raw.id, version: raw.version ?? 1, author: 'secretary',
    scope: (raw.scope as DepositDraft['scope']) ?? 'private', kind: raw.kind ?? 'gate', level: raw.level ?? 'object',
    point: raw.point ?? 'verify.preflight',
    trigger: { on: raw.trigger?.on ?? 'completion.claimed', mode: raw.trigger?.mode ?? 'on-event',
      ...(raw.trigger?.workspace ? { workspace: raw.trigger.workspace } : {}),
      ...(raw.trigger?.globs ? { globs: raw.trigger.globs } : {}), ...(raw.trigger?.signal ? { signal: raw.trigger.signal } : {}) },
    requires: raw.requires ?? [], params: (raw.params ?? {}) as DepositDraft['params'], exceptions: raw.exceptions ?? [],
    repairHint: raw.repairHint ?? '', intent: raw.intent ?? '', rubricBody: raw.rubricBody ?? '',
    actionClass: raw.actionClass ?? 'observe', origin: raw.origin ?? { kind: 'user-authored' }, cases,
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

function draftToManifest(draft: DepositDraft, raw?: RawDraft): DepositManifest {
  const rawScope: string = raw?.scope ?? draft.scope
  const trust = rawScope === 'public' ? 'public' : rawScope === 'shared' ? 'collaborator' : 'owner'
  return {
    id: draft.id, version: draft.version, kind: draft.kind, trust, cases: 'cases/',
    prose: `## 意图\n${draft.intent}\n\n## 判据\n${draft.rubricBody}`,
    params: draft.params, requires: draft.requires,
    ...(draft.kind === 'gate' || draft.kind === 'counter-rule' ? { point: draft.point as Point } : {}),
    ...(draft.stage ? { stage: draft.stage } : {}), ...(draft.enforce !== undefined ? { enforce: draft.enforce } : {}),
    actionClass: draft.actionClass, ...(draft.action ? { action: draft.action } : {}),
    ...(draft.trigger?.signal ? { trigger: { signal: draft.trigger.signal as never, ...(raw?.trigger?.match ? { match: raw.trigger.match } : {}) } } : {}),
    ...(raw?.measures ? { measures: raw.measures } : {}), ...(raw?.mandate ? { mandate: raw.mandate as MandateBinding } : {}),
    ...(raw?.rule ? { rule: raw.rule as unknown as DeclarativeRule } : {}),
  }
}

function buildStandaloneGateFn(draft: DepositDraft, raw?: RawDraft): (ctx: unknown) => Verdict | Promise<Verdict> {
  const bound = extractDefaultParams(draft.params)
  if (draft.id === 'verify.changed-paths') return ctx => createChangedPathsGate(bound).gate(ctx as never)
  if (draft.id === 'verify.rerun') return ctx => createVerifyRerunGate(bound).gate(ctx as never)
  if (draft.id === 'ticket.adaptive-dispatch') return ctx => createAdaptiveDispatchGate(bound).gate(ctx as never)
  if (raw?.rule !== undefined) {
    const entry = compileDeclarativeEntry(draftToManifest(draft, raw), bound)
    return ctx => evaluateCompiledEntry(entry, ctx)
  }
  return ctx => {
    const audit = auditRequires(ctx, draft.requires)
    return audit.ok
      ? { kind: 'unmeasured', cause: 'no-evidence', detail: `草稿 "${draft.id}" 尚未绑定已注册判据实现` }
      : { kind: 'unmeasured', cause: 'missing-input', detail: `缺少必需输入路径: ${audit.missing.join(', ')}` }
  }
}

function buildReplayGate(gov: GovernanceRuntime, draft: DepositDraft, raw?: RawDraft): ReplayGateFn<unknown> {
  if (draft.id === 'verify.changed-paths' || draft.id === 'verify.rerun' || draft.id === 'ticket.adaptive-dispatch' || raw?.rule !== undefined) return buildStandaloneGateFn(draft, raw)
  if (gov.registry.list().some(g => g.kind === 'gate' && g.id === draft.id)) {
    return async (ctx): Promise<Verdict> => {
      const ev = await gov.registry.evaluate(draft.point as Point, ctx as never), hit = [...ev.ran, ...ev.observed].find(r => r.id === draft.id)
      if (!hit) return { kind: 'unmeasured', cause: 'no-evidence', detail: `判据 "${draft.id}" 未产生执行记录` }
      return hit.outcome === 'allow' ? { kind: 'allow' } : hit.outcome === 'deny' ? { kind: 'deny', blockers: [hit.detail || 'denied'] }
        : hit.outcome === 'skipped' ? { kind: 'unmeasured', cause: 'all-skipped', detail: hit.detail || '判据条件不适用被跳过' } : { kind: 'unmeasured', cause: 'no-evidence', detail: hit.detail || 'unmeasured' }
    }
  }
  return buildStandaloneGateFn(draft, raw)
}

async function checkDeclarativeDraft(draft: DepositDraft, raw: RawDraft) {
  if (raw.rule === undefined) {
    if ((draft.kind === 'gate' || draft.kind === 'counter-rule' || draft.kind === 'evaluator') && !BUILTIN_EXECUTABLE_IDS.has(draft.id)) {
      return [{
        ruleId: 'missing-declarative-rule', field: 'rule',
        reason: `自定义 ${draft.kind} "${draft.id}" 缺少声明式 rule 配置`,
        repairHint: '请提供声明式 rule，例如命令检查: { "kind": "command_check", "requiredCommands": ["tsc --noEmit"] }，对应正反例 ctx 形如 { "commands": [{ "command": "tsc --noEmit", "exitCode": 0 }] } 与 exitCode: 1',
      }]
    }
    return []
  }
  const ruleIssues = validateDeclarativeRule(raw.rule).map(i => ({ ruleId: 'invalid-declarative-rule', field: i.field, reason: i.reason, repairHint: '修正零代码声明式 rule 配置' }))
  if (redactValue(raw.rule).redacted.length > 0) ruleIssues.push({ ruleId: 'secret-in-deposit', field: 'rule', reason: 'rule 配置疑似包含密钥或敏感字段', repairHint: '移除敏感字符串后再提交' })
  if (ruleIssues.length > 0) return ruleIssues
  try {
    const compiled = compileDeclarativeEntry(draftToManifest(draft, raw), extractDefaultParams(draft.params))
    if (draft.cases.length > 0) {
      const report = await runDepositCases(compiled, draft.cases)
      if (!report.ok || !report.mutationPassed) {
        ruleIssues.push({
          ruleId: 'case-check-failed', field: 'cases',
          reason: report.error ?? `红绿或变异用例未通过 (${report.passed}/${report.total} passed, mutationPassed=${report.mutationPassed})`,
          repairHint: ruleCtxHint(raw.rule['kind']),
        })
      }
    }
  } catch (err) {
    ruleIssues.push({ ruleId: 'declarative-compile-failed', field: 'rule', reason: err instanceof Error ? err.message : String(err), repairHint: '核对 kind、trigger.signal、action.name 与 rule 配置' })
  }
  return ruleIssues
}

async function mergeManifestExtras(depositMdPath: string, raw: RawDraft): Promise<void> {
  if (raw.rule === undefined && !raw.measures && !raw.mandate && !raw.trigger?.match) return
  if ((await lstat(depositMdPath)).isSymbolicLink()) throw new Error(`拒绝修改符号链接文件: ${depositMdPath}`)
  const parsed = parseDepositMarkdown(await readFile(depositMdPath, 'utf8')), m: Record<string, unknown> = { ...parsed.rawManifest }
  if (raw.rule !== undefined) m['rule'] = raw.rule
  if (raw.measures) m['measures'] = raw.measures
  if (raw.mandate) m['mandate'] = raw.mandate
  if (raw.trigger?.match && m['trigger'] && typeof m['trigger'] === 'object') m['trigger'] = { ...(m['trigger'] as Record<string, unknown>), match: raw.trigger.match }
  await writeFile(depositMdPath, `---\n${JSON.stringify(m, null, 2)}\n---\n\n${parsed.prose}\n`, 'utf8')
}

/** 构造挂入秘书主会话的 4 个结构化治理工具（零文件/shell 执行权且禁自称老板权威）。 */
export function secretaryGovernanceTools(gov: GovernanceRuntime): Tool[] {
  return [
    tool({
      name: 'orchestrator_memory_recall', description: 'Recall secretary memory and M6 attention.', schema: RecallSchema,
      execute: async args => {
        const res = await gov.memoryRepoLock.run(() => assembleMemoryPrompt({
          dir: gov.memoryDir, caller: { role: 'secretary', maxClearance: 'private' }, query: args.query, ftsIndex: gov.ftsIndex,
          ...(args.recent_messages ? { recentMessages: args.recent_messages } : {}), ...(args.budgets ? { budgets: args.budgets } : {}), now: gov.nowDate(),
        }))
        const droppedIds = [...res.receipt.resident.droppedIds, ...res.receipt.triggered.droppedIds, ...res.receipt.retrieved.droppedIds, ...res.receipt.attention.droppedIds]
        if (droppedIds.length > 0) {
          gov.appender.append({ id: `mem:recall:dropped:${randomUUID()}`, at: gov.nowDate().toISOString(), stream: 'memory:recall',
            type: 'memory.recall.dropped', source: { kind: 'secretary', ref: 'orchestrator_memory_recall' }, evidence: [], taint: 'trusted', payload: { query: args.query, droppedIds, receipt: res.receipt } })
        }
        return stripUndefined({ text: res.text, attention: res.attentionItems, receipt: res.receipt, droppedIds })
      },
    }),
    tool({
      name: 'orchestrator_memory_propose', description: 'Propose or tombstone M1-M3 memory with M0 source_ref.', schema: ProposeSchema,
      execute: async args => {
        let sourceRef = args.source_ref
        let env = sourceRef ? await gov.readSpineEnvelope(sourceRef) : undefined
        if (!env && args.trigger_id) {
          const resolved = await resolveTriggerSpineEnvelope(gov, args.trigger_id)
          if (resolved) { sourceRef = resolved.ref; env = resolved.env }
        }
        if (!env || !sourceRef) {
          return { kind: 'rejected', reason: 'unknown-source-ref',
            detail: args.trigger_id ? `未在 M0 事件脊中找到 trigger_id=${args.trigger_id} 对应的 trigger.received` : `source_ref 未在事件脊中确认: seq=${args.source_ref?.seq ?? 'missing'}` }
        }
        if (args.mode === 'tombstone') {
          if (!args.entry_id?.trim() || !args.reason?.trim()) throw new Error('tombstone mode requires entry_id and reason')
          if (args.layer === 'm2') return { kind: 'rejected', reason: 'forbidden', detail: '禁止秘书工具对 M2 条目打墓碑' }
          const rel = resolveMemoryRelPath({ layer: args.layer, ...(args.slug ? { slug: args.slug } : {}), ...(args.workspace_key ? { workspaceKey: args.workspace_key } : {}) })
          const page = await gov.memoryRepoLock.run(() => readMemoryPage(gov.memoryDir, rel)), hit = page?.layer !== 'm6' ? page?.entries.find(e => e.id === args.entry_id) : undefined
          if (hit && (hit.sourceType === 'user_ruling' || hit.sourceType === 'user_direct')) return { kind: 'rejected', reason: 'forbidden', detail: '禁止秘书工具对老板直述或裁决条目打墓碑' }
          const tombRes = await gov.memory.tombstone({ target: { layer: args.layer, ...(args.slug ? { slug: args.slug } : {}), ...(args.workspace_key ? { workspaceKey: args.workspace_key } : {}) }, entryId: args.entry_id, reason: args.reason, sourceRef, author: 'secretary' })
          await gov.ftsIndex.rebuild().catch(() => undefined)
          return stripUndefined({ kind: 'tombstoned', ...tombRes })
        }
        if (!args.statement?.trim()) throw new Error('propose mode requires statement')
        if (args.layer === 'm2' && env.taint === 'untrusted') return { kind: 'rejected', reason: 'forbidden', detail: '禁止使用 untrusted 来源事件写入 M2 记忆' }
        const resolvedScope = normalizeMemoryScope(args.layer, args.scope, args.workspace_key)
        const propRes = await gov.memory.propose({
          layer: args.layer, ...(args.slug ? { slug: args.slug } : {}), ...(args.workspace_key ? { workspaceKey: args.workspace_key } : {}),
          statement: args.statement, scope: resolvedScope, sourceType: args.source_type ?? 'session', sourceRef, author: 'secretary',
          taint: memoryTaintOf(env.taint), overrideTombstone: false, ...(args.topic_key ? { topicKey: args.topic_key } : {}), ...(args.clearance ? { clearance: args.clearance } : {}),
          ...(args.m2_kind ? { m2Kind: args.m2_kind } : {}), ...(args.resident !== undefined ? { resident: args.resident } : {}), ...(args.importance !== undefined ? { importance: args.importance } : {}),
          ...(args.verbatim_quote ? { verbatimQuote: args.verbatim_quote } : {}), ...(args.evidence_text ? { evidenceText: args.evidence_text } : {}), ...(args.trigger_keys ? { triggerKeys: args.trigger_keys } : {}),
        })
        if (propRes.kind === 'accepted') await gov.ftsIndex.rebuild().catch(() => undefined)
        return stripUndefined(propRes)
      },
    }),
    tool({
      name: 'orchestrator_attention_ledger', description: 'List or transition M6 ledger items.', schema: LedgerSchema,
      execute: async args => {
        const page = await gov.memoryRepoLock.run(() => readMemoryPage(gov.memoryDir, 'm6/ledger.md'))
        if (args.mode === 'list') return !page || page.layer !== 'm6' ? { revision: 0, items: [] } : stripUndefined({ revision: page.revision, items: args.status ? page.items.filter(i => i.status === args.status) : page.items })
        if (!args.id?.trim() || !args.next_status || !args.source_ref) throw new Error('transition mode requires id, next_status, and source_ref')
        const env = await gov.readSpineEnvelope(args.source_ref)
        if (!env) return { ok: false, reason: 'unknown-source-ref', detail: `source_ref 未在事件脊中确认: seq=${args.source_ref.seq}` }
        if ((args.next_status === 'approved' || args.next_status === 'dismissed') && env.type !== 'escalation.ruled') return { ok: false, reason: 'ruling-source-required', detail: 'approved/dismissed 必须绑定真实 escalation.ruled 事件' }
        const cur = page?.layer === 'm6' ? page.items.find(i => i.id === args.id) : undefined
        if (cur && (cur.status === 'approved' || cur.status === 'dismissed' || cur.status === 'expired')) return { ok: false, reason: 'already-resolved', detail: `M6 事项 ${args.id} 已处于终态 ${cur.status}` }
        const res = await gov.memory.transitionAttention({ id: args.id, action: args.next_status === 'asked' ? 'ask' : args.next_status === 'approved' ? 'approve' : 'dismiss' }, 'secretary')
        return stripUndefined({ ok: true, item: res.item, ...(res.commit ? { commit: res.commit } : {}) })
      },
    }),
    tool({
      name: 'orchestrator_deposit_author',
      description: 'Validate, replay, or shadow-install DepositDraft.',
      schema: DepositSchema,
      execute: async args => {
        if (args.mode === 'list_drafts') {
          const drafts = await listDepositDrafts(gov, { includeOnlineCandidates: args.include_online_candidates ?? true })
          return stripUndefined({ drafts })
        }
        if (!args.draft) throw new Error(`${args.mode} mode requires draft`)
        const draft = normalizeDraft(args.draft), nowIso = gov.nowDate().toISOString(), draftId = draft.id.trim() || 'invalid'
        const emit = (ev: Parameters<typeof telemetryToSpineInput>[0]) => gov.appender.append(telemetryToSpineInput(ev))
        if (args.mode === 'validate') {
          const res = validateDepositDraft(draft)
          const ruleIssues = await checkDeclarativeDraft(draft, args.draft)
          if (res.ok && ruleIssues.length > 0) {
            emit({ id: `authoring:admission_rejected:${draftId}:${randomUUID().slice(0, 8)}`, kind: 'admission_rejected', draftId, at: nowIso, actorId: 'secretary', ruleId: ruleIssues[0]!.ruleId, field: ruleIssues[0]!.field, reason: ruleIssues[0]!.reason })
            return stripUndefined({ ok: false, gate: 'machine', draft, violations: ruleIssues })
          }
          if (!res.ok && res.gate === 'machine') emit({ id: `authoring:admission_rejected:${draftId}:${randomUUID().slice(0, 8)}`, kind: 'admission_rejected', draftId, at: nowIso, actorId: 'secretary', ruleId: res.violations[0]!.ruleId, field: res.violations[0]!.field, reason: res.violations[0]!.reason })
          return stripUndefined(res)
        }
        if (args.mode === 'replay') {
          const cases: ReplayCase[] = args.cases ?? draft.cases.map((c, i) => ({
            id: c.name || `case-${i}`, family: draft.point || 'draft', input: c.ctx,
            expectedOutcome: c.expected === 'deny' ? 'defect' : c.expected === 'allow' ? 'clean' : 'unknown',
          }))
          const report = await runHistoricalReplay(buildReplayGate(gov, draft, args.draft), cases)
          emit({ id: `authoring:replay_viewed:${draftId}:${randomUUID().slice(0, 8)}`, kind: 'replay_viewed', draftId, at: nowIso, actorId: 'secretary', catches: report.catches, falseBlocks: report.falseBlocks, misses: report.misses, totalCases: report.totalCases })
          return stripUndefined(report)
        }
        const check = validateDepositDraft(draft), ruleIssues = await checkDeclarativeDraft(draft, args.draft)
        if (!check.ok || ruleIssues.length > 0) {
          const v = !check.ok && check.gate === 'machine' ? check.violations[0]! : ruleIssues[0]
          if (v) emit({ id: `authoring:admission_rejected:${draftId}:${randomUUID().slice(0, 8)}`, kind: 'admission_rejected', draftId, at: nowIso, actorId: 'secretary', ruleId: v.ruleId, field: v.field, reason: v.reason })
          return stripUndefined({ installed: false, validation: check.ok ? { ok: false, gate: 'machine', draft, violations: ruleIssues } : check })
        }
        const shadowDraft: DepositDraft = { ...check.draft, stage: 'shadow', enforce: false }
        const existing = gov.registry.list().find(g => g.id === shadowDraft.id)
        if (RESERVED_BUILTIN_DEPOSIT_IDS.has(shadowDraft.id) || (existing && existing.stage !== 'shadow')) {
          throw new Error(`禁止影子安装包覆盖内置保留或非 shadow 阶段判据: ${shadowDraft.id}`)
        }
        const written = await writeDepositDraftPackage(join(gov.stateDir, 'deposits'), shadowDraft)
        await mergeManifestExtras(written.depositMdPath, args.draft)
        const loaded = await loadDepositPackage(written.packageDir)
        if (!loaded.admission.admitted) throw new Error(`影子包准入异常: ${loaded.admission.violations.map(v => v.reason).join('; ')}`)
        let registeredInShadow = false
        const m = loaded.admission.manifest
        if (m.rule || m.kind === 'standing-order') {
          if (existing) gov.registry.unregister(shadowDraft.id)
          gov.registry.register(compileDeclarativeEntry({ ...m, stage: 'shadow', enforce: false, ...(m.kind === 'gate' || m.kind === 'counter-rule' ? { placement: { timing: 'pre', enforce: false } } : {}) }), 'shadow')
          registeredInShadow = true
        } else if (m.kind === 'gate' || m.kind === 'counter-rule') {
          if (existing) gov.registry.unregister(shadowDraft.id)
          gov.registry.register({
            kind: 'gate', id: shadowDraft.id, version: shadowDraft.version, point: (m.point ?? shadowDraft.point) as Point,
            description: shadowDraft.intent || shadowDraft.name, placement: { timing: 'pre', enforce: false },
            requires: shadowDraft.requires, gate: buildStandaloneGateFn(shadowDraft, args.draft),
          } as AnyGateDef, 'shadow')
          registeredInShadow = true
        }
        emit({ id: `authoring:shadow_installed:${shadowDraft.id}:${randomUUID().slice(0, 8)}`, kind: 'shadow_installed', draftId: shadowDraft.id, version: shadowDraft.version, at: nowIso, actorId: 'secretary' })
        return stripUndefined({ installed: true, stage: 'shadow', enforce: false, registeredInShadow, ...written })
      },
    }),
  ]
}
