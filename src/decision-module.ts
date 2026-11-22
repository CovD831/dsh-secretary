// DEPS: node:crypto | src/decisions, src/module, src/routes
// RESPONSIBILITY: 装配老板裁决与待裁路由
// MODULE: secretary
// ---
import { randomUUID } from 'node:crypto'
import { Decider } from './decisions.js'
import type { Install } from './module.js'
import { registerDecisionRoutes } from './routes.js'

export const install: Install = (ctx, deps) => {
  if (deps.approvals === undefined) throw new Error('审批模块必须先于裁决模块装配。')
  deps.decider = new Decider(deps.writer, {
    answerApproval: deps.approvals.respond,
    closeApprovals: deps.approvals.dispose,
    promptSecretary: async (pending, text) => {
      await ctx.sessionController.prompt({
        requestId: `boss-decision-${randomUUID()}`, sessionId: pending.sessionId, mode: 'queue',
        content: [{ type: 'text', text }],
      }, new AbortController().signal)
    },
  })
  registerDecisionRoutes(ctx, deps.writer, deps.decider)
  void ctx.effect(async () => async () => { await deps.decider?.dispose() })
}
