// DEPS: src/approvals, src/contracts, src/decisions, src/dispatch, src/events (仅类型)
// RESPONSIBILITY: 定义功能模块统一装配上下文
// MODULE: secretary
// ---
import type { registerApprovalQueue } from './approvals.js'
import type { Context } from './contracts.js'
import type { Decider } from './decisions.js'
import type { SessionController, StorageDomain, Workspace } from './dispatch.js'
import type { LogWriter } from './events.js'

export interface InstallContext extends Context {
  storageDomain: StorageDomain
  sessionController: SessionController
  connection: {
    fetch: { register(route: { path: string; methods: string[]; requestBody: string; fetch(request: Request): Promise<Response> }): unknown }
  }
}
export interface InstallDeps {
  writer: LogWriter
  workspace: Workspace | undefined
  approvals?: ReturnType<typeof registerApprovalQueue>
  decider?: Decider
  dispatchTools?: unknown[]
}
export type Install = (ctx: InstallContext, deps: InstallDeps) => void
