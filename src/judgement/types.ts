import type { Strength } from '../core/model.ts'
import type { SourceRef } from '../spine/types.ts'
import type { PathsOf } from './paths.ts'

export type { SourceRef }

export interface ScopeCatalog {
  intake: true
  ticket: true
  tool: true
  verify: true
  outward: true
  memory: true
  deposit: true
  collection: true
  workspace: true
}

export type Scope = keyof ScopeCatalog & string

export const BASE_SCOPES: readonly Scope[] = Object.freeze([
  'intake', 'ticket', 'tool', 'verify', 'outward', 'memory', 'deposit', 'collection', 'workspace',
])

export interface PointCatalog {}
export type Point = keyof PointCatalog & `${Scope}.${string}`
type BadPoints = Exclude<keyof PointCatalog, `${Scope}.${string}`>
export const POINTS_WELL_FORMED: [BadPoints] extends [never] ? true : never = true

export type UnmeasuredCause =
  | 'missing-input'
  | 'shell-blind'
  | 'timeout'
  | 'parse-failed'
  | 'threw'
  | 'all-skipped'
  | 'evaluator-stale'
  | 'no-evidence'

export type Verdict =
  | { kind: 'allow'; produced?: Readonly<Record<string, unknown>> }
  | { kind: 'deny'; blockers: readonly [string, ...string[]] }
  | { kind: 'unmeasured'; cause: UnmeasuredCause; detail: string; disposition?: 'refuse' | 'tolerate' }

export type Placement =
  | { timing: 'pre'; enforce: boolean }
  | { timing: 'post'; enforce: false }

export type Stage = 'shadow' | 'observe' | 'enforce' | 'retired'
export type LadderRung = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export const LADDER_RUNG_NAMES = Object.freeze({
  0: 'anecdote',
  1: 'proposed',
  2: 'cases',
  3: 'shadow',
  4: 'replay-ab',
  5: 'multi-seed-ci',
  6: 'holdout',
  7: 'canary',
  8: 'loo',
  9: 'proven',
}) satisfies Record<LadderRung, string>

export type ActionClass = 'read' | 'draft' | 'local-write' | 'commit' | 'push-branch' | 'outward-post' | 'merge'
export type IsolationTier = 'I1' | 'I2' | 'I3' | 'I4' | 'I5'
export type IsolationCeiling = Readonly<Record<IsolationTier, readonly ActionClass[]>>

export const ISOLATION_CEILINGS: IsolationCeiling = Object.freeze({
  I1: Object.freeze(['read', 'draft'] as const),
  I2: Object.freeze(['read', 'draft', 'local-write', 'commit', 'push-branch'] as const),
  I3: Object.freeze(['read', 'draft', 'local-write', 'commit', 'push-branch', 'outward-post'] as const),
  I4: Object.freeze(['read', 'draft', 'local-write', 'commit', 'push-branch', 'outward-post', 'merge'] as const),
  I5: Object.freeze(['read', 'draft', 'local-write', 'commit', 'push-branch', 'outward-post', 'merge'] as const),
})

export type Requires<C> = readonly Exclude<PathsOf<C, 3>, '' | `${string}.`>[]

export interface GateDef<P extends Point = Point> {
  kind: 'gate'
  id: string
  version: number
  point: P
  description: string
  side?: 'hard' | 'soft'
  placement: Placement
  requires: Requires<PointCatalog[P]>
  appliesTo?: (ctx: PointCatalog[P]) => boolean
  gate: (ctx: PointCatalog[P]) => Verdict | Promise<Verdict>
  acceptance?: readonly [string, ...string[]]
  proof?: ProofRequirement
}

export interface SignalCatalog {
  'ticket.stale': { ticketId: string; stage: string; staleMinutes: number }
  'friction.repeated': { patternId: string; seenCount: number; distinctWorkspaces: number }
  'verify.failed': { ticketId: string; point: string; blockerCount: number }
  'ci.replay_completed': { totalCases: number; catches: number; falseBlocks: number }
}
export interface ActionCatalog {
  'proposal.create': { title?: string; draftKind?: string }
  'defect.record': { summary: string }
  'rule-defect.record': { summary: string }
  'ticket.remind': { message: string }
  'ticket.escalate': { reason: string }
  'ticket.tag': { tag: string }
}
export type SignalName = keyof SignalCatalog & string
export type ActionName = keyof ActionCatalog & string

export interface MandateBinding {
  strength: Strength
  scope: string
  ceiling: ActionClass
  isolation: IsolationTier
  policyVersion: string
}

export interface StandingOrderDef<S extends SignalName = SignalName, A extends ActionName = ActionName> {
  kind: 'standing-order'
  id: string
  version: number
  description: string
  trigger: { signal: S; match?: Partial<SignalCatalog[S]> }
  action: { name: A; params: ActionCatalog[A] }
  mandate: MandateBinding
  cooldownMs?: number
}

