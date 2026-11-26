/** RSI 离线回放、指针桥接与零耦合评估器公共契约。 */
import type { DepositDraft } from '../authoring/types.ts'
import type { EvaluationReading, Point } from '../judgement/types.ts'
import type { EvidenceRef, SourceRef, SpineDraft, SpineSource, Taint } from '../spine/types.ts'
import type { Verdict } from '../judgement/types.ts'

export type ExpectedOutcome = 'defect' | 'clean' | 'unknown'
export type SplitBucket = 'train' | 'validation' | 'holdout'

export interface SessionEventPtr {
  readonly sessionId: string
  readonly seq?: number
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
  readonly sessionFromSeq?: number
  readonly sessionToSeq?: number
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

export type SessionStepPhase = 'locate' | 'edit' | 'verify' | 'report' | 'other'
export interface SessionStepTrace {
  readonly stepIndex: number; readonly tool: string; readonly phase: SessionStepPhase
  readonly skeleton: string; readonly isError: boolean; readonly exitCode?: number
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
  readonly steps?: readonly SessionStepTrace[]
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

export type NaturalBackfillLabel =
  | 'L1:verify_failed' | 'L2:gate_denied_fixed' | 'L3:rework_retry' | 'L4:circuit_broken'
  | 'L5:tool_error' | 'L6:escalation_queued' | 'L7:ruling_decided' | 'L8:memory_rejected'
  | 'L9:memory_corrected' | 'L10:recall_dropped' | 'L11:unmeasured_gap' | 'L12:external_taint'
  | 'L13:draft_abandoned'
export type FourWayAttribution = 'missing_rule' | 'wrong_rule' | 'unmeasurable' | 'rule_conflict'
export type CalibratedDecision = 'allow' | 'deterministic_gate' | 'block' | 'ask'

export interface CalibratedGateRecord {
  readonly gateId: string
  readonly callId: string
  readonly ticketId: string
  readonly rawScore: number
  readonly calibratedProb: number
  readonly thresholdBand: readonly [number, number]
  readonly decision: CalibratedDecision
  readonly groundTruthBackfill?: 'clean' | 'defect'
}

export interface LabelledEventRecord {
  readonly seq: number; readonly id: string; readonly at: string; readonly ticketId?: string
  readonly label: NaturalBackfillLabel; readonly attribution?: FourWayAttribution
  readonly clusterKey?: string; readonly point?: string; readonly toolName?: string
}

export interface AttributionSummary {
  readonly counts: Readonly<Record<FourWayAttribution, number>>
  readonly totalAttributed: number; readonly totalTickets: number; readonly totalToolExecutions: number
  readonly ratePerTicket: Readonly<Record<FourWayAttribution, number | undefined>>
  readonly ratePerToolExecution: Readonly<Record<FourWayAttribution, number | undefined>>
}

export interface FrictionCluster {
  readonly key: string; readonly category: string; readonly point?: string; readonly toolName?: string
  readonly attribution?: FourWayAttribution; readonly seenCount: number; readonly distinctDays: readonly string[]
  readonly refs: readonly SourceRef[]; readonly qualifiesForRung1: boolean; readonly draft?: DepositDraft
}

export interface OnlineCollectionResult {
  readonly eventCount: number; readonly labelHits: readonly LabelledEventRecord[]
  readonly labelCounts: Readonly<Record<NaturalBackfillLabel, number>>
  readonly taskRecords: readonly TaskBehaviorRecord[]; readonly behavioralMetrics: BehavioralMetricsReading
  readonly replayCases: readonly ReplayCase[]; readonly joinedSessionMetrics: readonly JoinedSessionMetricRow[]
  readonly attribution: AttributionSummary; readonly clusters: readonly FrictionCluster[]
  readonly candidateDrafts: readonly DepositDraft[]; readonly minedSopDrafts?: readonly DepositDraft[]
  readonly calibratedRecords: readonly CalibratedGateRecord[]
  readonly effectivenessReading: EvaluationReading; readonly windowComparison: WindowComparison
}

export interface BootstrapCIResult {
  readonly verdict: 'improved' | 'regressed' | 'unmeasured'; readonly mean: number | undefined
  readonly lower: number | undefined; readonly upper: number | undefined
  readonly confidenceLevel: number; readonly seeds: readonly (number | string)[]; readonly sampleSize: number
  readonly crossesZero: boolean; readonly reason: string
}

export interface HoldoutEvaluationResult {
  readonly promoted: boolean; readonly verdict: EvaluationReading['verdict']; readonly trainDelta: number
  readonly holdoutDelta: number; readonly generalizationRatio: number | undefined
  readonly baselineTrain: ReplayReportCard; readonly candidateTrain: ReplayReportCard
  readonly baselineHoldout: ReplayReportCard; readonly candidateHoldout: ReplayReportCard
  readonly holdoutCI: BootstrapCIResult; readonly windowComparison: WindowComparison
  readonly reading: EvaluationReading; readonly auditEvent: SpineDraft<Record<string, unknown>>; readonly reason: string
}

export interface AblationCase {
  readonly id: string; readonly family: string; readonly point?: Point; readonly input: unknown
  readonly expectedOutcome: ExpectedOutcome; readonly tokens?: number; readonly durationMs?: number
}

export interface LeaveOneOutGateImpact {
  readonly gateId: string; readonly stage: string; readonly evaluations: number; readonly uniqueCatches: number
  readonly ablatedReport: ReplayReportCard; readonly deltaBenefit: number; readonly deltaFalseBlocks: number
  readonly savedTokens: number; readonly savedMs: number; readonly redundant: boolean; readonly harmful: boolean
}

export interface RuleConflictPair {
  readonly gateA: string; readonly gateB: string; readonly caseIds: readonly string[]
  readonly conflictType: 'allow-vs-deny' | 'false-block-override'; readonly detail: string
}

export interface LeaveOneOutResult {
  readonly baseline: ReplayReportCard; readonly impacts: readonly LeaveOneOutGateImpact[]
  readonly redundantGateIds: readonly string[]; readonly harmfulGateIds: readonly string[]
  readonly conflicts: readonly RuleConflictPair[]
}

export interface TemperatureScaler {
  readonly temperature: number; readonly bias: number; readonly inputSpace: 'probability' | 'logit'
  readonly fitted: boolean; readonly sampleCount: number; readonly lossBefore: number; readonly lossAfter: number
}

export interface CalibrationBin {
  readonly binIndex: number; readonly lower: number; readonly upper: number
  readonly count: number; readonly avgConfidence: number; readonly empiricalRate: number
}

export interface ExpectedCalibrationReport {
  readonly state: 'measured' | 'unmeasured'; readonly ece: number | undefined; readonly rawEce?: number
  readonly totalLabeled: number; readonly numBins: number; readonly bins: readonly CalibrationBin[]; readonly reason?: string
}
