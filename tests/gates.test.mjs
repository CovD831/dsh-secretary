import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LogWriter, readRecentEvents } from '../dist/events.js'
import { gateRegistry } from '../dist/gates/index.js'
import { install } from '../dist/gates/runner.js'
import { runGateFixtures } from './gate-fixtures.mjs'

function gate(judge, id = 'dispatch.fake') {
  return {
    id, point: 'dispatch', version: '0.1', matches: () => true, judge,
    fixtures: { red: 'unused-red.json', green: 'unused-green.json' },
  }
}
function execution(agent) {
  return { agent, name: 'bash', arguments: { command: 'pwd' }, callId: 'call-1', signal: new AbortController().signal }
}
async function setup(registry, workspaces = { workspace1: 'workspace-session' }, rootOf) {
  gateRegistry.splice(0, gateRegistry.length, ...registry)
  const listeners = []
  const ctx = {
    get: name => name === 'subagents' && rootOf !== undefined ? { rootOf } : undefined,
    on(name, listener, options) { listeners.push({ name, listener, options }) },
    storageDomain: { open: async () => ({ table: () => ({ entries: () => Object.entries(workspaces) }), close: async () => {} }) },
  }
  const root = await mkdtemp(join(tmpdir(), 'secretary-gate-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  install(ctx, { writer })
  const hook = listeners.find(item => item.name === 'tools/pre-execute')
  return { writer, hook }
}
const agent = id => ({ id, session: { header: {}, snapshotEvents: () => [] } })

test('空注册表放行且非管辖会话不运行 gate', async t => {
  const { hook } = await setup([])
  assert.deepEqual(hook.options, { prepend: true })
  assert.deepEqual(await hook.listener(execution(agent('other')), async () => ({ kind: 'allow' })), { kind: 'allow' })
  const fake = gate(() => { throw new Error('不应调用') })
  const scoped = await setup([fake], { workspace1: 'workspace-session' })
  assert.deepEqual(await scoped.hook.listener(execution(agent('other')), async () => ({ kind: 'allow' })), { kind: 'allow' })
  t.after(() => gateRegistry.splice(0))
})

test('工作区 teammate 受 gate 管辖，非工作区树不拦截', async t => {
  const { hook } = await setup([gate(() => ({ verdict: 'deny', reason: '树内应拦截。', evidence: {} }))],
    { workspace1: 'workspace-root' }, () => agent('workspace-root'))
  const result = await hook.listener(execution(agent('workspace-teammate')), async () => ({ kind: 'allow' }))
  assert.deepEqual(result, { kind: 'deny', reason: '树内应拦截。' })
  t.after(() => gateRegistry.splice(0))
})

test('非工作区 teammate 树交给后续钩子', async t => {
  const { hook } = await setup([gate(() => { throw new Error('树外不应调用') })],
    { workspace1: 'workspace-root' }, () => agent('other-root'))
  assert.deepEqual(await hook.listener(execution(agent('other-teammate')), async () => ({ kind: 'allow' })), { kind: 'allow' })
  t.after(() => gateRegistry.splice(0))
})

test('假 gate deny 返回拒绝并写完整判定事件', async t => {
  const fake = gate(() => ({ verdict: 'deny', reason: '请补验收标准。', evidence: { seq: 4 } }))
  const { writer, hook } = await setup([fake])
  const result = await hook.listener(execution(agent('workspace-session')), async () => ({ kind: 'allow' }))
  assert.deepEqual(result, { kind: 'deny', reason: '请补验收标准。' })
  const [event] = await readRecentEvents(writer.path)
  assert.equal(event.kind, 'gate.verdict')
  assert.equal(event.workspaceId, 'workspace1')
  assert.deepEqual(event.payload, {
    gateId: fake.id, gateVersion: fake.version, verdict: 'deny', reason: '请补验收标准。',
    toolName: 'bash', callId: 'call-1', phase: 'dispatch', evidence: { seq: 4 },
  })
  t.after(() => gateRegistry.splice(0))
})

test('judge 抛异常转 unmeasured、拒绝并说明修法', async t => {
  const { writer, hook } = await setup([gate(() => { throw new Error('观测丢失') })])
  const result = await hook.listener(execution(agent('workspace-session')), async () => ({ kind: 'allow' }))
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /无法测量，不放行；请补齐本次观测和证据后重试。判据异常：观测丢失/)
  const [event] = await readRecentEvents(writer.path)
  assert.equal(event.payload.verdict, 'unmeasured')
  assert.deepEqual(event.payload.evidence, { error: '观测丢失' })
  t.after(() => gateRegistry.splice(0))
})

test('只有注册表内 gate 会被调用，放行后才执行后续钩子', async t => {
  let registeredCalls = 0
  let unregisteredCalls = 0
  const unregistered = gate(() => { unregisteredCalls += 1; return { verdict: 'deny', reason: '未注册', evidence: {} } })
  void unregistered
  const { hook } = await setup([gate(() => { registeredCalls += 1; return { verdict: 'allow', reason: '证据充分', evidence: {} } })])
  const next = async () => ({ kind: 'allow' })
  assert.deepEqual(await hook.listener(execution(agent('workspace-session')), next), { kind: 'allow' })
  assert.equal(registeredCalls, 1)
  assert.equal(unregisteredCalls, 0)
  t.after(() => gateRegistry.splice(0))
})

test('通用 fixture 运行器验证红绿方向和禁用变异', async t => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-fixture-'))
  const input = { toolName: 'bash', args: {}, workspaceId: 'workspace1' }
  const fake = gate(({ exec }) => exec.arguments.block
    ? { verdict: 'deny', reason: '请修正', evidence: {} }
    : { verdict: 'allow', reason: '通过', evidence: {} }, 'runtime.fixture-fake')
  fake.fixtures = { red: join(root, 'red.json'), green: join(root, 'green.json') }
  input.args = { block: true }
  await Promise.all([
    writeFile(join(root, 'red.json'), JSON.stringify({ input, verdict: 'deny' })),
    writeFile(join(root, 'green.json'), JSON.stringify({ input: { ...input, args: { block: false } }, verdict: 'allow' })),
  ])
  await runGateFixtures([fake])
  fake.fixtures.red = join(root, 'green.json')
  await assert.rejects(runGateFixtures([fake]), /fixture/)
  t.after(() => gateRegistry.splice(0))
})