export type EvaluatorKey = `${string}@v${number}`

export type EvaluationReading = { reasons: readonly string[] } & (
  | { verdict: 'effective' | 'ineffective'; probability: number }
  | { verdict: 'unmeasured'; probability?: never }
)

export interface EvaluatorDef<S = unknown> {
  kind: 'evaluator'
  id: string
  version: number
  measures: string
  evaluate(s: S): EvaluationReading | Promise<EvaluationReading>
}

export interface ProofRequirement {
  evaluator: string
  minVersion?: number
  minProbability?: number
}

export interface ProofRecord {
  subject: { id: string; version: number }
  evaluator: EvaluatorKey
  reading: EvaluationReading
  at: SourceRef
}

export type AnyGateDef = [Point] extends [never] ? GateDef<never> : { [P in Point]: GateDef<P> }[Point]
export type AnyStandingOrderDef = [SignalName] extends [never]
  ? StandingOrderDef<never, never>
  : [ActionName] extends [never]
    ? StandingOrderDef<never, never>
    : { [S in SignalName]: { [A in ActionName]: StandingOrderDef<S, A> }[ActionName] }[SignalName]
export type RegistryEntry = AnyGateDef | AnyStandingOrderDef | EvaluatorDef

export type ParamSpec =
  | { type: 'number'; default?: number; min?: number; max?: number }
  | { type: 'string'; default?: string }
  | { type: 'boolean'; default?: boolean }
  | { type: 'enum'; values: readonly [string, ...string[]]; default?: string }

export type PredicateOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'matches' | 'non_empty'
export interface PathRulesConfig {
  readonly kind: 'path_rules'; readonly inputField?: string; readonly forbiddenGlobs?: readonly string[]
  readonly allowedPrefixes?: readonly string[]; readonly maxChangedFiles?: number; readonly maxChangedFilesParam?: string; readonly rejectTraversal?: boolean
}
export interface CommandCheckConfig {
  readonly kind: 'command_check'; readonly inputField?: string; readonly requiredCommands?: readonly string[]
  readonly forbidPatterns?: readonly string[]; readonly requireExitZero?: boolean
}
export interface PredicateClause {
  readonly path: string; readonly op: PredicateOp; readonly value?: unknown; readonly param?: string; readonly required?: boolean; readonly message?: string
}
export interface PredicatesConfig { readonly kind: 'predicates'; readonly mode?: 'all' | 'any'; readonly invert?: boolean; readonly clauses: readonly PredicateClause[] }
export interface WorkflowSopStep { readonly id: string; readonly requiredField?: string; readonly mustBeTrueField?: string; readonly message?: string }
export interface WorkflowSopConfig {
  readonly kind: 'workflow_sop'; readonly steps: readonly WorkflowSopStep[]; readonly signal?: SignalName
  readonly action?: { readonly name: ActionName; readonly params?: unknown }; readonly checklistField?: string
}
export type DeclarativeRule = PathRulesConfig | CommandCheckConfig | PredicatesConfig | WorkflowSopConfig
export interface DeclarativeRuleIssue { readonly field: string; readonly reason: string }

export interface DepositManifest {
  id: string
  version: number
  kind: RegistryEntry['kind'] | 'counter-rule'
  point?: Point
  trigger?: { signal: SignalName; match?: Readonly<Record<string, unknown>> }
  requires?: readonly string[]
  params: Readonly<Record<string, ParamSpec>>
  trust: 'owner' | 'collaborator' | 'public'
  prose: string
  cases: string
  proof?: ProofRequirement
  stage?: Stage
  enforce?: boolean
  placement?: Placement
  side?: 'hard' | 'soft'
  actionClass?: 'observe' | 'block' | 'side-effecting'
  action?: { name: string; params?: unknown }
  mandate?: MandateBinding
  measures?: string
  cooldownMs?: number
  rule?: DeclarativeRule
}

export interface RunEntry {
  id: string
  version: number
  outcome: Verdict['kind'] | 'skipped'
  skip?: 'not-applicable' | 'input-surface-absent'
  detail?: string
}

export interface PointEvaluation {
  point: Point
  verdict: Verdict
  registered: number
  evaluated: number
  skipped: number
  ran: readonly RunEntry[]
  observed: readonly RunEntry[]
}

export interface JudgementRegistry {
  register(entry: RegistryEntry, stage: Stage): void
  evaluate<P extends Point>(point: P, ctx: PointCatalog[P]): Promise<PointEvaluation>
  standingOrders(signal: SignalName): readonly StandingOrderDef[]
}
