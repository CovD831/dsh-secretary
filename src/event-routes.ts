// DEPS: src/constants, src/events, src/module (仅类型)
// RESPONSIBILITY: 提供最近事件和写入故障的只读接口
// MODULE: secretary
// ---
import { ROUTES } from './constants.js'
import { readRecentEvents } from './events.js'
import type { Install } from './module.js'

export const install: Install = (ctx, { writer }) => {
  ctx.connection.fetch.register({
    path: ROUTES.events, methods: ['GET'], requestBody: 'buffered',
    fetch: async () => Response.json({
      events: await readRecentEvents(writer.path),
      writeFailure: writer.failure === null ? null : '事件日志写入失败，读数可能不完整',
    }),
  })
}
