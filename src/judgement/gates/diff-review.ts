import type { GateDef, Verdict } from '../types.ts'

export type DiffReviewSeverity = 'critical' | 'high' | 'medium' | 'low'

export interface DiffReviewFinding {
  readonly severity: DiffReviewSeverity
  readonly file: string
  readonly line?: number
  readonly issue: string
  readonly evidence: string
}

export type DiffReviewOutcome =
  | {
      readonly status: 'ok'
      readonly verdict: 'approve' | 'request_changes'
      readonly findings: readonly DiffReviewFinding[]
      readonly summary?: string
      readonly reviewerModel?: string
    }
  | {
      readonly status: 'unavailable' | 'timeout' | 'parse-failed'
      readonly detail: string
    }

export interface DiffReviewParams {
  readonly max_review_rounds: number
  readonly block_severities: string
}

export const DEFAULT_DIFF_REVIEW_PARAMS: DiffReviewParams = Object.freeze({
  max_review_rounds: 2,
  block_severities: 'critical,high',
})

export interface DiffReviewCtx {
  readonly workflowRiskTier?: 'fast' | 'elevated' | null
  readonly codeChangedPaths?: readonly string[] | null
  readonly changedPaths?: readonly string[] | null
  readonly review?: DiffReviewOutcome | null
  readonly rejectedRounds?: number
  readonly waived?: boolean
  readonly params?: Partial<DiffReviewParams>
}

declare module '../types.ts' {
  interface PointCatalog {
    'verify.diff-review': DiffReviewCtx
  }
}

const normRel = (p: string): string => p.trim().replace(/\\/g, '/').replace(/^\.\//, '')

export function filterGroundedDiffFindings(
  findings: readonly DiffReviewFinding[],
  allowedPaths: readonly string[],
  blockSeveritiesCsv: string,
): { readonly groundedBlockers: DiffReviewFinding[]; readonly warnings: DiffReviewFinding[] } {
  const allowed = new Set(allowedPaths.map(normRel).filter(Boolean))
  const blockSevs = new Set(String(blockSeveritiesCsv ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
  const groundedBlockers: DiffReviewFinding[] = []
  const warnings: DiffReviewFinding[] = []
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue
    const file = normRel(String(f.file ?? ''))
    const issue = String(f.issue ?? '').trim()
    const evidence = String(f.evidence ?? '').trim()
    const sev = String(f.severity ?? 'low').trim().toLowerCase() as DiffReviewSeverity
    if (!file || !issue || !evidence) continue
    const normalized: DiffReviewFinding = { severity: sev, file, ...(Number.isInteger(f.line) ? { line: f.line } : {}), issue, evidence }
    if (blockSevs.has(sev) && allowed.has(file)) groundedBlockers.push(normalized)
    else warnings.push(normalized)
  }
  return { groundedBlockers, warnings }
}

/** 完工期独立对抗 diff 复核门：只凭真实文件锚点+阻断级证据拦截，超轮次升级老板裁决且禁自动绕过。 */
export function evaluateDiffReview(
  ctx: DiffReviewCtx,
  boundParams?: Partial<DiffReviewParams>,
): Verdict {
  const p: DiffReviewParams = { ...DEFAULT_DIFF_REVIEW_PARAMS, ...ctx.params, ...boundParams }
  if (!Number.isInteger(p.max_review_rounds) || p.max_review_rounds < 1 || p.max_review_rounds > 10) {
    return { kind: 'deny', blockers: [`参数 max_review_rounds=${String(p.max_review_rounds)} 超出允许范围 [1, 10]`] }
  }
  if (ctx.workflowRiskTier !== 'fast' && ctx.workflowRiskTier !== 'elevated') {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少有效的 workflowRiskTier 输入' }
  }
  if (ctx.codeChangedPaths === undefined || ctx.codeChangedPaths === null) {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少 codeChangedPaths 输入' }
  }
  if (ctx.workflowRiskTier === 'fast') {
    return { kind: 'allow', produced: { skipped: 'fast-tier' } }
  }
  if (ctx.codeChangedPaths.length === 0) {
    return { kind: 'allow', produced: { skipped: 'no-code-changes' } }
  }
  if (ctx.waived === true) {
    return { kind: 'allow', produced: { waivedBy: 'boss' } }
  }
  const rounds = ctx.rejectedRounds ?? 0
  if (rounds >= p.max_review_rounds) {
    return {
      kind: 'deny',
      blockers: [
        `独立对抗复核已连续 ${rounds} 轮发现阻断问题（达上限 ${p.max_review_rounds} 轮），已暂停自动放行并升级人工裁决；请调 orchestrator_report(state='blocked', human_action=...) 或等待老板审批豁免`,
      ],
    }
  }
  const rev = ctx.review
  if (!rev) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: '高风险代码变更缺少宿主独立对抗 diff 复核结果' }
  }
  if (rev.status === 'timeout') {
    return { kind: 'unmeasured', cause: 'timeout', detail: rev.detail || '宿主独立 diff 对抗复核超时' }
  }
  if (rev.status === 'parse-failed') {
    return { kind: 'unmeasured', cause: 'parse-failed', detail: rev.detail || '宿主独立 diff 对抗复核输出解析失败' }
  }
  if (rev.status === 'unavailable') {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: rev.detail || '宿主独立 diff 对抗复核模型不可用' }
  }
  if (rev.status !== 'ok') {
    return { kind: 'unmeasured', cause: 'parse-failed', detail: '未知的 diff 对抗复核状态' }
  }

  const allowedPaths = [...new Set([...ctx.codeChangedPaths, ...(ctx.changedPaths ?? [])])]
  const { groundedBlockers, warnings } = filterGroundedDiffFindings(rev.findings ?? [], allowedPaths, p.block_severities)
  if (groundedBlockers.length > 0) {
    const formatted = groundedBlockers.slice(0, 5).map(f => `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.issue} (${f.evidence})`)
    return { kind: 'deny', blockers: formatted as [string, ...string[]] }
  }
  if (rev.verdict === 'request_changes') {
    if (warnings.length === 0) {
      return { kind: 'unmeasured', cause: 'parse-failed', detail: 'Diff 复核返回 request_changes 但未提供任何合法且含证据的问题条目' }
    }
    return {
      kind: 'allow',
      produced: { verdict: 'approve-after-filter', warningsCount: warnings.length, filteredUngroundedOrLow: true },
    }
  }
  if (rev.verdict === 'approve') {
    return { kind: 'allow', produced: { verdict: 'approve', warningsCount: warnings.length } }
  }
  return { kind: 'unmeasured', cause: 'parse-failed', detail: `非法 diff 复核裁决: ${String((rev as { verdict?: unknown }).verdict)}` }
}

export function createDiffReviewGate(boundParams?: Partial<DiffReviewParams>): GateDef<'verify.diff-review'> {
  return {
    kind: 'gate',
    id: 'verify.diff-review',
    version: 1,
    point: 'verify.diff-review',
    description: '高风险/跨模块代码改动在确定性验证通过后由宿主发起独立单轮对抗 diff 复核（仅认带证据实质锚点）',
    side: 'soft',
    placement: { timing: 'pre', enforce: true },
    requires: ['workflowRiskTier', 'codeChangedPaths'],
    gate: ctx => evaluateDiffReview(ctx, boundParams),
  }
}

export const verifyDiffReviewGate: GateDef<'verify.diff-review'> = createDiffReviewGate()
