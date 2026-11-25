import type { DepositManifest, ParamSpec, Stage, UnmeasuredCause, Verdict } from '../judgement/types.ts'
import type { EvidenceRef, SourceRef, SpineDraft } from '../spine/types.ts'

export type AttributionCategory = 'env_transient' | 'exec_mistake' | 'gate_gap' | 'mandate_unclear'
export type RulingDecision = 'approve' | 'reject' | 'revise'

export interface EscalationRuling {
  readonly escalationId: string
  readonly ticketId: string
  readonly operatorOpenId: string
  readonly decision: RulingDecision
  readonly attribution: AttributionCategory
  readonly note?: string
  readonly captureAsRule?: boolean
  readonly sourceRef: SourceRef
  readonly decidedAt: string
}

export interface PendingEscalationRuling {
  readonly escalationId: string
  readonly ticketId: string
  readonly operatorOpenId: string
  readonly decision: RulingDecision
  readonly attribution: AttributionCategory
  readonly note?: string
  readonly captureAsRule?: boolean
  readonly decidedAt: string
}

export type AuthoringStage = 'S0_capture' | 'S1_draft' | 'S2_cases' | 'S3_replay' | 'S4_shadow'
export type DepositKind = DepositManifest['kind']
export type MandateCeiling = 'L0' | 'L1' | 'L2' | 'L3'

export interface DepositFixtureCase {
  readonly name: string
  readonly expected: Verdict['kind']
  readonly ctx: unknown
  readonly expectedCause?: UnmeasuredCause
  readonly note?: string
}

export interface DepositTriggerDraft {
  readonly on: string
  readonly workspace?: string
  readonly globs?: readonly string[]
  readonly mode: 'always' | 'on-event' | 'scheduled-sweep'
  readonly signal?: string
}

export interface DepositDraft {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly author: string
  readonly scope: 'private' | `workspace:${string}` | 'public'
  readonly kind: DepositKind
  readonly level: 'object' | 'meta'
  readonly point: string
  readonly trigger: DepositTriggerDraft
  readonly requires: readonly string[]
  readonly params: Readonly<Record<string, ParamSpec>>
  readonly exceptions: readonly string[]
  readonly repairHint: string
  readonly intent: string
  readonly rubricBody: string
  readonly enforce?: boolean
  readonly stage?: Stage
  readonly mandateCeiling?: MandateCeiling
  readonly actionClass: 'observe' | 'block' | 'side-effecting'
  readonly mandateRef?: string
  readonly action?: { readonly name: string; readonly params?: unknown }
  readonly origin: { readonly kind: 'user-authored' | 'friction-mined' | 'forked'; readonly refs?: readonly string[] }
  readonly cases: readonly DepositFixtureCase[]
  readonly unansweredSlots?: readonly string[]
}

export type SpineInput<P = unknown> = SpineDraft<P>

interface TelemetryBase {
  readonly id?: string
  readonly draftId: string
  readonly at: string
  readonly actorId: string
  readonly stage?: AuthoringStage
  readonly evidence?: readonly EvidenceRef[]
}

export type AuthoringTelemetryEvent =
  | (TelemetryBase & { readonly kind: 'deposit_attempted'; readonly origin: DepositDraft['origin']['kind'] })
  | (TelemetryBase & { readonly kind: 'draft_created'; readonly depositKind: DepositKind; readonly scope: DepositDraft['scope'] })
  | (TelemetryBase & { readonly kind: 'fixtures_labeled'; readonly positiveCount: number; readonly negativeCount: number })
  | (TelemetryBase & { readonly kind: 'replay_viewed'; readonly catches: number; readonly falseBlocks: number; readonly misses: number; readonly totalCases: number })
  | (TelemetryBase & { readonly kind: 'shadow_installed'; readonly version: number })
  | (TelemetryBase & { readonly kind: 'abandoned_at'; readonly atStage: AuthoringStage; readonly reason?: string })
  | (TelemetryBase & { readonly kind: 'admission_rejected'; readonly ruleId: string; readonly field: string; readonly reason: string })

export type FeishuCardElement = Readonly<Record<string, unknown>>

