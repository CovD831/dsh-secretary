/** 可信记忆系统 M1–M6 公共类型契约（双时态溯源、M6 注意力账本与预算账单）。 */
import type { SourceRef, Taint as SpineTaint } from '../spine/types.ts'

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
