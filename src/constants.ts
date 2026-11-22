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
  approval: 'dsh.approval',
  bossDecision: 'boss.decision',
} as const
export const PRESET_NAME = 'secretary'
export const MOODS = ['neutral', 'working', 'happy', 'concerned'] as const
export const MAX_LINE_LENGTH = 40
export const PANEL_ID = 'dsh-secretary'
export const WORKSPACE_STORAGE_SPEC = {
  name: 'dsh-secretary', version: 0,
  tables: { workspaces: { valueSchema: {} } },
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
