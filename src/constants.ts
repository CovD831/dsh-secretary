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
} as const
export const DISPATCH_TOOL_NAMES = { dispatch: 'secretary_dispatch', status: 'secretary_status' } as const
export const MAX_TASK_LENGTH = 2000
export const MAX_ACCEPTANCE_LENGTH = 1000
export const MAX_SUMMARY_LENGTH = 200
export const PRESET_NAME = 'secretary'
export const MOODS = ['neutral', 'working', 'happy', 'concerned'] as const
export const MAX_LINE_LENGTH = 40
export const PANEL_ID = 'dsh-secretary'
