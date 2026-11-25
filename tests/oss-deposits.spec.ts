import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createJudgementRegistry, loadDepositPackage, runDepositCases } from '../src/judgement/index.ts'
import {
  createIssueIntakeGate,
  createReplyDeskGate,
  createReproStatusGate,
  evaluateIssueIntake,
  evaluateReplyDesk,
  evaluateReproStatus,
  issueIntakeGate,
  replyDeskGate,
  reproStatusGate,
} from '../src/judgement/gates/index.ts'
import { runHistoricalReplay, type ReplayCase } from '../src/rsi/index.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

describe('OSS maintenance deposit packages', () => {
  it('loads, admits, and passes red-green + mutation checks for all 3 OSS deposits', async () => {
    const targets = [
      { dir: 'issue-intake-quadruple', gate: issueIntakeGate, point: 'intake.bug-quadruple' },
      { dir: 'repro-four-states', gate: reproStatusGate, point: 'verify.repro-evidence' },
      { dir: 'outbound-reply-desk', gate: replyDeskGate, point: 'outward.reply-desk' },
    ] as const
    for (const t of targets) {
      const { admission, cases } = await loadDepositPackage(join(REPO_ROOT, 'deposits', t.dir))
      expect(admission.admitted, `${t.dir} admission`).toBe(true)
      if (admission.admitted) {
        expect(admission.manifest.point).toBe(t.point)
        expect(Object.keys(admission.manifest.params).length).toBeGreaterThanOrEqual(2)
      }
      expect(cases.length).toBeGreaterThanOrEqual(4)
      const report = await runDepositCases(t.gate as never, cases)
      expect(report.error, `${t.dir} error`).toBeUndefined()
      expect(report.mutationPassed, `${t.dir} mutation`).toBe(true)
      expect(report.ok, `${t.dir} ok`).toBe(true)
    }
  })
})

describe('workflow 1: intake.bug-quadruple', () => {
  it('covers allow/deny/unmeasured boundaries and enforces boundParams over ctx.params', async () => {
    const reg = createJudgementRegistry()
    reg.register(createIssueIntakeGate({ dedup_similarity_threshold: 0.9, require_error_text: true }), 'enforce')

    expect((await reg.evaluate('intake.bug-quadruple', { issueType: 'bug' })).verdict).toMatchObject({ kind: 'unmeasured', cause: 'missing-input' })
    expect((await reg.evaluate('intake.bug-quadruple', { issueType: 'bug', body: null })).verdict).toMatchObject({ kind: 'unmeasured', cause: 'missing-input' })
    expect((await reg.evaluate('intake.bug-quadruple', {
      issueType: 'bug', body: 'dup', proposedAction: 'auto-close-duplicate',
      quadruple: { version: '1.0', platform: 'linux', steps: 'run', errorText: 'boom' },
    })).verdict.kind).toBe('deny')

    const forcedTriage = await reg.evaluate('intake.bug-quadruple', {
      issueType: 'bug', body: 'crash without error', proposedAction: 'triage',
      quadruple: { version: '1.0', platform: 'macOS', steps: 'open' },
      params: { require_error_text: false },
    })
    expect(forcedTriage.verdict.kind).toBe('deny')

    const routed = await reg.evaluate('intake.bug-quadruple', {
      issueType: 'bug', body: 'crash', proposedAction: 'needs-info',
      quadruple: { version: '1.0', platform: 'macOS' },
      dedupCandidates: [{ issueNumber: 12, similarity: 0.92, diffSummary: 'same crash' }, { issueNumber: 15, similarity: 0.87 }],
      params: { dedup_similarity_threshold: 0.8 },
    })
    expect(routed.verdict.kind).toBe('allow')
    if (routed.verdict.kind === 'allow') {
      const produced = routed.verdict.produced?.['intake.bug-quadruple'] as Record<string, unknown>
      expect(produced['nextStep']).toBe('needs-info')
      expect(produced['recognizedFields']).toEqual(['version', 'platform'])
      expect(produced['missingFields']).toEqual(['steps', 'errorText'])
      expect(produced['dedupProposals']).toEqual([{ issueNumber: 12, similarity: 0.92, diffSummary: 'same crash' }])
    }

    expect(evaluateIssueIntake({ issueType: 'enhancement', body: 'add dark mode', proposedAction: 'triage' }).kind).toBe('allow')
    expect(evaluateIssueIntake({
      issueType: 'bug', body: 'ok', proposedAction: 'triage',
      quadruple: { version: '1.0', platform: 'linux', steps: 'run' },
    }, { require_error_text: false }).kind).toBe('allow')
    expect(evaluateIssueIntake({ issueType: 'bug', body: 'x', params: { dedup_similarity_threshold: 0.3 } }).kind).toBe('deny')
  })
})

