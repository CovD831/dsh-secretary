/** 作者面漏斗：响亮机器门、代修草稿、四分法分流、记忆提案转换与脱敏遥测入脊。 */
import { isValidScopeStage } from '../judgement/registry.ts'
import { BASE_SCOPES, type ParamSpec } from '../judgement/types.ts'
import { redactValue } from '../spine/redact.ts'
import type {
  AuthoringMemoryProposal,
  AuthoringTelemetryEvent,
  DepositDraft,
  DraftValidationResult,
  EscalationRouteResult,
  EscalationRuling,
  MachineGateViolation,
  MemoryProposalContext,
  SpineInput,
} from './types.ts'

const KNOWN_SCOPES = new Set<string>(BASE_SCOPES)
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const ALLOWED_COUNTER_ACTION_RE = /^(?:proposal|defect|rule-defect)\.[a-z0-9-]+$/

function isBadRequiresPath(path: string): boolean {
  const trimmed = path.trim()
  return trimmed === '' || trimmed.includes('..') || trimmed.startsWith('.') || trimmed.endsWith('.') || /\s/.test(trimmed)
}

function isValidParamSpec(spec: unknown): spec is ParamSpec {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return false
  const s = spec as Record<string, unknown>
  if (s['type'] === 'number') {
    const { default: def, min, max } = s
    if (def !== undefined && (typeof def !== 'number' || !Number.isFinite(def))) return false
    if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) return false
    if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) return false
    if (typeof min === 'number' && typeof max === 'number' && min > max) return false
    if (typeof def === 'number' && ((typeof min === 'number' && def < min) || (typeof max === 'number' && def > max))) return false
    return true
  }
  if (s['type'] === 'string') return s['default'] === undefined || typeof s['default'] === 'string'
  if (s['type'] === 'boolean') return s['default'] === undefined || typeof s['default'] === 'boolean'
  if (s['type'] === 'enum' && Array.isArray(s['values']) && s['values'].length > 0 && s['values'].every(v => typeof v === 'string' && v.trim() !== '')) {
    return s['default'] === undefined || (typeof s['default'] === 'string' && s['values'].includes(s['default']))
  }
  return false
}

function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128)
  return cleaned || fallback
}

