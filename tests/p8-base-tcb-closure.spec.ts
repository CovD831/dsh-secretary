import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'
import { findRevertedSessionPaths } from '../src/executor/git-workspace-snapshot.ts'
import { PreExecuteCompletionGuard } from '../src/executor/pre-execute-gates.ts'
import { inferTicketTaskType, isTestOverlayPath } from '../src/executor/red-green-probe.ts'
import { RuntimeGuard } from '../src/executor/runtime-guard.ts'
import { buildSessionSandboxRunner } from '../src/executor/sandbox-runner.ts'
import { createVerifyRerunGate, evaluateVerifyRerun, executeVerifyRerunCommands } from '../src/judgement/gates/verify-rerun.ts'
import { createJudgementRegistry, discoverAndRegisterDeposits } from '../src/judgement/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { createSpineAppender, ensureSpineSchema, type SpineEnvelope } from '../src/spine/index.ts'
import { provisionWorktree } from '../src/workspaces/worktree.ts'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []
const stores: Store[] = []

function makeDir(prefix = 'dsh-p8-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}

function makeStore(): Store {
  const s = new Store(join(makeDir('dsh-p8-db-'), 'orch.db'))
  stores.push(s)
  return s
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' })
}

async function setupProvisionedRepo(opts?: {
  ticketId?: string; title?: string; assignment?: string; verifyCommands?: string[]
  taskType?: 'feature' | 'bugfix' | 'refactor' | 'docs'; cowPaths?: string[]
}) {
  const repo = makeDir('dsh-p8-repo-'), stateDir = makeDir('dsh-p8-state-')
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Tester'])
  git(repo, ['config', 'user.email', 'tester@example.com'])
  writeFileSync(join(repo, '.gitignore'), '.env*\nnode_modules/\ndist/\n')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'tests'), { recursive: true })
  writeFileSync(join(repo, 'src/calc.mjs'), 'export function add(a, b) { return a - b }\n')
  writeFileSync(join(repo, 'tests/smoke.test.mjs'), "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\ntest('smoke', () => assert.equal(1, 1))\n")
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'init'])

  const store = makeStore()
  ensureSpineSchema(store.db, 0)
  const events: SpineEnvelope[] = []
  let seq = 0
  const rawAppender = createSpineAppender(store, { kick: () => {} })
  const appender = {
    append: (draft: Parameters<typeof rawAppender.append>[0]) => {
      const ref = rawAppender.append(draft)
      events.push({ v: 1, seq: ++seq, at: draft.at ?? new Date().toISOString(), ...draft } as SpineEnvelope)
      return ref
    },
  }
  const ws = { id: 'ws-p8', repository: repo, baseBranch: 'main', branchPrefix: 'ticket/', isolation: 'I2' as const, ...(opts?.cowPaths ? { cowPaths: opts.cowPaths } : {}) }
  store.saveSettings({ ...store.settings(), workspaces: [ws] })
  const id = opts?.ticketId ?? 't-p8'
  const wt = join(stateDir, 'work', id)
  await provisionWorktree({ ticketId: id, workspace: ws, executionName: id, targetDir: wt, appender })
  store.tickets.save({
    id, title: opts?.title ?? 'Implement feature', state: 'working',
    origin: { triggerId: id, triggerIds: [id], thread: 'desk:1' }, channels: [],
    mandate: { strength: 'explicit', basis: {}, actor: { source: 'secretary-bus', id: 'boss' } },
    execution: {
      directory: wt, name: `worker-${id}`, assignment: opts?.assignment ?? 'complete task',
      workspace: 'ws-p8', verifyCommands: opts?.verifyCommands ?? ['node --test'],
      ...(opts?.taskType ? { taskType: opts.taskType } : {}),
    },
    assignments: [],
  } as unknown as Ticket)
  const registry = createJudgementRegistry()
  await discoverAndRegisterDeposits({ registry, dirs: [join(process.cwd(), 'deposits')], registerSeededOssGates: false })
  return { repo, wt, stateDir, store, appender, events, registry, id }
}

