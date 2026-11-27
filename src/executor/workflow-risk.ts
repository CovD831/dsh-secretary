/** 零 LLM 确定性工作流风险分诊器：发射期与完工期共享同一快速/高危分级逻辑。 */
import { DEFAULT_ADAPTIVE_DISPATCH_PARAMS } from '../judgement/gates/adaptive-dispatch.ts'
import { isTestOverlayPath } from './red-green-probe.ts'

export type WorkflowRiskTier = 'fast' | 'elevated'

export interface WorkflowRiskParams {
  readonly max_fast_files: number
  readonly max_fast_modules: number
  readonly max_fast_diff_lines: number
  readonly escalate_on_retry: number
}

export const DEFAULT_WORKFLOW_RISK_PARAMS: WorkflowRiskParams = Object.freeze({
  max_fast_files: DEFAULT_ADAPTIVE_DISPATCH_PARAMS.solo_max_files,
  max_fast_modules: 1,
  max_fast_diff_lines: 150,
  escalate_on_retry: DEFAULT_ADAPTIVE_DISPATCH_PARAMS.escalate_after_fails,
})

export interface WorkflowRiskResult {
  readonly tier: WorkflowRiskTier
  readonly reasons: readonly string[]
  readonly distinctModules: number
}

const MULTI_TIER_ROOTS = new Set(['src', 'packages', 'apps', 'services', 'libs', 'deposits'])
const HIGH_RISK_PATH_RE = /(?:^|\/)(?:auth|permission|mandate|sandbox|guard|runtime-guard|pre-execute-gates|git-workspace-snapshot|gates|security|secret|credential|migration|schema|ruling-queue|outbox|outward|payment|billing)(?:[._/-]|$)/i
const HIGH_RISK_INTENT_RE = /(?:架构重构|跨模块契约|权限隔离|安全门禁|数据库迁移|\b(?:architecture\s+refactor|schema\s+migration|breaking\s+contract|security\s+boundary|permission\s+model)\b)/gi
const PREFIX_NEG_RE = /(?:(?:^|[\s,;.(])(?:no|not|without|avoid(?:ing)?)\s+|(?:非|无|无需|禁止)\s*)$/i

function hasAffirmativeHighRiskIntent(text: string): boolean {
  HIGH_RISK_INTENT_RE.lastIndex = 0
  for (let m = HIGH_RISK_INTENT_RE.exec(text); m; m = HIGH_RISK_INTENT_RE.exec(text)) {
    if (!PREFIX_NEG_RE.test(text.slice(Math.max(0, m.index - 24), m.index))) return true
  }
  return false
}

/** 归并 `src/<mod>`、`packages/<mod>` 等顶层模块键，防止 `src/` 下跨目录修改误算成单模块。 */
export function extractModuleKey(relPath: string): string {
  const segs = relPath.trim().replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean)
  if (segs.length === 0) return ''
  const top = segs[0]!
  if (MULTI_TIER_ROOTS.has(top) && segs.length >= 2) {
    return segs.length === 2 && /\.[a-z0-9]+$/i.test(segs[1]!) ? `${top}/<root>` : `${top}/${segs[1]!}`
  }
  return top
}

export function isHighRiskPath(relPath: string): boolean {
  return HIGH_RISK_PATH_RE.test(relPath.replace(/\\/g, '/').replace(/^\.\//, ''))
}

export function classifyWorkflowRisk(input: {
  readonly paths?: readonly string[]
  readonly title?: string
  readonly assignment?: string
  readonly triggerText?: string
  readonly retryCount?: number
  readonly executionMode?: 'solo' | 'team'
  readonly diffLineCount?: number
  readonly params?: Partial<WorkflowRiskParams>
}): WorkflowRiskResult {
  const p: WorkflowRiskParams = { ...DEFAULT_WORKFLOW_RISK_PARAMS, ...input.params }
  const paths = [...new Set((input.paths ?? []).map(s => s.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))]
  const reasons: string[] = []
  const highPath = paths.find(isHighRiskPath)
  if (highPath) reasons.push(`high-risk-path:${highPath}`)

  const modules = new Set<string>()
  for (const rel of paths) {
    if (isTestOverlayPath(rel)) continue
    const key = extractModuleKey(rel)
    if (key) modules.add(key)
  }
  const distinctModules = modules.size
  if (distinctModules > p.max_fast_modules) reasons.push(`multi-module:${distinctModules}`)
  if (paths.length > p.max_fast_files) reasons.push(`scope-files:${paths.length}`)
  if (input.diffLineCount !== undefined && input.diffLineCount > p.max_fast_diff_lines) reasons.push(`large-diff:${input.diffLineCount}`)
  if ((input.retryCount ?? 0) >= p.escalate_on_retry) reasons.push(`retry-escalation:${input.retryCount ?? 0}`)
  if (input.executionMode === 'team') reasons.push('execution-mode:team')

  const text = `${input.title ?? ''} ${input.assignment ?? ''} ${input.triggerText ?? ''}`
  if (hasAffirmativeHighRiskIntent(text)) reasons.push('high-risk-intent')

  return { tier: reasons.length > 0 ? 'elevated' : 'fast', reasons, distinctModules }
}

/** 仅在高风险/跨模块工单注入紧凑行动清单（fast 通道返回空串，零冗余成本）。 */
export function renderElevatedWorkflowNotice(risk: WorkflowRiskResult): string {
  if (risk.tier !== 'elevated') return ''
  return [
    `## 高风险/跨模块核查提示 (elevated: ${risk.reasons.slice(0, 3).join(', ')})`,
    '1. 动代码前先列出最硬反例、最小改法边界与回滚路径。',
    '2. 若改动跨模块契约/安全隔离，先验证边界用例再改实现。',
    '3. 完工前逐项核对改动路径、真实命令退出码与未验证项。',
  ].join('\n')
}