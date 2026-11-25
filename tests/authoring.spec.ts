import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  toMemoryProposal,
  validateDepositDraft,
  writeDepositDraftPackage,
  type DepositDraft,
  type EscalationRuling,
} from '../src/authoring/index.ts'
import { loadDepositPackage, parseDepositMarkdown } from '../src/judgement/deposit.ts'
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

describe('feishu CardKit 2.0 cards, guards, expiration, and hardened 3s callbacks', () => {
  it('splits long markdown and enforces <=30KB UTF-8 limit even with oversized header', () => {
    const longMd = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行：${'数据'.repeat(25)}`).join('\n')
    const chunks = splitMarkdownElements(longMd, 2800)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2800)

    const built = buildEscalationCard({
      escalationId: 'esc-huge', ticketId: 'T-99', title: '标'.repeat(500),
      summary: '中'.repeat(15_000), detailUrl: 'https://dsh.local/tickets/T-99', issuedAt: '2026-11-23T00:00:00.000Z',
    })
    expect(built.truncated).toBe(true)
    expect(built.byteLength).toBeLessThanOrEqual(30_000)
    expect(JSON.stringify(built.card)).toContain('https://dsh.local/tickets/T-99')
    expect(assertCardByteLimit(built.card, 400).byteLength).toBeLessThanOrEqual(400)
  })

  it('enforces 14-day TTL, operator auth, ticketId, anti-fake SourceRef, and idempotent callback lock', () => {
    const issuedAt = '2026-11-01T00:00:00.000Z'
    const card = buildEscalationCard({
      escalationId: 'esc-1', ticketId: 'T-1', title: '未知错误码停用确认',
      summary: '连续失败 12 次，需确认归因与是否立规。', issuedAt, sourceRef: { seq: 42, id: 'm0-42' },
    })
    expect(card.card.schema).toBe('2.0')
    expect(Date.parse(card.expiresAt) - Date.parse(issuedAt)).toBe(CARD_TTL_MS)
    expect(isCardExpired(issuedAt, '2026-11-15T00:00:00.000Z')).toBe(true)

    const rolled = buildExpiredCardReplacement({
      request: { escalationId: 'esc-1', ticketId: 'T-1', title: '未知错误码停用确认', summary: '滚动重发', issuedAt },
      now: '2026-11-16T08:00:00.000Z',
    })
    expect(JSON.stringify(rolled.expiredOldCard.card)).toContain('已过期，请在新卡操作')

    const seen = new Set<string>()
    const rawCb = {
      header: { event_id: 'cb-evt-100' },
      event: {
        operator: { open_id: 'ou_boss_001' },
        action: {
          value: { escalationId: 'esc-1', ticketId: 'T-1', decision: 'revise', issuedAt },
          form_value: { attribution: 'gate_gap', captureAsRule: true, note: '补齐判据' },
        },
      },
    }
    expect(parseFeishuCardCallback(rawCb, { seenCallbackIds: seen, now: '2026-11-02T00:00:00Z', isAllowedOperator: id => id === 'ou_other' })).toEqual({ ok: false, reason: 'unauthorized-operator' })
    expect(seen.size).toBe(0)
    expect(parseFeishuCardCallback(rawCb, { now: '2026-11-16T00:00:00Z' })).toEqual({ ok: false, reason: 'card-expired' })
    expect(parseFeishuCardCallback({ event: { operator: { open_id: 'ou_boss_001' }, action: { value: { decision: 'approve' }, form_value: { attribution: 'gate_gap' } } } })).toEqual({ ok: false, reason: 'missing-ticket-id' })
    expect(parseFeishuCardCallback(rawCb, { now: '2026-11-02T00:00:00Z', verifiedSourceRef: { seq: 0, id: 'fake' } })).toEqual({ ok: false, reason: 'invalid-source-ref' })

    const withoutRef = parseFeishuCardCallback(rawCb, { now: '2026-11-02T01:02:03.000Z' })
    expect(withoutRef.ok).toBe(true)
    if (withoutRef.ok) {
      expect(withoutRef.ruling).toBeUndefined()
      expect(withoutRef.pendingRuling?.ticketId).toBe('T-1')
    }

    const withRef = parseFeishuCardCallback(rawCb, { seenCallbackIds: seen, now: '2026-11-02T01:02:03.000Z', isAllowedOperator: id => id === 'ou_boss_001', verifiedSourceRef: { seq: 42, id: 'm0-42' } })
    expect(withRef.ok).toBe(true)
    if (withRef.ok) {
      expect(withRef.ruling?.sourceRef).toEqual({ seq: 42, id: 'm0-42' })
      expect(JSON.stringify(withRef.response.card)).toContain('已裁决：修改意见')
    }
    expect(parseFeishuCardCallback(rawCb, { seenCallbackIds: seen, now: '2026-11-02T01:02:03.000Z' })).toMatchObject({ ok: true, duplicate: true })
  })

  it('renders yellow default warnings on draft card and bidirectional metrics on replay card', async () => {
    const draft = makeBaseDraft({ unansweredSlots: ['exceptions'] })
    expect(buildDepositDraftCard(draft).card.header?.template).toBe('yellow')
    const replay = await runHistoricalReplay(
      (input: { ok: boolean }) => (input.ok ? { kind: 'allow' } : { kind: 'deny', blockers: ['missing'] }),
      [
        { id: 'c1', family: 'f1', input: { ok: false }, expectedOutcome: 'defect', tokens: 120, durationMs: 40 },
        { id: 'c2', family: 'f2', input: { ok: false }, expectedOutcome: 'clean', tokens: 80, durationMs: 25 },
        { id: 'c3', family: 'f3', input: { ok: true }, expectedOutcome: 'defect', tokens: 60, durationMs: 20 },
      ],
    )
    const text = JSON.stringify(buildReplayReportCard(draft, replay).card)
    expect(text).toContain('误伤（falseBlocks）**：1/3')
    expect(text).toContain('漏检（misses）**：1/3')
    expect(text).toContain('装入影子试穿期（只记账不拦截）')
  })
})

describe('authoring funnel, D5 & mandate gates, memory proposal bridge, and symlink-safe packaging', () => {
  it('enforces D5 action.name, fail-closed mandateCeiling, standing-order signal, ParamSpec bounds, and evidence gate', () => {
    const d5BadAction = validateDepositDraft(makeBaseDraft({ kind: 'counter-rule', enforce: false, stage: 'shadow', actionClass: 'observe', action: { name: 'rule.promote' } }))
    expect(d5BadAction.ok).toBe(false)
    if (!d5BadAction.ok && d5BadAction.gate === 'machine') {
      expect(d5BadAction.violations[0]?.ruleId).toBe('constitutional-d5-counter-rule')
      expect(d5BadAction.repairedDraft.action?.name).toBe('proposal.create')
      expect(validateDepositDraft(d5BadAction.repairedDraft).ok).toBe(true)
    }

    const sideEffectNoCeiling = validateDepositDraft(makeBaseDraft({ actionClass: 'side-effecting', mandateRef: 'ws:m1', mandateCeiling: undefined }))
    expect(sideEffectNoCeiling.ok).toBe(false)
    if (!sideEffectNoCeiling.ok && sideEffectNoCeiling.gate === 'machine') {
      expect(sideEffectNoCeiling.violations.some(v => v.ruleId === 'exceeds-mandate-ceiling')).toBe(true)
    }

    const badOrderAndParam = validateDepositDraft(makeBaseDraft({
      kind: 'standing-order', trigger: { on: 'sig', signal: '', mode: 'scheduled-sweep' },
      params: { bad: { type: 'number', min: 10, max: 2 } }, scope: 'public',
    }))
    expect(badOrderAndParam.ok).toBe(false)
    if (!badOrderAndParam.ok && badOrderAndParam.gate === 'machine') {
      const rules = new Set(badOrderAndParam.violations.map(v => v.ruleId))
      expect(rules.has('missing-trigger-signal')).toBe(true)
      expect(rules.has('invalid-param-spec')).toBe(true)
    }

    const needsSamples = validateDepositDraft(makeBaseDraft({ cases: [{ name: 'only-green', expected: 'allow', ctx: {} }] }))
    expect(needsSamples).toMatchObject({ ok: false, gate: 'evidence', status: 'needs-more-samples', missingPositive: false, missingNegative: true })
  })

  it('routes 4-way attributions, bridges M2/M3 proposals, and redacts telemetry with untrusted taint', () => {
    const base = (overrides: Partial<EscalationRuling>): EscalationRuling => ({
      escalationId: 'esc-9', ticketId: 'T-9', operatorOpenId: 'ou_boss_001',
      decision: 'approve', attribution: 'env_transient', sourceRef: { seq: 9, id: 'm0-9' }, decidedAt: '2026-11-23T00:00:00Z',
      ...overrides,
    })
    expect(routeEscalationRuling(base({ attribution: 'env_transient' }))).toMatchObject({ route: 'transient-retry', suppressRuleProposal: true })
    expect(routeEscalationRuling(base({ attribution: 'gate_gap' })).route).toBe('deposit-draft')

    const m3Route = routeEscalationRuling(base({ attribution: 'exec_mistake', note: '先跑 typecheck' }), { workspace: 'main' })
    expect(m3Route.route).toBe('workspace-memory-proposal')
    if (m3Route.route === 'workspace-memory-proposal') {
      expect(toMemoryProposal(m3Route, { slug: 'Run Typecheck!' })).toMatchObject({
        layer: 'm3', workspaceKey: 'main', slug: 'run-typecheck', scope: 'workspace:main',
        sourceType: 'user_ruling', author: 'user', confidence: 'stated', taint: 'clean', clearance: 'workspace',
      })
    }
    const m2Route = routeEscalationRuling(base({ attribution: 'mandate_unclear', note: '禁止自动 push' }))
    if (m2Route.route === 'user-ruling-memory-proposal') {
      expect(toMemoryProposal(m2Route, { m2Kind: 'veto' })).toMatchObject({
        layer: 'm2', scope: 'global', sourceType: 'user_ruling', m2Kind: 'veto', clearance: 'private',
      })
    }

    const spine = telemetryToSpineInput({
      kind: 'admission_rejected', draftId: 'verify.demo', at: '2026-11-23T01:00:00Z',
      actorId: 'secretary', ruleId: 'missing-mandate-ref', field: 'mandateRef',
      reason: 'leaked sk-proj-abcdef1234567890xyz', evidence: [{ kind: 'event', ref: 'token=ghp_1234567890abcdefghij123456' }],
    })
    expect(spine.taint).toBe('untrusted')
    expect(JSON.stringify(spine)).not.toContain('sk-proj-abcdef1234567890xyz')
    expect(JSON.stringify(spine)).not.toContain('ghp_1234567890abcdefghij123456')
    expect(spine.redacted?.length).toBeGreaterThanOrEqual(2)
  })

  it('blocks symlink escape before mkdir/writeFile, rejects secrets, and preserves manifest metadata for loadDepositPackage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-auth-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-auth-out-'))
    tempDirs.push(root, outside)

    symlinkSync(outside, join(root, 'verify.symlink-dir'))
    await expect(writeDepositDraftPackage(root, makeBaseDraft({ id: 'verify.symlink-dir' }))).rejects.toThrow(/符号链接/)
    expect(existsSync(join(outside, 'cases'))).toBe(false)

    const targetFile = join(outside, 'victim.txt')
    writeFileSync(targetFile, 'ORIGINAL')
    mkdirSync(join(root, 'verify.symlink-file', 'cases'), { recursive: true })
    symlinkSync(targetFile, join(root, 'verify.symlink-file', 'DEPOSIT.md'))
    await expect(writeDepositDraftPackage(root, makeBaseDraft({ id: 'verify.symlink-file' }))).rejects.toThrow(/符号链接/)
    expect(readFileSync(targetFile, 'utf8')).toBe('ORIGINAL')

    await expect(writeDepositDraftPackage(root, makeBaseDraft({ intent: 'secret sk-proj-abcdef1234567890xyz' }))).rejects.toThrow(/凭据/)

    const draft = makeBaseDraft({ mandateRef: 'ws:main#m1', mandateCeiling: 'L2', origin: { kind: 'friction-mined', refs: ['esc-42'] } })
    const written = await writeDepositDraftPackage(root, draft)
    const parsed = parseDepositMarkdown(readFileSync(written.depositMdPath, 'utf8'))
    expect(parsed.rawManifest['requires']).toEqual(draft.requires)
    expect(parsed.rawManifest['scope']).toBe('workspace:main')
    expect(parsed.rawManifest['mandate_ref']).toBe('ws:main#m1')
    expect(parsed.rawManifest['origin']).toEqual({ kind: 'friction-mined', origin_refs: ['esc-42'] })

    const loaded = await loadDepositPackage(written.packageDir)
    expect(loaded.admission.admitted).toBe(true)
    expect(loaded.cases).toHaveLength(2)
  })
})
