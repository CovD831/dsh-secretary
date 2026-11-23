import { isAbsolute } from 'node:path'
import type { Ticket } from '../core/model.ts'
import type { ActionClass, GateDef, IsolationCeiling, IsolationTier, JudgementRegistry, Stage, Verdict } from '../judgement/types.ts'
import type { Settings } from '../policy.ts'
import { ISOLATION_CEILING, type WorkspaceDef, type WorkspaceRegistry } from './types.ts'

export const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9-]*$/

export type WorkspaceSettingsReader =
  | { settings(): Pick<Settings, 'workspaces'> }
  | (() => Pick<Settings, 'workspaces'>)

export function validateWorkspaceDef(def: WorkspaceDef): WorkspaceDef {
  if (!WORKSPACE_ID_PATTERN.test(def.id)) {
    throw new Error(`工作区 id "${def.id}" 非法，必须匹配 ${WORKSPACE_ID_PATTERN.source}`)
  }
  if (!isAbsolute(def.repository)) {
    throw new Error(`工作区 "${def.id}" 的 repository 必须为绝对路径: "${def.repository}"`)
  }
  if (!def.baseBranch.trim()) {
    throw new Error(`工作区 "${def.id}" 的 baseBranch 不能为空`)
  }
  if (!(def.isolation in ISOLATION_CEILING)) {
    throw new Error(`工作区 "${def.id}" 的隔离档 "${String(def.isolation)}" 非法`)
  }
  return def
}

/** 从 `store.settings().workspaces` 投影读取工作区定义，零双写不落第二份配置。 */
export function createWorkspaceRegistry(source: WorkspaceSettingsReader): WorkspaceRegistry {
  const read = typeof source === 'function' ? source : () => source.settings()
  const list = (): readonly WorkspaceDef[] => {
    const raw = read().workspaces ?? []
    const seen = new Set<string>()
    return raw.map(item => {
      const def = validateWorkspaceDef(item)
      if (seen.has(def.id)) throw new Error(`工作区 id "${def.id}" 重复`)
      seen.add(def.id)
      return def
    })
  }
  return {
    list,
    resolve(ticket: Pick<Ticket, 'execution'>): WorkspaceDef | undefined {
      const id = ticket.execution?.workspace
      return id ? list().find(item => item.id === id) : undefined
    },
  }
}

export function isActionWithinIsolation(
  action: ActionClass,
  isolation: IsolationTier,
  ceilings: IsolationCeiling = ISOLATION_CEILING,
): boolean {
  return (Object.hasOwn(ceilings, isolation) ? ceilings[isolation] : []).includes(action)
}

export function checkMandateIsolation(
  mandateCeiling: ActionClass,
  workspace?: Pick<WorkspaceDef, 'id' | 'isolation'>,
  ceilings: IsolationCeiling = ISOLATION_CEILING,
): Verdict {
  if (!workspace) return { kind: 'allow' }
  const allowed = Object.hasOwn(ceilings, workspace.isolation) ? ceilings[workspace.isolation] : []
  if (allowed.includes(mandateCeiling)) return { kind: 'allow' }
  return {
    kind: 'deny',
    blockers: [`工作区 "${workspace.id}" 隔离档为 ${String(workspace.isolation)}（上限 ${allowed.join(', ') || '无'}），拒绝执行 "${mandateCeiling}"；worktree 不抬高隔离档`],
  }
}

export const TICKET_DISPATCH_ISOLATION_GATE: GateDef<'ticket.dispatch'> = {
  kind: 'gate',
  id: 'ticket.dispatch.isolation-ceiling',
  version: 1,
  point: 'ticket.dispatch',
  description: 'Mandate × 隔离档配对门：工作区隔离档决定允许的最大动作级别，worktree 不抬高安全边界',
  side: 'hard',
  placement: { timing: 'pre', enforce: true },
  requires: ['mandateCeiling'],
  gate: ctx => checkMandateIsolation(ctx.mandateCeiling, ctx.workspace),
}

export function registerDispatchIsolationGate(registry: Pick<JudgementRegistry, 'register'>, stage: Stage = 'enforce'): void {
  registry.register(TICKET_DISPATCH_ISOLATION_GATE, stage)
}
