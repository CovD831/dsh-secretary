// DEPS: 无
// RESPONSIBILITY: 集中定义工具名、动作与事件种类
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
} as const
export const DISPATCH_TOOL_NAMES = { dispatch: 'secretary_dispatch', status: 'secretary_status' } as const
export const MAX_TASK_LENGTH = 2000
export const MAX_ACCEPTANCE_LENGTH = 1000
export const MAX_SUMMARY_LENGTH = 200
export const PRESET_NAME = 'secretary'
export const MOODS = ['neutral', 'working', 'happy', 'concerned'] as const
export const MAX_LINE_LENGTH = 40
export const PANEL_ID = 'dsh-secretary'
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
export const APPROVAL_OPTIONS = [
  { id: 'allow', label: '允许本次操作', consequence: '仅放行这一次工具调用', recommended: false },
  { id: 'reject', label: '拒绝本次操作', consequence: '把拒绝结果返回原会话', recommended: true },
] as const
