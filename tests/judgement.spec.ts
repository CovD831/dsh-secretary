import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  POINTS_WELL_FORMED,
  admitDeposit,
  auditRequires,
  createJudgementRegistry,
  loadDepositPackage,
  runDepositCases,
  type DepositManifest,
  type EvaluationReading,
  type EvaluatorDef,
  type GateDef,
  type Placement,
  type PointEvaluation,
  type Requires,
  type StandingOrderDef,
} from '../src/judgement/index.ts'

interface SampleCtx {
  task?: {
    id: string
    tags?: readonly string[]
    meta?: Record<string, unknown>
    nested?: { flag: boolean }
  }
  retry: number
}

declare module '../src/judgement/types.ts' {
  interface PointCatalog {
    'verify.test-gate': SampleCtx
    'ticket.test-dispatch': { ticketId: string; ready?: boolean }
  }
  interface SignalCatalog {
    'test.sick-account': { accountId: string; failRate: number }
  }
  interface ActionCatalog {
    'test.disable-account': { reason: string }
  }
}

const VALID_PROSE = [
  '## 意图\n防止未附带有效证明的修改直接放行。',
  '## 判据\n必须提供非空 task.id 与正数 retry 或满足阈值的测试证明。',
  '## 正反例\n正例与反例详见 cases/。',
  '## 例外\n仅纯文档变更时跳过。',
  '## 修复指引\n请补充 task.id 并重跑验证。',
].join('\n\n')

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('judgement compile-time types', () => {
  it('enforces Requires<C> paths, Placement pre/post invariant, and unmeasured EvaluationReading', () => {
    expect(POINTS_WELL_FORMED).toBe(true)
    const validReq: Requires<SampleCtx> = ['task', 'task.id', 'task.tags', 'task.meta', 'task.nested.flag', 'retry']
    expect(validReq).toHaveLength(6)
    // @ts-expect-error 写错路径名必须在编译期报错
    const badTypo: Requires<SampleCtx> = ['task.typo']
    // @ts-expect-error 索引字典不得展开任意键
    const badBag: Requires<SampleCtx> = ['task.meta.anything']
    // @ts-expect-error 索引字典不得产生尾部空段
    const badDot: Requires<SampleCtx> = ['task.meta.']
    // @ts-expect-error 只读数组不得展开下标
    const badArr: Requires<SampleCtx> = ['task.tags.0']
    const gateBadReq: GateDef<'verify.test-gate'> = {
      kind: 'gate', id: 'g.type-err', version: 1, point: 'verify.test-gate', description: 'type check',
      placement: { timing: 'pre', enforce: true },
      // @ts-expect-error GateDef.requires 必须校验 PointCatalog[P] 路径
      requires: ['task.typo'],
      gate: () => ({ kind: 'allow' }),
    }

    const prePlace: Placement = { timing: 'pre', enforce: true }
    const postObserve: Placement = { timing: 'post', enforce: false }
    // @ts-expect-error 事后口 (post) 编译期禁止 enforce: true
    const badPlace: Placement = { timing: 'post', enforce: true }

    const effectiveReading: EvaluationReading = { verdict: 'effective', probability: 0.92, reasons: ['passed'] }
    const abstainedReading: EvaluationReading = { verdict: 'unmeasured', reasons: ['insufficient samples'] }
    // @ts-expect-error unmeasured 评估读数编译期禁填 probability
    const badReading: EvaluationReading = { verdict: 'unmeasured', probability: 0.5, reasons: ['guess'] }

    const validOrder: StandingOrderDef<'test.sick-account', 'test.disable-account'> = {
      kind: 'standing-order',
      id: 'order.valid-type',
      version: 1,
      description: 'valid',
      trigger: { signal: 'test.sick-account', match: { accountId: 'acc-1' } },
      action: { name: 'test.disable-account', params: { reason: 'sick' } },
      mandate: { strength: 'explicit', scope: 'workspace:main', ceiling: 'local-write', isolation: 'I2', policyVersion: 'v1' },
    }
    // @ts-expect-error trigger.match 禁止表达式字符串
    const badOrderMatch: StandingOrderDef<'test.sick-account', 'test.disable-account'> = { ...validOrder, trigger: { signal: 'test.sick-account', match: 'failRate > 0.9' } }

    expect([badTypo, badBag, badDot, badArr, gateBadReq, prePlace, postObserve, badPlace, effectiveReading, abstainedReading, badReading, validOrder, badOrderMatch].length).toBeGreaterThan(0)
  })
})

