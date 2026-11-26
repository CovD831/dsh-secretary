import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { GovernanceRuntime } from '../src/app/governance.ts'
import { adoptDepositDraft, listDepositDrafts } from '../src/app/governance-drafts.ts'
import { Store } from '../src/app/store.ts'
import { validateDepositDraft } from '../src/authoring/index.ts'
import { compileDeclarativeRuleFn, validateDeclarativeRule, type CommandCheckConfig } from '../src/judgement/declarative.ts'
import { collectOnlineRsiSnapshot, extractSessionStepSequence, joinNativeSessionMetrics, mineWorkflowSopDrafts } from '../src/rsi/index.ts'
import { createSpineAppender, ensureSpineSchema, type SpineEnvelope } from '../src/spine/index.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const callEv = (seq: number, callId: string, name: string, args: Record<string, unknown>): SessionEvent => ({
  type: 'tool/call', seq: SessionSeq(seq), time: 1000 + seq * 100,
  data: { turn: 1, step: seq + 1, callId: ToolCallId(callId), name, arguments: JSON.stringify(args) },
})

const resEv = (seq: number, callId: string, text: string, isError = false): SessionEvent => ({
  type: 'tool/result', seq: SessionSeq(seq), time: 1000 + seq * 100, surfaceOp: 'append',
  data: { turn: 1, step: seq, message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text }], isError }) },
})

const spineEv = (seq: number, ticketId: string, type: `${string}.${string}`, payload: Record<string, unknown>, sessionId?: string): SpineEnvelope => ({
  v: 1, seq, id: `ev-${seq}`, at: '2026-11-26T10:00:00.000Z', stream: `ticket:${ticketId}`, type,
  source: { kind: 'system', ref: 'test' },
  evidence: sessionId ? [{ kind: 'event', ref: `session:${sessionId}` }] : [],
  taint: 'trusted',
  payload: { ticketId, ...payload, ...(sessionId ? { sessionId } : {}) },
})