describe('workflow 2: verify.repro-evidence', () => {
  it('enforces four terminal states, not-reproduced non-close rule, and boundParams priority', async () => {
    const reg = createJudgementRegistry()
    reg.register(createReproStatusGate({ require_script_for_reproduced: true, min_red_output_chars: 12 }), 'enforce')

    expect((await reg.evaluate('verify.repro-evidence', {})).verdict).toMatchObject({ kind: 'unmeasured', cause: 'missing-input' })
    expect((await reg.evaluate('verify.repro-evidence', { terminalState: 'unknown-state' })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('verify.repro-evidence', {
      terminalState: 'not-reproduced', proposedAction: 'close-issue', matrixTried: ['macOS-15'],
    })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('verify.repro-evidence', {
      terminalState: 'not-reproduced', proposedAction: 'label-only', matrixTried: [],
    })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('verify.repro-evidence', {
      terminalState: 'not-reproduced', proposedAction: 'close-issue', humanConfirmedClose: true, matrixTried: ['macOS-15', 'ubuntu-24'],
    })).verdict.kind).toBe('allow')

    expect((await reg.evaluate('verify.repro-evidence', {
      terminalState: 'reproduced', redOutput: 'TypeError: x', proposedAction: 'open-fix-pr',
      params: { require_script_for_reproduced: false, min_red_output_chars: 5 },
    })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('verify.repro-evidence', {
      terminalState: 'blocked-needs-env', proposedAction: 'open-fix-pr',
    })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('verify.repro-evidence', {
      terminalState: 'blocked-needs-info', proposedAction: 'label-only',
    })).verdict.kind).toBe('allow')

    expect(evaluateReproStatus({
      terminalState: 'reproduced', reproScriptPath: 'repro/bug.ts', redOutput: 'AssertionError: expected 1 to equal 2',
    }).kind).toBe('allow')
  })
})

describe('workflow 3: outward.reply-desk', () => {
  it('enforces AI policies, thread recheck, rate-limit circuit breaker, T1/T2 ceiling, and boundParams', async () => {
    const reg = createJudgementRegistry()
    reg.register(createReplyDeskGate({ max_writes_per_min: 50, max_writes_per_hour: 300 }), 'enforce')

    expect((await reg.evaluate('outward.reply-desk', {
      repoAiPolicy: 'allow', threadClosedOrResolved: false, writesLastMinute: null, writesLastHour: 10,
    })).verdict).toMatchObject({ kind: 'unmeasured', cause: 'missing-input' })
    expect((await reg.evaluate('outward.reply-desk', {
      repoAiPolicy: 'require_disclosure', messageKind: 'template_ack', hasAiDisclosure: false,
      threadClosedOrResolved: false, writesLastMinute: 1, writesLastHour: 10,
    })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('outward.reply-desk', {
      repoAiPolicy: 'forbid_ai_comments', messageKind: 'template_ack', hasAiDisclosure: true,
      threadClosedOrResolved: false, writesLastMinute: 1, writesLastHour: 10,
    })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('outward.reply-desk', {
      repoAiPolicy: 'allow', messageKind: 'template_ack',
      threadClosedOrResolved: true, writesLastMinute: 1, writesLastHour: 10,
    })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('outward.reply-desk', {
      repoAiPolicy: 'allow', messageKind: 'template_ack',
      threadClosedOrResolved: false, writesLastMinute: 55, writesLastHour: 10,
      params: { max_writes_per_min: 80 },
    })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('outward.reply-desk', {
      repoAiPolicy: 'allow', messageKind: 'freeform_reply', humanApproved: false,
      threadClosedOrResolved: false, writesLastMinute: 1, writesLastHour: 10,
    })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('outward.reply-desk', {
      repoAiPolicy: 'require_disclosure', messageKind: 'freeform_reply', hasAiDisclosure: true, humanApproved: true,
      threadClosedOrResolved: false, writesLastMinute: 10, writesLastHour: 100,
    })).verdict.kind).toBe('allow')
    expect(evaluateReplyDesk({
      repoAiPolicy: 'allow', messageKind: 'template_ack', threadClosedOrResolved: false, writesLastMinute: 1, writesLastHour: 10,
      params: { max_writes_per_hour: 999 },
    }).kind).toBe('deny')
  })
})

