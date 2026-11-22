// DEPS: src/constants, src/decisions, src/events
// RESPONSIBILITY: 提供队首只读投影和老板裁决 HTTP 入口
// MODULE: secretary
// ---
import { ROUTES } from './constants.js'
import { Decider, readQueue } from './decisions.js'
import { LogWriter } from './events.js'

interface RouteContext {
  connection: {
    fetch: { register(route: { path: string; methods: string[]; requestBody: string; fetch(request: Request): Promise<Response> }): unknown }
  }
}

export function registerDecisionRoutes(ctx: RouteContext, writer: LogWriter, decider: Decider): void {
  ctx.connection.fetch.register({
    path: ROUTES.pending, methods: ['GET'], requestBody: 'buffered',
    fetch: async () => {
      try {
        return Response.json({ ...await readQueue(writer), writeFailure: writer.failure === null ? null : '事件日志写入失败，读数可能不完整' })
      } catch {
        return Response.json({ error: '待裁队列读取失败。' }, { status: 500 })
      }
    },
  })
  ctx.connection.fetch.register({
    path: ROUTES.decision, methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      let input: unknown
      try { input = await request.json() } catch { input = undefined }
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return Response.json({ error: '请求体必须是 JSON 对象。' }, { status: 400 })
      }
      try {
        return Response.json(await decider.decide(input as Parameters<Decider['decide']>[0]))
      } catch (error) {
        const message = error instanceof Error ? error.message : '裁决失败。'
        const status = message.startsWith('待裁件不存在') ? 409
          : message.startsWith('事件日志写入失败') || message.startsWith('裁决已落日志') ? 500 : 400
        return Response.json({ error: message }, { status })
      }
    },
  })
}
