/** 可信记忆系统 M1–M6 公共导出入口。 */
export {
  DEFAULT_MEMORY_BUDGETS, memoryTaintOf, ResidentBudgetExceededError,
  type AssembledMemoryPrompt, type AssemblePromptOptions, type AttentionItem,
  type AttentionKind, type AttentionProposal, type AttentionStatus,
  type AttentionTransition, type BucketReceipt, type Clearance, type Confidence,
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
export {
  MemoryFtsIndex, RECIPE_FINGERPRINT, searchM0Fallback, tokenizeForSearch,
  type FtsSearchHit, type FtsSearchOptions, type FtsSearchResult,
  type M0FallbackHit, type MemoryFtsIndexOptions,
} from './fts-index.ts'
export {
  computeMemoryBelievabilityMetrics, loadWorkspacePitfallNotes,
  proposeTicketMemoryPatches, tickM6AttentionLifecycle, writeUserDirectMemory,
} from './lifecycle.ts'
