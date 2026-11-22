// DEPS: src/approval-module, src/contracts, src/decision-module, src/dispatch-tools, src/event-routes, src/events, src/gates/runner, src/module, src/normalize-module, src/secretary-tools
// RESPONSIBILITY: 按功能模块列表装配秘书插件，不在此处实现功能
// MODULE: secretary
// ---
import { install as approvals } from './approval-module.js'
import type { Context } from './contracts.js'
import { install as decisions } from './decision-module.js'
import { install as dispatchTools } from './dispatch-tools.js'
import { install as eventRoutes } from './event-routes.js'
import { LogWriter } from './events.js'
import { install as gates } from './gates/runner.js'
import type { Install, InstallContext, InstallDeps } from './module.js'
import { install as normalize } from './normalize-module.js'
import { install as secretaryTools } from './secretary-tools.js'

const modules: Install[] = [normalize, dispatchTools, secretaryTools, approvals, decisions, eventRoutes, gates]

export function apply(ctx: Context, writer: LogWriter, workspace: InstallDeps['workspace']): void {
  const deps: InstallDeps = { writer, workspace }
  ctx.inject(['storageDomain', 'sessionController', 'connection'], ((scoped: InstallContext) => {
    for (const install of modules) install(scoped, deps)
  }) as never)
  console.info('dsh-secretary 已激活；秘书 preset 仅装配自研工具。')
  void ctx.effect(async () => async () => {
    await writer.flush()
    console.info('dsh-secretary 已释放。')
  })
}
