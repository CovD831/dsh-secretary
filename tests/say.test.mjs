import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEnvelope, LogWriter } from '../dist/events.js'
import { ask, handover, say } from '../dist/say.js'

const agent = { id: 'session-secretary' }

test('secretary_say 超过 40 字被拒绝，不产生事件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-red-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  await assert.rejects(say(writer, agent, { line: '超'.repeat(41), mood: 'neutral' }), /1 至 40 字/)
  await assert.rejects(readFile(writer.path, 'utf8'), { code: 'ENOENT' })
})

test('secretary_say 合法输入通过并写入说话事件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-green-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  assert.deepEqual(await say(writer, agent, { line: '骨架已就位。', mood: 'happy' }), { accepted: true })
  const event = JSON.parse(await readFile(writer.path, 'utf8'))
  assert.equal(event.kind, 'secretary.say')
  assert.deepEqual(event.payload, { text: '骨架已就位。', mood: 'happy' })
})

const askOptions = [
  { id: 'retry', label: '重新验证', consequence: '多花一轮', recommended: true },
  { id: 'accept', label: '接受现状', consequence: '保留风险', recommended: false },
]

test('secretary_ask 重复 id 或多个推荐项被拒绝，不产生事件', async () => {
  for (const [name, options, message] of [
    ['重复 id', [{ ...askOptions[0] }, { ...askOptions[1], id: 'retry', recommended: false }], /id 不能重复/],
    ['多个推荐项', [{ ...askOptions[0] }, { ...askOptions[1], recommended: true }], /最多只能有一个推荐选项/],
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'secretary-ask-red-'))
    const writer = new LogWriter(join(root, 'events.jsonl'))
    await assert.rejects(ask(writer, agent, { text: '如何处理？', options, allowNote: true }), message, name)
    await assert.rejects(readFile(writer.path, 'utf8'), { code: 'ENOENT' })
  }
})

test('secretary_ask 合法输入写入提问事件并返回事件 id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-ask-green-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  const result = await ask(writer, agent, { text: '如何处理？', options: askOptions, allowNote: true })
  const event = JSON.parse(await readFile(writer.path, 'utf8'))
  assert.equal(event.kind, 'secretary.ask')
  assert.equal(result.eventId, event.id)
  assert.deepEqual(event.payload, { text: '如何处理？', options: askOptions, allowNote: true })
})

test('secretary_handover 超过 200 字被拒绝，不产生事件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-handover-red-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  await assert.rejects(handover(writer, agent, {
    conclusion: '超'.repeat(201), reason: '原因', impact: '影响', evidence: [],
  }), /结论须为 1 至 200 字/)
  await assert.rejects(readFile(writer.path, 'utf8'), { code: 'ENOENT' })
})

test('secretary_handover 合法输入写入文件事件并返回事件 id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secretary-handover-green-'))
  const writer = new LogWriter(join(root, 'events.jsonl'))
  const result = await handover(writer, agent, {
    conclusion: '修复已完成。', reason: '根因已消除。', impact: '无额外影响。', evidence: ['dsh:s-ws1:71', 'src/say.ts'],
  })
  const event = JSON.parse(await readFile(writer.path, 'utf8'))
  assert.equal(event.kind, 'secretary.handover')
  assert.equal(result.eventId, event.id)
  assert.deepEqual(event.payload, {
    title: '修复已完成。', conclusion: '修复已完成。', rationale: '根因已消除。',
    impact: '无额外影响。', evidenceRefs: ['dsh:s-ws1:71', 'src/say.ts'],
  })
})

test('信封包含 v0 必填字段', () => {
  const event = createEnvelope({
    id: 'dsh:session-secretary:1', kind: 'dsh.session', sessionId: 'session-secretary',
    workspaceId: null, source: 'dsh', causedBy: null, payload: { seq: 1 },
  })
  assert.deepEqual(Object.keys(event).sort(), ['causedBy', 'id', 'kind', 'payload', 'sessionId', 'source', 'ts', 'v', 'workspaceId'])
  assert.equal(event.v, '0')
  assert.ok(!Number.isNaN(Date.parse(event.ts)))
})
