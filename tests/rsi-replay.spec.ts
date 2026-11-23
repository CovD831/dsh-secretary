import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { DomainEvent } from '../src/core/ports.ts'
import { createSpineAppender, ensureSpineSchema, type SpineEnvelope } from '../src/spine/index.ts'
import {
  assertCaseSetEquality,
  compareParamCandidates,
  compareWindows,
  computeBehavioralMetrics,
  confidenceOf,
  createPersistenceSessionReader,
  domainEventToSpineDraft,
  extractSessionPtr,
  joinNativeSessionMetrics,
  runHistoricalReplay,
  splitByFamily,
  toEvaluationReading,
  type ReplayCase,
} from '../src/rsi/index.ts'

interface CorpusTask {
  id: string
  subject: string
  kind: string
  status: string
  inScope: string[]
  outOfScope?: string[]
  verify: string[]
  acceptance: string[]
  objective: string
  dependencies: string[]
}

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function loadFrozenCorpus(): ReplayCase<CorpusTask>[] {
  const raw = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/gate-corpus.json'), 'utf8')) as {
    _note: string
    _count: number
    tasks: CorpusTask[]
  }
  expect(raw._note).toContain('Do not tidy')
  expect(raw.tasks).toHaveLength(43)
  return raw.tasks.map((task) => {
    const scopeText = `${task.subject} ${task.inScope.join(' ')}`
    const family = /changed-paths/i.test(scopeText) ? 'changed-paths'
      : /output schema/i.test(scopeText) ? 'tool-schema'
      : /admission|absorb|convene|checkpoint/i.test(scopeText) ? 'admission'
      : /tools\.ts|tools\//i.test(scopeText) ? 'tools-split'
      : /backtest|repair|completion|deadlock/i.test(scopeText) ? 'completion-repair'
      : /stale|freshness|stamp/i.test(scopeText) ? 'stale-module'
      : /terminal|dependency|scheduler/i.test(scopeText) ? 'terminal-dep'
      : /tristate|unmeasured|requires/i.test(scopeText) ? 'tristate-audit'
      : /atomicity/i.test(scopeText) ? 'atomicity'
      : `other-${task.kind}`
    const expectedOutcome = task.status === 'completed' ? 'clean'
      : (task.status === 'failed' || task.status === 'cancelled') ? 'defect'
      : 'unknown'
    return {
      id: task.id,
      family,
      input: task,
      expectedOutcome,
    }
  })
}

describe('gate-corpus 切分与样本集守卫', () => {
  it('加载 43 条真实冻结语料，splitByFamily 确定性且零跨族泄漏', () => {
    const cases = loadFrozenCorpus()
    expect(cases).toHaveLength(43)
    const splitA = splitByFamily(cases, { train: 0.6, validation: 0.2, holdout: 0.2 }, 'seed-1')
    const splitB = splitByFamily(cases, { train: 0.6, validation: 0.2, holdout: 0.2 }, 'seed-1')
    expect(splitA).toEqual(splitB)
    expect(splitA.train.length + splitA.validation.length + splitA.holdout.length).toBe(43)
    expect(splitA.train.length).toBeGreaterThan(0)
    expect(splitA.validation.length).toBeGreaterThan(0)
    expect(splitA.holdout.length).toBeGreaterThan(0)

    const famOf = (list: readonly ReplayCase<CorpusTask>[]) => new Set(list.map(c => c.family))
    const fTrain = famOf(splitA.train)
    const fVal = famOf(splitA.validation)
    const fHold = famOf(splitA.holdout)
    for (const f of fTrain) { expect(fVal.has(f)).toBe(false); expect(fHold.has(f)).toBe(false) }
    for (const f of fVal) expect(fHold.has(f)).toBe(false)
    const trimmed = splitByFamily([
      { id: 'x1', family: ' adm ', input: 1, expectedOutcome: 'clean' },
      { id: 'x2', family: 'adm', input: 2, expectedOutcome: 'defect' },
    ], { train: 0.5, validation: 0.5, holdout: 0 }, 0)
    expect(trimmed.train.length === 2 || trimmed.validation.length === 2).toBe(true)
  })

  it('assertCaseSetEquality 拒绝缺漏、多出或重复样本（防挑软柿子）', () => {
    const ids = loadFrozenCorpus().map(c => c.id)
    expect(() => assertCaseSetEquality(ids, [...ids].reverse())).not.toThrow()
    expect(() => assertCaseSetEquality(ids, ids.slice(0, 42))).toThrow(/不一致/)
    expect(() => assertCaseSetEquality(ids, [...ids, 'extra-t99'])).toThrow(/不一致/)
    expect(() => assertCaseSetEquality(ids, [...ids.slice(0, 42), ids[0]!])).toThrow(/重复/)
  })
})