export interface FeishuCardPayload {
  readonly schema: '2.0'
  readonly config: { readonly update_multi: boolean; readonly wide_screen_mode?: boolean }
  readonly header?: {
    readonly template?: string
    readonly title: { readonly tag: 'plain_text'; readonly content: string }
  }
  readonly body: { readonly elements: readonly FeishuCardElement[] }
}

export interface BuiltFeishuCard {
  readonly card: FeishuCardPayload
  readonly issuedAt: string
  readonly expiresAt: string
  readonly byteLength: number
  readonly truncated: boolean
}

export interface EscalationCardRequest {
  readonly escalationId: string
  readonly ticketId: string
  readonly title: string
  readonly summary: string
  readonly detailUrl?: string
  readonly issuedAt: string
  readonly sourceRef?: SourceRef
  readonly defaultAttribution?: AttributionCategory
}

export interface ExpiredCardMeta {
  readonly request: EscalationCardRequest
  readonly oldCardId?: string
  readonly oldMessageId?: string
  readonly now?: string
}

export interface FeishuCardCallbackResponse {
  readonly toast: { readonly type: 'success' | 'info' | 'warning'; readonly content: string }
  readonly card?: FeishuCardPayload
}

export type FeishuCallbackParseResult =
  | {
      readonly ok: true
      readonly duplicate: boolean
      readonly callbackId: string
      readonly operatorOpenId: string
      readonly pendingRuling?: PendingEscalationRuling
      readonly ruling?: EscalationRuling
      readonly response: FeishuCardCallbackResponse
    }
  | { readonly ok: false; readonly reason: string }

export interface MachineGateViolation {
  readonly ruleId: string
  readonly field: string
  readonly reason: string
  readonly repairHint: string
}

export type DraftValidationResult =
  | {
      readonly ok: false
      readonly gate: 'machine'
      readonly violations: readonly MachineGateViolation[]
      readonly repairedDraft: DepositDraft
    }
  | {
      readonly ok: false
      readonly gate: 'evidence'
      readonly status: 'needs-more-samples'
      readonly missingPositive: boolean
      readonly missingNegative: boolean
      readonly positiveCount: number
      readonly negativeCount: number
      readonly message: string
    }
  | {
      readonly ok: true
      readonly gate: 'ready'
      readonly draft: DepositDraft
      readonly positiveCount: number
      readonly negativeCount: number
    }

export type EscalationRouteResult =
  | { readonly route: 'transient-retry'; readonly suppressRuleProposal: true; readonly reason: string }
  | { readonly route: 'workspace-memory-proposal'; readonly layer: 'm3'; readonly sourceRef: SourceRef; readonly title: string; readonly summary: string; readonly workspace?: string }
  | { readonly route: 'deposit-draft'; readonly draft: DepositDraft; readonly sourceRef: SourceRef }
  | { readonly route: 'user-ruling-memory-proposal'; readonly layer: 'm2'; readonly sourceRef: SourceRef; readonly title: string; readonly summary: string; readonly workspace?: string }

export interface AuthoringMemoryProposal {
  readonly layer: 'm2' | 'm3'
  readonly slug?: string
  readonly workspaceKey?: string
  readonly statement: string
  readonly scope: 'global' | `workspace:${string}` | `person:${string}`
  readonly sourceType: 'user_ruling'
  readonly sourceRef: SourceRef
  readonly author: 'user'
  readonly confidence: 'stated'
  readonly taint: 'clean'
  readonly clearance: 'public' | 'workspace' | 'private'
  readonly m2Kind?: 'preference' | 'veto' | 'shared_event' | 'internal_moniker' | 'correction_repair'
}

export interface MemoryProposalContext {
  readonly workspaceId?: string
  readonly slug?: string
  readonly clearance?: 'public' | 'workspace' | 'private'
  readonly m2Kind?: 'preference' | 'veto' | 'shared_event' | 'internal_moniker' | 'correction_repair'
}

export interface WrittenDepositPackage {
  readonly packageDir: string
  readonly depositMdPath: string
  readonly casesPath: string
}