describe('historical replay zero false-blocks across OSS workflows', () => {
  it('achieves zero falseBlocks and zero misses across all three workflow replay sets', async () => {
    const intakeCases: ReplayCase<Parameters<typeof evaluateIssueIntake>[0]>[] = [
      { id: 'in-1', family: 'intake', expectedOutcome: 'clean', input: { issueType: 'bug', body: 'crash', proposedAction: 'triage', quadruple: { version: '1.2', platform: 'macOS', steps: 'run', errorText: 'ENOENT' } } },
      { id: 'in-2', family: 'intake', expectedOutcome: 'clean', input: { issueType: 'bug', body: 'incomplete', proposedAction: 'needs-info', quadruple: { version: '1.2' } } },
      { id: 'in-3', family: 'intake', expectedOutcome: 'defect', input: { issueType: 'bug', body: 'dup', proposedAction: 'auto-close-duplicate', quadruple: { version: '1.2', platform: 'macOS', steps: 'run', errorText: 'ENOENT' } } },
      { id: 'in-4', family: 'intake', expectedOutcome: 'defect', input: { issueType: 'bug', body: 'guess', proposedAction: 'triage', quadruple: { version: '1.2' } } },
    ]
    const reproCases: ReplayCase<Parameters<typeof evaluateReproStatus>[0]>[] = [
      { id: 'rp-1', family: 'repro', expectedOutcome: 'clean', input: { terminalState: 'reproduced', reproScriptPath: 'repro/1.ts', redOutput: 'ReferenceError: x is not defined', proposedAction: 'open-fix-pr' } },
      { id: 'rp-2', family: 'repro', expectedOutcome: 'clean', input: { terminalState: 'not-reproduced', matrixTried: ['linux-x64'], proposedAction: 'label-only' } },
      { id: 'rp-3', family: 'repro', expectedOutcome: 'defect', input: { terminalState: 'not-reproduced', matrixTried: ['linux-x64'], proposedAction: 'close-issue' } },
      { id: 'rp-4', family: 'repro', expectedOutcome: 'defect', input: { terminalState: 'blocked-needs-env', proposedAction: 'open-fix-pr' } },
    ]
    const replyCases: ReplayCase<Parameters<typeof evaluateReplyDesk>[0]>[] = [
      { id: 'rd-1', family: 'reply', expectedOutcome: 'clean', input: { repoAiPolicy: 'require_disclosure', messageKind: 'template_ack', hasAiDisclosure: true, threadClosedOrResolved: false, writesLastMinute: 2, writesLastHour: 20 } },
      { id: 'rd-2', family: 'reply', expectedOutcome: 'clean', input: { repoAiPolicy: 'allow', messageKind: 'freeform_reply', humanApproved: true, threadClosedOrResolved: false, writesLastMinute: 2, writesLastHour: 20 } },
      { id: 'rd-3', family: 'reply', expectedOutcome: 'defect', input: { repoAiPolicy: 'forbid_ai_comments', messageKind: 'template_ack', threadClosedOrResolved: false, writesLastMinute: 1, writesLastHour: 5 } },
      { id: 'rd-4', family: 'reply', expectedOutcome: 'defect', input: { repoAiPolicy: 'allow', messageKind: 'template_ack', threadClosedOrResolved: true, writesLastMinute: 1, writesLastHour: 5 } },
      { id: 'rd-5', family: 'reply', expectedOutcome: 'defect', input: { repoAiPolicy: 'allow', messageKind: 'freeform_reply', humanApproved: false, threadClosedOrResolved: false, writesLastMinute: 1, writesLastHour: 5 } },
    ]

    for (const [fn, set] of [
      [evaluateIssueIntake, intakeCases],
      [evaluateReproStatus, reproCases],
      [evaluateReplyDesk, replyCases],
    ] as const) {
      const card = await runHistoricalReplay(fn as never, set as never)
      expect(card.falseBlocks).toBe(0)
      expect(card.misses).toBe(0)
      expect(card.unmeasuredCount).toBe(0)
      expect(card.coverageDiscount).toBe(1)
      expect(card.catches).toBeGreaterThan(0)
    }
  })
})