describe('auditRequires runtime input surface', () => {
  it('treats only undefined as missing and accepts null, false, 0, and empty string', () => {
    const res = auditRequires(
      { a: null, b: false, c: 0, d: '', nested: { x: undefined } },
      ['a', 'b', 'c', 'd', 'nested.x', 'missing.deep', 'toString'],
    )
    expect(res.ok).toBe(false)
    expect(res.present).toEqual(['a', 'b', 'c', 'd'])
    expect(res.missing).toEqual(['nested.x', 'missing.deep', 'toString'])
  })
})

describe('createJudgementRegistry', () => {
  it('rejects duplicate ids, invalid scope.stage, missing mandate, and isolation ceiling violations', () => {
    const reg = createJudgementRegistry()
    const baseGate: GateDef<'verify.test-gate'> = {
      kind: 'gate', id: 'g.dup', version: 1, point: 'verify.test-gate', description: 'check',
      placement: { timing: 'pre', enforce: true }, requires: ['task.id'], gate: () => ({ kind: 'allow' }),
    }
    reg.register(baseGate, 'enforce')
    expect(() => reg.register(baseGate, 'enforce')).toThrow(/重复|已存在/)
    expect(() => reg.register({ ...baseGate, id: 'g.bad1', point: 'unknown.stage' as never }, 'enforce')).toThrow(/未知 scope|非法/)
    expect(() => reg.register({ ...baseGate, id: 'g.bad2', point: 'verify' as never }, 'enforce')).toThrow(/非法/)

    const orderBase: StandingOrderDef<'test.sick-account', 'test.disable-account'> = {
      kind: 'standing-order', id: 'so.1', version: 1, description: 'disable',
      trigger: { signal: 'test.sick-account', match: { accountId: 'a1' } },
      action: { name: 'test.disable-account', params: { reason: 'dead' } },
      mandate: { strength: 'explicit', scope: 'ws:1', ceiling: 'draft', isolation: 'I1', policyVersion: 'p1' },
    }
    reg.register(orderBase, 'enforce')
    expect(reg.standingOrders('test.sick-account')).toHaveLength(1)
    expect(() => reg.register({ ...orderBase, id: 'so.nomandate', mandate: undefined as never }, 'enforce')).toThrow(/MandateBinding/)
    expect(() => reg.register({
      ...orderBase, id: 'so.exceed',
      mandate: { strength: 'explicit', scope: 'ws:1', ceiling: 'local-write', isolation: 'I1', policyVersion: 'p1' },
    }, 'enforce')).toThrow(/越过隔离档/)
  })

  it('allows empty point, skips non-applicable gates, forces all-skipped to unmeasured, and aggregates non-short-circuit blockers', async () => {
    const reg = createJudgementRegistry()
    expect((await reg.evaluate('verify.test-gate', { retry: 1 })).verdict).toEqual({ kind: 'allow' })

    const skippedGate: GateDef<'verify.test-gate'> = {
      kind: 'gate', id: 'g.skip', version: 1, point: 'verify.test-gate', description: 'skip',
      placement: { timing: 'pre', enforce: true }, requires: ['retry'],
      appliesTo: ctx => ctx.retry > 10,
      gate: () => ({ kind: 'allow' }),
    }
    reg.register(skippedGate, 'enforce')
    const allSkipped = await reg.evaluate('verify.test-gate', { retry: 1 })
    expect(allSkipped.verdict.kind).toBe('unmeasured')
    if (allSkipped.verdict.kind === 'unmeasured') expect(allSkipped.verdict.cause).toBe('all-skipped')

    reg.register({
      kind: 'gate', id: 'g.deny1', version: 1, point: 'verify.test-gate', description: 'd1',
      placement: { timing: 'pre', enforce: true }, requires: ['retry'],
      gate: () => ({ kind: 'deny', blockers: ['blocker-one'] }),
    }, 'enforce')
    reg.register({
      kind: 'gate', id: 'g.deny2', version: 1, point: 'verify.test-gate', description: 'd2',
      placement: { timing: 'pre', enforce: true }, requires: ['retry'],
      gate: () => ({ kind: 'deny', blockers: ['blocker-two'] }),
    }, 'enforce')

    const multi = await reg.evaluate('verify.test-gate', { retry: 1 })
    expect(multi.registered).toBe(3)
    expect(multi.evaluated).toBe(2)
    expect(multi.skipped).toBe(1)
    expect(multi.verdict).toEqual({ kind: 'deny', blockers: ['[g.deny1] blocker-one', '[g.deny2] blocker-two'] })
  })

  it('handles missing-input without calling gate(), threw -> unmeasured, tolerate disposition, shadow isolation, and onEvaluated fault isolation', async () => {
    const observed: PointEvaluation[] = []
    const reg = createJudgementRegistry({
      onEvaluated: ev => {
        observed.push(ev)
        throw new Error('sink failed')
      },
    })
    const neverCalled = vi.fn(() => ({ kind: 'allow' as const }))
    reg.register({
      kind: 'gate', id: 'g.req', version: 1, point: 'verify.test-gate', description: 'req',
      placement: { timing: 'pre', enforce: true }, requires: ['task.id'], gate: neverCalled,
    }, 'enforce')
    const missingEv = await reg.evaluate('verify.test-gate', { retry: 1 })
    expect(neverCalled).not.toHaveBeenCalled()
    expect(missingEv.verdict.kind).toBe('unmeasured')
    if (missingEv.verdict.kind === 'unmeasured') expect(missingEv.verdict.cause).toBe('missing-input')
    expect(observed).toHaveLength(1)

    reg.unregister('g.req')
    reg.register({
      kind: 'gate', id: 'g.tolerate', version: 1, point: 'verify.test-gate', description: 'tol',
      placement: { timing: 'pre', enforce: true }, requires: ['retry'],
      gate: () => ({ kind: 'unmeasured', cause: 'no-evidence', detail: 'optional check', disposition: 'tolerate' }),
    }, 'enforce')
    reg.register({
      kind: 'gate', id: 'g.shadow', version: 1, point: 'verify.test-gate', description: 'shadow',
      placement: { timing: 'pre', enforce: true }, requires: ['retry'],
      gate: () => ({ kind: 'deny', blockers: ['shadow-only-hit'] }),
    }, 'shadow')
    const tolerated = await reg.evaluate('verify.test-gate', { retry: 1 })
    expect(tolerated.verdict).toEqual({ kind: 'allow' })
    expect(tolerated.observed.map(o => o.id)).toEqual(['g.tolerate', 'g.shadow'])

    reg.register({
      kind: 'gate', id: 'g.throw', version: 1, point: 'verify.test-gate', description: 'boom',
      placement: { timing: 'pre', enforce: true }, requires: ['retry'],
      gate: () => { throw new Error('boom') },
    }, 'enforce')
    const threwEv = await reg.evaluate('verify.test-gate', { retry: 1 })
    expect(threwEv.verdict.kind).toBe('unmeasured')
    if (threwEv.verdict.kind === 'unmeasured') expect(threwEv.verdict.cause).toBe('threw')

    // 验证 unmeasured 优先级高于 deny，且 observe 阶段只记账不阻塞
    reg.register({
      kind: 'gate', id: 'g.deny-lower', version: 1, point: 'verify.test-gate', description: 'deny',
      placement: { timing: 'pre', enforce: true }, requires: ['retry'],
      gate: () => ({ kind: 'deny', blockers: ['blocked-too'] }),
    }, 'enforce')
    const mixed = await reg.evaluate('verify.test-gate', { retry: 1 })
    expect(mixed.verdict.kind).toBe('unmeasured')
    expect(mixed.ran.some(r => r.id === 'g.deny-lower' && r.outcome === 'deny')).toBe(true)

    const obsReg = createJudgementRegistry({ onEvaluated: async () => Promise.reject(new Error('async sink fail')) })
    obsReg.register({
      kind: 'gate', id: 'g.obs', version: 1, point: 'verify.test-gate', description: 'obs',
      placement: { timing: 'pre', enforce: true }, requires: ['retry'],
      gate: () => ({ kind: 'deny', blockers: ['obs-hit'] }),
    }, 'observe')
    const obsEv = await obsReg.evaluate('verify.test-gate', { retry: 1 })
    expect(obsEv.registered).toBe(1)
    expect(obsEv.evaluated).toBe(1)
    expect(obsEv.verdict).toEqual({ kind: 'allow' })
    expect(obsEv.observed.map(o => o.id)).toEqual(['g.obs'])
  })

  it('downgrades to evaluator-stale when proof is missing or evaluator upgrades beyond proof version', async () => {
    const reg = createJudgementRegistry()
    const evalV1: EvaluatorDef = { kind: 'evaluator', id: 'eval.core', version: 1, measures: 'accuracy', evaluate: () => ({ verdict: 'effective', probability: 0.9, reasons: ['ok'] }) }
    reg.register(evalV1, 'enforce')
    reg.register({
      kind: 'gate', id: 'g.proven', version: 1, point: 'ticket.test-dispatch', description: 'proven gate',
      placement: { timing: 'pre', enforce: true }, requires: ['ticketId'],
      proof: { evaluator: 'eval.core', minVersion: 1, minProbability: 0.8 },
      gate: () => ({ kind: 'allow' }),
    }, 'enforce')

    const unproven = await reg.evaluate('ticket.test-dispatch', { ticketId: 'T-1' })
    expect(unproven.verdict.kind === 'unmeasured' && unproven.verdict.cause).toBe('evaluator-stale')

    reg.recordProof({
      subject: { id: 'g.proven', version: 1 }, evaluator: 'eval.core@v1',
      reading: { verdict: 'effective', probability: 0.91, reasons: ['golden'] }, at: { seq: 1, id: 'm0-1' },
    })
    expect((await reg.evaluate('ticket.test-dispatch', { ticketId: 'T-1' })).verdict).toEqual({ kind: 'allow' })

    reg.unregister('eval.core')
    reg.register({ ...evalV1, version: 2 }, 'enforce')
    const stale = await reg.evaluate('ticket.test-dispatch', { ticketId: 'T-1' })
    expect(stale.verdict.kind).toBe('unmeasured')
    if (stale.verdict.kind === 'unmeasured') expect(stale.verdict.cause).toBe('evaluator-stale')
  })
})