/** 严格区分机器门（即时硬拒+代修草稿）与证据门（非拒绝，只提示样本不足）。 */
export function validateDepositDraft(draft: DepositDraft): DraftValidationResult {
  const violations: MachineGateViolation[] = []
  let repaired: DepositDraft = { ...draft, requires: [...draft.requires], params: { ...draft.params } }

  if (typeof draft.id !== 'string' || !SAFE_ID_RE.test(draft.id) || draft.id.includes('..')) {
    violations.push({ ruleId: 'invalid-id', field: 'id', reason: '沉淀包 id 缺失或含非法路径字符', repairHint: '使用字母数字与 ._- 组成的非空唯一 id（不含 ..）' })
    repaired = { ...repaired, id: 'draft.unnamed-rule' }
  }
  if (typeof draft.version !== 'number' || !Number.isFinite(draft.version) || draft.version <= 0) {
    violations.push({ ruleId: 'invalid-version', field: 'version', reason: 'version 必须为大于 0 的有限数字', repairHint: '设置 version: 1' })
    repaired = { ...repaired, version: 1 }
  }
  if (!isValidScopeStage(draft.point, KNOWN_SCOPES)) {
    violations.push({ ruleId: 'invalid-point', field: 'point', reason: `挂载点 "${String(draft.point)}" 非法`, repairHint: `使用合法 <scope>.<stage>（scope 属 ${BASE_SCOPES.join('/')}）` })
    repaired = { ...repaired, point: 'verify.preflight' }
  }
  if (typeof draft.intent !== 'string' || draft.intent.trim() === '') {
    violations.push({ ruleId: 'missing-intent', field: 'intent', reason: '必填字段 intent 缺失或为空', repairHint: '用一句话写明这条规则防住或保证什么' })
    repaired = { ...repaired, intent: draft.name?.trim() || '待补充规则意图' }
  }
  const badReqs = draft.requires.filter(isBadRequiresPath)
  if (badReqs.length > 0) {
    violations.push({ ruleId: 'invalid-requires', field: 'requires', reason: `requires 存在空路径或非法 "..": ${badReqs.join(', ')}`, repairHint: '移除空字符串或 ".." 路径，仅声明合法点分路径' })
    repaired = { ...repaired, requires: draft.requires.filter(r => !isBadRequiresPath(r)) }
  }
  const validParams: Record<string, ParamSpec> = {}
  for (const [k, v] of Object.entries(draft.params)) {
    if (!isValidParamSpec(v)) {
      violations.push({ ruleId: 'invalid-param-spec', field: `params.${k}`, reason: `参数槽位 "${k}" 类型或默认/区间值非法`, repairHint: '核对 type/default/min/max/values' })
    } else validParams[k] = v
  }
  repaired = { ...repaired, params: validParams }
  if (Object.keys(draft.params).length === 0 && draft.scope !== 'private') {
    violations.push({
      ruleId: 'params-required-for-shared-scope', field: 'params',
      reason: `params 为空且 scope="${draft.scope}"：无参数沉淀绑定私有假设，严禁外流共享`,
      repairHint: '在 params 中至少声明一个参数槽位，或将 scope 降为 "private"',
    })
    repaired = { ...repaired, scope: 'private' }
  }
  if (draft.kind === 'standing-order' && (!draft.trigger.signal || draft.trigger.signal.trim() === '')) {
    violations.push({ ruleId: 'missing-trigger-signal', field: 'trigger.signal', reason: 'standing-order 必须绑定非空 trigger.signal', repairHint: '设置 trigger.signal 为受治理信号名' })
    repaired = { ...repaired, trigger: { ...repaired.trigger, signal: draft.trigger.on.trim() || 'signal.default' } }
  }
  if (draft.kind === 'counter-rule') {
    const actionBad = draft.action !== undefined && !ALLOWED_COUNTER_ACTION_RE.test(draft.action.name)
    const stageBad = draft.stage !== undefined && draft.stage !== 'shadow' && draft.stage !== 'observe'
    if (draft.enforce === true || draft.actionClass !== 'observe' || stageBad || actionBad) {
      violations.push({
        ruleId: 'constitutional-d5-counter-rule', field: actionBad ? 'action.name' : 'enforce',
        reason: '宪法冲突（D5）：counter-rule 仅具九级梯 Rung 1 提案权，严禁 enforce: true 或非提案动作',
        repairHint: '合九级梯改写为提案态：enforce: false、stage: "shadow"、actionClass: "observe"、action: { name: "proposal.create" }',
      })
      repaired = { ...repaired, enforce: false, stage: 'shadow', actionClass: 'observe', action: { name: 'proposal.create' } }
    }
  }
  if (draft.actionClass === 'side-effecting') {
    if (!draft.mandateRef || draft.mandateRef.trim() === '') {
      violations.push({ ruleId: 'missing-mandate-ref', field: 'mandateRef', reason: 'side-effecting 动作必须绑定有效的 mandateRef', repairHint: '提供工作区 mandateRef，或将 actionClass 降级为 "observe"' })
      repaired = { ...repaired, actionClass: 'observe' }
    }
    if (draft.mandateCeiling !== 'L2' && draft.mandateCeiling !== 'L3') {
      violations.push({ ruleId: 'exceeds-mandate-ceiling', field: 'mandateCeiling', reason: `side-effecting 必须显式具备 L2/L3 授权档位（当前：${String(draft.mandateCeiling ?? '未声明')}）`, repairHint: '声明 mandateCeiling: "L2"|"L3"，或将 actionClass 降为 "observe"' })
      repaired = { ...repaired, actionClass: 'observe' }
    }
  } else if (draft.actionClass === 'block' && draft.mandateCeiling === 'L0') {
    violations.push({ ruleId: 'exceeds-mandate-ceiling', field: 'mandateCeiling', reason: '动作类 block 越过只读工作区 mandateCeiling (L0)', repairHint: '将 actionClass 降为 "observe" 或提升工作区授权档' })
    repaired = { ...repaired, actionClass: 'observe' }
  }
  if (violations.length > 0) return { ok: false, gate: 'machine', violations, repairedDraft: repaired }

  const positiveCount = draft.cases.filter(c => c.expected === 'allow').length
  const negativeCount = draft.cases.filter(c => c.expected === 'deny').length
  const missingPositive = positiveCount === 0
  const missingNegative = negativeCount === 0
  if (missingPositive || missingNegative) {
    const lacks = [missingPositive ? '正例 (allow)' : '', missingNegative ? '反例 (deny)' : ''].filter(Boolean).join('与')
    return {
      ok: false, gate: 'evidence', status: 'needs-more-samples', missingPositive, missingNegative, positiveCount, negativeCount,
      message: `证据门提示（非拒绝）：还缺少 ${lacks}，当前正例 ${positiveCount} 条 / 反例 ${negativeCount} 条，请补充红绿用例后再落盘。`,
    }
  }
  return { ok: true, gate: 'ready', draft, positiveCount, negativeCount }
}

