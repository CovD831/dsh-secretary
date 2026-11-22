// DEPS: src/constants, src/module, src/say
// RESPONSIBILITY: 只给秘书 preset 注册五个自研工具并排除其他插件的全局工具
// MODULE: secretary
// ---
import { PRESET_NAME } from './constants.js'
import type { Install } from './module.js'
import { createSpeechTools } from './say.js'

// 已知的其他插件全局工具；新增时在此补充
const BLOCKED_GLOBAL_TOOLS = [
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'working_directory',
]

export const install: Install = (ctx, deps) => {
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.agentPreset !== PRESET_NAME) return undefined
    for (const tool of [...createSpeechTools(deps.writer), ...(deps.dispatchTools ?? [])]) agent.ctx.tools.register(tool)
    // 逐个排除其他插件的全局工具；未安装的工具跳过
    for (const name of BLOCKED_GLOBAL_TOOLS) {
      try { agent.ctx.tools.restrict({ deny: [name] }) } catch { /* 未安装则跳过 */ }
    }
    return undefined
  })
}