describe('deposit admission, D5 constitutional gate, and red-green cases runner', () => {
  it('validates DEPOSIT.md frontmatter + 5 sections and rejects empty params for non-owner trust', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deposit-ok-'))
    tempDirs.push(dir)
    mkdirSync(join(dir, 'cases'))
    writeFileSync(join(dir, 'DEPOSIT.md'), `---
id: verify.red-green
version: 1
kind: gate
point: verify.test-gate
params:
  minRetry:
    type: number
trust: collaborator
cases: cases/
---
${VALID_PROSE}
`)
    writeFileSync(join(dir, 'cases', 'fixtures.json'), JSON.stringify([
      { name: 'green', expected: 'allow', ctx: { task: { id: 't1' }, retry: 1 } },
      { name: 'red', expected: 'deny', ctx: { task: { id: 't1' }, retry: 0 } },
      { name: 'missing', expected: 'unmeasured', expectedCause: 'missing-input', ctx: { retry: 1 } },
    ]))
    return loadDepositPackage(dir).then(async ({ admission, cases }) => {
      expect(admission.admitted).toBe(true)
      const gate: GateDef<'verify.test-gate'> = {
        kind: 'gate', id: 'verify.red-green', version: 1, point: 'verify.test-gate', description: 'red-green',
        placement: { timing: 'pre', enforce: true }, requires: ['task.id', 'retry'],
        gate: ctx => (ctx.retry > 0 ? { kind: 'allow' } : { kind: 'deny', blockers: ['retry must > 0'] }),
      }
      const report = await runDepositCases(gate, cases)
      expect(report.ok).toBe(true)
      expect(report.mutationPassed).toBe(true)
      expect(report.passed).toBe(3)

      const brokenGate: GateDef<'verify.test-gate'> = { ...gate, gate: () => ({ kind: 'allow' }) }
      const brokenReport = await runDepositCases(brokenGate, cases)
      expect(brokenReport.ok).toBe(false)
      expect(brokenReport.failed).toBe(1)

      const noRedReport = await runDepositCases(gate, [cases[0]!])
      expect(noRedReport.ok).toBe(false)
      expect(noRedReport.mutationPassed).toBe(false)

      const unwiredRedReport = await runDepositCases(gate, [
        cases[0]!,
        { name: 'unwired-red', expected: 'deny', ctx: { retry: 0 } },
      ])
      expect(unwiredRedReport.ok).toBe(false)
      expect(unwiredRedReport.mutationPassed).toBe(false)
    })
  })

  it('rejects empty params on shared trust and enforces D5 constitutional correction on Seen>=3 counter-rule', () => {
    const missingParamsShared = admitDeposit(`---
{
  "id": "verify.private-only",
  "version": 1,
  "kind": "gate",
  "point": "verify.test-gate",
  "params": {},
  "trust": "public",
  "cases": "cases/"
}
---
${VALID_PROSE}`)
    expect(missingParamsShared.admitted).toBe(false)
    if (!missingParamsShared.admitted) {
      expect(missingParamsShared.violations.some(v => v.rule === 'params-required-for-shared-trust')).toBe(true)
    }

    const d5Blocked: DepositManifest = {
      id: 'lessons.seen-promote', version: 1, kind: 'counter-rule', point: 'verify.test-gate',
      params: { threshold: { type: 'number' } }, trust: 'owner', prose: VALID_PROSE, cases: 'cases/',
      stage: 'enforce', enforce: true, actionClass: 'side-effecting', action: { name: 'rule.promote' },
    }
    const d5Res = admitDeposit(d5Blocked)
    expect(d5Res.admitted).toBe(false)
    if (!d5Res.admitted) {
      expect(d5Res.violations[0]?.rule).toBe('constitutional-d5-counter-rule')
      expect(d5Res.violations[0]?.suggestion).toContain('shadow')
    }

    const d5Compliant = admitDeposit({
      ...d5Blocked, stage: 'shadow', enforce: false, actionClass: 'observe', action: { name: 'proposal.create' },
    })
    expect(d5Compliant.admitted).toBe(true)

    const ownerNoParams = admitDeposit(`---
id: verify.owner-private
version: 1
kind: gate
point: verify.test-gate
params: {}
trust: owner
cases: cases/
---
${VALID_PROSE}`)
    expect(ownerNoParams.admitted).toBe(true)

    const missingSec = admitDeposit(`---
id: verify.incomplete-prose
version: 1
kind: gate
point: verify.test-gate
params: {}
trust: owner
cases: cases/
---
## 意图
only intent
`)
    expect(missingSec.admitted).toBe(false)
    if (!missingSec.admitted) {
      expect(missingSec.violations.filter(v => v.rule === 'missing-prose-section')).toHaveLength(4)
    }
  })
})
