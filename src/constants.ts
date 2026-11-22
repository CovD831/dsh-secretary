// DEPS: 无
// RESPONSIBILITY: 集中定义跨模块共享的工具名、动作、事件种类和存储规格
// MODULE: secretary
// ---
export const TOOL_NAMES = {
  say: 'secretary_say',
  ask: 'secretary_ask',
  handover: 'secretary_handover',
} as const
export const ACTIONS = { say: 'say' } as const
export const KINDS = {
  session: 'dsh.session',
  tool: 'dsh.tool',
  agentStatus: 'dsh.agent-status',
  secretarySay: 'secretary.say',
  secretaryAsk: 'secretary.ask',
  secretaryHandover: 'secretary.handover',
  dispatch: 'dispatch',
  approval: 'dsh.approval',
  bossDecision: 'boss.decision',
  gateVerdict: 'gate.verdict',
} as const
export const DISPATCH_TOOL_NAMES = { dispatch: 'secretary_dispatch', status: 'secretary_status' } as const
export const PRESET_NAME = 'secretary'
export const WORKSPACE_MISSING = '尚未配置工作区，请在插件配置中设置 workspace.cwd'
export const WORKSPACE_STORAGE_SPEC = {
  name: 'dsh_secretary', version: 0,
  tables: {
    workspaces: {
      valueSchema: {
        parse(value: unknown): string {
          if (typeof value !== 'string' || value.length === 0) throw new Error('工作区存储的 sessionId 无效。')
          return value
        },
      },
    },
  },
} as const
export const WORKSPACE_TABLE = 'workspaces'
export const ROUTES = {
  events: '/api/dsh-secretary.events',
  pending: '/api/dsh-secretary.pending',
  decision: '/api/dsh-secretary.decision',
} as const