describe('S3 真实语料离线回放报告卡', () => {
  it('在 43 条真实任务上双报 catches / falseBlocks / misses / unmeasured 与覆盖折扣', async () => {
    const cases = loadFrozenCorpus()
    const gateFn = (task: CorpusTask) => {
      if (task.inScope.some(p => p.endsWith('/'))) {
        return { kind: 'unmeasured' as const, cause: 'missing-input' as const, detail: 'inScope 为粗粒度目录，无法判定' }
      }
      if (task.inScope.length > 2 || task.verify.length < 4) {
        return { kind: 'deny' as const, blockers: [`scope/verify 超限 (${task.inScope.length}/${task.verify.length})`] as const }
      }
      return { kind: 'allow' as const }
    }

    const noCostCard = await runHistoricalReplay(gateFn, cases)
    expect(noCostCard.totalCases).toBe(43)
    expect(noCostCard.catches).toBeGreaterThan(0)
    expect(noCostCard.falseBlocks).toBeGreaterThan(0)
    expect(noCostCard.misses).toBeGreaterThan(0)
    expect(noCostCard.unmeasuredCount).toBeGreaterThan(0)
    expect(noCostCard.triggeredCount).toBeGreaterThanOrEqual(noCostCard.catches + noCostCard.falseBlocks)
    expect(noCostCard.coverageDiscount).toBeCloseTo((43 - noCostCard.unmeasuredCount) / 43, 8)
    expect(noCostCard.coverageDiscount).toBeLessThan(1)
    expect(noCostCard.marginalCost.state).toBe('unmeasured')
    expect(noCostCard.marginalCost.deltaTokens).toBeUndefined()
    expect(noCostCard.marginalCost.deltaMs).toBeUndefined()

    const withCostCard = await runHistoricalReplay(gateFn, cases, {
      costModel: { perEvalTokens: 0, perEvalMs: 2, perTriggerTokens: 200, perTriggerMs: 500 },
    })
    expect(withCostCard.marginalCost.state).toBe('measured')
    expect(withCostCard.marginalCost.deltaTokens).toBe(withCostCard.triggeredCount * 200)
    expect(withCostCard.marginalCost.deltaMs).toBe(43 * 2 + withCostCard.triggeredCount * 500)

    const throwingCard = await runHistoricalReplay(() => { throw new Error('boom') }, cases.slice(0, 3))
    expect(throwingCard.unmeasuredCount).toBe(3)
    expect(throwingCard.coverageDiscount).toBe(0)
    expect(throwingCard.cases.every(c => c.verdict.kind === 'unmeasured')).toBe(true)
  })
})

