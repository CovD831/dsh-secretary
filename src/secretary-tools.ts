// DEPS: src/constants, src/module, src/say
// RESPONSIBILITY: 只给秘书 preset 注册五个自研工具并限制继承工具
// MODULE: secretary
// ---
import { DISPATCH_TOOL_NAMES, PRESET_NAME, TOOL_NAMES } from './constants.js'
import type { Install } from './module.js'
import { createSpeechTools } from './say.js'

export const install: Install = (ctx, deps) => {
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.agentPreset !== PRESET_NAME) return undefined
    for (const tool of [...createSpeechTools(deps.writer), ...(deps.dispatchTools ?? [])]) agent.ctx.tools.register(tool)
    // 显式白名单：不论其他插件注册了什么，秘书会话只保留这五个工具
    agent.ctx.tools.restrict({ allow: [...Object.values(TOOL_NAMES), ...Object.values(DISPATCH_TOOL_NAMES)] })
    return undefined
  })
}
