import type { SliceMetrics } from '../../context/types.ts'
import type { GateDef, Verdict } from '../types.ts'

export type ThinkingTier = 'low' | 'medium' | 'high'

export interface AdaptiveDispatchParams {
  readonly solo_max_files: number
  readonly max_capsule_bytes: number
  readonly default_thinking: ThinkingTier
  readonly escalate_after_fails: number
}

export const DEFAULT_ADAPTIVE_DISPATCH_PARAMS: AdaptiveDispatchParams = Object.freeze({
  solo_max_files: 6,
  max_capsule_bytes: 16000,
  default_thinking: 'low',
  escalate_after_fails: 2,
})

export interface AdaptiveDispatchCtx {
  readonly metrics?: SliceMetrics | null
  readonly retryCount?: number | null
  readonly params?: Partial<AdaptiveDispatchParams>
  readonly allowTeam?: boolean
}

declare module '../types.ts' {
  interface PointCatalog {
    'ticket.adaptive-dispatch': AdaptiveDispatchCtx
  }
}

const VALID_THINKING = new Set<ThinkingTier>(['low', 'medium', 'high'])

function validateParams(p: AdaptiveDispatchParams): string | undefined {
  if (!Number.isFinite(p.solo_max_files) || p.solo_max_files < 1 || p.solo_max_files > 30) {
    return `参数 solo_max_files=${String(p.solo_max_files)} 超出允许范围 [1, 30]`
  }
  if (!Number.isFinite(p.max_capsule_bytes) || p.max_capsule_bytes < 2000 || p.max_capsule_bytes > 100000) {
    return `参数 max_capsule_bytes=${String(p.max_capsule_bytes)} 超出允许范围 [2000, 100000]`
  }
  if (!VALID_THINKING.has(p.default_thinking)) {
    return `参数 default_thinking="${String(p.default_thinking)}" 非法，必须为 low|medium|high`
  }
  if (!Number.isFinite(p.escalate_after_fails) || p.escalate_after_fails < 1 || p.escalate_after_fails > 5) {
    return `参数 escalate_after_fails=${String(p.escalate_after_fails)} 超出允许范围 [1, 5]`
  }
  return undefined
}

/** 根据 1-Hop 切片读数与可调参数决定 solo/team 执行模式与思考档位。 */
export function evaluateAdaptiveDispatch(
  ctx: AdaptiveDispatchCtx,
  boundParams?: Partial<AdaptiveDispatchParams>,
): Verdict {
  const p: AdaptiveDispatchParams = { ...DEFAULT_ADAPTIVE_DISPATCH_PARAMS, ...boundParams, ...ctx.params }
  const paramErr = validateParams(p)
  if (paramErr) return { kind: 'deny', blockers: [paramErr] }

  const m = ctx.metrics
  const retries = ctx.retryCount
  if (
    !m ||
    typeof retries !== 'number' ||
    !Number.isFinite(retries) ||
    !Number.isFinite(m.targetFiles) ||
    !Number.isFinite(m.totalBytes)
  ) {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少有效的切片读数 metrics 或 retryCount' }
  }
  if (retries < 0 || m.targetFiles < 0 || m.totalBytes < 0) {
    return { kind: 'deny', blockers: ['切片读数或失败计数不得为负数'] }
  }

  const reasons: string[] = []
  if (m.targetFiles > p.solo_max_files) reasons.push(`targetFiles(${m.targetFiles}) > solo_max_files(${p.solo_max_files})`)
  if (m.totalBytes > p.max_capsule_bytes) reasons.push(`totalBytes(${m.totalBytes}) > max_capsule_bytes(${p.max_capsule_bytes})`)
  if (retries >= p.escalate_after_fails) reasons.push(`retryCount(${retries}) >= escalate_after_fails(${p.escalate_after_fails})`)

  if (reasons.length === 0) {
    return { kind: 'allow', produced: { executionMode: 'solo', thinkingTier: p.default_thinking } }
  }
  if (ctx.allowTeam === false) {
    return { kind: 'deny', blockers: [`需要拆队升档（${reasons.join('；')}），但当前工单禁止 team 模式`] }
  }
  return {
    kind: 'allow',
    produced: { executionMode: 'team', thinkingTier: 'high', escalateReason: reasons.join('; ') },
  }
}

export function createAdaptiveDispatchGate(boundParams?: Partial<AdaptiveDispatchParams>): GateDef<'ticket.adaptive-dispatch'> {
  return {
    kind: 'gate',
    id: 'ticket.adaptive-dispatch',
    version: 1,
    point: 'ticket.adaptive-dispatch',
    description: '基于 1-Hop 切片读数与失败次数的自适应派发与思考档位决策门',
    side: 'soft',
    placement: { timing: 'pre', enforce: true },
    requires: ['metrics', 'retryCount'],
    gate: ctx => evaluateAdaptiveDispatch(ctx, boundParams),
  }
}

export const adaptiveDispatchGate: GateDef<'ticket.adaptive-dispatch'> = createAdaptiveDispatchGate()
