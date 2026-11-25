/** 可信记忆系统 M1–M6 公共导出入口。 */
export {
  memoryTaintOf, ResidentBudgetExceededError,
  type AssembledMemoryPrompt, type AssemblePromptOptions, type AttentionItem,
  type AttentionKind, type AttentionProposal, type AttentionStatus,
  type AttentionTransition, type BucketReceipt, type Clearance, type Confidence,
  type FactLayer, type FactPage, type LedgerPage, type M2Kind,
  type MemoryBudgets, type MemoryEntry, type MemoryLayer, type MemoryPage,
  type MemoryPageMeta, type MemoryPageTarget, type MemoryProposal,
  type MemoryScope, type MemoryTaint, type PromptBudgetReceipt, type RecallCaller,
  type SourceType, type Taint, type TombstoneInput, type TombstoneResult,
  type TriggerKeys, type TriggerLogic, type WriteRejectReason, type WriteResult,
} from './types.ts'
export type { Taint as SpineTaint } from '../spine/types.ts'
export {
  assertSafeMemoryPath, assertSafeSegment, decodeMemoryPage, encodeMemoryPage,
  formatChangeLogLine, listMemoryPages, readMemoryPage, resolveMemoryRelPath,
  writeMemoryPage,
} from './codec.ts'
export { MemoryWriter, type MemoryWriterOptions } from './writer.ts'
export {
  assembleMemoryPrompt, canCallerReadEntry, DEFAULT_MEMORY_BUDGETS,
  isAttentionVisible, isEntryActiveAt, matchesTriggerKeys,
  MEMORY_PROMPT_GUARDRAIL,
} from './recall.ts'
