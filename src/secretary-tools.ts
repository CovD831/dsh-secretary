// DEPS: src/constants, src/module, src/say
// RESPONSIBILITY: 只给秘书 preset 注册五个自研工具并排除其他插件的全局工具
// MODULE: secretary
// ---
import { DISPATCH_TOOL_NAMES, PRESET_NAME, TOOL_NAMES } from './constants.js'
import type { Install } from './module.js'
import { createSpeechTools } from './say.js'

const SECRETARY_TOOLS = new Set([...Object.values(TOOL_NAMES), ...Object.values(DISPATCH_TOOL_NAMES)])

export const install: Install = (ctx, deps) => {
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.agentPreset !== PRESET_NAME) return undefined
    for (const tool of [...createSpeechTools(deps.writer), ...(deps.dispatchTools ?? [])]) agent.ctx.tools.register(tool)
    // 在工具调用前拦截：非秘书工具一律 deny，确保其他插件工具无法被调用
    if (typeof agent.ctx.waterfall === 'function') {
      agent.ctx.waterfall('tools/pre-execute', async (exec: { name: string }, next: () => Promise<unknown>) => {
        if (!SECRETARY_TOOLS.has(exec.name as never)) return { kind: 'deny', reason: `秘书不使用工具「${exec.name}」，只使用五个自研工具。` }
        return next()
      })
    }
    return undefined
  })
}
