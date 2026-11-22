// DEPS: node:crypto, node:fs/promises, node:path | src/constants, src/contracts
// RESPONSIBILITY: 仅在显式隔离配置下用固定流驱动真实秘书轮次
// MODULE: secretary
// ---
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DISPATCH_TOOL_NAMES, PRESET_NAME, TOOL_NAMES } from './constants.js'
import type { Agent } from './contracts.js'

const PROVIDER = 'secretary-selftest'
let sessionCalls = 0

const adapter = {
  providerInfo: (provider: string) => ({ id: provider, name: provider }),
  providerRetryPolicy: () => undefined,
  listModels: (provider: string) => Promise.resolve([{ provider, id: 'fixed', name: '固定自检流' }]),
  resolveModel: (provider: string, model: string) => Promise.resolve({ provider, id: model, name: model }),
  prepareCall(provider: string, model: string) {
    return Promise.resolve({ model: { provider, id: model, name: model }, stream: (options: { purpose?: string }) => this.stream(options) })
  },
  async * stream(options: { purpose?: string }): AsyncGenerator<unknown> {
    if (options.purpose === 'session-title') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '秘书骨架自检' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    sessionCalls += 1
    if (sessionCalls > 1) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const args = JSON.stringify({ line: '骨架已就位。', mood: 'happy' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'secretary-selftest-say', name: TOOL_NAMES.say, arguments: args } }
    const dispatchArgs = JSON.stringify({
      dispatchKey: 'secretary-selftest-dispatch', task: '验证隔离工作区能收到任务。',
      acceptance: '工作区日志出现带本派发 requestId 的 user/message。',
    })
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'secretary-selftest-dispatch', name: DISPATCH_TOOL_NAMES.dispatch, arguments: dispatchArgs } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  },
}

interface Llm {
  registerAdapter(providers: string[], value: typeof adapter): unknown
}

interface SelfTest {
  directory: string
  llm: Llm
  create(request: { cwd: string; agentPreset: string }): Promise<{ sessionId: string }>
  selectModel(request: { sessionId: string; provider: string; model: string }): Promise<unknown>
  get(sessionId: string): Agent | undefined
}

export function runSelfTest(selfTest: SelfTest): void {
  const report = async (): Promise<void> => {
    selfTest.llm.registerAdapter([PROVIDER], adapter)
    const created = await selfTest.create({ cwd: selfTest.directory, agentPreset: PRESET_NAME })
    const agent = selfTest.get(created.sessionId)
    if (agent === undefined) throw new Error('真实秘书会话创建后不可读取。')
    const tools = agent.ctx.tools.schemas(agent).map(tool => tool.name).sort()
    const expectedTools = [TOOL_NAMES.say, DISPATCH_TOOL_NAMES.dispatch, DISPATCH_TOOL_NAMES.status].sort()
    if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) throw new Error('秘书工具清单与说话、派发、查状态工具不符。')
    await selfTest.selectModel({ sessionId: created.sessionId, provider: PROVIDER, model: 'fixed' })
    agent.followup({
      id: randomUUID(), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '请运行秘书骨架自检。' }],
    })
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    const result = events.find(event => event.type === 'tool/result')
    const results = events.filter(event => event.type === 'tool/result')
    if (results.length !== 2 || results.some(event => (event.data as { message?: { isError?: boolean } }).message?.isError !== false)) {
      throw new Error('说话或派发工具未在原生 Agent Loop 成功完成。')
    }
    await writeFile(join(selfTest.directory, 'tools-view.json'), `${JSON.stringify({ created, tools, result }, null, 2)}\n`)
    console.info('秘书工具清单与真实派发自检已通过；固定流已走完原生 Agent Loop。')
  }
  void report().catch(error => console.error(`秘书无模型自检失败：${String(error)}`))
}
