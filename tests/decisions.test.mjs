import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerApprovalQueue } from '../dist/approvals.js'
import { Decider, projectPending, readQueue } from '../dist/decisions.js'
import { LogWriter } from '../dist/events.js'
import { ask } from '../dist/say.js'

function agent(id, preset = 'native') {
  return {
    id,
    session: {
      header: { agentPreset: preset },
      snapshotEvents: () => [{ type: 'approval/asked', data: { id: `audit-${id}`, toolName: 'bash', callId: `call-${id}` } }],
    },
  }
}

function setup(workspaces = {}) {
  const listeners = {}
  const ctx = {
    on(name, listener) { listeners[name] = listener },
    emitCreated(value) { return listeners['agent/created'](value) },
    request(value) { return listeners['approval/request'](value, async () => 'native') },
  }
  const storage = {
    async open() {
      return {
        table: () => ({ entries: () => Object.entries(workspaces) }),
        async close() {},
      }
    },
  }
  return { ctx, storage }
}

async function fixture(workspaces = {}) {
  const writer = new LogWriter(join(await mkdtemp(join(tmpdir(), 'secretary-decisions-')), 'events.jsonl'))
  const { ctx, storage } = setup(workspaces)
  const approvals = registerApprovalQueue(ctx, writer, storage)
  const prompts = []
  const decider = new Decider(writer, {
    answerApproval: approvals.respond,
    closeApprovals: approvals.dispose,
    promptSecretary: async (pending, text) => { prompts.push({ pending, text }) },
  })
  return { writer, ctx, approvals, decider, prompts }
}

test('非管辖会话审批交给宿主原生 waterfall', async () => {
  const { writer, ctx } = await fixture()
  assert.equal(await ctx.request({ agent: agent('user-session'), toolName: 'bash' }), 'native')
  assert.deepEqual(await readQueue(writer), { current: null, remaining: 0, total: 0 })
})

test('工作区审批截获，allow 裁决后返回 allowed-once 并写完整因果链', async () => {
  const { writer, ctx, decider } = await fixture({ workspace1: 'workspace-session' })
  const pending = ctx.request({ agent: agent('workspace-session'), toolName: 'bash', callId: 'call-workspace-session', reason: '执行测试' })
  await new Promise(resolve => setImmediate(resolve))
  const queue = await readQueue(writer)
  assert.equal(queue.total, 1)
  assert.equal(queue.current.payload.approvalId, 'audit-workspace-session')
  assert.equal(queue.current.workspaceId, 'workspace1')
  const result = await decider.decide({ pendingId: queue.current.pendingId, optionId: 'allow' })
  assert.equal(result.accepted, true)
  assert.equal(await pending, 'allowed-once')
  const events = projectPendingForTest(writer)
  assert.equal(events.find(event => event.kind === 'boss.decision').payload.approvalOutcome, 'allowed-once')
  assert.equal(events.find(event => event.kind === 'dsh.approval' && event.payload.phase === 'answered').causedBy, queue.current.pendingId)
})

test('秘书 preset 审批属于管辖会话', async () => {
  const { writer, ctx, approvals } = await fixture()
  const secretary = agent('secretary-session', 'secretary')
  ctx.emitCreated({ agent: secretary })
  const pending = ctx.request({ agent: secretary, toolName: 'bash' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await readQueue(writer)).current.sessionId, 'secretary-session')
  await approvals.dispose()
  assert.equal(await pending, 'rejected')
})

test('不存在或已裁决的 pendingId 被拒绝，不重复投递', async () => {
  const { writer, ctx, decider } = await fixture({ workspace1: 'workspace-session' })
  const pending = ctx.request({ agent: agent('workspace-session'), toolName: 'bash' })
  await new Promise(resolve => setImmediate(resolve))
  const { pendingId } = (await readQueue(writer)).current
  await assert.rejects(decider.decide({ pendingId: 'not-found', optionId: 'allow' }), /待裁件不存在/)
  await decider.decide({ pendingId, optionId: 'reject' })
  assert.equal(await pending, 'rejected')
  await assert.rejects(decider.decide({ pendingId, optionId: 'reject' }), /待裁件不存在/)
})

