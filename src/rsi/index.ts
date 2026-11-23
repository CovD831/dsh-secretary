/** RSI 离线回放、事件脊指针桥接与零耦合评估器模块统一导出。 */
export type {
  BehavioralMetricsReading,
  CommandOutcome,
  DomainEventBridgeMeta,
  ExpectedOutcome,
  FamilySplit,
  GenericMetricReading,
  JoinedSessionMetricRow,
  MarginalCostEstimate,
  ParamCandidateEvaluation,
  ParamSweepOptions,
  ParamSweepResult,
  ReplayCase,
  ReplayCaseClassification,
  ReplayCaseTrace,
  ReplayCostModel,
  ReplayGateFn,
  ReplayGateOutcome,
  ReplayOptions,
  ReplayReportCard,
  SessionEventPtr,
  SessionTokenSummary,
  SplitBucket,
  SplitRatios,
  TaskBehaviorRecord,
  WindowCompareOptions,
  WindowComparison,
  WindowSample,
} from './types.ts'
export {
  createPersistenceSessionReader,
  domainEventToSpineDraft,
  extractSessionPtr,
  joinNativeSessionMetrics,
  type SessionEventsReader,
} from './trace-bridge.ts'
export {
  assertCaseSetEquality,
  compareWindows,
  computeBehavioralMetrics,
  confidenceOf,
  splitByFamily,
  toEvaluationReading,
} from './evaluator.ts'
export {
  compareParamCandidates,
  runHistoricalReplay,
} from './replay.ts'
