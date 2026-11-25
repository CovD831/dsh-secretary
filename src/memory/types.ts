/** 可信记忆系统 M1–M6 公共类型契约（双时态溯源、M6 注意力账本与预算账单）。 */
import type { SourceRef, Taint as SpineTaint } from '../spine/types.ts'
import type { MemoryFtsIndex } from './fts-index.ts'

export type MemoryLayer = 'm1' | 'm2' | 'm3' | 'm4' | 'm6'
export type FactLayer = Exclude<MemoryLayer, 'm6'>
export type MemoryScope = 'global' | `workspace:${string}` | `person:${string}`
export type SourceType = 'user_direct' | 'user_ruling' | 'session' | 'external_doc' | 'inference'
export type Confidence = 'stated' | 'corroborated' | 'inferred'
export type Taint = 'clean' | 'external_untrusted'
export type MemoryTaint = Taint
export type Clearance = 'public' | 'workspace' | 'private'

export function memoryTaintOf(taint: SpineTaint): Taint {
  return taint === 'untrusted' ? 'external_untrusted' : 'clean'
}
export type TriggerLogic = 'AND_ANY' | 'AND_ALL' | 'NOT_ANY' | 'NOT_ALL'
export type M2Kind = 'preference' | 'veto' | 'shared_event' | 'internal_moniker' | 'correction_repair'

export interface TriggerKeys {
  primary: readonly string[]
  secondary?: readonly string[]
  logic?: TriggerLogic
}

export interface MemoryEntry {
  id: string
  statement: string
  scope: MemoryScope
  sourceType: SourceType
  sourceRef: SourceRef
  observedAt: string
  validFrom: string
  validTo?: string
  supersedes?: string
  invalidatedBy?: string
  invalidationReason?: string
  confidence: Confidence
  author: string
  taint: Taint
  clearance: Clearance
  topicKey?: string
  verbatimQuote?: string
  workspacesSeen?: readonly string[]
  seenCount?: number
  importance?: number
  lastAccessedAt?: string
  triggerKeys?: TriggerKeys
  m2Kind?: M2Kind
  resident?: boolean
}

export type AttentionKind = 'ruling' | 'conflict' | 'verification' | 'deposit-proposal'
export type AttentionStatus = 'pending' | 'asked' | 'approved' | 'dismissed' | 'expired'

export interface AttentionItem {
  id: string
  kind: AttentionKind
  status: AttentionStatus
  question: string
  sourceRefs: readonly SourceRef[]
  conflictingEntryIds?: readonly string[]
  clearance?: Clearance
  stickyTurns: number
  cooldownMs: number
  delaySeen: number
  seenCount: number
  remainingStickyTurns?: number
  cooldownUntil?: string
  updatedAt: string
}

export interface MemoryPageMeta {
  version: 1
  layer: MemoryLayer
  pageKey: string
  scope: MemoryScope
  revision: number
  updatedAt: string
}

export interface FactPage extends MemoryPageMeta {
  layer: FactLayer
  entries: MemoryEntry[]
  changeLog: string[]
}

export interface LedgerPage extends MemoryPageMeta {
  layer: 'm6'
  items: AttentionItem[]
  changeLog: string[]
}

export type MemoryPage = FactPage | LedgerPage

export interface MemoryPageTarget {
  layer: MemoryLayer
  slug?: string
  workspaceKey?: string
}

export interface MemoryProposal {
  layer: FactLayer
  slug?: string
  workspaceKey?: string
  statement: string
  scope: MemoryScope
  sourceType: SourceType
  sourceRef: SourceRef
  author: string
  observedAt?: string
  validFrom?: string
  confidence?: Confidence
  taint?: Taint
  clearance?: Clearance
  topicKey?: string
  verbatimQuote?: string
  evidenceText?: string
  workspacesSeen?: readonly string[]
  seenCount?: number
  importance?: number
  lastAccessedAt?: string
  triggerKeys?: TriggerKeys
  m2Kind?: M2Kind
  resident?: boolean
  overrideTombstone?: boolean
  invalidationReason?: string
  expectedRevision?: number
}

export type WriteRejectReason =
  | 'secret-detected'
  | 'missing-source-ref'
  | 'unknown-source-ref'
  | 'caller-id-forbidden'
  | 'invalid-input'
  | 'scope-mismatch'
  | 'm4-threshold-not-met'
  | 'tombstone-blocked'
  | 'verbatim-quote-mismatch'
  | 'revision-conflict'
  | 'resident-budget-exceeded'

export type WriteResult =
  | {
    kind: 'accepted'
    entry: MemoryEntry
    pagePath: string
    supersededIds: readonly string[]
    commit?: string
  }
  | {
    kind: 'rejected'
    reason: WriteRejectReason
    detail: string
    attentionItem?: AttentionItem
    commit?: string
  }
  | {
    kind: 'conflict'
    reason: 'topic-conflict'
    detail: string
    conflictingEntryIds: readonly string[]
    attentionItem: AttentionItem
    commit?: string
  }

export interface TombstoneInput {
  target: Omit<MemoryPageTarget, 'layer'> & { layer: FactLayer }
  entryId: string
  reason: string
  sourceRef: SourceRef
  author: string
}

