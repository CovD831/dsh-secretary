import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { RulingQueue } from '../src/app/ruling-queue.ts'
import { Store } from '../src/app/store.ts'
import { waitsForPerson, type Ticket } from '../src/core/index.ts'
import { feishu, startRuntime } from './fixtures/host.ts'
import { runHostDiffReview, runHostPlanReview } from '../src/executor/adversarial-review.ts'
import { prepareLaunchCapsule } from '../src/executor/capsule-hook.ts'
import { collectSanitizedDiffBundle } from '../src/executor/completion-metrics.ts'
import { PreExecuteCompletionGuard } from '../src/executor/pre-execute-gates.ts'
import { evaluateDiffReview } from '../src/judgement/gates/diff-review.ts'
import { evaluatePlanReview } from '../src/judgement/gates/plan-review.ts'
import { createJudgementRegistry, discoverAndRegisterDeposits } from '../src/judgement/index.ts'
import { KV } from '../src/kv.ts'
import { MemoryWriter } from '../src/memory/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { GitRepoLock, createSpineAppender, ensureSpineSchema, type SpineEnvelope } from '../src/spine/index.ts'
import { provisionWorktree } from '../src/workspaces/worktree.ts'

const tempDirs: string[] = []
const stores: Store[] = []

function makeDir(prefix = 'dsh-p10-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}
function makeStore(): Store {
  const s = new Store(join(makeDir('dsh-p10-db-'), 'orch.db'))
  stores.push(s)
  return s
}
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' })
}

class MockReviewAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  constructor(private readonly handler: (opts: GenerateOptions, idx: number) => string) { super() }
  override async *stream(opts: GenerateOptions): AsyncIterable<StreamChunk> {
    const idx = this.calls.push(opts) - 1
    yield { type: 'text-delta', index: 0, text: this.handler(opts, idx) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setupEnv(opts?: { ticketId?: string; verifyCommands?: string[]; stageOverrides?: Record<string, 'shadow' | 'observe' | 'enforce' | 'retired'> }) {
  const repo = makeDir('dsh-p10-repo-'), stateDir = makeDir('dsh-p10-state-')
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Tester']); git(repo, ['config', 'user.email', 'tester@example.com'])
  mkdirSync(join(repo, 'src/auth'), { recursive: true }); mkdirSync(join(repo, 'tests'), { recursive: true })
  writeFileSync(join(repo, 'src/slug.ts'), 'export const slug = 1\n')
  writeFileSync(join(repo, 'src/auth/guard.ts'), 'export function check(x: number) { return x > 0 }\n')
  writeFileSync(join(repo, 'tests/auth.spec.ts'), 'export const ok = true\n')
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'init'])

  const store = makeStore(); ensureSpineSchema(store.db, 0)
  const events: SpineEnvelope[] = []; let seq = 0
  const rawApp = createSpineAppender(store, { kick: () => {} })
  const appender = {
    append: (draft: Parameters<typeof rawApp.append>[0]) => {
      const ref = rawApp.append(draft)
      events.push({ v: 1, seq: ++seq, at: draft.at ?? new Date().toISOString(), ...draft } as SpineEnvelope)
      return ref
    },
  }
  const ws = { id: 'ws-p10', repository: repo, baseBranch: 'main', branchPrefix: 'ticket/', isolation: 'I2' as const }
  store.saveSettings(SettingsSchema.parse({ workspaces: [ws], eval: { model: { provider: 'deepseek', model: 'deepseek-chat' } } }))
  const id = opts?.ticketId ?? 't-p10', wt = join(stateDir, 'work', id)
  await provisionWorktree({ ticketId: id, workspace: ws, executionName: id, targetDir: wt, appender })
  store.tickets.save({
    id, title: 'Harden auth guard', state: 'working', origin: { triggerId: id, triggerIds: [id], thread: 'desk:1' }, channels: [],
    mandate: { strength: 'explicit', basis: {}, actor: { source: 'secretary-bus', id: 'boss' } },
    execution: { directory: wt, name: `worker-${id}`, assignment: 'check expiry on token', workspace: 'ws-p10', verifyCommands: opts?.verifyCommands ?? ['pnpm test'] },
    assignments: [],
  } as unknown as Ticket)
  const registry = createJudgementRegistry()
  await discoverAndRegisterDeposits({
    registry, dirs: [join(process.cwd(), 'deposits')], registerSeededOssGates: false,
    ...(opts?.stageOverrides ? { stageOverrides: opts.stageOverrides } : {}),
  })
  return { repo, wt, stateDir, store, appender, events, registry, id }
}

