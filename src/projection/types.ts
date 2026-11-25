/** 只读投影层公共类型契约（纯类型与纯常量，严禁导入任何 node:* 模块）。 */
import type { DepositManifest, Stage } from '../judgement/types.ts'
import type { AttentionItem, AttentionKind, AttentionStatus, MemoryEntry } from '../memory/types.ts'
import type { SourceRef, SpineEnvelope } from '../spine/types.ts'

export const AVATAR_POSTURES = [
  'paused_standby',
  'alert_fault',
  'raising_hand',
  'morning_briefing',
  'working_desk',
  'night_watch',
  'patrol_idle',
] as const

export const AVATAR_ZONES = ['secretary_counter', 'desk', 'board', 'lounge'] as const
export const AVATAR_SHIFTS = ['day', 'morning', 'night'] as const

export type AvatarPosture = typeof AVATAR_POSTURES[number]
export type AvatarZone = typeof AVATAR_ZONES[number]
export type AvatarShift = typeof AVATAR_SHIFTS[number]

export type DeviationKind =
  | 'ticket_failed'
  | 'ticket_blocked'
  | 'm6_conflict'
  | 'm6_ruling'
  | 'm6_verification'
  | 'person_waiting'

export type DeviationPriority = 'critical' | 'high' | 'medium'

export interface AvatarDeviation {
  readonly kind: DeviationKind
  readonly priority: DeviationPriority
  readonly ticketId?: string
  readonly attentionId?: string
  readonly sourceRef: SourceRef | null
  readonly summary: string
}

export type BarkCode =
  | 'BARK_DEVIATION_FAILED'
  | 'BARK_DEVIATION_BLOCKED'
  | 'BARK_M6_CONFLICT'
  | 'BARK_M6_RULING'
  | 'BARK_M6_VERIFICATION'
  | 'BARK_PERSON_WAITING'
  | 'BARK_MORNING_BRIEFING'
  | 'BARK_NIGHT_WATCH'
  | 'BARK_M2_MONIKER'
  | 'BARK_WORKING_TICKET'
  | 'BARK_RECENT_SPINE_EVENT'

export interface AvatarBark {
  readonly code: BarkCode
  readonly textZh: string
  readonly textEn: string
  readonly sourceRef: SourceRef
}

export interface TicketStateRef {
  readonly id: string
  readonly title?: string
  readonly action?: string
  readonly updatedAt?: string
  readonly sourceRef?: SourceRef
}

export interface AttentionRefItem {
  readonly id: string
  readonly kind: AttentionKind
  readonly status: AttentionStatus
  readonly question: string
  readonly sourceRefs: readonly SourceRef[]
  readonly updatedAt: string
}

export type SpineEventRef = Pick<SpineEnvelope, 'seq' | 'id' | 'at' | 'stream' | 'type' | 'payload'>
export type M2MonikerRef = Pick<MemoryEntry, 'id' | 'statement' | 'sourceRef' | 'm2Kind' | 'validTo' | 'invalidatedBy'> & { readonly validFrom?: string }

export interface AvatarStateInput {
  readonly workingCount: number
  readonly personWaitingTickets: readonly TicketStateRef[]
  readonly failedTickets: readonly TicketStateRef[]
  readonly blockedTickets: readonly TicketStateRef[]
  readonly pendingConflicts: number
  readonly pendingRulings: number
  readonly pendingVerifications: number
  readonly paused: boolean
  readonly now: Date
  readonly timezoneOffsetMinutes?: number
  readonly timeZone?: string
  readonly attentionItems?: readonly AttentionRefItem[]
  readonly recentSpineEvents?: readonly SpineEventRef[]
  readonly m2Monikers?: readonly M2MonikerRef[]
}

export interface AvatarCounts {
  readonly failed: number
  readonly blocked: number
  readonly personWaiting: number
  readonly working: number
  readonly pendingConflicts: number
  readonly pendingRulings: number
  readonly pendingVerifications: number
}

export interface AvatarProjectionState {
  readonly posture: AvatarPosture
  readonly zone: AvatarZone
  readonly shift: AvatarShift
  readonly paused: boolean
  readonly workingCount: number
  readonly deviation: AvatarDeviation | null
  readonly bark: AvatarBark | null
  readonly counts: AvatarCounts
}

export interface ScheduleItem {
  readonly id: string
  readonly kind: 'ruling_queue' | 'active_tickets' | 'morning_briefing' | 'consolidation_window'
  readonly window: string
  readonly titleZh: string
  readonly titleEn: string
  readonly status: 'active' | 'pending' | 'scheduled'
  readonly count: number
  readonly sourceRefs: readonly SourceRef[]
  readonly ticketIds?: readonly string[]
  readonly attentionIds?: readonly string[]
}

export interface StateProjectionView {
  readonly avatar: AvatarProjectionState
  readonly schedule: readonly ScheduleItem[]
  readonly updatedAt: string
}

export interface NotebookItem extends AttentionItem {
  readonly due: boolean
  readonly cooldownExpired: boolean
}

export interface NotebookCounts {
  readonly total: number
  readonly pending: number
  readonly asked: number
  readonly resolved: number
  readonly conflicts: number
  readonly rulings: number
  readonly verifications: number
  readonly depositProposals: number
  readonly dueReminders: number
}

export interface NotebookProjectionView {
  readonly exists: boolean
  readonly revision: number
  readonly updatedAt: string | null
  readonly counts: NotebookCounts
  readonly groups: {
    readonly pending: readonly NotebookItem[]
    readonly asked: readonly NotebookItem[]
    readonly resolved: readonly NotebookItem[]
  }
}

export interface SpineQuery {
  readonly sinceSeq?: number
  readonly limit?: number
  readonly ticketId?: string
  readonly type?: string
}

export interface SpineProjectionView {
  readonly items: readonly SpineEnvelope[]
  readonly totalMatched: number
  readonly headSeq: number
  readonly nextSinceSeq: number | null
  readonly hasMore: boolean
}

export interface DepositGateStats {
  readonly triggers: number
  readonly allow: number
  readonly deny: number
  readonly unmeasured: number
  readonly lastEvaluatedAt?: string
  readonly lastRef?: SourceRef
}

export interface DepositProjectionItem {
  readonly id: string
  readonly dirName: string
  readonly source: 'builtin' | 'state'
  readonly admitted: boolean
  readonly version?: number
  readonly kind?: DepositManifest['kind']
  readonly point?: string
  readonly stage?: Stage
  readonly trust?: DepositManifest['trust']
  readonly enforce?: boolean
  readonly params?: DepositManifest['params']
  readonly casesCount: number
  readonly violations?: readonly { readonly rule: string; readonly field: string; readonly reason: string }[]
  readonly stats: DepositGateStats
}

export interface DepositsProjectionView {
  readonly total: number
  readonly admittedCount: number
  readonly totalTriggers: number
  readonly allowCount: number
  readonly denyCount: number
  readonly unmeasuredCount: number
  readonly items: readonly DepositProjectionItem[]
}