export interface TombstoneResult {
  entry: MemoryEntry
  pagePath: string
  commit?: string
}

export interface AttentionProposal {
  kind: AttentionKind
  question: string
  sourceRefs: readonly SourceRef[]
  conflictingEntryIds?: readonly string[]
  clearance?: Clearance
  stickyTurns?: number
  cooldownMs?: number
  delaySeen?: number
  seenCount?: number
}

export interface AttentionTransition {
  id: string
  action: 'ask' | 'tick' | 'approve' | 'dismiss' | 'expire' | 'seen'
}

export interface RecallCaller {
  role: 'secretary' | 'worker'
  workspaceId?: string
  maxClearance: Clearance
}

export interface MemoryBudgets {
  residentMaxChars: number
  triggeredMaxChars: number
  retrievedMaxChars: number
  attentionMaxChars: number
}

export const DEFAULT_MEMORY_BUDGETS: MemoryBudgets = {
  residentMaxChars: 2200,
  triggeredMaxChars: 2000,
  retrievedMaxChars: 2000,
  attentionMaxChars: 1200,
}

export interface BucketReceipt {
  budgetChars: number
  usedChars: number
  includedIds: readonly string[]
  droppedIds: readonly string[]
}

export interface PromptBudgetReceipt {
  totalChars: number
  resident: BucketReceipt
  triggered: BucketReceipt
  retrieved: BucketReceipt
  attention: BucketReceipt
}

export interface AssemblePromptOptions {
  dir: string
  caller: RecallCaller
  query: string
  recentMessages?: readonly string[]
  now?: Date | string
  budgets?: Partial<MemoryBudgets>
  halfLifeDays?: number
  rrfK?: number
  ftsIndex?: MemoryFtsIndex
}

export interface AssembledMemoryPrompt {
  text: string
  receipt: PromptBudgetReceipt
  residentEntries: readonly MemoryEntry[]
  triggeredEntries: readonly MemoryEntry[]
  retrievedEntries: readonly MemoryEntry[]
  attentionItems: readonly AttentionItem[]
}

/** 常驻记忆超出预算硬封顶时抛出的结构化错误，逼迫触发巩固而非静默截断。 */
export class ResidentBudgetExceededError extends Error {
  readonly code = 'resident-budget-exceeded' as const
  readonly usedChars: number
  readonly maxChars: number
  readonly entryIds: readonly string[]

  constructor(usedChars: number, maxChars: number, entryIds: readonly string[]) {
    super(`resident-budget-exceeded: used ${usedChars} chars > max ${maxChars} chars`)
    this.name = 'ResidentBudgetExceededError'
    this.usedChars = usedChars
    this.maxChars = maxChars
    this.entryIds = entryIds
  }
}

export interface UserDirectMemoryInput {
  readonly statement: string; readonly layer?: 'm1' | 'm2' | 'm3'; readonly slug?: string; readonly workspaceKey?: string
  readonly scope?: MemoryScope; readonly topicKey?: string; readonly m2Kind?: M2Kind; readonly clearance?: Clearance
  readonly resident?: boolean; readonly importance?: number; readonly triggerKeys?: TriggerKeys
  readonly overrideTombstone?: boolean; readonly expectedRevision?: number; readonly invalidationReason?: string
  readonly eventId?: string; readonly actorRef?: string; readonly now?: Date | string
}
export interface UserDirectMemoryResult { readonly sourceRef: SourceRef; readonly writeResult: WriteResult; readonly tombstonedIds: readonly string[] }
export interface TicketPatchCandidate {
  readonly layer: FactLayer; readonly slug?: string; readonly workspaceKey?: string; readonly statement: string
  readonly scope: MemoryScope; readonly sourceType?: SourceType; readonly sourceRef: SourceRef; readonly author?: string
  readonly topicKey?: string; readonly patternKey?: string; readonly verbatimQuote?: string; readonly evidenceText?: string
  readonly workspacesSeen?: readonly string[]; readonly seenCount?: number; readonly triggerKeys?: TriggerKeys
  readonly importance?: number; readonly clearance?: Clearance; readonly resident?: boolean
}
export type PendingPatchProposal = MemoryProposal & { readonly expectedRevision: number; readonly targetRelPath: string }
export interface RejectedPatchCandidate { readonly candidate: TicketPatchCandidate; readonly reason: string; readonly detail: string }
export interface ProposeTicketPatchesResult {
  readonly proposals: readonly PendingPatchProposal[]; readonly m4Proposals: readonly PendingPatchProposal[]
  readonly rejected: readonly RejectedPatchCandidate[]; readonly writeResults?: readonly WriteResult[]
}
export interface TickM6LifecycleResult {
  readonly tickedIds: readonly string[]; readonly seenIds: readonly string[]
  readonly expiredIds: readonly string[]; readonly untouchedIds: readonly string[]
}
export interface MemoryBelievabilityMetrics {
  readonly repeatQuestionRate: number; readonly falseRecallCount: number; readonly weeklyCorrectedMemories: number
  readonly totalQuestions: number; readonly repeatQuestions: number; readonly windowDays: number
}