describe('trace-bridge 轻指针桥接 DSH 原生会话指标', () => {
  it('13 类 DomainEvent 转换为薄 SpineDraft 并按指针提取真实会话指标，缺失日志绝不填 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-rsi-bridge-'))
    tempDirs.push(dir)
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    ensureSpineSchema(store.db)
    const appender = createSpineAppender(store)

    const events: DomainEvent[] = [
      { type: 'trigger.received', at: '2026-11-24T00:00:00Z', data: { triggerId: 'trg-1', threads: ['gh:1'] } },
      { type: 'eval.started', at: '2026-11-24T00:00:01Z', data: { evalId: 'ev-1', threadKey: 'gh:1', triggerIds: ['trg-1'], strength: 'explicit' } },
      { type: 'decision.recorded', at: '2026-11-24T00:00:02Z', data: { decisionId: 'dec-1', kind: 'accept', threadKey: 'gh:1' } },
      { type: 'ticket.created', at: '2026-11-24T00:00:03Z', data: { ticketId: 't-1', decisionId: 'dec-1', strength: 'explicit' } },
      { type: 'assignment.started', at: '2026-11-24T00:00:04Z', data: { ticketId: 't-1', assignmentId: 'asg-1' } },
      { type: 'thread.subscribed', at: '2026-11-24T00:00:05Z', data: { threadKey: 'gh:1', ticketId: 't-1' } },
      { type: 'trigger.followup', at: '2026-11-24T00:00:06Z', data: { triggerId: 'trg-2' } },
      { type: 'ticket.resumed', at: '2026-11-24T00:00:07Z', data: { ticketId: 't-1', triggerId: 'trg-2' } },
      { type: 'thread.unsubscribed', at: '2026-11-24T00:00:08Z', data: { threadKey: 'gh:1', ticketId: 't-1', by: 'executor', reason: 'unrelated' } },
      { type: 'trigger.requeued', at: '2026-11-24T00:00:09Z', data: { triggerId: 'trg-2' } },
      { type: 'assignment.ended', at: '2026-11-24T00:00:10Z', data: { ticketId: 't-1', assignmentId: 'asg-1', reason: 'done' } },
      { type: 'ticket.ended', at: '2026-11-24T00:00:11Z', data: { ticketId: 't-1', by: 'executor', outcome: 'completed' } },
      { type: 'policy.changed', at: '2026-11-24T00:00:12Z', data: { from: 'v1', to: 'v2' } },
    ]
    const sessionByIdx = ['worker-t1', 'worker-t1', 'worker-partial', 'worker-purged']
    for (let i = 0; i < events.length; i++) {
      const draft = domainEventToSpineDraft(events[i]!, {
        causationId: i > 0 ? `cause-${i}` : undefined,
        ...(i < 4 ? { sessionId: sessionByIdx[i], sessionSeq: i, commit: 'abc1234' } : {}),
      })
      expect(JSON.stringify(draft.payload)).not.toContain('assistant/message')
      appender.append(draft)
    }

    const envelopes = (store.db.prepare('SELECT value FROM event_spine ORDER BY seq ASC LIMIT 5').all() as { value: string }[])
      .map(r => JSON.parse(r.value) as SpineEnvelope)
    store.close()

    const healthyLog: SessionEvent[] = [
      { type: 'tool/call', seq: SessionSeq(0), time: 1000, data: { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'bash', arguments: '{"command":"pnpm test"}' } },
      { type: 'tool/result', seq: SessionSeq(1), time: 2500, surfaceOp: 'append', data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'fail\n[exit code: 2]' }], isError: false }) } },
      { type: 'tool/call', seq: SessionSeq(2), time: 3000, data: { turn: 1, step: 2, callId: ToolCallId('c2'), name: 'bash', arguments: '{"command":"echo ok"}' } },
      { type: 'tool/result', seq: SessionSeq(3), time: 3500, surfaceOp: 'append', data: { turn: 1, step: 2, message: createToolResultMessage({ callId: ToolCallId('c2'), content: [{ type: 'text', text: 'ok' }], isError: false }) } },
      { type: 'assistant/message', seq: SessionSeq(4), time: 5000, surfaceOp: 'append', data: { turn: 1, step: 2, message: { id: 'm1' as never, role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [], usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 50 } } },
    ]
    const partialLog: SessionEvent[] = [
      { type: 'tool/call', seq: SessionSeq(0), time: 2000, data: { turn: 1, step: 1, callId: ToolCallId('c3'), name: 'read', arguments: '{}' } },
      { type: 'assistant/message', seq: SessionSeq(1), time: 2600, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'm2' as never, role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] } },
    ]
    const storeMap = new Map<string, readonly SessionEvent[]>([['worker-t1', healthyLog], ['worker-partial', partialLog]])
    const rows = await joinNativeSessionMetrics(envelopes, id => storeMap.get(id))

    expect(rows).toHaveLength(5)
    expect(rows[0]).toMatchObject({
      metricsState: 'measured',
      sessionId: 'worker-t1',
      commit: 'abc1234',
      toolCalls: 2,
      failedCommandCount: 1,
      durationMs: 4000,
      tokens: { inputTokens: 120, outputTokens: 30, totalTokens: 200, cacheReadTokens: 50 },
    })
    expect(rows[0]!.commandExitCodes.map(c => c.exitCode)).toEqual([2, 0])
    expect(rows[2]).toMatchObject({ metricsState: 'partial', toolCalls: 1, durationMs: 600, tokens: undefined })
    expect(rows[3]).toMatchObject({ metricsState: 'unmeasured', unmeasuredReason: 'session-log-unavailable', toolCalls: undefined, durationMs: undefined, tokens: undefined, failedCommandCount: undefined })
    expect(rows[4]).toMatchObject({ metricsState: 'unmeasured', unmeasuredReason: 'no-session-pointer', toolCalls: undefined, durationMs: undefined, tokens: undefined })

    let flushCalls = 0
    const reader = createPersistenceSessionReader({
      flush: async () => { flushCalls += 1; if (flushCalls === 3) throw new Error('flush fail') },
      open: async (id) => {
        if (String(id) !== 'worker-t1') throw new Error('ENOENT')
        let readOnce = false
        return {
          read: async () => ({ eventState: 'detached', events: readOnce ? [] : (readOnce = true, healthyLog) }),
          close: async () => {},
          [Symbol.asyncDispose]: async () => {},
        } as never
      },
    })
    expect(await reader('worker-t1')).toHaveLength(5)
    expect(await reader('missing-session')).toBeUndefined()
    expect(await reader('worker-t1')).toBeUndefined()
    expect(flushCalls).toBe(3)

    expect(extractSessionPtr({ evidence: [{ kind: 'event', ref: 'session:worker-t1#4' }], payload: {} })?.seq).toBe(4)
    const oneSided = { seq: 98, id: 's-from', at: '2026-11-24T00:00:19Z', stream: 'ticket:t-s' as const, type: 'ticket.ended' as const, evidence: [{ kind: 'event' as const, ref: 'session:worker-t1#2-' }], payload: {} }
    const slicedEnv = { seq: 99, id: 'slice-check', at: '2026-11-24T00:00:20Z', stream: 'ticket:t-slice' as const, type: 'ticket.ended' as const, evidence: [{ kind: 'event' as const, ref: 'session:worker-t1#0-1' }], payload: {} }
    const [fromRow, slicedRow] = await joinNativeSessionMetrics([oneSided, slicedEnv], id => storeMap.get(id))
    expect(fromRow).toMatchObject({ metricsState: 'measured', toolCalls: 1, failedCommandCount: 0, durationMs: 2000 })
    expect(slicedRow).toMatchObject({ metricsState: 'partial', toolCalls: 1, failedCommandCount: 1, durationMs: 1500, tokens: undefined })
  })
})

