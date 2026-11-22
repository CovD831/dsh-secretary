// DEPS: src/constants, src/contracts, src/dispatch, src/events, src/normalize, src/say
// RESPONSIBILITY: 以唯一日志写者组合秘书工具、原生事件与只读投影
// MODULE: secretary
// ---
import { PRESET_NAME } from './constants.js'
import type { Context } from './contracts.js'
import { createDispatchTool, createStatusTool, Workspace } from './dispatch.js'
import { readRecentEvents } from './events.js'
import { observeEvents } from './normalize.js'
import { createSayTool } from './say.js'

interface ConnectionContext extends Context {
  connection: {
    fetch: { register(route: { path: string; methods: string[]; requestBody: string; fetch(request: Request): Promise<Response> }): unknown }
  }
}
interface DispatchContext extends Context {
  sessionController: Parameters<typeof createDispatchTool>[1]
  storageDomain: Parameters<typeof createDispatchTool>[2]
}

export function apply(ctx: Context, writer: import('./events.js').LogWriter, workspace: Workspace): void {
  observeEvents(ctx, writer, workspace.id)
  ctx.inject(['sessionController', 'storageDomain'], ((dispatchCtx: DispatchContext) => {
    const dispatchTool = createDispatchTool(writer, dispatchCtx.sessionController, dispatchCtx.storageDomain, workspace)
    const statusTool = createStatusTool(writer, workspace)
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.agentPreset !== PRESET_NAME) return undefined
      agent.ctx.tools.register(createSayTool(writer))
      agent.ctx.tools.register(dispatchTool)
      agent.ctx.tools.register(statusTool)
      agent.ctx.tools.restrict({ allow: [] })
      return undefined
    })
  }) as never)
  ctx.inject(['connection'], ((connectionCtx: ConnectionContext) => {
    connectionCtx.connection.fetch.register({
      path: '/api/dsh-secretary.events', methods: ['GET'], requestBody: 'buffered',
      fetch: async () => Response.json({
        events: await readRecentEvents(writer.path),
        writeFailure: writer.failure === null ? null : '事件日志写入失败，读数可能不完整',
      }),
    })
  }) as never)
  console.info('dsh-secretary 已激活；秘书 preset 仅装配自研工具。')
  void ctx.effect(async () => async () => {
    await writer.flush()
    console.info('dsh-secretary 已释放。')
  })
}