test('ask 裁决投递回秘书会话并写 boss.decision', async () => {
  const { writer, decider, prompts } = await fixture()
  const { eventId } = await ask(writer, { id: 'secretary-session' }, {
    text: '是否重试？', allowNote: true,
    options: [{ id: 'retry', label: '重试验证', consequence: '多等一轮', recommended: true }],
  })
  await decider.decide({ pendingId: eventId, optionId: 'retry', note: '先独立验证' })
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].pending.sessionId, 'secretary-session')
  assert.match(prompts[0].text, /老板选了「重试验证」/)
  assert.match(prompts[0].text, /附言：先独立验证/)
  const events = projectPendingForTest(writer)
  const decision = events.find(event => event.kind === 'boss.decision')
  assert.equal(decision.causedBy, eventId)
  assert.deepEqual(decision.payload, { targetKind: 'secretary.ask', choiceId: 'retry', note: '先独立验证', approvalOutcome: null })
})

test('dispose 拒绝所有挂起审批并落 answered', async () => {
  const { writer, ctx, approvals } = await fixture({ workspace1: 'workspace-session' })
  const pending = ctx.request({ agent: agent('workspace-session'), toolName: 'bash' })
  await new Promise(resolve => setImmediate(resolve))
  await approvals.dispose()
  assert.equal(await pending, 'rejected')
  assert.equal((await readQueue(writer)).current, null)
  const events = projectPendingForTest(writer)
  assert.equal(events.find(event => event.kind === 'dsh.approval' && event.payload.phase === 'answered').payload.outcome, 'rejected')
})

test('dispose 与审批裁决竞态下仍拒绝挂起项', async () => {
  const { writer, ctx, decider, approvals } = await fixture({ workspace1: 'workspace-session' })
  const pending = ctx.request({ agent: agent('workspace-session'), toolName: 'bash' })
  await new Promise(resolve => setImmediate(resolve))
  const { pendingId } = (await readQueue(writer)).current
  const gate = Promise.withResolvers()
  const originalAppend = writer.append.bind(writer)
  writer.append = async (event, action) => {
    if (event.kind === 'dsh.approval' && event.payload.phase === 'answered') await gate.promise
    await originalAppend(event, action)
  }
  const deciding = decider.decide({ pendingId, optionId: 'allow' })
  while (projectPendingForTest(writer).at(-1)?.kind !== 'boss.decision') await new Promise(resolve => setImmediate(resolve))
  const disposal = decider.dispose()
  gate.resolve()
  await Promise.all([deciding, disposal])
  assert.equal(await pending, 'rejected')
})

test('队首和剩余计数只从日志重建，与内存挂起状态无关', async () => {
  const { writer, ctx, approvals } = await fixture({ workspace1: 'workspace-session' })
  const first = ctx.request({ agent: agent('workspace-session'), toolName: 'bash' })
  await new Promise(resolve => setImmediate(resolve))
  const { eventId } = await ask(writer, { id: 'secretary-session' }, {
    text: '是否继续？', allowNote: false,
    options: [{ id: 'continue', label: '继续', consequence: '继续执行', recommended: false }],
  })
  const before = await readQueue(writer)
  assert.equal(before.total, 2)
  assert.equal(before.remaining, 1)
  assert.notEqual(before.current.pendingId, eventId)
  const second = new LogWriter(writer.path)
  assert.deepEqual(await readQueue(second), before)
  const projected = projectPending(projectPendingForTest(writer))
  assert.equal(projected[0].pendingId, before.current.pendingId)
  await approvals.dispose()
  assert.equal(await first, 'rejected')
})

function projectPendingForTest(writer) {
  return readFileSync(writer.path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
