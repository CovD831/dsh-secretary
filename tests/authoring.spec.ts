import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CARD_TTL_MS,
  assertCardByteLimit,
  buildDepositDraftCard,
  buildEscalationCard,
  buildExpiredCardReplacement,
  buildReplayReportCard,
  isCardExpired,
  parseFeishuCardCallback,
  routeEscalationRuling,
  splitMarkdownElements,
  telemetryToSpineInput,
  validateDepositDraft,
  writeDepositDraftPackage,
  type DepositDraft,
  type EscalationRuling,
} from '../src/authoring/index.ts'
import { loadDepositPackage } from '../src/judgement/deposit.ts'
import { runHistoricalReplay } from '../src/rsi/replay.ts'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

const makeBaseDraft = (overrides: Partial<DepositDraft> = {}): DepositDraft => ({
  id: 'verify.red-green-sample',
  name: '修复必带红绿测',
  version: 1,
  author: 'ou_boss_001',
  scope: 'workspace:main',
  kind: 'gate',
  level: 'object',
  point: 'verify.preflight',
  trigger: { on: 'completion.claimed', mode: 'on-event', globs: ['src/**/*.ts'] },
  requires: ['task.diff', 'ci.results'],
  params: { minCoverage: { type: 'number', default: 0.8, min: 0, max: 1 } },
  exceptions: ['纯文档修改可跳过'],
  repairHint: '请补充去修复即红的测试用例后重跑验证。',
  intent: '防止未附带红绿测试证据的修复直接宣称完成。',
  rubricBody: '必须提供 base 失败、head 通过的测试证据。',
  enforce: true,
  actionClass: 'block',
  origin: { kind: 'user-authored' },
  cases: [
    { name: 'green-with-test', expected: 'allow', ctx: { hasRedGreen: true }, note: '含红绿测放行' },
    { name: 'red-no-test', expected: 'deny', ctx: { hasRedGreen: false }, note: '无测试拦截' },
  ],
  ...overrides,
})

