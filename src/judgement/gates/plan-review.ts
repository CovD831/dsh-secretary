import type { GateDef, Verdict } from '../types.ts'

export interface PlanReviewParams {
  readonly require_on_elevated: boolean
  readonly max_blockers_to_show: number
}

export const DEFAULT_PLAN_REVIEW_PARAMS: PlanReviewParams = Object.freeze({
  require_on_elevated: true,
  max_blockers_to_show: 5,
})

export type PlanReviewOutcome =
  | {
      readonly status: 'ok'
      readonly verdict: 'proceed' | 'revise'
      readonly criticalRisks: readonly string[]
      readonly counterexamples: readonly string[]
      readonly mustVerify: readonly string[]
      readonly summary?: string
      readonly reviewerModel?: string
    }
  | {
      readonly status: 'unavailable' | 'timeout' | 'parse-failed'
      readonly detail: string
    }

export interface PlanReviewCtx {
  readonly workflowRiskTier?: 'fast' | 'elevated' | null
  readonly review?: PlanReviewOutcome | null
  readonly params?: Partial<PlanReviewParams>
}

declare module '../types.ts' {
  interface PointCatalog {
    'ticket.plan-review': PlanReviewCtx
  }
}

const cleanList = (items?: readonly string[]): string[] =>
  Array.isArray(items) ? items.map(s => String(s).trim()).filter(Boolean) : []

/** 高风险/跨模块工单发射期计划对抗审视门：对 fast 通道零开销放行，对 elevated 要求实质性反例/风险审视。 */
export function evaluatePlanReview(
  ctx: PlanReviewCtx,
  boundParams?: Partial<PlanReviewParams>,
): Verdict {
  const p: PlanReviewParams = { ...DEFAULT_PLAN_REVIEW_PARAMS, ...ctx.params, ...boundParams }
  if (!Number.isInteger(p.max_blockers_to_show) || p.max_blockers_to_show < 1 || p.max_blockers_to_show > 20) {
    return { kind: 'deny', blockers: [`参数 max_blockers_to_show=${String(p.max_blockers_to_show)} 超出允许范围 [1, 20]`] }
  }
  if (ctx.workflowRiskTier !== 'fast' && ctx.workflowRiskTier !== 'elevated') {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少有效的 workflowRiskTier 输入' }
  }
  if (ctx.workflowRiskTier === 'fast') {
    return { kind: 'allow', produced: { skipped: 'fast-tier' } }
  }
  if (!p.require_on_elevated) {
    return { kind: 'allow', produced: { skipped: 'disabled-by-param' } }
  }
  const rev = ctx.review
  if (!rev) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: '高风险工单缺少宿主独立计划对抗审视结果' }
  }
  if (rev.status === 'timeout') {
    return { kind: 'unmeasured', cause: 'timeout', detail: rev.detail || '宿主计划对抗审视超时' }
  }
  if (rev.status === 'parse-failed') {
    return { kind: 'unmeasured', cause: 'parse-failed', detail: rev.detail || '宿主计划对抗审视输出解析失败' }
  }
  if (rev.status === 'unavailable') {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: rev.detail || '宿主计划对抗审视模型不可用' }
  }
  if (rev.status !== 'ok') {
    return { kind: 'unmeasured', cause: 'parse-failed', detail: '未知的计划对抗审视状态' }
  }
  const criticalRisks = cleanList(rev.criticalRisks)
  const counterexamples = cleanList(rev.counterexamples)
  const mustVerify = cleanList(rev.mustVerify)
  if (rev.verdict === 'revise') {
    const items = [...criticalRisks, ...counterexamples].slice(0, p.max_blockers_to_show)
    if (items.length === 0) {
      return { kind: 'unmeasured', cause: 'parse-failed', detail: '计划复核返回 revise 但未提供具体高危缺陷或反例' }
    }
    return { kind: 'deny', blockers: items as [string, ...string[]] }
  }
  if (rev.verdict === 'proceed') {
    return {
      kind: 'allow',
      produced: {
        verdict: 'proceed',
        risksCount: criticalRisks.length,
        counterexamplesCount: counterexamples.length,
        mustVerifyCount: mustVerify.length,
      },
    }
  }
  return { kind: 'unmeasured', cause: 'parse-failed', detail: `非法计划复核裁决: ${String((rev as { verdict?: unknown }).verdict)}` }
}

export function createPlanReviewGate(boundParams?: Partial<PlanReviewParams>): GateDef<'ticket.plan-review'> {
  return {
    kind: 'gate',
    id: 'ticket.plan-review',
    version: 1,
    point: 'ticket.plan-review',
    description: '高风险/跨模块工单发射前由宿主发起独立单轮计划对抗审视（fast 通道零 LLM 放行）',
    side: 'soft',
    placement: { timing: 'pre', enforce: true },
    requires: ['workflowRiskTier'],
    gate: ctx => evaluatePlanReview(ctx, boundParams),
  }
}

export const ticketPlanReviewGate: GateDef<'ticket.plan-review'> = createPlanReviewGate()
