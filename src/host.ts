// DEPS: node:crypto | src/approvals, src/constants, src/contracts, src/decisions, src/events, src/normalize, src/routes, src/say
// RESPONSIBILITY: 以唯一日志写者组合秘书工具、原生事件、审批截获与待裁接口
// MODULE: secretary
// ---
import { randomUUID } from 'node:crypto'
import { registerApprovalQueue, ApprovalContext, StorageDomain } from './approvals.js'
import { PRESET_NAME } from './constants.js'
import type { Context } from './contracts.js'
import { Decider } from './decisions.js'
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
  storageDomain: StorageDomain
  sessionController: {
    prompt(request: {
      requestId: string; sessionId: string; mode: 'queue'; content: Array<{ type: 'text'; text: string }>
    }, signal: AbortSignal): Promise<{ accepted: true }>
  }
}

export function apply(ctx: Context, writer: import('./events.js').LogWriter): void {
  observeEvents(ctx, writer)
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.agentPreset !== PRESET_NAME) return undefined
    for (const tool of createSpeechTools(writer)) agent.ctx.tools.register(tool)
    agent.ctx.tools.restrict({ allow: [] })
    return undefined
  })
  ctx.inject(['storageDomain', 'sessionController', 'connection'], ((decisionCtx: DecisionContext & ConnectionContext) => {
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
    registerDecisionRoutes(decisionCtx, writer, decider)
    void decisionCtx.effect(async () => async () => {
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
