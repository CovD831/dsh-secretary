// DEPS: node:crypto | src/approvals, src/constants, src/contracts, src/decisions, src/dispatch, src/events, src/normalize, src/routes, src/say
// RESPONSIBILITY: 以唯一日志写者组合秘书工具、派发、审批截获与待裁接口
// MODULE: secretary
// ---
import { randomUUID } from 'node:crypto'
import { registerApprovalQueue, ApprovalContext } from './approvals.js'
import { PRESET_NAME } from './constants.js'
import type { Context } from './contracts.js'
import { Decider } from './decisions.js'
import { createDispatchTool, createStatusTool, Workspace } from './dispatch.js'
import { readRecentEvents } from './events.js'
import { observeEvents } from './normalize.js'
import { registerDecisionRoutes } from './routes.js'
import { createSpeechTools } from './say.js'

interface ConnectionContext extends Context {
  connection: {
    fetch: { register(route: { path: string; methods: string[]; requestBody: string; fetch(request: Request): Promise<Response> }): unknown }
  }
}
interface DecisionContext extends ApprovalContext {
  storageDomain: Parameters<typeof createDispatchTool>[2]
  sessionController: Parameters<typeof createDispatchTool>[1]
}

export function apply(ctx: Context, writer: import('./events.js').LogWriter, workspace: Workspace | undefined): void {
  observeEvents(ctx, writer, workspace?.id ?? null)
  ctx.inject(['storageDomain', 'sessionController', 'connection'], ((decisionCtx: DecisionContext & ConnectionContext) => {
    const dispatchTool = createDispatchTool(writer, decisionCtx.sessionController, decisionCtx.storageDomain, workspace)
    const statusTool = createStatusTool(writer, workspace)
    const approvals = registerApprovalQueue(decisionCtx, writer, decisionCtx.storageDomain)
    const decider = new Decider(writer, {
      answerApproval: approvals.respond,
      closeApprovals: approvals.dispose,
      promptSecretary: async (pending, text) => {
        await decisionCtx.sessionController.prompt({
          requestId: `boss-decision-${randomUUID()}`, sessionId: pending.sessionId, mode: 'queue',
          content: [{ type: 'text', text }],
        }, new AbortController().signal)
      },
    })
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.agentPreset !== PRESET_NAME) return undefined
      for (const tool of createSpeechTools(writer)) agent.ctx.tools.register(tool)
      agent.ctx.tools.register(dispatchTool)
      agent.ctx.tools.register(statusTool)
      agent.ctx.tools.restrict({ allow: [] })
      return undefined
    })
    registerDecisionRoutes(decisionCtx, writer, decider)
    const recovered = approvals.recover().catch(error => console.error('启动时取消孤儿审批失败：', error))
    void decisionCtx.effect(async () => async () => {
      await recovered
      await decider.dispose()
      await approvals.dispose()
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
