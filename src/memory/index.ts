/** 可信记忆系统 M1–M6 公共导出入口。 */
export {
  DEFAULT_MEMORY_BUDGETS, memoryTaintOf, ResidentBudgetExceededError,
  type AssembledMemoryPrompt, type AssemblePromptOptions, type AttentionItem,
  type AttentionKind, type AttentionProposal, type AttentionStatus,
  type AttentionTransition, type BucketReceipt, type Clearance, type Confidence,
  type DemoteResidentInput, type DemoteResidentResult,
  type FactLayer, type FactPage, type LedgerPage, type M2Kind,
  type MemoryBelievabilityMetrics, type MemoryBudgets, type MemoryEntry,
  type MemoryLayer, type MemoryPage, type MemoryPageMeta, type MemoryPageTarget,
  type MemoryProposal, type MemoryScope, type MemoryTaint,
  type PendingPatchProposal, type PromptBudgetReceipt, type ProposeTicketPatchesResult,
  type RecallCaller, type RejectedPatchCandidate, type SourceType, type Taint,
  type TickM6LifecycleResult, type TicketPatchCandidate, type TombstoneInput,
  type TombstoneResult, type TriggerKeys, type TriggerLogic,
  type UserDirectMemoryInput, type UserDirectMemoryResult,
  type WriteRejectReason, type WriteResult,
} from './types.ts'
export type { Taint as SpineTaint } from '../spine/types.ts'
export {
  assertSafeMemoryPath, assertSafeSegment, decodeMemoryPage, encodeMemoryPage,
  formatChangeLogLine, listMemoryPages, readMemoryPage, resolveMemoryRelPath,
  writeMemoryPage,
} from './codec.ts'
export { MemoryWriter, type MemoryWriterOptions } from './writer.ts'
export {
  assertResidentBudget, assembleMemoryPrompt, canCallerReadEntry, formatEntryLine,
  isAttentionVisible, isEntryActiveAt, matchesTriggerKeys,
  MEMORY_PROMPT_GUARDRAIL,
} from './recall.ts'
export { buildSmartFtsQueries, scoreTokenCoverage, tokenizeForSearch } from './text-search.ts'
export {
  MemoryFtsIndex, RECIPE_FINGERPRINT, searchM0Fallback,
  type FtsSearchHit, type FtsSearchOptions, type FtsSearchResult,
  type M0FallbackHit, type MemoryFtsIndexOptions,
} from './fts-index.ts'
export {
  computeMemoryBelievabilityMetrics, loadWorkspacePitfallNotes,
  proposeTicketMemoryPatches, tickM6AttentionLifecycle, writeUserDirectMemory,
} from './lifecycle.ts'
export {
  callerFromPolicy, canPolicyDirectOverride, createGroupBotMemoryPolicy, createSecretaryMemoryPolicy,
  type PersistentBotMemoryPolicy,
} from './policy.ts'
export {
  TRANSCRIPT_RECIPE_FINGERPRINT, TranscriptFtsIndex,
  type TranscriptFtsOptions, type TranscriptHit,
} from './transcript-fts.ts'
export {
  extractSessionText, isInjectedSystemContext, readUnextractedSessionWindow, renderEpochStateAnchor,
  type SessionDialogLine, type SessionWindowSlice,
} from './session-window.ts'
export {
  DELTA_PROMPT_GUARDRAIL, EpochMemoryInjector,
  type EpochMemoryInjectorOptions, type TurnDeltaResult,
} from './epoch-injector.ts'
export {
  createHostDreamExtractor,
  type DreamExtractCandidate, type DreamExtractOutcome, type DreamExtractorFn,
} from './dreamer-llm.ts'
export { runDeepConsolidation, type DeepConsolidationReport } from './dreamer-deep.ts'
export {
  MemoryDreamer,
  type DreamCursorState, type DreamRunReport, type DreamStatusSummary, type MemoryDreamerOptions,
} from './dreamer.ts'
export {
  evaluateMemoryGoldSet,
  type GoldCaseBucket, type GoldEvalCase, type GoldEvalReport, type GoldSeedEntry,
} from './gold-eval.ts'
