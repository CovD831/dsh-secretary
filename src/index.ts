// DEPS: node:os, node:path | src/contracts, src/dispatch, src/events, src/host, src/selftest
// RESPONSIBILITY: 提供可独立加载的 Host 入口，不含未打包裸导入
// MODULE: secretary
// ---
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { Agent, Context } from './contracts.js'
import { validateWorkspaces, Workspace } from './dispatch.js'
import { LogWriter } from './events.js'
import { apply as applyHost } from './host.js'
import { runSelfTest } from './selftest.js'

export const name = 'dsh-secretary'
export const inject = ['tools']

interface Config { selfTestDirectory?: string; workspace?: Workspace | Workspace[] }
interface SelfTestContext extends Context {
  llm: { registerAdapter(providers: string[], value: unknown): unknown }
  sessionController: {
    create(request: { cwd: string; agentPreset: string }): Promise<{ sessionId: string }>
    selectModel(request: { sessionId: string; provider: string; model: string }): Promise<unknown>
  }
  agents: { get(sessionId: string): Agent | undefined }
}

export function apply(ctx: Context, config: Config = {}): void {
  const declared = config.workspace === undefined ? []
    : Array.isArray(config.workspace) ? config.workspace : [config.workspace]
  const workspace = declared.length === 0 ? undefined : validateWorkspaces(declared)
  // 与 rc.5 packages/util/home-paths/src/index.ts resolveDshHome 同规则；无 Cordis 路径服务。
  const configured = process.env.DSH_HOME
  const home = resolve(configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), '.dsh'))
  const directory = config.selfTestDirectory
  if (directory !== undefined) {
    if (resolve(directory) !== home && !resolve(directory).startsWith(`${home}${sep}`)) throw new Error('自检目录必须位于当前 DSH home 内。')
    ctx.inject(['llm', 'sessionController', 'agents'], ((scoped: SelfTestContext) => {
      runSelfTest({
        directory,
        llm: scoped.llm,
        create: request => scoped.sessionController.create(request),
        selectModel: request => scoped.sessionController.selectModel(request),
        get: sessionId => scoped.agents.get(sessionId),
      })
    }) as never)
  }
  applyHost(ctx, new LogWriter(join(home, 'plugins/dsh-secretary/event-log/events.jsonl')), workspace)
}