describe('评估器不变量与 Pareto 参数寻优', () => {
  it('confidenceOf / compareWindows / computeBehavioralMetrics 严守三态诚实与防刷分', () => {
    expect(confidenceOf(0, 0)).toBeUndefined()
    expect(confidenceOf(1, 0)).toBeUndefined()
    expect(confidenceOf(3, 2)).toBeUndefined()
    expect(confidenceOf(NaN, 10)).toBeUndefined()
    expect(confidenceOf(1, 1)!).toBeLessThan(confidenceOf(50, 50)!)
    const unm = toEvaluationReading(0, 0)
    expect(unm.verdict).toBe('unmeasured')
    expect('probability' in unm).toBe(false)

    expect(compareWindows({ failures: 0, opportunities: 0 }, { failures: 1, opportunities: 5 }).verdict).toBe('unmeasured')
    expect(compareWindows({ failures: 2, opportunities: 10 }, { failures: 0, opportunities: 0 }).verdict).toBe('unmeasured')
    expect(compareWindows({ failures: 5, opportunities: 10 }, { failures: 2, opportunities: 10, durationMs: Number.NaN }, { minObservationMs: 1000 }).verdict).toBe('unmeasured')
    expect(compareWindows({ failures: 5, opportunities: 10 }, { failures: 2, opportunities: 10 }).verdict).toBe('improved')
    expect(compareWindows({ failures: 2, opportunities: 10 }, { failures: 2, opportunities: 10 }).verdict).toBe('unchanged')
    expect(compareWindows({ failures: 1, opportunities: 10 }, { failures: 4, opportunities: 10 }).verdict).toBe('regressed')

    const baseBehavior = [
      { taskId: 'a', attempts: [{ at: 1, outcome: 'completed' as const }], escalations: 1, gateAllows: 0 },
      { taskId: 'b', attempts: [{ at: 1, outcome: 'failed' as const }, { outcome: 'completed' as const }], escalations: 2, gateAllows: 0 },
      { taskId: 'c', attempts: [] },
    ]
    const relaxedGateBehavior = baseBehavior.map(r => ({ ...r, gateAllows: 999 }))
    const m1 = computeBehavioralMetrics(baseBehavior as never)
    const m2 = computeBehavioralMetrics(relaxedGateBehavior as never)
    expect(m1).toEqual(m2)
    expect(m1.firstTryPassRate).toMatchObject({ state: 'measurable', value: 0.5, sample: 2 })
    expect(m1.reworkRate).toMatchObject({ state: 'measurable', value: 0.5, sample: 2 })
    expect(m1.escalationDensity).toMatchObject({ state: 'measurable', value: 1.5, sample: 2 })
    expect(computeBehavioralMetrics([{ taskId: 'x', attempts: [{ outcome: 'completed' }] }]).escalationDensity.state).toBe('unmeasured')
  })

  it('compareParamCandidates 在真实划分集上执行零退化护栏 + Pareto 寻优，绝不修改配置且密封 holdout', async () => {
    const cases = loadFrozenCorpus()
    const split = splitByFamily(cases, { train: 0.5, validation: 0.3, holdout: 0.2 }, 3)
    expect(split.validation.some(c => c.expectedOutcome === 'clean')).toBe(true)
    interface Params { maxFiles: number; minVerify: number; tokenCost: number; lazyUnmeasured?: boolean }
    const buildGate = (p: Params) => (task: CorpusTask) => {
      if (p.lazyUnmeasured) return { verdict: { kind: 'unmeasured' as const, cause: 'missing-input' as const, detail: 'lazy' }, deltaTokens: 1, deltaMs: 1 }
      const hit = task.inScope.length > p.maxFiles || task.verify.length < p.minVerify
      return {
        verdict: hit ? { kind: 'deny' as const, blockers: ['超阈'] as const } : { kind: 'allow' as const },
        deltaTokens: hit ? p.tokenCost : 10,
        deltaMs: hit ? 40 : 5,
      }
    }

    const candidates: Params[] = [
      { maxFiles: 1, minVerify: 5, tokenCost: 50 },
      { maxFiles: 3, minVerify: 3, tokenCost: 200 },
      { maxFiles: 3, minVerify: 3, tokenCost: 80 },
      { maxFiles: 12, minVerify: 1, tokenCost: 20 },
      { maxFiles: 1, minVerify: 1, tokenCost: 1, lazyUnmeasured: true },
    ]
    const sweep = await compareParamCandidates(buildGate, candidates, split, { baseline: candidates[1]!, maxFalseBlocks: 0 })
    expect(sweep.baseline?.params).toEqual(candidates[1])
    expect(sweep.proposalOnly).toBe(true)
    expect(sweep.applied).toBe(false)
    expect(sweep.holdoutOpened).toBe(false)
    expect(sweep.holdoutCaseCount).toBe(split.holdout.length)
    expect(sweep.candidates[0]!.guardrailPassed).toBe(false)
    expect(sweep.candidates[4]!.guardrailPassed).toBe(false)
    expect(sweep.candidates[1]!.paretoOptimal).toBe(false)
    expect(sweep.paretoFrontier.some(c => c.index === 2)).toBe(true)
    expect(sweep.recommended?.index).toBe(2)
    expect(sweep.summary).toContain('proposalOnly=true')
    expect(sweep.summary).toContain('holdoutOpened=false')

    const impossible = await compareParamCandidates(buildGate, [candidates[0]!, candidates[4]!], split, { maxFalseBlocks: 0 })
    expect(impossible.recommended).toBeUndefined()
    expect(impossible.paretoFrontier).toHaveLength(0)

    const synthCases: ReplayCase<number>[] = [
      { id: 'c1', family: 'f1', input: 0, expectedOutcome: 'clean' },
      ...Array.from({ length: 9 }, (_, k) => ({ id: `d${k}`, family: `fd${k % 3}`, input: k + 1, expectedOutcome: 'defect' as const })),
    ]
    const synthSplit = splitByFamily(synthCases, { train: 0.2, validation: 0.8, holdout: 0 }, 1)
    const antiLazy = await compareParamCandidates(
      (mode: 'lazy' | 'real') => (n: number) => mode === 'lazy'
        ? (n === 0 ? { kind: 'allow' as const } : { kind: 'unmeasured' as const, cause: 'missing-input' as const, detail: 'skip' })
        : (n >= 1 && n <= 3 ? { kind: 'deny' as const, blockers: ['caught'] as const } : { kind: 'allow' as const }),
      ['lazy', 'real'],
      synthSplit,
      { baseline: 'lazy', maxFalseBlockRate: 0 },
    )
    expect(antiLazy.maxFalseBlocksAllowed).toBe(0)
    expect(antiLazy.recommended?.params).toBe('real')
    expect(antiLazy.candidates[0]!.paretoOptimal).toBe(false)
  })
})
