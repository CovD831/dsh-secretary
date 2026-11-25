import type { Ticket } from '../core/model.ts'
import {
  ISOLATION_CEILINGS,
  type ActionClass,
  type IsolationCeiling,
  type IsolationTier,
  type Verdict,
} from '../judgement/types.ts'
import type { SourceRef } from '../spine/types.ts'

export type { IsolationCeiling }

/** 配对律：预授权上限由隔离档决定；worktree 只是物理隔离容器，不抬高安全隔离档。 */
export const ISOLATION_CEILING: IsolationCeiling = ISOLATION_CEILINGS

export interface WorkspaceDef {
  id: string
  repository: string
  source?: string
  baseBranch: string
  branchPrefix: string
  isolation: IsolationTier
  prepare?: string
  approvalMode?: 'always-ask' | 'smart-auto' | 'full-trust'
  cowPaths?: readonly string[]
  verifyCommands?: readonly string[]
}

export interface WorktreeObservation {
  path: string
  branch?: string
  head: string
  /** 仅当 `git status --porcelain` 成功解析时为 boolean；解析失败或超时诚实置为 undefined。 */
  dirty?: boolean
  locked: boolean
  prunable: boolean
}

export interface GcSubject {
  ticket: Pick<Ticket, 'id' | 'ended' | 'follows' | 'execution'>
  tree?: WorktreeObservation
  mergedIntoBase?: boolean
  now: string
}

export type GcPlan =
  | { kind: 'keep'; because: Verdict }
  | { kind: 'remove-worktree'; path: string }
  | { kind: 'remove-worktree-and-branch'; path: string; branch: string }

export interface Provisioned {
  ticketId: string
  workspace: string
  branch: string
  base: string
  at: SourceRef
}

export type ProvisionedDraft = Omit<Provisioned, 'at'>

export interface WorkspaceRegistry {
  list(): readonly WorkspaceDef[]
  resolve(t: Pick<Ticket, 'execution'>): WorkspaceDef | undefined
}

declare module '../judgement/types.ts' {
  interface PointCatalog {
    'workspace.gc': GcSubject
    'ticket.dispatch': { mandateCeiling: ActionClass; workspace?: WorkspaceDef }
  }
}