const makePre = (id: string, wt: string, args: unknown) => ({
  callId: `c-${Math.random()}`, name: 'orchestrator_report', arguments: args, signal: new AbortController().signal,
  agent: { id: `worker-${id}`, session: { id: `worker-${id}`, header: { cwd: wt } } },
})
const emitTool = (ctx: Context, id: string, wt: string, name: string, diffs?: string[]) => {
  ctx.emit('tools/result', { name, agent: { id: `worker-${id}`, session: { id: `worker-${id}`, header: { cwd: wt } } } } as never,
    diffs ? { isError: false, content: [], meta: { diffs: diffs.map(path => ({ path })) } } : { isError: false, content: [] })
}
const callPre = (ctx: Context, id: string, wt: string, args: unknown) =>
  ctx.waterfall('tools/pre-execute' as never, makePre(id, wt, args) as never, (async () => 'allow') as never)

afterEach(() => {
  for (const s of stores.splice(0)) try { s.close() } catch { /* ignore */ }
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('P8 L1 base TCB closure', () => {
  it('Fix #2a: recovers cleanly when worker writes .env.staging then removes it via bash rm or non-shell delete', async () => {
    const { wt, store, appender, events, registry, id, stateDir } = await setupProvisionedRepo()
    const ctx = new Context()
    const guard = new PreExecuteCompletionGuard({
      context: ctx, store, registry, appender, memoryDir: join(stateDir, 'memory'),
      runVerifyCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    })

    writeFileSync(join(wt, '.env.staging'), 'SECRET=leak\n')
    emitTool(ctx, id, wt, 'write', ['.env.staging'])
    expect(await callPre(ctx, id, wt, { state: 'ready', summary: 'oops', declared_paths: ['.env.staging'] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('verify.secret-path-guard') })

    rmSync(join(wt, '.env.staging'))
    emitTool(ctx, id, wt, 'bash')
    expect(await callPre(ctx, id, wt, { state: 'ready', summary: 'cleaned', declared_paths: [] })).toBe('allow')

    const pathEv = events.filter(e => e.type === 'gate.evaluated' && (e.payload as { point?: string }).point === 'verify.changed-paths').at(-1)
    const secEv = events.filter(e => e.type === 'gate.evaluated' && (e.payload as { point?: string }).point === 'verify.secret-path-guard').at(-1)
    expect((pathEv?.payload as { revertedPaths?: string[] }).revertedPaths).toEqual(['.env.staging'])
    expect((secEv?.payload as { revertedPaths?: string[] }).revertedPaths).toEqual(['.env.staging'])

    // Non-shell deletion & in-place tracked revert without shell also recover cleanly
    const ctx2 = new Context()
    const guard2 = new PreExecuteCompletionGuard({
      context: ctx2, store, registry, appender, memoryDir: join(stateDir, 'memory'),
      runVerifyCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    })
    writeFileSync(join(wt, '.env.staging'), 'SECRET=2\n')
    emitTool(ctx2, id, wt, 'write', ['.env.staging'])
    const orig = readFileSync(join(wt, 'src/calc.mjs'), 'utf8')
    writeFileSync(join(wt, 'src/calc.mjs'), 'export const tmp = 1\n')
    emitTool(ctx2, id, wt, 'edit', ['src/calc.mjs'])
    rmSync(join(wt, '.env.staging'))
    emitTool(ctx2, id, wt, 'fs_delete')
    writeFileSync(join(wt, 'src/calc.mjs'), orig)
    emitTool(ctx2, id, wt, 'edit', ['src/calc.mjs'])
    expect(await callPre(ctx2, id, wt, { state: 'ready', summary: 'clean', declared_paths: [] })).toBe('allow')

    guard2.dispose()
    guard.dispose()
  })

  it('Fix #2b: blocks --skip-worktree, commit-then-delete, out-of-worktree traversal, dist/.env, .ENV.local, and full-trust .env bypass', async () => {
    const { wt, store, appender, registry, id, stateDir } = await setupProvisionedRepo({ cowPaths: ['node_modules'] })
    const ctx = new Context()
    const guard = new PreExecuteCompletionGuard({
      context: ctx, store, registry, appender, memoryDir: join(stateDir, 'memory'),
      runVerifyCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    })

    // 1. skip-worktree index tamper after edit + bash tamper MUST fail
    writeFileSync(join(wt, 'src/calc.mjs'), 'export function add(a, b) { return a + b }\n')
    emitTool(ctx, id, wt, 'edit', ['src/calc.mjs'])
    writeFileSync(join(wt, 'src/calc.mjs'), 'export function add() { return 999 }\n')
    emitTool(ctx, id, wt, 'bash')
    git(wt, ['update-index', '--skip-worktree', 'src/calc.mjs'])
    expect(await callPre(ctx, id, wt, { state: 'ready', summary: 'sneak', declared_paths: [] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('shell-blind') })
    git(wt, ['update-index', '--no-skip-worktree', 'src/calc.mjs'])
    git(wt, ['checkout', '--', 'src/calc.mjs'])

    // 2. commit .env.staging then delete in commit 2 MUST stay blocked (history polluted)
    writeFileSync(join(wt, '.env.staging'), 'SECRET=committed\n')
    emitTool(ctx, id, wt, 'write', ['.env.staging'])
    git(wt, ['config', 'user.name', 'W']); git(wt, ['config', 'user.email', 'w@example.com'])
    git(wt, ['add', '-f', '.env.staging']); git(wt, ['commit', '-m', 'leak'])
    git(wt, ['rm', '-f', '.env.staging']); git(wt, ['commit', '-m', 'cleanup'])
    expect(await callPre(ctx, id, wt, { state: 'ready', summary: 'cleaned commit', declared_paths: [] })).toMatchObject({ kind: 'deny' })

    // 2b. bash-only commit .env.staging then delete in commit 2 (ZERO structured write!) MUST stay blocked
    const bashCommit = await setupProvisionedRepo({ ticketId: 't-p8-bashhist', cowPaths: ['node_modules'] })
    const cBh = new Context()
    const gBh = new PreExecuteCompletionGuard({
      context: cBh, store: bashCommit.store, registry: bashCommit.registry, appender: bashCommit.appender,
      memoryDir: join(bashCommit.stateDir, 'memory'), runVerifyCommand: async () => ({ exitCode: 0 }),
    })
    writeFileSync(join(bashCommit.wt, '.env.staging'), 'SECRET=bash_only\n')
    git(bashCommit.wt, ['config', 'user.name', 'W']); git(bashCommit.wt, ['config', 'user.email', 'w@example.com'])
    git(bashCommit.wt, ['add', '-f', '.env.staging']); git(bashCommit.wt, ['commit', '-m', 'leak'])
    git(bashCommit.wt, ['rm', '-f', '.env.staging']); git(bashCommit.wt, ['commit', '-m', 'wipe'])
    emitTool(cBh, bashCommit.id, bashCommit.wt, 'bash')
    expect(await callPre(cBh, bashCommit.id, bashCommit.wt, { state: 'ready', summary: 'bash wipe', declared_paths: [] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('shell-blind') })
    gBh.dispose()

    // 3. out-of-worktree paths must NEVER be accepted as reverted
    const outsideEnv = join(makeDir('dsh-p8-out-'), 'outside.env')
    const revOut = await findRevertedSessionPaths({
      workdir: wt, sessionDiffs: new Set([outsideEnv, '../outside.env']), dirty: new Set(), untracked: new Set(),
    })
    expect(revOut.size).toBe(0)

    // 4. cowPaths third-party *.pem does NOT cause deadlock, while dist/.env, node_modules/.env.local, .ENV.local, and .envrc MUST block
    const setup2 = await setupProvisionedRepo({ ticketId: 't-p8-sec', cowPaths: ['node_modules'] })
    const ctx2 = new Context()
    const g2 = new PreExecuteCompletionGuard({
      context: ctx2, store: setup2.store, registry: setup2.registry, appender: setup2.appender,
      memoryDir: join(setup2.stateDir, 'memory'), runVerifyCommand: async () => ({ exitCode: 0 }),
    })
    mkdirSync(join(setup2.wt, 'node_modules/ssl-root-cas'), { recursive: true })
    writeFileSync(join(setup2.wt, 'node_modules/ssl-root-cas/ca.pem'), '-----BEGIN CERTIFICATE-----\n')
    emitTool(ctx2, setup2.id, setup2.wt, 'bash')
    expect(await callPre(ctx2, setup2.id, setup2.wt, { state: 'ready', summary: 'third party pem in cow', declared_paths: [] })).toBe('allow')

    mkdirSync(join(setup2.wt, 'dist'), { recursive: true })
    writeFileSync(join(setup2.wt, 'dist/.env'), 'SECRET=1\n')
    expect(await callPre(ctx2, setup2.id, setup2.wt, { state: 'ready', summary: 'dist', declared_paths: [] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('shell-blind') })
    rmSync(join(setup2.wt, 'dist/.env'))

    writeFileSync(join(setup2.wt, 'node_modules/.env.local'), 'SECRET=nm\n')
    expect(await callPre(ctx2, setup2.id, setup2.wt, { state: 'ready', summary: 'nm env', declared_paths: [] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('shell-blind') })
    rmSync(join(setup2.wt, 'node_modules/.env.local'))

    expect((await setup2.registry.evaluate('verify.secret-path-guard', { changedPaths: ['.ENV.local'] })).verdict.kind).toBe('deny')
    expect((await setup2.registry.evaluate('verify.secret-path-guard', { changedPaths: ['.envrc'] })).verdict.kind).toBe('deny')

    // 5. RuntimeGuard catches *id_rsa*, .dsh/config, .envrc under smart-auto AND blocks .env/.dsh (including shell > / ;) even under full-trust
    setup2.store.saveSettings(SettingsSchema.parse({ executor: { approvalMode: 'full-trust' } }))
    const rgCtx = new Context()
    rgCtx.reflect.provide('agents', { get: () => undefined })
    const rg = new RuntimeGuard({
      context: rgCtx, store: setup2.store, engine: { report: () => {} } as never,
      appender: setup2.appender, rulings: { requestDshApproval: async () => 'rejected', enqueue: async () => {} } as never, relayToMaster: () => {},
    })
    rg.install()
    const fire = (name: string, args: unknown) => rgCtx.waterfall('tools/pre-execute' as never, {
      callId: `rg-${Math.random()}`, rootCallId: 'r', name, arguments: args, signal: new AbortController().signal,
      token: Symbol(), agent: { id: `worker-${setup2.id}`, session: { id: `worker-${setup2.id}`, header: {} } },
    } as never, (async () => ({ kind: 'allow' })) as never)

    expect(await fire('write', { file_path: join(setup2.wt, '.env.staging') })).toMatchObject({ kind: 'ask' })
    expect(await fire('write', { file_path: join(setup2.wt, '.envrc') })).toMatchObject({ kind: 'ask' })
    expect(await fire('bash', { command: 'echo X=1>.env' })).toMatchObject({ kind: 'ask' })
    expect(await fire('bash', { command: 'cd .dsh&&ls' })).toMatchObject({ kind: 'ask' })
    expect(await fire('bash', { command: 'echo x >> ~/.dsh/config.json' })).toMatchObject({ kind: 'ask' })
    expect(await fire('write', { file_path: join(setup2.wt, 'src/ok.ts') })).toEqual({ kind: 'allow' })
    setup2.store.saveSettings(SettingsSchema.parse({ executor: { approvalMode: 'smart-auto' } }))
    expect(await fire('write', { file_path: join(setup2.wt, 'keys/id_rsa_prod') })).toMatchObject({ kind: 'ask' })
    expect(await fire('write', { file_path: join(setup2.wt, '.dsh/secret.json') })).toMatchObject({ kind: 'ask' })
    expect(await fire('write', { file_path: join(setup2.wt, '.envrc') })).toMatchObject({ kind: 'ask' })

    rg.dispose(); g2.dispose(); guard.dispose()
  })

  it('Fix #1a: runs real I2 baseline red-green probe on bugfix tickets, overlays new tests, rewrites symlinks, and caches allow', async () => {
    const { wt, store, appender, events, registry, id, stateDir } = await setupProvisionedRepo({
      ticketId: 't-rg-1', title: 'Fix add subtraction bug', assignment: 'Fix add() in src/calc.mjs', cowPaths: ['node_modules'],
    })
    // Workspace-like symlink inside node_modules pointing back into wt must be rewritten to tempDir copy!
    mkdirSync(join(wt, 'node_modules/@local'), { recursive: true })
    symlinkSync(join(wt, 'src/calc.mjs'), join(wt, 'node_modules/@local/calc.mjs'))

    let runCount = 0
    const ctx = new Context()
    const guard = new PreExecuteCompletionGuard({
      context: ctx, store, registry, appender, memoryDir: join(stateDir, 'memory'),
      runVerifyCommand: async (_cmd, cwd) => {
        runCount += 1
        try {
          const out = await execFileAsync(process.execPath, ['--test'], { cwd, timeout: 10_000 })
          return { exitCode: 0, stdout: out.stdout, stderr: out.stderr }
        } catch (err) {
          const e = err as { code?: number; stdout?: string; stderr?: string }
          return { exitCode: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
        }
      },
    })

    // Worker fixes src/calc.mjs and adds regression test importing through node_modules/@local workspace symlink!
    writeFileSync(join(wt, 'src/calc.mjs'), 'export function add(a, b) { return a + b }\n')
    writeFileSync(join(wt, 'tests/calc.test.mjs'), "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { add } from '../node_modules/@local/calc.mjs'\ntest('add bugfix', () => assert.equal(add(2, 3), 5))\n")
    emitTool(ctx, id, wt, 'edit', ['src/calc.mjs'])
    emitTool(ctx, id, wt, 'write', ['tests/calc.test.mjs'])

    // Untested fake fix check first (before tests/calc.test.mjs? Here tests/calc.test.mjs exists so baseline FAILS -> GREEN!)
    expect(await callPre(ctx, id, wt, { state: 'ready', summary: 'fixed add', declared_paths: ['src/calc.mjs', 'tests/calc.test.mjs'] })).toBe('allow')
    expect(runCount).toBe(2) // 1 forward + 1 baseline probe
    const ev1 = events.filter(e => e.type === 'gate.evaluated' && (e.payload as { point?: string }).point === 'verify.rerun').at(-1)
    expect((ev1?.payload as { redGreen?: { exitCodeWithoutFix: number; exitCodeWithFix: number }; probeBase?: string })).toMatchObject({
      redGreen: { exitCodeWithoutFix: 1, exitCodeWithFix: 0 },
      probeBase: expect.stringMatching(/^[0-9a-f]{40}$/),
    })

    // Second identical ready report MUST hit cache with zero additional command runs
    expect(await callPre(ctx, id, wt, { state: 'ready', summary: 'fixed add', declared_paths: ['src/calc.mjs', 'tests/calc.test.mjs'] })).toBe('allow')
    expect(runCount).toBe(2)
    guard.dispose()
  })

  it('Fix #1b: denies zero-red fake fixes, never washes timeout/sandbox/127 into red, and isolates cache/docs/unanchored tickets', async () => {
    // 1. Fake fix where baseline already passes -> deny
    const f1 = await setupProvisionedRepo({ ticketId: 't-fake', title: 'Fix edge bug', verifyCommands: ['node -e "process.exit(0)"'] })
    const c1 = new Context()
    const g1 = new PreExecuteCompletionGuard({ context: c1, store: f1.store, registry: f1.registry, runVerifyCommand: async () => ({ exitCode: 0 }) })
    writeFileSync(join(f1.wt, 'src/calc.mjs'), '// noop\n'); emitTool(c1, f1.id, f1.wt, 'edit', ['src/calc.mjs'])
    expect(await callPre(c1, f1.id, f1.wt, { state: 'ready', summary: 'done', declared_paths: ['src/calc.mjs'] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('仍返回 0') })
    g1.dispose()

    // 2. Infra failure on baseline (timedOut, sandboxDenied, noSandbox, exit 127) -> unmeasured, NEVER valid red
    for (const bad of [
      { command: 'npm test', exitCodeWithoutFix: 124, exitCodeWithFix: 0, verifierRole: 'verifier', timedOut: true },
      { command: 'npm test', exitCodeWithoutFix: 1, exitCodeWithFix: 0, verifierRole: 'verifier', sandboxDenied: true },
      { command: 'npm test', exitCodeWithoutFix: 1, exitCodeWithFix: 0, verifierRole: 'verifier', noSandbox: true },
      { command: 'npm test', exitCodeWithoutFix: 127, exitCodeWithFix: 0, verifierRole: 'verifier' },
    ]) {
      expect(evaluateVerifyRerun({ taskType: 'bugfix', builderRole: 'worker', claimedDone: true, rerun: { command: 'npm test', exitCode: 0, verifierRole: 'verifier' }, redGreen: bad }).kind).toBe('unmeasured')
    }
    const sbCtx = new Context()
    sbCtx.reflect.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: f1.wt }) })
    sbCtx.reflect.provide('shell', { resolve: (r: unknown) => r, execute: async () => ({ result: async () => ({ exitCode: 1, timedOut: false, aborted: false, stdout: { text: '' }, stderr: { text: 'denied' }, sandbox: { mode: 'workspace-write', denied: true } }) }) })
    const sbOut = await buildSessionSandboxRunner(sbCtx, { id: 's' }, f1.wt)('npm test', '/tmp/other', { timeoutMs: 5000 })
    expect(sbOut.sandboxDenied).toBe(true)

    // 3. Non-provisioned bugfix repo (even with forged git config branch.main.base) returns unmeasured(no-evidence)
    const unprov = makeDir('dsh-p8-unprov-')
    git(unprov, ['init', '-b', 'main']); git(unprov, ['config', 'user.name', 'T']); git(unprov, ['config', 'user.email', 't@t'])
    writeFileSync(join(unprov, 'a.txt'), '1\n'); git(unprov, ['add', '.']); git(unprov, ['commit', '-qm', 'init'])
    git(unprov, ['config', 'branch.main.base', git(unprov, ['rev-parse', 'HEAD']).trim()])
    const sUn = makeStore(), cUn = new Context()
    const rUn = createJudgementRegistry(); await discoverAndRegisterDeposits({ registry: rUn, dirs: [join(process.cwd(), 'deposits')], registerSeededOssGates: false })
    sUn.tickets.save({ id: 't-un', title: 'Fix missing check', state: 'working', assignments: [], execution: { directory: unprov, name: 't-un', assignment: 'fix bug', verifyCommands: ['true'] } } as never)
    const gUn = new PreExecuteCompletionGuard({ context: cUn, store: sUn, registry: rUn, runVerifyCommand: async () => ({ exitCode: 0 }) })
    expect(await callPre(cUn, 't-un', unprov, { state: 'ready', summary: 'ok', declared_paths: [] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('判据不可测 (no-evidence)') })
    gUn.dispose()

    // 3b. PreExecuteCompletionGuard never washes baseline exit 127 or timeout into valid red
    const env127 = await setupProvisionedRepo({ ticketId: 't-127', title: 'Fix env bug', verifyCommands: ['npm test'] })
    const c127 = new Context()
    const g127 = new PreExecuteCompletionGuard({
      context: c127, store: env127.store, registry: env127.registry,
      runVerifyCommand: async (_cmd, cwd) => cwd === env127.wt ? { exitCode: 0 } : { exitCode: 127 },
    })
    expect(await callPre(c127, env127.id, env127.wt, { state: 'ready', summary: 'ok', declared_paths: [] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('判据不可测 (no-evidence)') })
    g127.dispose()

    // 4. taskType heuristic, test overlay classification, & docs guard
    expect(isTestOverlayPath('src/spec/openapi.ts')).toBe(false)
    expect(isTestOverlayPath('src/test/helper.ts')).toBe(false)
    expect(isTestOverlayPath('tests/foo.spec.ts')).toBe(true)
    expect(isTestOverlayPath('pkg/auth_test.go')).toBe(true)
    expect(isTestOverlayPath('tests/test_auth.py')).toBe(true)
    expect(isTestOverlayPath('deposits/verify-rerun/cases/cases.json')).toBe(true)
    expect(inferTicketTaskType({ title: 'Add fix-width button & ensure no regression', execution: { assignment: 'ui tweak' } } as never)).toBe('feature')
    expect(inferTicketTaskType({ title: 'Fix token expiry bug', execution: { taskType: 'docs', assignment: 'docs only' } } as never)).toBe('docs')
    const docsTick = await setupProvisionedRepo({ ticketId: 't-docs', title: 'Fix token bug', taskType: 'docs', verifyCommands: ['true'] })
    const cDoc = new Context()
    const gDoc = new PreExecuteCompletionGuard({ context: cDoc, store: docsTick.store, registry: docsTick.registry, runVerifyCommand: async () => ({ exitCode: 0 }) })
    expect(await callPre(cDoc, docsTick.id, docsTick.wt, { state: 'ready', summary: 'docs', declared_paths: [] })).toBe('allow')
    gDoc.dispose()

    const noDown = await setupProvisionedRepo({ ticketId: 't-nodown', title: 'Fix auth token bug', verifyCommands: ['node -e "process.exit(0)"'] })
    const cNd = new Context()
    const gNd = new PreExecuteCompletionGuard({ context: cNd, store: noDown.store, registry: noDown.registry, runVerifyCommand: async () => ({ exitCode: 0 }) })
    writeFileSync(join(noDown.wt, 'README.md'), 'docs edit only\n'); emitTool(cNd, noDown.id, noDown.wt, 'write', ['README.md'])
    expect(await callPre(cNd, noDown.id, noDown.wt, { state: 'ready', summary: 'readme only', declared_paths: ['README.md'] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('仍返回 0') })
    gNd.dispose()

    // 5. Bound require_red_green: false skips probe (1 run) & cache key isolated across feature vs bugfix
    const optOff = await setupProvisionedRepo({ ticketId: 't-off', title: 'Fix optional bug', verifyCommands: ['true'] })
    const regOff = createJudgementRegistry(); regOff.register(createVerifyRerunGate({ require_red_green: false }), 'enforce')
    let offRuns = 0
    const cOff = new Context()
    const gOff = new PreExecuteCompletionGuard({ context: cOff, store: optOff.store, registry: regOff, runVerifyCommand: async () => { offRuns += 1; return { exitCode: 0 } } })
    expect(await callPre(cOff, optOff.id, optOff.wt, { state: 'ready', summary: 'ok', declared_paths: [] })).toBe('allow')
    expect(offRuns).toBe(1)
    gOff.dispose()

    const sharedCache = new Map()
    const featRes = await executeVerifyRerunCommands(['true'], f1.wt, { ticketId: 't-iso', revision: 1, taskType: 'feature', cache: sharedCache, runCommand: async () => ({ exitCode: 0 }) })
    expect(featRes.verdict.kind).toBe('allow')
    const bugRes = await executeVerifyRerunCommands(['true'], f1.wt, { ticketId: 't-iso', revision: 1, taskType: 'bugfix', cache: sharedCache, runCommand: async () => ({ exitCode: 0 }) })
    expect(bugRes.verdict).toMatchObject({ kind: 'unmeasured', cause: 'no-evidence' })
    expect(bugRes.cached).toBe(false)

    // Switching require_red_green false -> true on shared guard cache falls through to probe instead of sticking unmeasured
    const optSwitch = await setupProvisionedRepo({ ticketId: 't-sw', title: 'Fix add switch', verifyCommands: ['node --test'] })
    const regSwOff = createJudgementRegistry(); regSwOff.register(createVerifyRerunGate({ require_red_green: false }), 'enforce')
    const regSwOn = createJudgementRegistry(); regSwOn.register(createVerifyRerunGate({ require_red_green: true }), 'enforce')
    const sharedPreCache = new Map()
    const runRealNode = async (_c: string, cwd: string) => {
      try { const o = await execFileAsync(process.execPath, ['--test'], { cwd, timeout: 10_000 }); return { exitCode: 0, stdout: o.stdout, stderr: o.stderr } }
      catch (e) { const r = e as { code?: number; stdout?: string; stderr?: string }; return { exitCode: r.code ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } }
    }
    const cSw1 = new Context(), gSw1 = new PreExecuteCompletionGuard({ context: cSw1, store: optSwitch.store, registry: regSwOff, rerunCache: sharedPreCache, runVerifyCommand: runRealNode })
    writeFileSync(join(optSwitch.wt, 'src/calc.mjs'), 'export function add(a, b) { return a + b }\n')
    writeFileSync(join(optSwitch.wt, 'tests/calc.test.mjs'), "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { add } from '../src/calc.mjs'\ntest('sw', () => assert.equal(add(2, 3), 5))\n")
    emitTool(cSw1, optSwitch.id, optSwitch.wt, 'edit', ['src/calc.mjs']); emitTool(cSw1, optSwitch.id, optSwitch.wt, 'write', ['tests/calc.test.mjs'])
    expect(await callPre(cSw1, optSwitch.id, optSwitch.wt, { state: 'ready', summary: 'off', declared_paths: ['src/calc.mjs', 'tests/calc.test.mjs'] })).toBe('allow')
    const cSw2 = new Context(), gSw2 = new PreExecuteCompletionGuard({ context: cSw2, store: optSwitch.store, registry: regSwOn, appender: optSwitch.appender, memoryDir: join(optSwitch.stateDir, 'memory'), rerunCache: sharedPreCache, runVerifyCommand: runRealNode })
    gSw2.getObservation(optSwitch.id) // hydrated from store
    expect(await callPre(cSw2, optSwitch.id, optSwitch.wt, { state: 'ready', summary: 'on', declared_paths: ['src/calc.mjs', 'tests/calc.test.mjs'] })).toBe('allow')
    gSw1.dispose(); gSw2.dispose()
  })
})