import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import test from 'node:test'
import { gateRegistry } from '../dist/gates/index.js'
import { judgeGate } from '../dist/gates/runner.js'

async function runFixture(gate, color) {
  const path = gate.fixtures[color]
  const fixture = JSON.parse(await readFile(isAbsolute(path) ? path : resolve(path), 'utf8'))
  const input = fixture.input
  assert.equal(color === 'red' ? fixture.verdict !== 'allow' : fixture.verdict === 'allow', true,
    `${gate.id} ${color} fixture 的期望方向错误`)
  const exec = { ...input.exec, name: input.toolName, arguments: input.args, callId: 'fixture-call' }
  const context = { ...input, exec, agent: input.agent ?? { id: 'fixture-session' } }
  assert.equal(gate.matches(input.toolName, input.args), true, `${gate.id} fixture 不适用`)
  assert.equal((await judgeGate(gate, context)).verdict, fixture.verdict, `${gate.id} 红 fixture`)
}

export async function runGateFixtures(registry = gateRegistry) {
  for (const gate of registry) {
    await runFixture(gate, 'red')
    const original = gate.judge
    gate.judge = async () => ({ verdict: 'allow', reason: '禁用变异', evidence: null })
    try {
      await assert.rejects(runFixture(gate, 'red'), /红 fixture/)
    } finally {
      gate.judge = original
    }
    await runFixture(gate, 'green')
  }
}

test('每个已注册 gate 的红绿 fixture 及禁用变异', async () => {
  await runGateFixtures()
})
