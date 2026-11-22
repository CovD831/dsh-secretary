// DEPS: src/constants, src/module, src/say
// RESPONSIBILITY: 只给秘书 preset 注册五个自研工具并限制继承工具
// MODULE: secretary
// ---
import { PRESET_NAME } from './constants.js'
import type { Install } from './module.js'
import { createSpeechTools } from './say.js'

export const install: Install = (ctx, deps) => {
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.agentPreset !== PRESET_NAME) return undefined
    for (const tool of [...createSpeechTools(deps.writer), ...(deps.dispatchTools ?? [])]) agent.ctx.tools.register(tool)
    agent.ctx.tools.restrict({ allow: [] })
    return undefined
  })
}
