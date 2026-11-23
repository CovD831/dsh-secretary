/** 作者面漏斗：响亮机器门、代修草稿、四分法归因分流、遥测入脊与标准包落盘。 */
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { admitDeposit } from '../judgement/deposit.ts'
import { isValidScopeStage } from '../judgement/registry.ts'
import { BASE_SCOPES } from '../judgement/types.ts'
import type {
  AuthoringTelemetryEvent,
  DepositDraft,
  DraftValidationResult,
  EscalationRouteResult,
  EscalationRuling,
  MachineGateViolation,
  SpineInput,
  WrittenDepositPackage,
} from './types.ts'

const KNOWN_SCOPES = new Set<string>(BASE_SCOPES)
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const SECRET_RE = /\b(?:sk-[a-zA-Z0-9]{12,}|ghp_[a-zA-Z0-9]{12,}|xox[baprs]-[a-zA-Z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/g

function redactText(text: string): string {
  return text.replace(SECRET_RE, '[REDACTED]')
}

function isBadRequiresPath(path: string): boolean {
  const trimmed = path.trim()
  return trimmed === '' || trimmed.includes('..') || trimmed.startsWith('.') || trimmed.endsWith('.') || /\s/.test(trimmed)
}

function isInsideDir(parentReal: string, childReal: string): boolean {
  const rel = relative(parentReal, childReal)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 严格区分机器门（即时硬拒+代修草稿）与证据门（非拒绝，只提示样本不足）。 */
export function validateDepositDraft(draft: DepositDraft): DraftValidationResult {
  const violations: MachineGateViolation[] = []
  let repaired: DepositDraft = { ...draft, requires: [...draft.requires] }

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
  if (Object.keys(draft.params).length === 0 && draft.scope !== 'private') {
    violations.push({
      ruleId: 'params-required-for-shared-scope', field: 'params',
      reason: `params 为空且 scope="${draft.scope}"：无参数沉淀绑定私有假设，严禁外流共享`,
      repairHint: '在 params 中至少声明一个参数槽位，或将 scope 降为 "private"',
    })
    repaired = { ...repaired, scope: 'private' }
  }
  if (draft.kind === 'counter-rule' && (draft.enforce === true || draft.actionClass !== 'observe' || (draft.stage !== undefined && draft.stage !== 'shadow' && draft.stage !== 'observe'))) {
    violations.push({
      ruleId: 'constitutional-d5-counter-rule', field: 'enforce',
      reason: '宪法冲突（D5）：counter-rule 仅具九级梯 Rung 1 提案权，严禁 enforce: true 或直接拦截晋升',
      repairHint: '合九级梯改写为提案态：enforce: false、stage: "shadow"、actionClass: "observe"、action: { name: "proposal.create" }',
    })
    repaired = { ...repaired, enforce: false, stage: 'shadow', actionClass: 'observe', action: { name: 'proposal.create' } }
  }
  if (draft.actionClass === 'side-effecting') {
    if (!draft.mandateRef || draft.mandateRef.trim() === '') {
      violations.push({ ruleId: 'missing-mandate-ref', field: 'mandateRef', reason: 'side-effecting 动作必须绑定有效的 mandateRef', repairHint: '提供工作区 mandateRef，或将 actionClass 降级为 "observe"' })
      repaired = { ...repaired, actionClass: 'observe' }
    }
    if (draft.mandateCeiling === 'L0' || draft.mandateCeiling === 'L1') {
      violations.push({ ruleId: 'exceeds-mandate-ceiling', field: 'mandateCeiling', reason: `动作类 side-effecting 越过工作区 mandateCeiling (${draft.mandateCeiling})`, repairHint: '申请工作区授权升至 L2/L3，或将 actionClass 降为 "observe"' })
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
      id: `friction.${slug}`,
      name: `捕获规则 ${ruling.escalationId}`,
      version: 1,
      author: ruling.operatorOpenId,
      scope: 'private',
      kind: 'gate',
      level: 'object',
      point: context.point ?? 'verify.preflight',
      trigger: { on: 'escalation.recorded', ...(context.workspace ? { workspace: context.workspace } : {}), mode: 'on-event' },
      requires: ['ticket.id'],
      params: {},
      exceptions: [],
      repairHint: ruling.note?.trim() || '请按裁决意见补充证据后重试。',
      intent: context.intent ?? (ruling.note?.trim() || `从升级裁决 ${ruling.escalationId}（工单 ${ruling.ticketId}）捕获的判据草案`),
      rubricBody: ruling.note?.trim() || `针对工单 ${ruling.ticketId} 的裁决 (${ruling.decision}) 沉淀为可复验前置判据。`,
      enforce: false,
      actionClass: 'observe',
      origin: { kind: 'friction-mined', refs: [ruling.escalationId] },
      cases: [],
      unansweredSlots: ['point', 'requires', 'params', 'exceptions'],
    }
    return { route: 'deposit-draft', draft, sourceRef: ruling.sourceRef }
  }
  if (ruling.attribution === 'env_transient') {
    return { route: 'transient-retry', suppressRuleProposal: true, reason: ruling.note?.trim() || '环境波动仅触发退避重试与冷却，不污染规则库' }
  }
  if (ruling.attribution === 'exec_mistake') {
    return {
      route: 'workspace-memory-proposal', layer: 'm3', sourceRef: ruling.sourceRef,
      title: `踩坑笔记提议（${ruling.ticketId}）`,
      summary: ruling.note?.trim() || `执行失误裁决 ${ruling.escalationId}（${ruling.decision}），建议沉淀为工作区 M3 经验。`,
    }
  }
  return {
    route: 'user-ruling-memory-proposal', layer: 'm2', sourceRef: ruling.sourceRef,
    title: `委托边界澄清提议（${ruling.ticketId}）`,
    summary: ruling.note?.trim() || `委托不清裁决 ${ruling.escalationId}（${ruling.decision}），建议沉淀为老板偏好/M2 边界。`,
  }
}

/** 通过机器门与最小红绿对校验后，将草稿落盘为可被 loadDepositPackage 无损加载的标准沉淀包。 */
export async function writeDepositDraftPackage(rootDir: string, draft: DepositDraft): Promise<WrittenDepositPackage> {
  const check = validateDepositDraft(draft)
  if (!check.ok) {
    if (check.gate === 'machine') throw new Error(`机器门拒绝落盘：${check.violations.map(v => `${v.ruleId}(${v.field})`).join('; ')}`)
    throw new Error(check.message)
  }
  const baseAbs = resolve(rootDir)
  await mkdir(baseAbs, { recursive: true })
  const rootReal = await realpath(baseAbs)
  const pkgTarget = resolve(rootReal, draft.id)
  if (relative(rootReal, pkgTarget) !== draft.id) throw new Error(`非法包目录路径 "${draft.id}"：疑似目录穿越`)
  const casesDir = join(pkgTarget, 'cases')
  await mkdir(casesDir, { recursive: true })
  const pkgReal = await realpath(pkgTarget)
  const casesReal = await realpath(casesDir)
  if (!isInsideDir(rootReal, pkgReal) || !isInsideDir(pkgReal, casesReal)) throw new Error(`包路径 "${draft.id}" 越出根目录`)

  const manifest: Record<string, unknown> = {
    id: draft.id,
    version: draft.version,
    kind: draft.kind,
    point: draft.point,
    params: draft.params,
    trust: draft.scope === 'private' ? 'owner' : draft.scope === 'public' ? 'public' : 'collaborator',
    cases: 'cases/',
    actionClass: draft.actionClass,
    ...(draft.stage ? { stage: draft.stage } : {}),
    ...(draft.enforce !== undefined ? { enforce: draft.enforce } : {}),
    ...(draft.action ? { action: draft.action } : {}),
    ...(draft.kind === 'standing-order' ? { trigger: { signal: draft.trigger.signal ?? draft.trigger.on } } : {}),
  }
  const examplesMd = draft.cases.map(c => `- [${c.expected}] \`${c.name}\`${c.note ? `：${c.note}` : ''}`).join('\n')
  const exceptionsMd = draft.exceptions.length > 0 ? draft.exceptions.map(e => `- ${e}`).join('\n') : '暂无显式例外。'
  const depositMd = [
    '---',
    JSON.stringify(manifest, null, 2),
    '---',
    `## 意图\n${draft.intent.trim()}`,
    `## 判据\n${draft.rubricBody.trim() || draft.intent.trim()}`,
    `## 正例与反例\n${examplesMd}`,
    `## 例外\n${exceptionsMd}`,
    `## 被拦时的话\n${draft.repairHint.trim() || '请补充必需输入或修复不合规项后重试。'}`,
  ].join('\n\n') + '\n'

  const admission = admitDeposit(depositMd)
  if (!admission.admitted) throw new Error(`生成包自检未过准入：${admission.violations.map(v => `${v.rule}:${v.reason}`).join('; ')}`)
  const depositMdPath = join(pkgReal, 'DEPOSIT.md')
  const casesPath = join(casesReal, 'cases.json')
  const serializedCases = draft.cases.map(({ name, expected, ctx, expectedCause }) => ({
    name, expected, ctx, ...(expectedCause ? { expectedCause } : {}),
  }))
  await writeFile(depositMdPath, depositMd, 'utf8')
  await writeFile(casesPath, `${JSON.stringify(serializedCases, null, 2)}\n`, 'utf8')
  return { packageDir: pkgReal, depositMdPath, casesPath }
}

/** 将作者面遥测事件直接转换为脱敏的 M0 事件脊输入草稿。 */
export function telemetryToSpineInput(event: AuthoringTelemetryEvent): SpineInput<Record<string, unknown>> {
  const { id, draftId, at, actorId, evidence, ...rest } = event
  const safePayload: Record<string, unknown> = { draftId }
  for (const [k, v] of Object.entries(rest)) safePayload[k] = typeof v === 'string' ? redactText(v) : v
  return {
    id: id ?? `authoring:${event.kind}:${draftId}:${at}`,
    at,
    stream: `authoring:${draftId}`,
    type: `authoring.${event.kind}`,
    source: { kind: 'secretary', ref: actorId },
    evidence: evidence ?? [],
    taint: 'trusted',
    payload: safePayload,
  }
}
