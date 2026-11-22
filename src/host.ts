// DEPS: src/constants, src/contracts, src/events, src/normalize, src/say
// RESPONSIBILITY: 以唯一日志写者组合秘书工具、原生事件与只读投影
// MODULE: secretary
// ---
import { PRESET_NAME } from './constants.js'
import type { Context } from './contracts.js'
import { readRecentEvents } from './events.js'
import { observeEvents } from './normalize.js'
import { createSayTool } from './say.js'

interface ConnectionContext extends Context {
  connection: {
    fetch: { register(route: { path: string; methods: string[]; requestBody: string; fetch(request: Request): Promise<Response> }): unknown }
  }
}

export function apply(ctx: Context, writer: import('./events.js').LogWriter): void {
  observeEvents(ctx, writer)
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.agentPreset !== PRESET_NAME) return undefined
    agent.ctx.tools.register(createSayTool(writer))
    agent.ctx.tools.restrict({ allow: [] })
    return undefined
  })
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
