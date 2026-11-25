/** 零双写多工作区注册表、Orca 式真分支 worktree 建树与 `workspace.gc` 事前判局回收。 */
export { ISOLATION_CEILING } from './types.ts'
export type {
  GcPlan,
  GcSubject,
  IsolationCeiling,
  Provisioned,
  ProvisionedDraft,
  WorkspaceDef,
  WorkspaceRegistry,
  WorktreeObservation,
} from './types.ts'
export {
  TICKET_DISPATCH_ISOLATION_GATE,
  WORKSPACE_ID_PATTERN,
  checkMandateIsolation,
  createWorkspaceRegistry,
  isActionWithinIsolation,
  registerDispatchIsolationGate,
  validateWorkspaceDef,
  type WorkspaceSettingsReader,
} from './registry.ts'
export {
  copyCowDependencies,
  deriveBranchName,
  findWorktreeObservation,
  isBranchMergedIntoBase,
  observeWorktrees,
  parseWorktreeListPorcelain,
  provisionWorktree,
  recordProvisioned,
  type GitRunOptions,
  type ProvisionWorktreeInput,
} from './worktree.ts'
export {
  WORKSPACE_GC_GATE,
  executeWorkspaceGc,
  planWorkspaceGc,
  registerWorkspaceGcGate,
  runWorkspaceGc,
  type GcExecutionResult,
} from './gc.ts'
