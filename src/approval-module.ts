// DEPS: src/approvals, src/module
// RESPONSIBILITY: 装配审批截获并在恢复后释放挂起审批
// MODULE: secretary
// ---
import { registerApprovalQueue } from './approvals.js'
import type { Install } from './module.js'

export const install: Install = (ctx, deps) => {
  deps.approvals = registerApprovalQueue(ctx as Parameters<typeof registerApprovalQueue>[0], deps.writer, ctx.storageDomain)
  const recovered = deps.approvals.recover().catch(error => console.error('启动时取消孤儿审批失败：', error))
  void ctx.effect(async () => async () => {
    await recovered
    await deps.approvals?.dispose()
  })
}
