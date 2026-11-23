/** RSI 离线回放、指针桥接与零耦合评估器公共契约。 */
import type { SpineSource, Taint, EvidenceRef } from '../spine/types.ts'
import type { Verdict } from '../judgement/types.ts'

export type ExpectedOutcome = 'defect' | 'clean' | 'unknown'
export type SplitBucket = 'train' | 'validation' | 'holdout'

export interface SessionEventPtr {
  readonly sessionId: string
  readonly fromSeq?: number
  readonly toSeq?: number
  readonly commit?: string
}

export interface ReplayCase<I = unknown> {
  readonly id: string
  readonly family: string
  readonly input: I
  readonly expectedOutcome: ExpectedOutcome
  readonly tokens?: number
  readonly durationMs?: number
  readonly sessionEventPtr?: SessionEventPtr
}

export interface SplitRatios {
  readonly train: number
  readonly validation: number
  readonly holdout: number
}

export interface FamilySplit<I = unknown> {
  readonly train: readonly ReplayCase<I>[]
  readonly validation: readonly ReplayCase<I>[]
  readonly holdout: readonly ReplayCase<I>[]
  readonly familyAssignments: Readonly<Record<string, SplitBucket>>
}

export type ReplayGateOutcome =
  | Verdict
  | { readonly verdict: Verdict; readonly deltaTokens?: number; readonly deltaMs?: number }

export type ReplayGateFn<I = unknown> = (
  input: I,
  replayCase: ReplayCase<I>,
) => ReplayGateOutcome | Promise<ReplayGateOutcome>

export interface ReplayCostModel {
  readonly perEvalTokens?: number
  readonly perEvalMs?: number
  readonly perTriggerTokens?: number
  readonly perTriggerMs?: number
  readonly falseBlockMultiplier?: number
}

export interface ReplayOptions {
  readonly costModel?: ReplayCostModel
}

export interface MarginalCostEstimate {
  readonly deltaTokens: number | undefined
  readonly deltaMs: number | undefined
  readonly state: 'measured' | 'partial' | 'unmeasured'
}

export type ReplayCaseClassification =
  | 'catch'
  | 'false-block'
  | 'miss'
  | 'true-allow'
  | 'unmeasured'
  | 'unknown-label'

export interface ReplayCaseTrace {
  readonly caseId: string
  readonly family: string
  readonly expectedOutcome: ExpectedOutcome
  readonly verdict: Verdict
  readonly classification: ReplayCaseClassification
  readonly deltaTokens?: number
  readonly deltaMs?: number
}

export interface ReplayReportCard {
  readonly caseIds: readonly string[]
  readonly totalCases: number
  readonly triggeredCount: number
  readonly catches: number
  readonly falseBlocks: number
  readonly misses: number
  readonly trueAllows: number
  readonly unknownLabelCount: number
  readonly unmeasuredCount: number
  readonly coverageDiscount: number
  readonly netBenefit: number
  readonly marginalCost: MarginalCostEstimate
  readonly cases: readonly ReplayCaseTrace[]
}

export interface ParamCandidateEvaluation<P> {
  readonly index: number
  readonly params: P
  readonly train: ReplayReportCard
  readonly validation: ReplayReportCard
  readonly effectiveBenefit: number
  readonly guardrailPassed: boolean
  readonly guardrailViolations: readonly string[]
  readonly paretoOptimal: boolean
}

export interface ParamSweepOptions<P> {
  readonly baseline?: P
  readonly maxFalseBlocks?: number
  readonly maxFalseBlockRate?: number
  readonly maxMisses?: number
  readonly minCoverageDiscount?: number
  readonly costModel?: ReplayCostModel
}

export interface ParamSweepResult<P> {
  readonly proposalOnly: true
  readonly applied: false
  readonly holdoutOpened: false
  readonly holdoutCaseCount: number
  readonly maxFalseBlocksAllowed: number
  readonly baseline?: { readonly params: P; readonly train: ReplayReportCard; readonly validation: ReplayReportCard }
  readonly candidates: readonly ParamCandidateEvaluation<P>[]
  readonly paretoFrontier: readonly ParamCandidateEvaluation<P>[]
  readonly recommended: ParamCandidateEvaluation<P> | undefined
  readonly summary: string
}

export interface DomainEventBridgeMeta {
  readonly id?: string
  readonly stream?: `${string}:${string}`
  readonly causationId?: string
  readonly correlationId?: string
  readonly source?: SpineSource
  readonly taint?: Taint
  readonly sessionId?: string
  readonly sessionSeq?: number
  readonly commit?: string
  readonly evidence?: readonly EvidenceRef[]
}

export interface CommandOutcome {
  readonly callId: string
  readonly tool: string
  readonly exitCode: number | undefined
  readonly signal?: string
  readonly isError: boolean
}

export interface SessionTokenSummary {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

export interface JoinedSessionMetricRow {
  readonly envelopeSeq: number
  readonly envelopeId: string
  readonly eventType: string
  readonly stream: string
  readonly causationId?: string
  readonly correlationId?: string
  readonly sessionId?: string
  readonly commit?: string
  readonly metricsState: 'measured' | 'partial' | 'unmeasured'
  readonly unmeasuredReason?: string
  readonly toolCalls: number | undefined
  readonly commandExitCodes: readonly CommandOutcome[]
  readonly failedCommandCount: number | undefined
  readonly durationMs: number | undefined
  readonly tokens: SessionTokenSummary | undefined
}

export interface WindowSample {
  readonly failures: number
  readonly opportunities: number
  readonly durationMs?: number
}

export interface WindowCompareOptions {
  readonly minObservationMs?: number
}

export interface WindowComparison {
  readonly verdict: 'improved' | 'unchanged' | 'regressed' | 'unmeasured'
  readonly beforeRate: number | undefined
  readonly afterRate: number | undefined
  readonly deltaRate: number | undefined
  readonly deltaFailures: number | undefined
  readonly reasons: readonly string[]
}

export interface TaskBehaviorRecord {
  readonly taskId: string
  readonly attempts: readonly { readonly at?: number; readonly outcome: 'completed' | 'failed' | 'cancelled' }[]
  readonly escalations?: number
}

export type GenericMetricReading =
  | { readonly state: 'measurable'; readonly value: number; readonly sample: number; readonly why: string }
  | { readonly state: 'unmeasured'; readonly why: string }

export interface BehavioralMetricsReading {
  readonly firstTryPassRate: GenericMetricReading
  readonly reworkRate: GenericMetricReading
  readonly escalationDensity: GenericMetricReading
  readonly executedTasks: number
}
