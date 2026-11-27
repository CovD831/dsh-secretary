/** 基于 Chow 最优升级规则的分档实验路由器及 sweep.ts 参数寻优适配器。 */
import type { ProblemClusterFeatures } from './problem-clustering.ts'
import type { ReplayGateFn } from './types.ts'

export type ExperimentTier =
  | 'T0_direct_autofix'
  | 'T1_light_single_pass'
  | 'T2_heavy_causal'
  | 'human_spec_ruling'

export interface TierRouterParams {
  readonly maxT0AutoFixFiles: number
  readonly maxT1OneHopFiles: number
  readonly minT2Entrypoints: number
  readonly escalateAfterRetries: number
  readonly requireSharedLocusForT2: boolean
}

export interface TierCostProfile {
  readonly t2ExtraTokens: number
  readonly t2ExtraMs: number
  readonly humanAskTokens: number
  readonly humanAskMs: number
}

export interface TierRouteDecision {
  readonly tier: ExperimentTier
  readonly escalateFromFastLane: boolean
  readonly reasons: readonly string[]
  readonly deltaTokens: number
  readonly deltaMs: number
}

export const DEFAULT_TIER_ROUTER_PARAMS: TierRouterParams = {
  maxT0AutoFixFiles: 1,
  maxT1OneHopFiles: 2,
  minT2Entrypoints: 2,
  escalateAfterRetries: 2,
  requireSharedLocusForT2: true,
}

export const DEFAULT_TIER_COST_PROFILE: TierCostProfile = {
  t2ExtraTokens: 3800,
  t2ExtraMs: 14000,
  humanAskTokens: 600,
  humanAskMs: 2000,
}

/** 依据根因簇特征与阈值参数决定走直接收紧快修 (T0/T1)、重型因果实验 (T2) 或人类规范裁决。 */
export function routeProblemCluster(
  features: ProblemClusterFeatures,
  params: TierRouterParams = DEFAULT_TIER_ROUTER_PARAMS,
  cost: TierCostProfile = DEFAULT_TIER_COST_PROFILE,
): TierRouteDecision {
  const reasons: string[] = []
  if (!features.deterministicOracle || features.safetyDirection === 'fail-open') {
    if (!features.deterministicOracle) reasons.push('non-deterministic-oracle')
    if (features.safetyDirection === 'fail-open') reasons.push('fail-open-safety-risk')
    return {
      tier: 'human_spec_ruling',
      escalateFromFastLane: true,
      reasons,
      deltaTokens: cost.humanAskTokens,
      deltaMs: cost.humanAskMs,
    }
  }

  if (features.safetyDirection === 'fail-closed' && features.oneHopFileCount <= params.maxT0AutoFixFiles && features.sharedLocusCount === 0) {
    return {
      tier: 'T0_direct_autofix',
      escalateFromFastLane: false,
      reasons: ['fail-closed-deterministic-bounded'],
      deltaTokens: 0,
      deltaMs: 0,
    }
  }

  const multiEntryHit = features.entryPointCount >= params.minT2Entrypoints
    && (!params.requireSharedLocusForT2 || features.sharedLocusCount >= 1)
  if (multiEntryHit) reasons.push(`entryPoints(${features.entryPointCount})>=${params.minT2Entrypoints}`)
  if (features.oneHopFileCount > params.maxT1OneHopFiles) reasons.push(`oneHopFiles(${features.oneHopFileCount})>${params.maxT1OneHopFiles}`)
  if (features.maxRetryCount >= params.escalateAfterRetries) reasons.push(`retries(${features.maxRetryCount})>=${params.escalateAfterRetries}`)

  if (reasons.length > 0) {
    return {
      tier: 'T2_heavy_causal',
      escalateFromFastLane: true,
      reasons,
      deltaTokens: cost.t2ExtraTokens,
      deltaMs: cost.t2ExtraMs,
    }
  }

  return {
    tier: 'T1_light_single_pass',
    escalateFromFastLane: false,
    reasons: ['bounded-single-pass'],
    deltaTokens: 0,
    deltaMs: 0,
  }
}

/** 将分档参数编译为 sweep.ts / calibration.ts 可直接回放的 ReplayGateFn。 */
export function buildTierEscalationGate(
  params: TierRouterParams,
  cost: TierCostProfile = DEFAULT_TIER_COST_PROFILE,
): ReplayGateFn<ProblemClusterFeatures> {
  return features => {
    const decision = routeProblemCluster(features, params, cost)
    if (decision.escalateFromFastLane) {
      return {
        verdict: { kind: 'deny', blockers: [decision.tier, ...decision.reasons] as [string, ...string[]] },
        deltaTokens: decision.deltaTokens,
        deltaMs: decision.deltaMs,
      }
    }
    return {
      verdict: { kind: 'allow' },
      deltaTokens: 0,
      deltaMs: 0,
    }
  }
}

/** 无分档纯 T1 快修基线门：一律放行单次快修，用于校准对比净收益。 */
export const UNROUTED_FAST_LANE_GATE: ReplayGateFn<ProblemClusterFeatures> = () => ({
  verdict: { kind: 'allow' },
  deltaTokens: 0,
  deltaMs: 0,
})