/** 四分法归因确定性分流器：环境波动重跑、执行失误进 M3、判据缺口/原地捕获建草稿、委托不清进 M2。 */
export function routeEscalationRuling(
  ruling: EscalationRuling,
  context: { readonly point?: string; readonly intent?: string; readonly workspace?: string } = {},
): EscalationRouteResult {
  if (ruling.captureAsRule === true || ruling.attribution === 'gate_gap') {
    const slug = ruling.escalationId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'captured'
    const draft: DepositDraft = {
      id: `friction.${slug}`, name: `捕获规则 ${ruling.escalationId}`, version: 1, author: ruling.operatorOpenId,
      scope: 'private', kind: 'gate', level: 'object', point: context.point ?? 'verify.preflight',
      trigger: { on: 'escalation.recorded', ...(context.workspace ? { workspace: context.workspace } : {}), mode: 'on-event' },
      requires: ['ticket.id'], params: {}, exceptions: [],
      repairHint: ruling.note?.trim() || '请按裁决意见补充证据后重试。',
      intent: context.intent ?? (ruling.note?.trim() || `从升级裁决 ${ruling.escalationId}（工单 ${ruling.ticketId}）捕获的判据草案`),
      rubricBody: ruling.note?.trim() || `针对工单 ${ruling.ticketId} 的裁决 (${ruling.decision}) 沉淀为可复验前置判据。`,
      enforce: false, actionClass: 'observe', origin: { kind: 'friction-mined', refs: [ruling.escalationId] },
      cases: [], unansweredSlots: ['point', 'requires', 'params', 'exceptions'],
    }
    return { route: 'deposit-draft', draft, sourceRef: ruling.sourceRef }
  }
  if (ruling.attribution === 'env_transient') {
    return { route: 'transient-retry', suppressRuleProposal: true, reason: ruling.note?.trim() || '环境波动仅触发退避重试与冷却，不污染规则库' }
  }
  if (ruling.attribution === 'exec_mistake') {
    return {
      route: 'workspace-memory-proposal', layer: 'm3', sourceRef: ruling.sourceRef,
      ...(context.workspace ? { workspace: context.workspace } : {}),
      title: `踩坑笔记提议（${ruling.ticketId}）`,
      summary: ruling.note?.trim() || `执行失误裁决 ${ruling.escalationId}（${ruling.decision}），建议沉淀为工作区 M3 经验。`,
    }
  }
  return {
    route: 'user-ruling-memory-proposal', layer: 'm2', sourceRef: ruling.sourceRef,
    ...(context.workspace ? { workspace: context.workspace } : {}),
    title: `委托边界澄清提议（${ruling.ticketId}）`,
    summary: ruling.note?.trim() || `委托不清裁决 ${ruling.escalationId}（${ruling.decision}），建议沉淀为老板偏好/M2 边界。`,
  }
}

/** 将 M3/M2 归因分流结果桥接为符合 MemoryWriter.propose 契约的记忆提案。 */
export function toMemoryProposal(
  routed: Extract<EscalationRouteResult, { readonly route: 'workspace-memory-proposal' | 'user-ruling-memory-proposal' }>,
  ctx: MemoryProposalContext = {},
): AuthoringMemoryProposal {
  if (!Number.isSafeInteger(routed.sourceRef.seq) || routed.sourceRef.seq <= 0 || routed.sourceRef.id.trim() === '') {
    throw new Error('记忆提案必须绑定真实的 M0 SourceRef（seq > 0 且 id 非空）')
  }
  const rawWs = ctx.workspaceId ?? routed.workspace
  if (routed.route === 'workspace-memory-proposal') {
    if (!rawWs || rawWs.trim() === '') throw new Error('M3 工作区经验提案缺少 workspaceId')
    const workspaceKey = sanitizeSegment(rawWs, 'default')
    const slug = sanitizeSegment(ctx.slug ?? routed.sourceRef.id, 'ruling-note')
    return {
      layer: 'm3', workspaceKey, slug, statement: routed.summary, scope: `workspace:${workspaceKey}`,
      sourceType: 'user_ruling', sourceRef: routed.sourceRef, author: 'user',
      confidence: 'stated', taint: 'clean', clearance: ctx.clearance ?? 'workspace',
    }
  }
  const workspaceKey = rawWs?.trim() ? sanitizeSegment(rawWs, 'default') : undefined
  return {
    layer: 'm2', slug: 'profile', statement: routed.summary,
    scope: workspaceKey ? `workspace:${workspaceKey}` : 'global',
    sourceType: 'user_ruling', sourceRef: routed.sourceRef, author: 'user',
    confidence: 'stated', taint: 'clean', clearance: ctx.clearance ?? 'private',
    m2Kind: ctx.m2Kind ?? 'preference',
  }
}

/** 将作者面遥测事件直接转换为递归脱敏的 M0 事件脊输入草稿。 */
export function telemetryToSpineInput(event: AuthoringTelemetryEvent): SpineInput<Record<string, unknown>> {
  const { id, draftId, at, actorId, evidence, ...rest } = event
  const cleanedPayload = redactValue<Record<string, unknown>>({ draftId, ...rest }, 'payload')
  const cleanedEvidence = redactValue(evidence ?? [], 'evidence')
  const redacted = [...new Set([...cleanedPayload.redacted, ...cleanedEvidence.redacted])]
  const hasUserText = (event.kind === 'abandoned_at' && Boolean(event.reason)) || event.kind === 'admission_rejected'
  return {
    id: id ?? `authoring:${event.kind}:${draftId}:${at}`,
    at,
    stream: `authoring:${draftId}`,
    type: `authoring.${event.kind}`,
    source: { kind: 'secretary', ref: actorId },
    evidence: cleanedEvidence.value,
    taint: hasUserText ? 'untrusted' : 'trusted',
    ...(redacted.length > 0 ? { redacted } : {}),
    payload: cleanedPayload.value,
  }
}