describe('P1 Trace-to-SOP Miner', () => {
  it('提取脱敏低基数有序工具步骤并挂载到 JoinedSessionMetricRow', async () => {
    const events: SessionEvent[] = [
      callEv(0, 'c1', 'read_file', { file_path: 'src/rsi/types.ts', apiKey: 'sk-secret1234567890abcdef' }),
      resEv(1, 'c1', 'ok'),
      callEv(2, 'c2', 'edit_file', { file_path: 'src/rsi/sop-miner.ts' }),
      resEv(3, 'c2', 'ok'),
      callEv(4, 'c3', 'bash', { command: 'DSH_HOME=/tmp/dsh-p1b-test TOKEN=Bearer_abcdef123456 pnpm tsc --noEmit' }),
      resEv(5, 'c3', 'error TS2322\n[exit code: 2]', false),
      callEv(6, 'c4', 'bash', { command: 'vitest run tests/p1-trace-sop-miner.spec.ts' }),
      resEv(7, 'c4', 'passed\n[exit code: 0]', false),
      callEv(8, 'c5', 'orchestrator_report', { summary: 'done' }),
      resEv(9, 'c5', 'ok'),
    ]
    const steps = extractSessionStepSequence(events)
    expect(steps.map(s => [s.stepIndex, s.phase, s.skeleton, s.isError, s.exitCode])).toEqual([
      [0, 'locate', 'read:src', false, undefined],
      [1, 'edit', 'edit:src', false, undefined],
      [2, 'verify', 'tsc --noEmit', true, 2],
      [3, 'verify', 'vitest run', false, 0],
      [4, 'report', 'report:ready', false, undefined],
    ])
    expect(JSON.stringify(steps)).not.toContain('sk-secret1234567890abcdef')
    expect(JSON.stringify(steps)).not.toContain('Bearer_abcdef123456')
    expect(extractSessionStepSequence(events, 3)).toHaveLength(3)

    const envs = [spineEv(1, 't-1', 'ticket.ended', { outcome: 'completed' }, 's-1'), spineEv(2, 't-missing', 'ticket.ended', { outcome: 'completed' })]
    const rows = await joinNativeSessionMetrics(envs, id => (id === 's-1' ? events : undefined))
    expect(rows[0]!.steps).toHaveLength(5)
    expect(rows[1]!.metricsState).toBe('unmeasured')
    expect(rows[1]!.steps).toBeUndefined()
  })

  it('模式 A（返工收敛）与模式 B（support>=3 高频 SOP）提炼出可编译影子草稿与真实红绿用例', async () => {
    const reworkLog: SessionEvent[] = [
      callEv(0, 'r1', 'read_file', { path: 'src/app/governance.ts' }), resEv(1, 'r1', 'ok'),
      callEv(2, 'r2', 'bash', { command: 'pnpm typecheck' }), resEv(3, 'r2', 'TS fail\n[exit code: 1]'),
      callEv(4, 'r3', 'edit_file', { path: 'src/app/governance.ts' }), resEv(5, 'r3', 'ok'),
      callEv(6, 'r4', 'bash', { command: 'tsc --noEmit' }), resEv(7, 'r4', 'ok\n[exit code: 0]'),
      callEv(8, 'r5', 'bash', { command: 'vitest run tests/p0-governance-flow.spec.ts' }), resEv(9, 'r5', 'ok\n[exit code: 0]'),
      callEv(10, 'r6', 'present', {}), resEv(11, 'r6', 'ok'),
    ]
    const cleanLog: SessionEvent[] = [
      callEv(0, 'k1', 'grep', { path: 'src/rsi' }), resEv(1, 'k1', 'ok'),
      callEv(2, 'k2', 'edit_file', { path: 'src/rsi/evaluator.ts' }), resEv(3, 'k2', 'ok'),
      callEv(4, 'k3', 'bash', { command: 'vitest run' }), resEv(5, 'k3', 'ok\n[exit code: 0]'),
      callEv(6, 'k4', 'orchestrator_report', {}), resEv(7, 'k4', 'ok'),
    ]
    const events: SpineEnvelope[] = [
      spineEv(1, 't-rework', 'gate.evaluated', { point: 'verify.preflight', verdict: { kind: 'deny', blockers: ['typecheck'] } }, 's-rework'),
      spineEv(2, 't-rework', 'ticket.ended', { outcome: 'completed' }, 's-rework'),
      spineEv(3, 't-c1', 'ticket.ended', { outcome: 'completed' }, 's-c1'),
      spineEv(4, 't-c2', 'ticket.ended', { outcome: 'completed' }, 's-c2'),
      spineEv(5, 't-c3', 'ticket.ended', { outcome: 'completed' }, 's-c3'),
    ]
    const logs = new Map<string, SessionEvent[]>([['s-rework', reworkLog], ['s-c1', cleanLog], ['s-c2', cleanLog], ['s-c3', cleanLog]])
    const joined = await joinNativeSessionMetrics(events, id => logs.get(id))
    const drafts = mineWorkflowSopDrafts({ events, joinedSessionMetrics: joined })
    expect(drafts.length).toBe(2)

    for (const d of drafts) {
      expect(d.kind).toBe('gate')
      expect(d.stage).toBe('shadow')
      expect(d.enforce).toBe(false)
      expect(d.actionClass).toBe('observe')
      expect(d.point).toBe('verify.preflight')
      expect(d.origin.kind).toBe('friction-mined')
      expect(d.origin.refs?.some(r => r.startsWith('m0:'))).toBe(true)
      expect(d.rubricBody).toContain('## 操作步骤')
      const v = validateDepositDraft(d)
      expect(v.ok && v.gate === 'ready').toBe(true)

      const rule = (d as unknown as { rule: CommandCheckConfig }).rule
      expect(validateDeclarativeRule(rule)).toEqual([])
      const fn = compileDeclarativeRuleFn(rule, d.params)
      for (const c of d.cases) expect(fn(c.ctx).kind).toBe(c.expected)
    }

    const twoOnly = mineWorkflowSopDrafts({ events: events.slice(2, 4), joinedSessionMetrics: joined.slice(2, 4) })
    expect(twoOnly).toHaveLength(0)
  })

  it('接入 online-collector 并通过 GET/adopt 零胶水影子安装', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-p1-sop-'))
    dirs.push(dir)
    const store = new Store(join(dir, 'state.sqlite'))
    ensureSpineSchema(store.db)
    const gov = new GovernanceRuntime({ store, stateDir: dir, now: () => new Date('2026-11-26T10:00:00.000Z') })
    await gov.recover()
    const appender = createSpineAppender(store)
    const log: SessionEvent[] = [
      callEv(0, 'a1', 'read_file', { path: 'src/rsi/types.ts' }), resEv(1, 'a1', 'ok'),
      callEv(2, 'a2', 'bash', { command: 'tsc --noEmit' }), resEv(3, 'a2', 'fail\n[exit code: 2]'),
      callEv(4, 'a3', 'bash', { command: 'tsc --noEmit' }), resEv(5, 'a3', 'ok\n[exit code: 0]'),
      callEv(6, 'a4', 'orchestrator_report', {}), resEv(7, 'a4', 'ok'),
    ]
    appender.append({ ...spineEv(1, 't-online', 'worker.tool_finished', { toolName: 'bash', isError: true }, 's-on'), id: 'on-1' })
    appender.append({ ...spineEv(2, 't-online', 'ticket.ended', { outcome: 'completed' }, 's-on'), id: 'on-2' })

    const snap = await collectOnlineRsiSnapshot({ db: store.db, memoryDir: gov.memoryDir, readSessionEvents: id => (id === 's-on' ? log : undefined) })
    const mined = snap.minedSopDrafts ?? []
    expect(mined).toHaveLength(1)
    expect(snap.candidateDrafts.some(d => d.id === mined[0]!.id)).toBe(true)

    const saved = await adoptDepositDraft(gov, { draft: mined[0] as unknown as Record<string, unknown>, installShadow: false })
    expect(saved.ok).toBe(true)
    const listed = await listDepositDrafts(gov, { includeOnlineCandidates: true })
    const sopEntry = listed.find(e => e.id === mined[0]!.id)
    expect(sopEntry?.ready).toBe(true)

    const adopted = await adoptDepositDraft(gov, { draftId: mined[0]!.id, installShadow: true })
    expect(adopted.ok && adopted.installed && adopted.stage === 'shadow' && adopted.enforce === false).toBe(true)
    expect(gov.registry.list().some(g => g.id === mined[0]!.id && g.stage === 'shadow')).toBe(true)
    await gov.shutdown()
  })
})
