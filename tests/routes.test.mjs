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
  apply(ctx, writer)
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
