// DEPS: 无
// RESPONSIBILITY: 集中定义工具名、动作与事件种类
// MODULE: secretary
// ---
export const TOOL_NAMES = { say: 'secretary_say' } as const
export const ACTIONS = { say: 'say' } as const
export const KINDS = {
  session: 'dsh.session',
  tool: 'dsh.tool',
  agentStatus: 'dsh.agent-status',
  secretarySay: 'secretary.say',
} as const
export const PRESET_NAME = 'secretary'
export const MOODS = ['neutral', 'working', 'happy', 'concerned'] as const
export const MAX_LINE_LENGTH = 40
export const PANEL_ID = 'dsh-secretary'
