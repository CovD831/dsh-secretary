import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEnvelope, LogWriter } from '../dist/events.js'
import { say } from '../dist/say.js'

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

test('信封包含 v0 必填字段', () => {
  const event = createEnvelope({
    id: 'dsh:session-secretary:1', kind: 'dsh.session', sessionId: 'session-secretary',
    workspaceId: null, source: 'dsh', causedBy: null, payload: { seq: 1 },
  })
  assert.deepEqual(Object.keys(event).sort(), ['causedBy', 'id', 'kind', 'payload', 'sessionId', 'source', 'ts', 'v', 'workspaceId'])
  assert.equal(event.v, '0')
  assert.ok(!Number.isNaN(Date.parse(event.ts)))
})
