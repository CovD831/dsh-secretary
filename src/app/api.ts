/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type {
  DepositsProjectionView,
  NotebookProjectionView,
  SpineProjectionView,
  StateProjectionView,
} from '../projection/types.ts'
import type { DecideRulingInput, RulingItem, RulingStatus } from './ruling-queue.ts'
import type { SecretaryFeedEntry } from './tools/secretary-core.ts'
import type {
  HoldoutEvaluationResult, LeaveOneOutResult, MemoryStudioView, RsiWorkbenchView,
  TransitionDepositStageResult, UserDirectMemoryResult, WriteResult,
} from './http-governance.ts'
import type { DiscoveredDepositRecord, Stage } from '../judgement/index.ts'
import type { AvatarPackSummary } from './avatar-pipeline.ts'
import type { TicketTranscriptView } from './transcript-reader.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'GET tickets/:id/transcript': { query?: { limit?: number }; response: TicketTranscriptView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
  'GET projection/state': { response: StateProjectionView }
  'GET projection/notebook': { response: NotebookProjectionView }
  'GET projection/spine': { query?: { sinceSeq?: number; limit?: number; ticketId?: string; type?: string }; response: SpineProjectionView }
  'GET projection/deposits': { response: DepositsProjectionView }
  'GET rulings': { query?: { status?: RulingStatus }; response: { active: RulingItem | null; pendingCount: number; items: RulingItem[] } }
  'POST rulings/:id/decide': { body: Omit<DecideRulingInput, 'id' | 'actorId'> & { actorId?: string }; response: { ok: boolean; item?: RulingItem; duplicate?: boolean; reason?: string } }
  'GET secretary/feed': { response: { items: SecretaryFeedEntry[]; activeRuling: RulingItem | null; pendingCount: number } }
  'POST secretary/messages': { body: { text: string; threadId?: string }; response: { triggerId: string; received: string } }
  'GET deposits/ledger': { response: { records: readonly DiscoveredDepositRecord[]; markdown: string } }
  'POST deposits/:id/stage': { body: { toStage: Stage; reason?: string }; response: TransitionDepositStageResult }
  'GET memory/studio': { response: MemoryStudioView }
  'POST memory/direct': {
    body: {
      layer?: 'm1' | 'm2' | 'm3' | 'm4'; slug?: string; workspaceKey?: string; statement: string; scope?: string
      topicKey?: string; m2Kind?: 'preference' | 'veto' | 'shared_event' | 'internal_moniker' | 'correction_repair'
      clearance?: 'public' | 'workspace' | 'private'; resident?: boolean; importance?: number
      overrideTombstone?: boolean; expectedRevision?: number; invalidationReason?: string
    }
    response: UserDirectMemoryResult
  }
  'POST memory/patches/:index': { body: { decision: 'approve' | 'dismiss' }; response: { ok: boolean; writeResult?: WriteResult; reason?: string } }
  'GET rsi/workbench': { response: RsiWorkbenchView }
  'POST rsi/ablation': {
    body: { cases: { id: string; family: string; input: unknown; expectedOutcome: 'defect' | 'clean' | 'unknown'; point?: string }[] }
    response: LeaveOneOutResult
  }
  'POST rsi/holdout': {
    body: { candidateId: string; point: string; cases: { id: string; family: string; input: unknown; expectedOutcome: 'defect' | 'clean' | 'unknown' }[] }
    response: { ok: true; result: HoldoutEvaluationResult } | { ok: false; reason: string }
  }
  'GET pixel-office/proof': { response: { workspaceId: string; seed: number; width: number; height: number; paletteColors: number; html: string } }
  'GET avatars': { response: { activeId: string; items: AvatarPackSummary[] } }
  'POST avatars/select': { body: { avatarId: string }; response: { ok: boolean; activeId: string } }
  'POST avatars/generate': { body: { name: string; prompt: string; seed?: number }; response: { ok: boolean; pack?: AvatarPackSummary; error?: string } }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
