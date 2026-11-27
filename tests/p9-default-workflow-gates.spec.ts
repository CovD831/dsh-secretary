import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'
import { prepareLaunchCapsule } from '../src/executor/capsule-hook.ts'
import { collectCompletionCodeMetrics } from '../src/executor/completion-metrics.ts'
import { PreExecuteCompletionGuard } from '../src/executor/pre-execute-gates.ts'
import { classifyWorkflowRisk, extractModuleKey } from '../src/executor/workflow-risk.ts'
import { evaluateChangeTestCoverage } from '../src/judgement/gates/change-test-coverage.ts'
import { evaluateCommandContract } from '../src/judgement/gates/command-contract.ts'
import { createJudgementRegistry, discoverAndRegisterDeposits, matchDepositPlaybooks } from '../src/judgement/index.ts'
import { createSpineAppender, ensureSpineSchema, type SpineEnvelope } from '../src/spine/index.ts'
import { provisionWorktree } from '../src/workspaces/worktree.ts'

const tempDirs: string[] = []
const stores: Store[] = []

function makeDir(prefix = 'dsh-p9-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}
function makeStore(): Store {
  const s = new Store(join(makeDir('dsh-p9-db-'), 'orch.db'))
  stores.push(s)
  return s
}
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' })
}

async function setupEnv(opts?: {
  ticketId?: string; title?: string; assignment?: string; verifyCommands?: string[]
  taskType?: 'feature' | 'bugfix' | 'docs'; stageOverrides?: Record<string, 'shadow' | 'observe' | 'enforce' | 'retired'>
}) {
  const repo = makeDir('dsh-p9-repo-'), stateDir = makeDir('dsh-p9-state-')
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Tester']); git(repo, ['config', 'user.email', 'tester@example.com'])
  mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(join(repo, 'tests'), { recursive: true })
  writeFileSync(join(repo, 'src/calc.ts'), 'export function calc(n: number): number {\n  return n + 1\n}\n')
  writeFileSync(join(repo, 'tests/calc.test.ts'), 'export const t = 1\n')
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'init'])

  const store = makeStore(); ensureSpineSchema(store.db, 0)
  const events: SpineEnvelope[] = []; let seq = 0
  const rawAppender = createSpineAppender(store, { kick: () => {} })
  const appender = {
    append: (draft: Parameters<typeof rawAppender.append>[0]) => {
      const ref = rawAppender.append(draft)
      events.push({ v: 1, seq: ++seq, at: draft.at ?? new Date().toISOString(), ...draft } as SpineEnvelope)
      return ref
    },
  }
  const ws = { id: 'ws-p9', repository: repo, baseBranch: 'main', branchPrefix: 'ticket/', isolation: 'I2' as const }
  store.saveSettings({ ...store.settings(), workspaces: [ws] })
  const id = opts?.ticketId ?? 't-p9', wt = join(stateDir, 'work', id)
  await provisionWorktree({ ticketId: id, workspace: ws, executionName: id, targetDir: wt, appender })
  store.tickets.save({
    id, title: opts?.title ?? 'Implement calc helper', state: 'working',
    origin: { triggerId: id, triggerIds: [id], thread: 'desk:1' }, channels: [],
    mandate: { strength: 'explicit', basis: {}, actor: { source: 'secretary-bus', id: 'boss' } },
    execution: {
      directory: wt, name: `worker-${id}`, assignment: opts?.assignment ?? 'add helper',
      workspace: 'ws-p9', verifyCommands: opts?.verifyCommands ?? ['pnpm test'],
      ...(opts?.taskType ? { taskType: opts.taskType } : {}),
    },
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

describe('P9 Stage-1 default workflow & deterministic acceptance gates', () => {
  it('classifies fast vs elevated workflow risk cleanly including src/<mod> multi-module detection', () => {
    expect(extractModuleKey('src/executor/a.ts')).toBe('src/executor')
    expect(extractModuleKey('src/judgement/b.ts')).toBe('src/judgement')

    expect(classifyWorkflowRisk({ paths: ['src/slug.mjs'], title: 'Fix typo', retryCount: 0, diffLineCount: 20 }))
      .toMatchObject({ tier: 'fast', reasons: [], distinctModules: 1 })

    const crossMod = classifyWorkflowRisk({ paths: ['src/executor/a.ts', 'src/judgement/b.ts'] })
    expect(crossMod.tier).toBe('elevated')
    expect(crossMod.distinctModules).toBe(2)
    expect(crossMod.reasons).toContain('multi-module:2')

    expect(classifyWorkflowRisk({ paths: ['src/auth/login.ts'] }).reasons).toContain('high-risk-path:src/auth/login.ts')
    expect(classifyWorkflowRisk({ paths: ['src/a.ts'], retryCount: 1 })).toMatchObject({ tier: 'fast', reasons: [] })
    expect(classifyWorkflowRisk({ paths: ['src/a.ts'], retryCount: 2 }).reasons).toContain('retry-escalation:2')
    expect(classifyWorkflowRisk({ paths: ['src/a.ts'], diffLineCount: 180 }).reasons).toContain('large-diff:180')
    expect(classifyWorkflowRisk({ paths: ['1', '2', '3', '4', '5', '6', '7'] }).reasons).toContain('scope-files:7')
    expect(classifyWorkflowRisk({ title: '跨模块契约 schema migration' }).reasons).toContain('high-risk-intent')
    expect(classifyWorkflowRisk({ title: 'fix typo without breaking contract' }).tier).toBe('fast')
    expect(classifyWorkflowRisk({ title: 'without breaking contract; architecture refactor' }).reasons).toContain('high-risk-intent')
  })

  it('scopes elevated playbook & launch notice without adding overhead to trivial fast lane', async () => {
    const pb = { id: 'verify.command-contract', stage: 'observe' as const, playbook: { summary: '高危提示', when: { riskTiers: ['elevated'] as const }, steps: ['列反例'] } }
    expect(matchDepositPlaybooks({ deposits: [pb], riskTier: 'fast' })).toHaveLength(0)
    expect(matchDepositPlaybooks({ deposits: [pb], riskTier: 'elevated' }).map(m => m.matchedBy)).toEqual([['riskTier']])

    const repo = makeDir('dsh-p9-cap-')
    mkdirSync(join(repo, 'src/auth'), { recursive: true })
    writeFileSync(join(repo, 'src/auth/guard.ts'), 'export function verifyAuth() { return true }\n')
    const registry = createJudgementRegistry()
    await discoverAndRegisterDeposits({ registry, dirs: [join(process.cwd(), 'deposits')], registerSeededOssGates: false })

    // Trivial fast ticket with no paths/commands returns undefined
    const fastCap = await prepareLaunchCapsule({
      ticket: { id: 't-fast', title: '你好', assignments: [], execution: { name: 't-fast', directory: repo, assignment: 'hello' } },
      workspaceDir: repo, registry, playbooks: [pb],
    })
    expect(fastCap).toBeUndefined()

    // Elevated ticket injects elevated notice, matches elevated playbook, and records workflowRisk on M0
    const spineDrafts: Record<string, unknown>[] = []
    const elCap = await prepareLaunchCapsule({
      ticket: { id: 't-el', title: 'Update src/auth/guard.ts', assignments: [], execution: { name: 't-el', directory: repo, assignment: 'harden verifyAuth' } },
      workspaceDir: repo, registry, playbooks: [pb],
      recordSpine: d => spineDrafts.push(d.payload),
    })
    expect(elCap?.workflowRisk?.tier).toBe('elevated')
    expect(elCap?.capsule.text).toContain('高风险/跨模块核查提示')
    expect(elCap?.matchedPlaybooks).toEqual(['verify.command-contract'])
    expect((spineDrafts[0] as { workflowRisk?: { tier: string } }).workflowRisk?.tier).toBe('elevated')

    // Large single-module file escalated to team by ticket.adaptive-dispatch must also re-match elevated playbooks
    writeFileSync(join(repo, 'src/big.ts'), 'x'.repeat(20_000))
    const teamEscCap = await prepareLaunchCapsule({
      ticket: { id: 't-team-esc', title: 'Update src/big.ts', assignments: [], execution: { name: 't-team-esc', directory: repo, assignment: 'edit src/big.ts' } },
      workspaceDir: repo, registry, playbooks: [pb], allowTeam: true,
    })
    expect(teamEscCap?.dispatch?.executionMode).toBe('team')
    expect(teamEscCap?.workflowRisk?.tier).toBe('elevated')
    expect(teamEscCap?.matchedPlaybooks).toEqual(['verify.command-contract'])
  })

  it('enforces verify.command-contract segment checks before verify.rerun and ignores team_task_update', async () => {
    expect(evaluateCommandContract({ codeChangedPaths: ['src/a.ts'], verifyCommands: [] })).toMatchObject({ kind: 'unmeasured', cause: 'no-evidence' })
    expect(evaluateCommandContract({ codeChangedPaths: [], verifyCommands: [] }).kind).toBe('allow')
    expect(evaluateCommandContract({ codeChangedPaths: ['src/a.ts'], verifyCommands: ['true'] }).kind).toBe('deny')
    for (const bypass of [
      'pnpm test || true', 'pnpm test || echo ok', 'pnpm test; echo ok', 'pnpm test || true;',
      'pnpm test || true # keep', '(pnpm test || true)', 'pnpm test || true && echo done',
      'pnpm test | cat', 'pnpm test\ntrue', 'sh -c "pnpm test || true"',
    ]) {
      expect(evaluateCommandContract({ codeChangedPaths: ['src/a.ts'], verifyCommands: [bypass] }).kind, bypass).toBe('deny')
    }
    expect(evaluateCommandContract({ codeChangedPaths: ['src/a.ts'], verifyCommands: ['pnpm test && true'] }).kind).toBe('allow')
    expect(evaluateCommandContract({ codeChangedPaths: ['src/a.ts'], verifyCommands: ['echo "=== test ===" && pnpm test'] }).kind).toBe('allow')
    expect(evaluateCommandContract({ codeChangedPaths: ['src/a.ts'], verifyCommands: ['rm -f tmp.db || true && pnpm test'] }).kind).toBe('allow')

    // Integration: observe logs warning without blocking; enforce blocks BEFORE verify.rerun runs
    const envObs = await setupEnv({ ticketId: 't-cc-obs', verifyCommands: ['true'] })
    const cObs = new Context()
    const gObs = new PreExecuteCompletionGuard({ context: cObs, store: envObs.store, registry: envObs.registry, appender: envObs.appender, memoryDir: join(envObs.stateDir, 'memory'), runVerifyCommand: async () => ({ exitCode: 0 }) })
    writeFileSync(join(envObs.wt, 'src/calc.ts'), 'export function calc(n: number): number { return n + 2 }\n')
    emitDiff(cObs, envObs.id, envObs.wt, ['src/calc.ts'])
    expect(await callPre(cObs, envObs.id, envObs.wt, 'orchestrator_report', { state: 'ready', summary: 'done', declared_paths: ['src/calc.ts'] })).toBe('allow')
    const obsEv = envObs.events.find(e => (e.payload as { point?: string }).point === 'verify.command-contract')
    expect((obsEv?.payload as { disposition?: string; observed?: { outcome: string }[] }).disposition).toBe('warn')
    expect((obsEv?.payload as { observed?: { outcome: string }[] }).observed?.[0]?.outcome).toBe('deny')

    const envEnf = await setupEnv({
      ticketId: 't-cc-enf', verifyCommands: ['pnpm test || true'],
      stageOverrides: { 'verify.command-contract': 'enforce' },
    })
    let verifyCalls = 0
    const cEnf = new Context()
    const gEnf = new PreExecuteCompletionGuard({
      context: cEnf, store: envEnf.store, registry: envEnf.registry, appender: envEnf.appender,
      memoryDir: join(envEnf.stateDir, 'memory'), runVerifyCommand: async () => { verifyCalls += 1; return { exitCode: 0 } },
    })
    writeFileSync(join(envEnf.wt, 'src/calc.ts'), 'export function calc(n: number): number { return n + 3 }\n')
    emitDiff(cEnf, envEnf.id, envEnf.wt, ['src/calc.ts'])
    // Intermediate team_task_update must NOT trigger verify.command-contract (it may run verify.rerun)
    expect(await callPre(cEnf, envEnf.id, envEnf.wt, 'team_task_update', { action: 'complete' })).toBe('allow')
    verifyCalls = 0
    expect(await callPre(cEnf, envEnf.id, envEnf.wt, 'orchestrator_report', { state: 'ready', summary: 'done', declared_paths: ['src/calc.ts'] })).toMatchObject({
      kind: 'deny', reason: expect.stringContaining('[verify.command-contract]'),
    })
    expect(verifyCalls).toBe(0) // Blocked BEFORE verify.rerun executed!
    gObs.dispose(); gEnf.dispose()
  })

  it('enforces verify.change-test-coverage using fast git numstat + untracked line count and resists arg spoofing', async () => {
    expect(evaluateChangeTestCoverage({ taskType: 'feature', codeChangedPaths: ['src/a.ts'], testChangedPaths: [], changedCodeLines: 40 }).kind).toBe('deny')
    expect(evaluateChangeTestCoverage({ taskType: 'feature', codeChangedPaths: ['src/a.ts'], testChangedPaths: [], changedCodeLines: 12 }).kind).toBe('allow')
    expect(evaluateChangeTestCoverage({ taskType: 'feature', codeChangedPaths: ['src/a.ts'], testChangedPaths: ['tests/a.spec.ts'], changedCodeLines: 100 }).kind).toBe('allow')
    expect(evaluateChangeTestCoverage({ taskType: 'docs', codeChangedPaths: ['scripts/doc.mjs'], testChangedPaths: [], changedCodeLines: 100 }).kind).toBe('allow')

    const env = await setupEnv({
      ticketId: 't-cov', verifyCommands: ['pnpm test'],
      stageOverrides: { 'verify.change-test-coverage': 'enforce', 'verify.command-contract': 'enforce' },
    })
    const ctx = new Context()
    // Register custom verify.* point to verify host-computed fields cannot be overwritten by worker args!
    let receivedCustomCtx: Record<string, unknown> | undefined
    env.registry.register({
      kind: 'gate', id: 'custom.inspect-args', version: 1, point: 'verify.inspect' as never,
      description: 'capture completion ctx', placement: { timing: 'pre', enforce: true }, requires: [],
      gate: (c: Record<string, unknown>) => { receivedCustomCtx = c; return { kind: 'allow' } },
    } as never, 'enforce')
    const guard = new PreExecuteCompletionGuard({
      context: ctx, store: env.store, registry: env.registry, appender: env.appender,
      memoryDir: join(env.stateDir, 'memory'), runVerifyCommand: async () => ({ exitCode: 0 }),
    })

    // Write 35 non-empty lines to a new untracked product file with 0 test changes -> deny!
    const newCode = Array.from({ length: 35 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
    writeFileSync(join(env.wt, 'src/new-feature.ts'), newCode)
    emitDiff(ctx, env.id, env.wt, ['src/new-feature.ts'])
    const metrics = await collectCompletionCodeMetrics({ workdir: env.wt, changedPaths: ['src/new-feature.ts'], untrackedPaths: ['src/new-feature.ts'] })
    expect(metrics).toEqual({ codeChangedPaths: ['src/new-feature.ts'], testChangedPaths: [], changedCodeLines: 35 })

    expect(await callPre(ctx, env.id, env.wt, 'orchestrator_report', {
      state: 'ready', summary: 'untested feature', declared_paths: ['src/new-feature.ts'],
      codeChangedPaths: [], testChangedPaths: ['tests/spoofed.spec.ts'], changedCodeLines: 0,
    })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('[verify.change-test-coverage]') })

    // Add real test file -> passes AND custom point receives real host-computed arrays (not spoofed worker args!)
    writeFileSync(join(env.wt, 'tests/new-feature.spec.ts'), 'export const pass = true\n')
    emitDiff(ctx, env.id, env.wt, ['tests/new-feature.spec.ts'])
    expect(await callPre(ctx, env.id, env.wt, 'orchestrator_report', {
      state: 'ready', summary: 'tested feature', declared_paths: ['src/new-feature.ts', 'tests/new-feature.spec.ts'],
      codeChangedPaths: [], workflowRisk: { tier: 'fast', reasons: [], distinctModules: 0 },
    })).toBe('allow')
    expect(receivedCustomCtx?.['codeChangedPaths']).toEqual(['src/new-feature.ts'])
    expect(receivedCustomCtx?.['testChangedPaths']).toEqual(['tests/new-feature.spec.ts'])
    // Metric honesty: untrackedPaths=null on untracked file yields null (unmeasured), NUL binary ignores byte inflation, --relative matches subdir
    const blindMetrics = await collectCompletionCodeMetrics({ workdir: env.wt, changedPaths: ['src/new-feature.ts'], untrackedPaths: null })
    expect(blindMetrics.changedCodeLines).toBeNull()
    expect(evaluateChangeTestCoverage({ taskType: 'feature', ...blindMetrics })).toMatchObject({ kind: 'unmeasured', cause: 'no-evidence' })
    writeFileSync(join(env.wt, 'src/blob.dat'), Buffer.from([0, 10, 10, 10, 10]))
    const binMetrics = await collectCompletionCodeMetrics({ workdir: env.wt, changedPaths: ['src/blob.dat'], untrackedPaths: ['src/blob.dat'] })
    expect(binMetrics.changedCodeLines).toBe(0)
    writeFileSync(join(env.wt, 'src/calc.ts'), 'export function calc(n: number): number {\n  return n + 99\n}\n')
    const subMetrics = await collectCompletionCodeMetrics({ workdir: join(env.wt, 'src'), changedPaths: ['calc.ts'], untrackedPaths: [] })
    expect(subMetrics.changedCodeLines).toBe(2)
    guard.dispose()
  })
})
