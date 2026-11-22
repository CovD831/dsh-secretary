import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dispatch, status, validateWorkspaces } from '../dist/dispatch.js'
import { createEnvelope, LogWriter } from '../dist/events.js'

function fixture(storage = new Map()) {
  const controller = {
    calls: [],
    async create(request) {
      this.calls.push({ type: 'create', request })
      return { sessionId: 'session-workspace' }
    },
    async prompt(request) {
      this.calls.push({ type: 'prompt', request })
      return { accepted: true }
    },
  }
  const storageDomain = {
    async open() {
      return {
        table: () => ({
          get: key => storage.get(key),
          put: async (key, value) => storage.set(key, value),
        }),
        close: async () => {},
      }
    },
  }
  return { controller, storageDomain, storage }
}

const args = {
  dispatchKey: 'dispatch-1', task: '修复登录回归。', acceptance: '独立重跑登录测试并通过。',
}

test('缺 acceptance 被拒绝，不建工作区也不落事件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-dispatch-red-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  const { controller, storageDomain } = fixture()
  await assert.rejects(dispatch(writer, controller, storageDomain, { id: 'session-secretary' }, { id: 'ws', cwd: root }, { ...args, acceptance: undefined }), /验收标准须为 1 至 1000 字/)
  assert.equal(controller.calls.length, 0)
  await assert.rejects(readFile(writer.path, 'utf8'), { code: 'ENOENT' })
})

test('正常派发产生 prepared 与 accepted，causedBy 关联且工作区收到验收标准', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-dispatch-green-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  const { controller, storageDomain, storage } = fixture()
  const result = await dispatch(writer, controller, storageDomain, { id: 'session-secretary' }, { id: 'ws', cwd: root }, args)
  assert.equal(result.accepted, true)
  assert.equal(result.targetSessionId, 'session-workspace')
  assert.deepEqual(controller.calls.map(call => call.type), ['create', 'prompt'])
  assert.equal(controller.calls[0].request.cwd, root)
  assert.equal(storage.get('ws'), 'session-workspace')
  assert.equal(controller.calls[1].request.content[0].text, '任务：修复登录回归。\n验收标准：独立重跑登录测试并通过。')
  const events = (await readFile(writer.path, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(events.map(event => event.payload.phase), ['prepared', 'accepted'])
  assert.equal(events[0].payload.requestId, null)
  assert.equal(events[1].causedBy, events[0].id)
  assert.equal(events[1].payload.requestId, controller.calls[1].request.requestId)
  assert.equal(events[0].workspaceId, 'ws')
})

test('同 dispatchKey 已有 accepted 时不重复投递', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-dispatch-idempotent-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  const { controller, storageDomain } = fixture()
  const secretary = { id: 'session-secretary' }
  const workspace = { id: 'ws', cwd: root }
  const first = await dispatch(writer, controller, storageDomain, secretary, workspace, args)
  const second = await dispatch(writer, controller, storageDomain, secretary, workspace, args)
  assert.deepEqual(second, { ...first, duplicate: true })
  assert.equal(controller.calls.filter(call => call.type === 'prompt').length, 1)
  const events = (await readFile(writer.path, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(events.filter(event => event.kind === 'dispatch').length, 2)
})

test('重启后复用已存 sessionId，不重复建工作区', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-dispatch-restart-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  const { controller, storageDomain } = fixture(new Map([['ws', 'session-existing']]))
  await dispatch(writer, controller, storageDomain, { id: 'session-secretary' }, { id: 'ws', cwd: root }, args)
  assert.deepEqual(controller.calls.map(call => call.type), ['prompt'])
  assert.equal(controller.calls[0].request.sessionId, 'session-existing')
})

test('同 dispatchKey 并发派发只投递一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-dispatch-concurrent-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  const { controller, storageDomain } = fixture()
  await Promise.all([
    dispatch(writer, controller, storageDomain, { id: 'session-secretary' }, { id: 'ws', cwd: root }, args),
    dispatch(writer, controller, storageDomain, { id: 'session-secretary' }, { id: 'ws', cwd: root }, args),
  ])
  assert.equal(controller.calls.filter(call => call.type === 'prompt').length, 1)
  assert.equal(controller.calls.filter(call => call.type === 'create').length, 1)
})

test('多个工作区被拒绝', () => {
  const root = join(tmpdir(), 'secretary-multiple-workspaces')
  assert.throws(() => validateWorkspaces([{ id: 'a', cwd: root }, { id: 'b', cwd: root }]), /第一阶段只能配置一个工作区/)
})

test('查状态只投影目标工作区日志并返回 idle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-status-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  const { controller, storageDomain } = fixture()
  await dispatch(writer, controller, storageDomain, { id: 'session-secretary' }, { id: 'ws', cwd: root }, args)
  await writer.append(createEnvelope({
    id: 'plugin:status-idle', kind: 'dsh.agent-status', sessionId: 'session-workspace', workspaceId: 'ws', source: 'dsh', causedBy: null,
    payload: { agentId: 'session-workspace', status: 'idle' },
  }))
  const result = await status(writer, 'ws', 10)
  assert.equal(result.status, 'idle')
  assert.ok(result.events.length > 0)
  assert.ok(!JSON.stringify(result).includes(args.acceptance))
  assert.ok(result.events.every(event => event.id !== undefined))
})