describe('feishu CardKit 2.0 cards, guards, expiration, and 3s callbacks', () => {
  it('splits long markdown under 2800 chars and truncates >30KB UTF-8 cards to deep link', () => {
    const longMd = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行：${'数据'.repeat(25)}`).join('\n')
    const chunks = splitMarkdownElements(longMd, 2800)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2800)
    expect(splitMarkdownElements('A'.repeat(6000), 2800).every(c => c.length <= 2800)).toBe(true)

    const built = buildEscalationCard({
      escalationId: 'esc-huge',
      ticketId: 'T-99',
      title: '超长上下文裁决',
      summary: '中'.repeat(15_000),
      detailUrl: 'https://dsh.local/tickets/T-99',
      issuedAt: '2026-11-23T00:00:00.000Z',
    })
    expect(built.truncated).toBe(true)
    expect(built.byteLength).toBeLessThanOrEqual(30_000)
    expect(JSON.stringify(built.card)).toContain('https://dsh.local/tickets/T-99')

    const manualCheck = assertCardByteLimit(built.card, 30_000)
    expect(manualCheck.truncated).toBe(false)
    expect(manualCheck.byteLength).toBeLessThanOrEqual(30_000)
  })

  it('builds escalation cards with 14-day TTL, rolling replacement, and idempotent <3s callback lock', () => {
    const issuedAt = '2026-11-01T00:00:00.000Z'
    const card = buildEscalationCard({
      escalationId: 'esc-1', ticketId: 'T-1', title: '未知错误码停用确认',
      summary: '连续失败 12 次，需确认归因与是否立规。', issuedAt, sourceRef: { seq: 42, id: 'm0-42' },
    })
    expect(card.card.schema).toBe('2.0')
    expect(card.card.config.update_multi).toBe(true)
    expect(Date.parse(card.expiresAt) - Date.parse(issuedAt)).toBe(CARD_TTL_MS)
    expect(isCardExpired(issuedAt, '2026-11-14T23:59:59.000Z')).toBe(false)
    expect(isCardExpired(issuedAt, '2026-11-15T00:00:00.000Z')).toBe(true)

    const rolled = buildExpiredCardReplacement({
      request: { escalationId: 'esc-1', ticketId: 'T-1', title: '未知错误码停用确认', summary: '重试滚动', issuedAt },
      now: '2026-11-16T08:00:00.000Z',
    })
    expect(JSON.stringify(rolled.expiredOldCard.card)).toContain('已过期，请在新卡操作')
    expect(rolled.replacementCard.issuedAt).toBe('2026-11-16T08:00:00.000Z')

    expect(parseFeishuCardCallback({ operator: { open_id: '' }, action: {} }).ok).toBe(false)
    const seen = new Set<string>()
    const rawCb = {
      header: { event_id: 'cb-evt-100' },
      event: {
        operator: { open_id: 'ou_boss_001' },
        action: {
          value: { escalationId: 'esc-1', ticketId: 'T-1', decision: 'revise', sourceRef: { seq: 42, id: 'm0-42' } },
          form_value: { attribution: 'gate_gap', captureAsRule: true, note: '补齐判据' },
        },
      },
    }
    const first = parseFeishuCardCallback(rawCb, { seenCallbackIds: seen, now: '2026-11-02T01:02:03.000Z' })
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.duplicate).toBe(false)
      expect(first.ruling?.captureAsRule).toBe(true)
      expect(first.ruling?.attribution).toBe('gate_gap')
      const cardText = JSON.stringify(first.response.card)
      expect(cardText).toContain('已裁决：修改意见')
      expect(cardText).toContain('ou_boss_001')
      expect(cardText).toContain('2026-11-02T01:02:03.000Z')
    }
    const retry = parseFeishuCardCallback(rawCb, { seenCallbackIds: seen })
    expect(retry.ok && retry.duplicate).toBe(true)
  })

  it('renders yellow default warnings on draft card and bidirectional metrics on replay card', async () => {
    const draft = makeBaseDraft({ unansweredSlots: ['exceptions', 'params.minCoverage'] })
    const draftCard = buildDepositDraftCard(draft)
    expect(draftCard.card.header?.template).toBe('yellow')
    expect(JSON.stringify(draftCard.card)).toContain('保守默认值')

    const replay = await runHistoricalReplay(
      (input: { ok: boolean }) => (input.ok ? { kind: 'allow' } : { kind: 'deny', blockers: ['missing'] }),
      [
        { id: 'c1', family: 'f1', input: { ok: false }, expectedOutcome: 'defect', tokens: 120, durationMs: 40 },
        { id: 'c2', family: 'f2', input: { ok: false }, expectedOutcome: 'clean', tokens: 80, durationMs: 25 },
        { id: 'c3', family: 'f3', input: { ok: true }, expectedOutcome: 'defect', tokens: 60, durationMs: 20 },
      ],
      { costModel: { perEvalTokens: 10, perEvalMs: 5 } },
    )
    const reportCard = buildReplayReportCard(draft, replay)
    const text = JSON.stringify(reportCard.card)
    expect(text).toContain('误伤（falseBlocks）**：1/3')
    expect(text).toContain('漏检（misses）**：1/3')
    expect(text).toContain('coverageDiscount')
    expect(text).toContain('deltaTokens')
    expect(text).toContain('装入影子试穿期（只记账不拦截）')
  })
})

describe('authoring funnel: machine gate, D5 correction, 4-way routing, telemetry, and package roundtrip', () => {
  it('loudly rejects empty params on shared scope, enforces D5 counter-rule rewrite, checks mandate, and separates evidence gate', () => {
    const sharedNoParams = validateDepositDraft(makeBaseDraft({ params: {}, scope: 'public' }))
    expect(sharedNoParams.ok).toBe(false)
    if (!sharedNoParams.ok && sharedNoParams.gate === 'machine') {
      expect(sharedNoParams.violations.some(v => v.ruleId === 'params-required-for-shared-scope')).toBe(true)
      expect(sharedNoParams.repairedDraft.scope).toBe('private')
      expect(validateDepositDraft(sharedNoParams.repairedDraft).ok).toBe(true)
    }

    const d5Violation = validateDepositDraft(makeBaseDraft({ kind: 'counter-rule', enforce: true, actionClass: 'block' }))
    expect(d5Violation.ok).toBe(false)
    if (!d5Violation.ok && d5Violation.gate === 'machine') {
      expect(d5Violation.violations.some(v => v.ruleId === 'constitutional-d5-counter-rule')).toBe(true)
      expect(d5Violation.repairedDraft.enforce).toBe(false)
      expect(d5Violation.repairedDraft.stage).toBe('shadow')
      expect(d5Violation.repairedDraft.actionClass).toBe('observe')
      expect(validateDepositDraft(d5Violation.repairedDraft).ok).toBe(true)
    }

    const badMandateAndReqs = validateDepositDraft(makeBaseDraft({
      id: '', version: 0, point: 'invalid_point', intent: '  ',
      requires: ['task.id', '', '../secret'], actionClass: 'side-effecting', mandateCeiling: 'L1', mandateRef: undefined,
    }))
    expect(badMandateAndReqs.ok).toBe(false)
    if (!badMandateAndReqs.ok && badMandateAndReqs.gate === 'machine') {
      const rules = new Set(badMandateAndReqs.violations.map(v => v.ruleId))
      expect(rules.has('invalid-id')).toBe(true)
      expect(rules.has('invalid-version')).toBe(true)
      expect(rules.has('invalid-point')).toBe(true)
      expect(rules.has('missing-intent')).toBe(true)
      expect(rules.has('invalid-requires')).toBe(true)
      expect(rules.has('missing-mandate-ref')).toBe(true)
      expect(rules.has('exceeds-mandate-ceiling')).toBe(true)
    }

    const needsSamples = validateDepositDraft(makeBaseDraft({ cases: [{ name: 'only-green', expected: 'allow', ctx: {} }] }))
    expect(needsSamples.ok).toBe(false)
    if (!needsSamples.ok && needsSamples.gate === 'evidence') {
      expect(needsSamples.status).toBe('needs-more-samples')
      expect(needsSamples.missingPositive).toBe(false)
      expect(needsSamples.missingNegative).toBe(true)
    }
  })

  it('routes 4-way attributions deterministically and converts telemetry to redacted SpineInput', () => {
    const baseRuling = (overrides: Partial<EscalationRuling>): EscalationRuling => ({
      escalationId: 'esc-9', ticketId: 'T-9', operatorOpenId: 'ou_boss_001',
      decision: 'approve', attribution: 'env_transient', sourceRef: { seq: 9, id: 'm0-9' }, decidedAt: '2026-11-23T00:00:00Z',
      ...overrides,
    })
    const rEnv = routeEscalationRuling(baseRuling({ attribution: 'env_transient' }))
    expect(rEnv.route === 'transient-retry' && rEnv.suppressRuleProposal).toBe(true)

    const rExec = routeEscalationRuling(baseRuling({ attribution: 'exec_mistake' }))
    expect(rExec.route === 'workspace-memory-proposal' && rExec.layer === 'm3').toBe(true)

    const rGate = routeEscalationRuling(baseRuling({ attribution: 'gate_gap' }))
    expect(rGate.route === 'deposit-draft' && rGate.draft.origin.kind === 'friction-mined').toBe(true)
    if (rGate.route === 'deposit-draft') expect(rGate.draft.origin.refs).toEqual(['esc-9'])

    const rCaptured = routeEscalationRuling(baseRuling({ attribution: 'exec_mistake', captureAsRule: true }))
    expect(rCaptured.route).toBe('deposit-draft')

    const rMandate = routeEscalationRuling(baseRuling({ attribution: 'mandate_unclear' }))
    expect(rMandate.route === 'user-ruling-memory-proposal' && rMandate.layer === 'm2').toBe(true)

    const spine = telemetryToSpineInput({
      kind: 'admission_rejected', draftId: 'verify.demo', at: '2026-11-23T01:00:00Z',
      actorId: 'secretary', ruleId: 'missing-mandate-ref', field: 'mandateRef', reason: 'token sk-abcdefghijklmnop12345 leaked',
    })
    expect(spine.stream).toBe('authoring:verify.demo')
    expect(spine.type).toBe('authoring.admission_rejected')
    expect(String(spine.payload['reason'])).toContain('[REDACTED]')
    expect(String(spine.payload['reason'])).not.toContain('sk-abcdefghijklmnop12345')
  })

  it('writes standard DEPOSIT.md + cases.json loadable by loadDepositPackage and blocks traversal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-authoring-pkg-'))
    tempDirs.push(root)

    await expect(writeDepositDraftPackage(root, makeBaseDraft({ id: '../escape' }))).rejects.toThrow()

    const draft = makeBaseDraft()
    const written = await writeDepositDraftPackage(root, draft)
    const loaded = await loadDepositPackage(written.packageDir)
    expect(loaded.admission.admitted).toBe(true)
    if (loaded.admission.admitted) {
      expect(loaded.admission.manifest.id).toBe(draft.id)
      expect(loaded.admission.manifest.trust).toBe('collaborator')
      expect(loaded.admission.sections?.intent).toBe(draft.intent)
    }
    expect(loaded.cases).toHaveLength(2)
    expect(loaded.cases.map(c => c.expected)).toEqual(['allow', 'deny'])
  })
})
