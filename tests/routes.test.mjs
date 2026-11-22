import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../dist/host.js'
import { LogWriter } from '../dist/events.js'
import { ask } from '../dist/say.js'
import { registerDecisionRoutes } from '../dist/routes.js'

test('GET 只暴露队首和计数，POST 拒绝已裁 pendingId', async () => {
  const writer = new LogWriter(join(await mkdtemp(join(tmpdir(), 'secretary-routes-')), 'events.jsonl'))
  const args = {
    text: '继续吗？', allowNote: false,
    options: [{ id: 'continue', label: '继续', consequence: '继续执行', recommended: false }],
  }
  const first = await ask(writer, { id: 'secretary' }, args)
  await ask(writer, { id: 'secretary' }, args)
  const routes = new Map()
  const ctx = { connection: { fetch: { register(route) { routes.set(route.path, route) } } } }
  const prompts = []
  const decider = {
    decide: async input => {
      const event = {
        v: '0', id: 'plugin:decision-test', ts: new Date().toISOString(), kind: 'boss.decision',
        sessionId: 'secretary', workspaceId: null, source: 'plugin', causedBy: input.pendingId,
        payload: { targetKind: 'secretary.ask', choiceId: input.optionId, note: null, approvalOutcome: null },
      }
      const { readRecentEvents } = await import('../dist/events.js')
      const events = await readRecentEvents(writer.path, Number.MAX_SAFE_INTEGER)
      if (events.some(item => item.kind === 'boss.decision' && item.causedBy === input.pendingId)
        || !events.some(item => item.id === input.pendingId)) throw new Error('待裁件不存在、已裁决或不是当前队首。')
      await writer.append(event, true)
      prompts.push(input)
      return { accepted: true, pendingId: input.pendingId, decisionId: event.id }
    },
  }
  registerDecisionRoutes(ctx, writer, decider)
  const queue = routes.get('/api/dsh-secretary.pending')
  const decision = routes.get('/api/dsh-secretary.decision')
  const before = await (await queue.fetch(new Request('http://local/api/dsh-secretary.pending'))).json()
  assert.equal(before.current.pendingId, first.eventId)
  assert.equal(before.remaining, 1)
  assert.equal(before.total, 2)
  const accepted = await decision.fetch(new Request('http://local/api/dsh-secretary.decision', {
    method: 'POST', body: JSON.stringify({ pendingId: first.eventId, optionId: 'continue' }),
  }))
  assert.equal(accepted.status, 200)
  const duplicate = await decision.fetch(new Request('http://local/api/dsh-secretary.decision', {
    method: 'POST', body: JSON.stringify({ pendingId: first.eventId, optionId: 'continue' }),
  }))
  assert.equal(duplicate.status, 409)
  assert.equal(prompts.length, 1)
  assert.equal((await (await queue.fetch(new Request('http://local/api/dsh-secretary.pending'))).json()).remaining, 0)
})

test('Host 的 ask 裁决经 sessionController.prompt 投递回秘书会话', async () => {
  const writer = new LogWriter(join(await mkdtemp(join(tmpdir(), 'secretary-host-')), 'events.jsonl'))
  const routes = new Map()
  const listeners = new Map()
  const effects = []
  const prompts = []
  const ctx = {
    on(name, listener) { listeners.set(name, listener) },
    inject(_services, setup) { setup(ctx) },
    effect(setup) { effects.push(setup) },
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    storageDomain: { open: async () => ({ table: () => ({ entries: () => [] }), close: async () => {} }) },
    sessionController: { prompt: async request => { prompts.push(request); return { accepted: true } } },
  }
  apply(ctx, writer, { id: 'workspace', cwd: '/tmp/workspace' })
  const secretary = {
    id: 'secretary-live',
    session: { header: { agentPreset: 'secretary' }, snapshotEvents: () => [] },
    ctx: { tools: { register() {}, restrict() {} } },
  }
  listeners.get('agent/created')({ agent: secretary })
  const { eventId } = await ask(writer, secretary, {
    text: '是否继续？', allowNote: true,
    options: [{ id: 'yes', label: '继续', consequence: '继续执行', recommended: true }],
  })
  const response = await routes.get('/api/dsh-secretary.decision').fetch(new Request('http://local/api/dsh-secretary.decision', {
    method: 'POST', body: JSON.stringify({ pendingId: eventId, optionId: 'yes', note: '保持范围' }),
  }))
  assert.equal(response.status, 200)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'secretary-live')
  assert.equal(prompts[0].mode, 'queue')
  assert.match(prompts[0].requestId, /^boss-decision-/)
  assert.match(prompts[0].content[0].text, /附言：保持范围/)
  assert.ok(prompts[0] !== undefined)
})