const callPre = (ctx: Context, id: string, wt: string, name: string, args: unknown) =>
  ctx.waterfall('tools/pre-execute' as never, {
    callId: `c-${Math.random()}`, name, arguments: args, signal: new AbortController().signal,
    agent: { id: `worker-${id}`, session: { id: `worker-${id}`, header: { cwd: wt } } },
  } as never, (async () => 'allow') as never)

const emitDiff = (ctx: Context, id: string, wt: string, paths: string[]) => {
  ctx.emit('tools/result', { name: 'edit', agent: { id: `worker-${id}`, session: { id: `worker-${id}`, header: { cwd: wt } } } } as never,
    { isError: false, content: [], meta: { diffs: paths.map(path => ({ path })) } })
}

afterEach(() => {
  for (const s of stores.splice(0)) try { s.close() } catch { /* ignore */ }
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('P10 Stage-2 host-initiated independent adversarial review', () => {
  it('evaluates plan-review & diff-review pure gates with three-state honesty, file grounding, anti-loop cap, and boss waiver', () => {
    expect(evaluatePlanReview({ workflowRiskTier: 'fast' }).kind).toBe('allow')
    expect(evaluatePlanReview({ workflowRiskTier: 'elevated', review: { status: 'ok', verdict: 'revise', criticalRisks: [], counterexamples: [], mustVerify: [] } }))
      .toMatchObject({ kind: 'unmeasured', cause: 'parse-failed' })
    expect(evaluatePlanReview({ workflowRiskTier: 'elevated', review: { status: 'timeout', detail: '20s' } }))
      .toMatchObject({ kind: 'unmeasured', cause: 'timeout' })
    expect(evaluatePlanReview({ workflowRiskTier: 'elevated', review: { status: 'ok', verdict: 'revise', criticalRisks: ['bypass'], counterexamples: ['exp=0'], mustVerify: [] } }).kind)
      .toBe('deny')

    expect(evaluateDiffReview({ workflowRiskTier: 'fast', codeChangedPaths: ['src/slug.ts'] }).kind).toBe('allow')
    expect(evaluateDiffReview({
      workflowRiskTier: 'elevated', codeChangedPaths: ['src/auth/guard.ts'],
      review: { status: 'ok', verdict: 'request_changes', findings: [] },
    })).toMatchObject({ kind: 'unmeasured', cause: 'parse-failed' })
    expect(evaluateDiffReview({
      workflowRiskTier: 'elevated', codeChangedPaths: ['src/auth/guard.ts'], changedPaths: ['src/auth/guard.ts'],
      review: { status: 'ok', verdict: 'request_changes', findings: [{ severity: 'high', file: 'src/other.ts', issue: 'hallucination', evidence: 'none' }] },
    })).toMatchObject({ kind: 'allow', produced: { filteredUngroundedOrLow: true } })
    expect(evaluateDiffReview({
      workflowRiskTier: 'elevated', codeChangedPaths: ['src/auth/guard.ts'], rejectedRounds: 2,
      review: { status: 'ok', verdict: 'approve', findings: [] },
    })).toMatchObject({ kind: 'deny' })
    expect(evaluateDiffReview({ workflowRiskTier: 'elevated', codeChangedPaths: ['src/auth/guard.ts'], rejectedRounds: 2, waived: true }).kind)
      .toBe('allow')
  })

  it('invokes host plan review via LlmRuntime only on elevated tickets and records M0 without false-blocking fast tickets', async () => {
    const repo = makeDir('dsh-p10-plan-')
    mkdirSync(join(repo, 'src/auth'), { recursive: true })
    writeFileSync(join(repo, 'src/slug.ts'), 'export const s = 1\n')
    writeFileSync(join(repo, 'src/auth/guard.ts'), 'export function auth(x: number) { return x > 0 }\n')

    const ctx = new Context()
    const llm = new LlmRuntime(ctx)
    ctx.set('llm' as never, llm)
    const adapter = new MockReviewAdapter(() => JSON.stringify({
      verdict: 'revise', criticalRisks: ['Missing zero check in auth()'], counterexamples: ['auth(0) returns false unexpectedly'], mustVerify: ['test auth(0)'], summary: 'check boundary',
    }))
    llm.registerAdapter(['deepseek'], adapter)
    const settings = SettingsSchema.parse({ eval: { model: { provider: 'deepseek', model: 'deepseek-chat' } } })

    const obsReg = createJudgementRegistry()
    await discoverAndRegisterDeposits({ registry: obsReg, dirs: [join(process.cwd(), 'deposits')], registerSeededOssGates: false })
    const cache = new Map()
    const fastCap = await prepareLaunchCapsule({
      ticket: { id: 't-f', title: 'Update src/slug.ts', assignments: [], execution: { name: 't-f', directory: repo, assignment: 'edit slug' } },
      workspaceDir: repo, registry: obsReg, runPlanReview: req => runHostPlanReview(ctx, settings, req), planReviewCache: cache,
    })
    expect(fastCap?.workflowRisk?.tier).toBe('fast')
    expect(adapter.calls.length).toBe(0)

    const spine: Record<string, unknown>[] = []
    const elObs = await prepareLaunchCapsule({
      ticket: { id: 't-e', title: 'Update src/auth/guard.ts', assignments: [], execution: { name: 't-e', directory: repo, assignment: 'fix check' } },
      workspaceDir: repo, registry: obsReg, runPlanReview: req => runHostPlanReview(ctx, settings, req), planReviewCache: cache,
      recordSpine: d => spine.push(d.payload),
    })
    expect(adapter.calls.length).toBe(1)
    expect(adapter.calls[0]?.purpose).toBe('adversarial-review')
    expect(elObs?.blocked).toBeUndefined()
    expect(elObs?.capsule.text).toContain('宿主独立计划对抗审视 (revise)')
    expect(spine.some(p => p['point'] === 'ticket.plan-review')).toBe(true)

    const enfReg = createJudgementRegistry()
    await discoverAndRegisterDeposits({ registry: enfReg, dirs: [join(process.cwd(), 'deposits')], registerSeededOssGates: false, stageOverrides: { 'ticket.plan-review': 'enforce' } })
    const elEnf = await prepareLaunchCapsule({
      ticket: { id: 't-e', title: 'Update src/auth/guard.ts', assignments: [], execution: { name: 't-e', directory: repo, assignment: 'fix check' } },
      workspaceDir: repo, registry: enfReg, runPlanReview: req => runHostPlanReview(ctx, settings, req), planReviewCache: cache,
    })
    expect(adapter.calls.length).toBe(1) // served from cache!
    expect(elEnf?.blocked?.[0]).toContain('Missing zero check')

    const offline = await runHostPlanReview(new Context(), settings, {
      ticketId: 't-off', title: 'Offline', entryFiles: ['src/auth/guard.ts'], risk: { tier: 'elevated', reasons: ['high-risk-path:src/auth/guard.ts'], distinctModules: 1 },
    })
    expect(offline.status).toBe('unavailable')
  })

  it('enforces verify.diff-review after verify.rerun, redacts secrets, escalates at 2 rounds, and unlocks only on exact-revision Boss waiver', async () => {
    const env = await setupEnv({
      ticketId: 't-dr', verifyCommands: ['pnpm test'],
      stageOverrides: { 'verify.command-contract': 'enforce', 'verify.diff-review': 'enforce' },
    })
    const ctx = new Context()
    const llm = new LlmRuntime(ctx)
    ctx.set('llm' as never, llm)
    const adapter = new MockReviewAdapter(() => JSON.stringify({
      verdict: 'request_changes', summary: 'Found auth flaw',
      findings: [
        { severity: 'high', file: 'src/auth/guard.ts', line: 1, issue: 'allows negative token', evidence: 'check returns true without checking expiry' },
        { severity: 'medium', file: 'src/auth/guard.ts', issue: 'minor style', evidence: 'nit' },
      ],
    }))
    llm.registerAdapter(['deepseek'], adapter)

    const memDir = join(env.stateDir, 'memory'), memLock = new GitRepoLock()
    const memory = new MemoryWriter({ dir: memDir, lock: memLock, resolveRef: async () => true })
    const rulings = new RulingQueue({ store: env.store, appender: env.appender, memory, memoryDir: memDir, memoryRepoLock: memLock })
    let verifyExit = 1
    const escalated: { revision: string; rejectedRounds: number; escalationCycle: number }[] = []
    const guard = new PreExecuteCompletionGuard({
      context: ctx, store: env.store, registry: env.registry, appender: env.appender, memoryDir: memDir,
      runVerifyCommand: async () => ({ exitCode: verifyExit }),
      onReviewEscalated: info => {
        escalated.push({ revision: info.revision, rejectedRounds: info.rejectedRounds, escalationCycle: info.escalationCycle })
        void rulings.enqueue({ id: `esc:${info.ticketId}:${info.escalationCycle}:${info.revision}`, kind: 'system_escalation', escalationType: 'gate_escalation', ticketId: info.ticketId, toolName: 'verify.diff-review', callId: info.revision, question: info.reason })
      },
    })

    writeFileSync(join(env.wt, 'src/auth/guard.ts'), 'export const check = (x: number) => x > 1\nconst tok = "sk-proj-secret1234567890abcdef"\n')
    writeFileSync(join(env.wt, 'tests/auth.spec.ts'), 'export const ok = true\nexport const tested = 1\n')
    emitDiff(ctx, env.id, env.wt, ['src/auth/guard.ts', 'tests/auth.spec.ts'])

    const envTmp = makeDir('dsh-p10-sec-')
    writeFileSync(join(envTmp, '.env'), 'SECRET=plain_env_value\n')
    writeFileSync(join(envTmp, 'safe.ts'), 'export const token = "sk-proj-secret1234567890abcdef"\n')
    const bundle = await collectSanitizedDiffBundle({ workdir: envTmp, codeChangedPaths: ['.env', 'safe.ts'], untrackedPaths: ['.env', 'safe.ts'] })
    expect(bundle).not.toContain('plain_env_value')
    expect(bundle).not.toContain('sk-proj-secret1234567890abcdef')
    expect(bundle).toContain('safe.ts')

    // 1. Failing verify.rerun must NOT waste an LLM diff-review call
    expect(await callPre(ctx, env.id, env.wt, 'orchestrator_report', { state: 'ready', summary: 'wip', declared_paths: ['src/auth/guard.ts', 'tests/auth.spec.ts'] }))
      .toMatchObject({ kind: 'deny', reason: expect.stringContaining('[verify.rerun]') })
    expect(adapter.calls.length).toBe(0)

    // 2. Passing verify.rerun -> invokes LLM once, scrubs sk-proj-..., excludes .env, blocks cleanly
    verifyExit = 0
    expect(await callPre(ctx, env.id, env.wt, 'orchestrator_report', { state: 'ready', summary: 'done 1', declared_paths: ['src/auth/guard.ts', 'tests/auth.spec.ts'] }))
      .toMatchObject({ kind: 'deny', reason: expect.stringContaining('[verify.diff-review]') })
    expect(adapter.calls.length).toBe(1)
    const prompt1 = JSON.stringify(adapter.calls[0]?.messages ?? [])
    expect(prompt1).not.toContain('sk-proj-secret1234567890abcdef')
    expect(prompt1).not.toContain('plain_env_value')
    expect(escalated.length).toBe(0)

    // 3. Re-submitting same revision hits cache -> still 1 LLM call
    expect(await callPre(ctx, env.id, env.wt, 'orchestrator_report', { state: 'ready', summary: 'retry same', declared_paths: ['src/auth/guard.ts', 'tests/auth.spec.ts'] }))
      .toMatchObject({ kind: 'deny', reason: expect.stringContaining('[verify.diff-review]') })
    expect(adapter.calls.length).toBe(1)

    // 4. Editing code creates rev2 -> LLM call #2 rejects -> hits max_review_rounds=2 -> escalates ONCE
    writeFileSync(join(env.wt, 'src/auth/guard.ts'), 'export const check = (x: number) => x > 2\n')
    expect(await callPre(ctx, env.id, env.wt, 'orchestrator_report', { state: 'ready', summary: 'done 2', declared_paths: ['src/auth/guard.ts', 'tests/auth.spec.ts'] }))
      .toMatchObject({ kind: 'deny', reason: expect.stringContaining('[verify.diff-review]') })
    expect(adapter.calls.length).toBe(2)
    expect(escalated.length).toBe(1)

    // 5. Attempt 3 even with edit does NOT burn another LLM call & STILL denies (anti-gaming!)
    writeFileSync(join(env.wt, 'src/auth/guard.ts'), 'export const check = (x: number) => x > 3\n')
    expect(await callPre(ctx, env.id, env.wt, 'orchestrator_report', { state: 'ready', summary: 'done 3', declared_paths: ['src/auth/guard.ts', 'tests/auth.spec.ts'] }))
      .toMatchObject({ kind: 'deny', reason: expect.stringContaining('已连续 2 轮发现阻断问题') })
    expect(adapter.calls.length).toBe(2)

    // 6. Boss waives exact escalated rev2; restore rev2 -> ALLOW; modify to rev3 -> DENY (exact-revision binding)
    await new Promise(r => setTimeout(r, 15))
    const q = rulings.list('pending')[0]!
    await rulings.decide({ id: q.id, decision: 'approve', optionId: 'approve', actorId: 'boss', note: 'verified ok' })
    env.store.set(KV.governance.reviewWaivers, { [env.id]: escalated[0]!.revision })

    writeFileSync(join(env.wt, 'src/auth/guard.ts'), 'export const check = (x: number) => x > 2\n')
    expect(await callPre(ctx, env.id, env.wt, 'orchestrator_report', { state: 'ready', summary: 'waived rev2', declared_paths: ['src/auth/guard.ts', 'tests/auth.spec.ts'] }))
      .toBe('allow')

    writeFileSync(join(env.wt, 'src/auth/guard.ts'), 'export const check = (x: number) => x > 9\n')
    expect(await callPre(ctx, env.id, env.wt, 'orchestrator_report', { state: 'ready', summary: 'post-waiver edit', declared_paths: ['src/auth/guard.ts', 'tests/auth.spec.ts'] }))
      .toMatchObject({ kind: 'deny', reason: expect.stringContaining('已连续 2 轮发现阻断问题') })

    // Boss rejects escalation -> host clears prior waiver, resets review rounds & increments escalationCycle so even recurring rev2 re-escalates with a fresh pending ruling!
    env.store.set(KV.governance.reviewWaivers, {})
    guard.resetDiffReviewRounds(env.id)
    writeFileSync(join(env.wt, 'src/auth/guard.ts'), 'export const check = (x: number) => x > 10\n')
    expect(await callPre(ctx, env.id, env.wt, 'orchestrator_report', { state: 'ready', summary: 'post-reset fix', declared_paths: ['src/auth/guard.ts', 'tests/auth.spec.ts'] }))
      .toMatchObject({ kind: 'deny', reason: expect.stringContaining('allows negative token') })
    expect(adapter.calls.length).toBe(3)
    writeFileSync(join(env.wt, 'src/auth/guard.ts'), 'export const check = (x: number) => x > 2\n')
    expect(await callPre(ctx, env.id, env.wt, 'orchestrator_report', { state: 'ready', summary: 'reverted to rev2', declared_paths: ['src/auth/guard.ts', 'tests/auth.spec.ts'] }))
      .toMatchObject({ kind: 'deny', reason: expect.stringContaining('allows negative token') })
    await new Promise(r => setTimeout(r, 15))
    expect(escalated.length).toBe(2)
    expect(escalated[1]!.escalationCycle).toBe(1)
    expect(rulings.list('pending').length).toBe(1)

    // 7b. Host diff review fails closed (parse-failed) when request_changes drops all malformed findings
    const malCtx = new Context(), malLlm = new LlmRuntime(malCtx)
    malLlm.registerAdapter(['deepseek'], new MockReviewAdapter(() => JSON.stringify({
      verdict: 'request_changes', summary: 'broken', findings: [{ severity: 'high', file: 'src/a.ts', issue: 'missing evidence' }],
    })))
    const malOutcome = await runHostDiffReview(malCtx, env.store.settings(), {
      ticketId: 't-mal', title: 'Malformed', revision: 'r1', diffBundle: '+code',
      codeChangedPaths: ['src/a.ts'], testChangedPaths: [], commandResults: [], risk: { tier: 'elevated', reasons: ['high-risk-path:src/a.ts'], distinctModules: 1 },
    })
    expect(malOutcome).toMatchObject({ status: 'parse-failed' })

    // 0. Fast ticket must NOT invoke diff-review LLM even under enforce
    const callsBeforeFast = adapter.calls.length
    const fastCtx = new Context(); new LlmRuntime(fastCtx).registerAdapter(['deepseek'], adapter)
    const fastEnv = await setupEnv({ ticketId: 't-dr-fast', verifyCommands: ['pnpm test'], stageOverrides: { 'verify.diff-review': 'enforce' } })
    fastEnv.store.tickets.save({ ...fastEnv.store.tickets.get(fastEnv.id)!, title: 'Update src/slug.ts', execution: { ...fastEnv.store.tickets.get(fastEnv.id)!.execution!, assignment: 'tweak slug' } } as unknown as Ticket)
    const fastGuard = new PreExecuteCompletionGuard({ context: fastCtx, store: fastEnv.store, registry: fastEnv.registry, appender: fastEnv.appender, memoryDir: join(fastEnv.stateDir, 'memory'), runVerifyCommand: async () => ({ exitCode: 0 }) })
    writeFileSync(join(fastEnv.wt, 'src/slug.ts'), 'export const slug = 2\n')
    emitDiff(fastCtx, fastEnv.id, fastEnv.wt, ['src/slug.ts'])
    expect(await callPre(fastCtx, fastEnv.id, fastEnv.wt, 'orchestrator_report', { state: 'ready', summary: 'fast ok', declared_paths: ['src/slug.ts'] })).toBe('allow')
    expect(adapter.calls.length).toBe(callsBeforeFast)
    fastGuard.dispose()

    // 7. Offline host returns unmeasured(no-evidence) with 0 throws
    const offEnv = await setupEnv({ ticketId: 't-dr-off', verifyCommands: ['pnpm test'], stageOverrides: { 'verify.diff-review': 'enforce' } })
    const offCtx = new Context()
    const offGuard = new PreExecuteCompletionGuard({ context: offCtx, store: offEnv.store, registry: offEnv.registry, appender: offEnv.appender, memoryDir: join(offEnv.stateDir, 'memory'), runVerifyCommand: async () => ({ exitCode: 0 }) })
    writeFileSync(join(offEnv.wt, 'src/auth/guard.ts'), 'export const check = (x: number) => x > 5\n')
    emitDiff(offCtx, offEnv.id, offEnv.wt, ['src/auth/guard.ts'])
    expect(await callPre(offCtx, offEnv.id, offEnv.wt, 'orchestrator_report', { state: 'ready', summary: 'offline', declared_paths: ['src/auth/guard.ts'] }))
      .toMatchObject({ kind: 'deny', reason: expect.stringContaining('no-evidence') })
    guard.dispose(); offGuard.dispose()
  })

  it('wakes blocked worker via retryTicket before note on Runtime verify.diff-review approve and reject rulings', async () => {
    const host = await startRuntime()
    try {
      const a = await host.acceptedTicket(feishu('9001', '@bot blocked waiver test'))
      await host.runTool(a.sessionId, 'orchestrator_report', { state: 'blocked', summary: '2 rounds failed', human_action: 'waive?' })
      expect(waitsForPerson(host.runtime.store.tickets.get(a.ticket.id)!)).toBe(true)
      const rApprove = await host.runtime.governance.rulings.enqueue({
        id: `diff-rev-esc:${a.ticket.id}:0:rev-b1`, kind: 'system_escalation', escalationType: 'gate_escalation',
        ticketId: a.ticket.id, toolName: 'verify.diff-review', callId: 'rev-b1', question: 'waive rev-b1?',
      })
      await host.runtime.governance.rulings.decide({ id: rApprove.id, decision: 'approve', optionId: 'approve', actorId: 'boss', note: 'lgtm' })
      await host.runtime.idle()
      const tApprove = host.runtime.store.tickets.get(a.ticket.id)!
      expect(waitsForPerson(tApprove)).toBe(false)
      expect(tApprove.assignments.length).toBe(2)
      expect(host.runtime.store.get(KV.governance.reviewWaivers)?.[a.ticket.id]).toBe('rev-b1')
      const approveNote = tApprove.inputs.find(i => i.kind === 'note' && i.text.includes('老板已豁免本次独立对抗复核'))
      expect(approveNote).toBeDefined()
      expect(tApprove.assignments[1]?.state).toBe('running')
      expect(tApprove.undelivered).toEqual([])
      expect(host.deliveries.mock.calls.some(([d]) => d.sessionId === a.sessionId && d.text.includes('老板已豁免本次独立对抗复核'))).toBe(true)

      const b = await host.acceptedTicket(feishu('9002', '@bot blocked reject test'))
      await host.runTool(b.sessionId, 'orchestrator_report', { state: 'blocked', summary: '2 rounds failed', human_action: 'fix or waive?' })
      expect(waitsForPerson(host.runtime.store.tickets.get(b.ticket.id)!)).toBe(true)
      const rReject = await host.runtime.governance.rulings.enqueue({
        id: `diff-rev-esc:${b.ticket.id}:0:rev-b2`, kind: 'system_escalation', escalationType: 'gate_escalation',
        ticketId: b.ticket.id, toolName: 'verify.diff-review', callId: 'rev-b2', question: 'reject rev-b2?',
      })
      await host.runtime.governance.rulings.decide({ id: rReject.id, decision: 'reject', optionId: 'reject', actorId: 'boss', note: 'fix expiry bug' })
      await host.runtime.idle()
      const tReject = host.runtime.store.tickets.get(b.ticket.id)!
      expect(waitsForPerson(tReject)).toBe(false)
      expect(tReject.assignments.length).toBe(2)
      const rejectNote = tReject.inputs.find(i => i.kind === 'note' && i.text.includes('已重置复核计数'))
      expect(rejectNote).toBeDefined()
      expect(tReject.assignments[1]?.state).toBe('running')
      expect(tReject.undelivered).toEqual([])
      expect(host.deliveries.mock.calls.some(([d]) => d.sessionId === b.sessionId && d.text.includes('已重置复核计数'))).toBe(true)
    } finally {
      await host.stop()
    }
  })
})
