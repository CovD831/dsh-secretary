// DEPS: src/constants, src/contracts, src/module, src/say
// RESPONSIBILITY: 只给秘书 preset 注册五个自研工具并把可见工具限制为本层注册的工具
// MODULE: secretary
// ---
import { PRESET_NAME } from './constants.js'
import type { Agent, Session } from './contracts.js'
import type { Install } from './module.js'
import { createSpeechTools } from './say.js'

// 宿主 agentPresets 服务：composedPreset 读 agent.ctx 实际挂载的组合，presetForSession 只读会话录制的投影
interface AgentPresetsService {
  composedPreset(agentCtx: Agent['ctx']): string | undefined
  presetForSession(session: Session): string | null | undefined
}

export const install: Install = (ctx, deps) => {
  const agents = new Map<string, Agent>()
  const installed = new Map<string, Array<() => void>>()

  // 判据按“实际组合”优先：composedPreset(agent.ctx) 读本 agent 实际挂载的 preset；
  // 旧会话没有录制的 agentPreset 时 presetForSession 返回 null（它只是会话投影，不代表实际组合），
  // 故排在第二；header.agentPreset 是创建时冻结的事实，仅作最后退路（运行期切换不会反映）。
  // 任一步方法不存在或返回非字符串才继续下一步，避免宿主按默认 preset 组成却判不出秘书。
  const presetOf = (agent: Agent): string | undefined => {
    const presets = ctx.get?.<AgentPresetsService>('agentPresets')
    const composed = presets?.composedPreset?.(agent.ctx)
    if (typeof composed === 'string') return composed
    const projected = presets?.presetForSession?.(agent.session)
    if (typeof projected === 'string') return projected
    return agent.session.header.agentPreset
  }

  const applyIsolation = (agent: Agent): void => {
    if (installed.has(agent.id)) return
    const disposers: Array<() => void> = []
    const keep = (disposer: unknown): void => {
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
    }
    // fail-closed：先禁掉所有继承来的工具，再注册本层五个工具；本层注册不受 restrict 影响
    keep(agent.ctx.tools.restrict({ allow: [] }))
    for (const tool of [...createSpeechTools(deps.writer), ...(deps.dispatchTools ?? [])]) keep(agent.ctx.tools.register(tool))
    installed.set(agent.id, disposers)
  }

  const liftIsolation = (agent: Agent): void => {
    const disposers = installed.get(agent.id)
    if (disposers === undefined) return
    installed.delete(agent.id)
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch (error) { console.warn(`dsh-secretary：撤销秘书工具隔离失败：${String(error)}`) }
    }
  }

  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    agents.set(agent.id, agent)
    if (presetOf(agent) === PRESET_NAME) applyIsolation(agent)
    return undefined
  })

  // 宿主以 (sessionId, agentPreset) 两个参数 emit，未加 scope
  ctx.on('agent-preset/selected', (sessionId: string, agentPreset: string) => {
    const agent = agents.get(sessionId)
    if (agent === undefined) return undefined
    if (agentPreset === PRESET_NAME) applyIsolation(agent)
    else liftIsolation(agent)
    return undefined
  })

  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    liftIsolation(agent)
    agents.delete(agent.id)
    return undefined
  })
}