test('启动时取消日志中没有本进程 resolver 的孤儿审批', async () => {
  const writer = new LogWriter(join(await mkdtemp(join(tmpdir(), 'secretary-orphan-')), 'events.jsonl'))
  await writer.append({
    v: '0', id: 'plugin:orphan-approval', ts: new Date().toISOString(), kind: 'dsh.approval',
    sessionId: 'workspace-session', workspaceId: 'workspace', source: 'plugin', causedBy: null,
    payload: { phase: 'pending', toolName: 'bash', callId: 'call-1', reason: '测试', outcome: null, approvalId: null },
  }, true)
  const listeners = new Map()
  const effects = []
  const ctx = {
    on(name, listener) { listeners.set(name, listener) },
    inject(_services, setup) { setup(ctx) },
    effect(setup) { effects.push(setup) },
    connection: { fetch: { register() {} } },
    storageDomain: { open: async () => ({ table: () => ({ entries: () => [] }), close: async () => {} }) },
    sessionController: { prompt: async () => ({ accepted: true }) },
  }
  apply(ctx, writer, { id: 'workspace', cwd: '/tmp/workspace' })
  for (const setup of effects) await (await setup())()
  const events = (await import('../dist/events.js')).readRecentEvents
    ? await (await import('../dist/events.js')).readRecentEvents(writer.path, Number.MAX_SAFE_INTEGER)
    : []
  const answered = events.find(event => event.kind === 'dsh.approval' && event.payload.phase === 'answered')
  assert.ok(answered, '孤儿审批没有 answered 事件')
  assert.equal(answered.causedBy, 'plugin:orphan-approval')
  assert.equal(answered.payload.outcome, 'cancelled')
  assert.equal(answered.payload.reason, '插件重启，原审批已失效')
})

test('未配置工作区时插件照常注册工具，说话可用而派发返回中文错误', async () => {
  const writer = new LogWriter(join(await mkdtemp(join(tmpdir(), 'secretary-no-workspace-')), 'events.jsonl'))
  const listeners = new Map()
  const tools = new Map()
  const ctx = {
    on(name, listener) { listeners.set(name, listener) },
    inject(_services, setup) { setup(ctx) },
    effect() {},
    connection: { fetch: { register() {} } },
    storageDomain: { open: async () => ({ table: () => ({ entries: () => [] }), close: async () => {} }) },
    sessionController: { prompt: async () => ({ accepted: true }) },
  }
  apply(ctx, writer, undefined)
  const session = header => ({ header, snapshotEvents: () => [] })
  const secretary = {
    id: 'secretary-live', session: session({ agentPreset: 'secretary' }),
    ctx: { tools: { register(tool) { tools.set(tool.name, tool) }, restrict() {} } },
  }
  listeners.get('agent/created')({ agent: secretary })
  assert.deepEqual([...tools.keys()].sort(), ['secretary_ask', 'secretary_dispatch', 'secretary_handover', 'secretary_say', 'secretary_status'])
  assert.deepEqual(await tools.get('secretary_say').execute({ line: '工作区还没配好。', mood: 'concerned' }, { agent: secretary }), { accepted: true })
  assert.deepEqual(await tools.get('secretary_status').execute({}, { agent: secretary }), { status: 'unknown', events: [] })
  await assert.rejects(
    tools.get('secretary_dispatch').execute({ dispatchKey: 'k1', task: '做点事。', acceptance: '有回执。' }, { agent: secretary }),
    /尚未配置工作区，请在插件配置中设置 workspace\.cwd/,
  )
  listeners.get('agent/created')({ agent: { ...secretary, id: 'other', session: session({ agentPreset: 'standard' }) } })
  assert.equal(tools.size, 5)
})

test('秘书回投失败写失败事件并由 GET 显式暴露', async () => {
  const writer = new LogWriter(join(await mkdtemp(join(tmpdir(), 'secretary-prompt-failure-')), 'events.jsonl'))
  const routes = new Map()
  const listeners = new Map()
  const ctx = {
    on(name, listener) { listeners.set(name, listener) },
    inject(_services, setup) { setup(ctx) },
    effect() {},
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    storageDomain: { open: async () => ({ table: () => ({ entries: () => [] }), close: async () => {} }) },
    sessionController: { prompt: async () => { throw new Error('秘书会话已失效') } },
  }
  apply(ctx, writer, { id: 'workspace', cwd: '/tmp/workspace' })
  const secretary = {
    id: 'secretary-live', session: { header: { agentPreset: 'secretary' }, snapshotEvents: () => [] },
    ctx: { tools: { register() {}, restrict() {} } },
  }
  listeners.get('agent/created')({ agent: secretary })
  const { eventId } = await ask(writer, secretary, {
    text: '继续吗？', allowNote: false,
    options: [{ id: 'yes', label: '继续', consequence: '继续执行', recommended: true }],
  })
  const response = await routes.get('/api/dsh-secretary.decision').fetch(new Request('http://local/api/dsh-secretary.decision', {
    method: 'POST', body: JSON.stringify({ pendingId: eventId, optionId: 'yes' }),
  }))
  assert.equal(response.status, 500)
  const { readRecentEvents } = await import('../dist/events.js')
  const events = await readRecentEvents(writer.path, Number.MAX_SAFE_INTEGER)
  assert.ok(events.some(event => event.kind === 'dispatch' && event.payload.phase === 'failed' && event.causedBy !== null))
  const pending = await (await routes.get('/api/dsh-secretary.pending').fetch(new Request('http://local/api/dsh-secretary.pending'))).json()
  assert.match(pending.writeFailure, /秘书|投递|失败/)
})
