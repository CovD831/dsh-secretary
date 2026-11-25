import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { GovernanceRuntime } from '../src/app/governance.ts'
import { executorTools } from '../src/app/tools/executor.ts'
import { secretaryGovernanceTools } from '../src/app/tools/secretary-governance.ts'
import type { Ticket } from '../src/core/index.ts'
import { PreExecuteCompletionGuard } from '../src/executor/pre-execute-gates.ts'
import {
  admitDeposit, compileDeclarativeEntry, createJudgementRegistry, discoverAndRegisterDeposits,
  evaluateCompiledEntry, loadDepositPackage, renderDepositsLedgerMarkdown, resolveDepositEntry,
  runDepositCases, transitionDepositStage, validateDeclarativeRule,
  type DeclarativeRule, type DepositCase, type DepositManifest,
} from '../src/judgement/index.ts'
import { evaluateChangedPaths } from '../src/judgement/gates/changed-paths.ts'
import { executeVerifyRerunCommands, extractVerifyCommandsFromText } from '../src/judgement/gates/verify-rerun.ts'
import type { SpineDraft, SpineAppender } from '../src/spine/types.ts'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

function makeTempDir(prefix = 'dsh-m2-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function makeSpineCollector() {
  const events: SpineDraft[] = []
  const appender: SpineAppender = {
    append(draft) {
      events.push(draft)
      return { seq: events.length, id: draft.id }
    },
  }
  return { events, appender }
}

function makeProse(desc: string): string {
  return `## 意图\n${desc}\n\n## 判据\n按规则执行。\n\n## 正反例\n见 cases。\n\n## 例外\n无。\n\n## 修复指引\n按提示修复。\n`
}

function makeManifestWithRule(id: string, kind: DepositManifest['kind'], rule: DeclarativeRule, extra: Partial<DepositManifest> = {}): DepositManifest {
  return {
    id, version: 1, kind, trust: 'public', cases: 'cases/', prose: makeProse(id),
    params: { max_files: { type: 'number', default: 5, min: 1, max: 50 } },
    ...(kind === 'gate' ? { point: 'verify.secret-path-guard' as never, stage: 'enforce', enforce: true } : {}),
    rule,
    ...extra,
  }
}

async function initGitRepo(dir: string, initialFiles: Record<string, string>) {
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'M2 Test'], { cwd: dir })
  for (const [rel, body] of Object.entries(initialFiles)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body, 'utf8')
  }
  await execFileAsync('git', ['add', '-A'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })
}

function makeTicket(id: string, dir: string, verifyCommands?: string[], assignment?: string): Ticket {
  return {
    id, threadKey: `thread:${id}`, title: id,
    execution: { name: `worker-${id}`, directory: dir, assignment: assignment ?? 'implement feature', ...(verifyCommands ? { verifyCommands } : {}) },
    assignments: [{ state: 'running', assignment: assignment ?? 'implement feature', startedAt: '2026-11-26T00:00:00.000Z' }],
    undelivered: [], createdAt: '2026-11-26T00:00:00.000Z',
  } as unknown as Ticket
}

describe('Milestone 2: Zero-Code Building Blocks, 10 Seed Deposits & PreExecute Hard Gates', () => {
  it('supports all 4 zero-code declarative building blocks with red/green + mutant + unmeasured honesty', async () => {
    const specs: Array<{
      id: string; kind: DepositManifest['kind']; rule: DeclarativeRule; extra?: Partial<DepositManifest>; cases: DepositCase[]
    }> = [
      {
        id: 'zc.path-rules', kind: 'gate',
        rule: { kind: 'path_rules', forbiddenGlobs: ['**/.env*', '**/secrets/**'], allowedPrefixes: ['src/', 'tests/'], maxChangedFilesParam: 'max_files' },
        cases: [
          { name: 'allow-src', expected: 'allow', ctx: { changedPaths: ['src/a.ts', 'tests/a.spec.ts'] } },
          { name: 'deny-secret', expected: 'deny', ctx: { changedPaths: ['src/.env.prod'] } },
          { name: 'deny-outside-prefix', expected: 'deny', ctx: { changedPaths: ['docs/readme.md'] } },
          { name: 'deny-traversal', expected: 'deny', ctx: { changedPaths: ['../outside.ts'] } },
          { name: 'unmeasured-missing', expected: 'unmeasured', expectedCause: 'missing-input', ctx: {} },
        ],
      },
      {
        id: 'zc.command-check', kind: 'gate',
        rule: { kind: 'command_check', requiredCommands: ['pnpm test'], forbidPatterns: ['--no-verify'], requireExitZero: true },
        cases: [
          { name: 'allow-clean-cmd', expected: 'allow', ctx: { commands: [{ command: 'pnpm test', exitCode: 0 }] } },
          { name: 'deny-failed-cmd', expected: 'deny', ctx: { commands: [{ command: 'pnpm test', exitCode: 1 }] } },
          { name: 'deny-forbidden-flag', expected: 'deny', ctx: { commands: [{ command: 'git commit --no-verify', exitCode: 0 }, { command: 'pnpm test', exitCode: 0 }] } },
          { name: 'unmeasured-timeout', expected: 'unmeasured', expectedCause: 'timeout', ctx: { commands: [{ command: 'pnpm test', exitCode: null, timedOut: true }] } },
          { name: 'unmeasured-string-without-exitcode', expected: 'unmeasured', expectedCause: 'no-evidence', ctx: { commands: ['pnpm test'] } },
        ],
      },
      {
        id: 'zc.predicates', kind: 'gate',
        rule: {
          kind: 'predicates', mode: 'all',
          clauses: [
            { path: 'metrics.files', op: 'lte', param: 'max_files' },
            { path: 'metrics.env', op: 'in', value: ['staging', 'prod'] },
            { path: 'metrics.tag', op: 'matches', value: '^v\\d+' },
            { path: 'metrics.note', op: 'non_empty' },
          ],
        },
        cases: [
          { name: 'allow-match', expected: 'allow', ctx: { metrics: { files: 3, env: 'prod', tag: 'v2', note: 'ok' } } },
          { name: 'deny-over-max', expected: 'deny', ctx: { metrics: { files: 9, env: 'prod', tag: 'v2', note: 'ok' } } },
          { name: 'unmeasured-missing-required', expected: 'unmeasured', expectedCause: 'missing-input', ctx: { metrics: { files: 2, env: 'prod' } } },
        ],
      },
      {
        id: 'zc.workflow-sop', kind: 'standing-order',
        extra: { trigger: { signal: 'verify.failed', match: { branch: 'main' } }, action: { name: 'ticket.escalate' }, requires: ['ticketId', 'triaged'] },
        rule: {
          kind: 'workflow_sop', signal: 'verify.failed', action: { name: 'ticket.escalate' }, checklistField: 'steps',
          steps: [{ id: 'collect-logs', requiredField: 'ticketId', mustBeTrueField: 'triaged' }],
        },
        cases: [
          { name: 'allow-sop', expected: 'allow', ctx: { signal: 'verify.failed', payload: { branch: 'main', ticketId: 't1', triaged: true, steps: ['collect-logs'] } } },
          { name: 'deny-missing-step', expected: 'deny', ctx: { signal: 'verify.failed', payload: { branch: 'main', ticketId: 't1', triaged: true, steps: [] } } },
          { name: 'unmeasured-missing-field', expected: 'unmeasured', expectedCause: 'missing-input', ctx: { signal: 'verify.failed', payload: { branch: 'main', ticketId: 't1', steps: ['collect-logs'] } } },
        ],
      },
    ]

    for (const spec of specs) {
      const manifest = makeManifestWithRule(spec.id, spec.kind, spec.rule, spec.extra)
      const adm = admitDeposit(manifest)
      expect(adm.admitted, spec.id).toBe(true)
      const entry = compileDeclarativeEntry(manifest)
      const rep = await runDepositCases(entry, spec.cases)
      expect(rep.ok, `${spec.id}: ${rep.error ?? ''}`).toBe(true)
      expect(rep.mutationPassed, spec.id).toBe(true)
      for (const c of spec.cases) {
        const verdict = await evaluateCompiledEntry(entry, c.ctx)
        expect(verdict.kind, `${spec.id}/${c.name}`).toBe(c.expected)
        if (c.expectedCause && verdict.kind === 'unmeasured') expect(verdict.cause).toBe(c.expectedCause)
      }
    }

    const shellIssues = validateDeclarativeRule({ kind: 'workflow_sop', steps: [{ id: 'a' }], shell: 'rm -rf /' })
    expect(shellIssues.some(i => i.field === 'rule.shell')).toBe(true)
    const badSignalIssues = validateDeclarativeRule({ kind: 'workflow_sop', steps: [{ id: 'a' }], signal: 'rogue.signal' })
    expect(badSignalIssues.some(i => i.field === 'rule.signal')).toBe(true)
  })

  it('executes zero-code rules end-to-end inside orchestrator_deposit_author (validate, replay, install_shadow)', async () => {
    const stateDir = makeTempDir('dsh-m2-author-')
    const { appender } = makeSpineCollector()
    const registry = createJudgementRegistry()
    const gov = { stateDir, registry, appender, nowDate: () => new Date('2026-11-26T00:00:00.000Z') } as unknown as GovernanceRuntime
    const authorTool = secretaryGovernanceTools(gov).find(t => t.name === 'orchestrator_deposit_author')!

    const draftInput = {
      id: 'verify.no-tmp-write', name: 'No Tmp Write', scope: 'public', kind: 'gate', point: 'verify.secret-path-guard',
      requires: ['changedPaths'], params: { max_files: { type: 'number', default: 10, min: 1, max: 50 } },
      exceptions: ['none'], repairHint: 'Remove tmp path', intent: 'Block tmp paths zero-code.', rubricBody: 'Block **/tmp/**',
      actionClass: 'block', stage: 'observe', enforce: false,
      rule: { kind: 'path_rules', inputField: 'changedPaths', forbiddenGlobs: ['**/tmp/**', '*.bak'] },
      cases: [
        { name: 'clean-src', expected: 'allow', ctx: { changedPaths: ['src/ok.ts'] } },
        { name: 'bad-tmp', expected: 'deny', ctx: { changedPaths: ['a/tmp/hack.ts'] } },
      ],
    }

    const val = await authorTool.execute({ mode: 'validate', draft: draftInput } as never, {} as never) as { ok: boolean }
    expect(val.ok).toBe(true)

    const replay = await authorTool.execute({ mode: 'replay', draft: draftInput } as never, {} as never) as {
      totalCases: number; catches: number; trueAllows: number; falseBlocks: number; unmeasuredCount: number
    }
    expect(replay.totalCases).toBe(2)
    expect(replay.catches).toBe(1)
    expect(replay.trueAllows).toBe(1)
    expect(replay.falseBlocks).toBe(0)
    expect(replay.unmeasuredCount).toBe(0)

    const inst = await authorTool.execute({ mode: 'install_shadow', draft: draftInput } as never, {} as never) as {
      installed: boolean; registeredInShadow: boolean; packageDir: string
    }
    expect(inst.installed).toBe(true)
    expect(inst.registeredInShadow).toBe(true)

    const reloaded = await loadDepositPackage(inst.packageDir)
    expect(reloaded.admission.admitted).toBe(true)
    const ev = await registry.evaluate('verify.secret-path-guard' as never, { changedPaths: ['foo/tmp/x.ts'] } as never)
    expect(ev.observed.some(o => o.id === 'verify.no-tmp-write' && o.outcome === 'deny')).toBe(true)
  })

  it('admits and runs red/green + mutant cases for all 10 deposit packages under deposits/, enforcing D5 & LEDGER.md', async () => {
    const depositsRoot = join(process.cwd(), 'deposits')
    const dirs = (await readdir(depositsRoot, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()
    expect(dirs.length).toBe(10)
    expect(dirs).toEqual(expect.arrayContaining(['seen-three-friction', 'stale-ticket-patrol', 'secret-path-guard', 'replay-ci-evaluator']))

    for (const dirName of dirs) {
      const loaded = await loadDepositPackage(join(depositsRoot, dirName))
      expect(loaded.admission.admitted, `deposit ${dirName}`).toBe(true)
      if (!loaded.admission.admitted) continue
      const entry = resolveDepositEntry(loaded.admission.manifest)
      expect(entry, `entry ${dirName}`).toBeDefined()
      const rep = await runDepositCases(entry!, loaded.cases)
      expect(rep.ok, `${dirName}: ${rep.error ?? ''}`).toBe(true)
      expect(rep.mutationPassed, `mutant ${dirName}`).toBe(true)
    }

    const registry = createJudgementRegistry()
    const report = await discoverAndRegisterDeposits({ registry, dirs: [depositsRoot] })
    expect(report.rejectedIds).toEqual([])
    expect(report.failedCaseIds).toEqual([])
    expect(report.registeredIds.length).toBe(10)

    const { events, appender } = makeSpineCollector()
    const frictionLoaded = await loadDepositPackage(join(depositsRoot, 'seen-three-friction'))
    if (!frictionLoaded.admission.admitted) throw new Error('expected admitted')
    const d5Blocked = await transitionDepositStage({
      id: 'friction.seen-three', toStage: 'enforce', registry, stageOverrides: {}, manifest: frictionLoaded.admission.manifest, appender,
    })
    expect(d5Blocked.ok).toBe(false)
    if (!d5Blocked.ok) expect(d5Blocked.code).toBe('constitutional-d5')

    const missingEntryRejected = await transitionDepositStage({
      id: 'friction.seen-three', toStage: 'enforce', registry, stageOverrides: {}, appender,
    })
    expect(missingEntryRejected.ok).toBe(false)
    if (!missingEntryRejected.ok) expect(missingEntryRejected.code).toBe('missing-entry')

    const secLoaded = await loadDepositPackage(join(depositsRoot, 'secret-path-guard'))
    if (!secLoaded.admission.admitted) throw new Error('expected admitted')
    const promoted = await transitionDepositStage({
      id: 'verify.secret-path-guard', toStage: 'enforce', registry, stageOverrides: {}, manifest: secLoaded.admission.manifest, appender, reason: 'all cases green',
    })
    expect(promoted.ok).toBe(true)
    expect(events.some(e => e.type === 'deposit.stage_transitioned')).toBe(true)

    const outDir = makeTempDir('dsh-m2-ledger-')
    const ledgerPath = join(outDir, 'LEDGER.md')
    const ledger = await renderDepositsLedgerMarkdown(report.records, { outPath: ledgerPath, generatedAt: '2026-11-26T00:00:00.000Z' })
    expect(ledger.writtenPath).toBe(ledgerPath)
    const md = await readFile(ledgerPath, 'utf8')
    expect(md).toContain('只读派生视图')
    expect(md).toContain('friction.seen-three')
    expect(md).toContain('verify.secret-path-guard')
    expect((await lstat(ledgerPath)).isFile()).toBe(true)
  })

  it('enforces gate-changed-paths §2 rules & PreExecuteCompletionGuard across root worker and child subagents', async () => {
    // Direct §2 checks: fabrication on ignored dist/, concealment filtering dist/, trailing slash rejection, shell-blind
    expect(evaluateChangedPaths({
      declaredPaths: ['dist/fake.js'], sessionDiffPaths: [], gitDirtyPaths: ['src/real.ts'], untrackedPaths: [],
    }).kind).toBe('deny')
    expect(evaluateChangedPaths({
      declaredPaths: ['src/real.ts'], sessionDiffPaths: ['src/real.ts'], gitDirtyPaths: ['src/real.ts', 'dist/bundle.js', 'app.log'], untrackedPaths: ['.DS_Store'],
    }).kind).toBe('allow')
    expect(evaluateChangedPaths({
      declaredPaths: ['src/'], sessionDiffPaths: ['src/a.ts'], gitDirtyPaths: ['src/a.ts'], untrackedPaths: [],
    }).kind).toBe('deny')
    const blind = evaluateChangedPaths({
      declaredPaths: [], sessionDiffPaths: [], gitDirtyPaths: [], untrackedPaths: [], sawShellWrite: true,
    })
    expect(blind.kind).toBe('unmeasured')
    if (blind.kind === 'unmeasured') expect(blind.cause).toBe('shell-blind')

    // PreExecuteCompletionGuard full lifecycle in temp git repo
    const repoDir = makeTempDir('dsh-m2-repo-')
    await initGitRepo(repoDir, { 'src/a.ts': 'export const a = 1\n' })
    const store = new Store(join(makeTempDir('dsh-m2-db-'), 'orch.db'))
    const registry = createJudgementRegistry()
    await discoverAndRegisterDeposits({ registry, dirs: [join(process.cwd(), 'deposits')] })
    const { events, appender } = makeSpineCollector()

    const ctx = new Context()
    const verifyResults: Array<{ exitCode: number | null; timedOut?: boolean }> = []
    let nextCmdResult: { exitCode: number | null; timedOut?: boolean; stdout?: string; stderr?: string } = { exitCode: 0, stdout: 'ok' }
    const guard = new PreExecuteCompletionGuard({
      context: ctx, store, registry, appender,
      runVerifyCommand: async cmd => {
        verifyResults.push({ exitCode: nextCmdResult.exitCode, timedOut: nextCmdResult.timedOut })
        return { ...nextCmdResult, stdout: `${cmd}:ok` }
      },
    })

    const makeExec = (name: string, callId: string, args: unknown, sessionId: string, parentSession?: string) => ({
      callId, rootCallId: callId, name, arguments: args, signal: new AbortController().signal, token: Symbol('tok') as never,
      agent: { id: sessionId, session: { id: sessionId, header: { cwd: repoDir, ...(parentSession ? { parentSession } : {}) } } as never } as never,
    })

    // Ticket t1: root write + child write + verify pass => allow + cached second report
    store.tickets.save(makeTicket('t1', repoDir, ['pnpm test']))
    writeFileSync(join(repoDir, 'src/a.ts'), 'export const a = 2\n', 'utf8')
    writeFileSync(join(repoDir, 'src/child.ts'), 'export const c = 1\n', 'utf8')
    ctx.emit('tools/result', makeExec('write', 'c1', {}, 'worker-t1') as never, { isError: false, content: [], meta: { diffs: [{ path: join(repoDir, 'src/a.ts') }] } })
    ctx.emit('tools/result', makeExec('edit', 'c2', {}, 'sub-t1', 'worker-t1') as never, { isError: false, content: [], meta: { diffs: [{ path: 'src/child.ts' }] } })

    const callPre = async (exec: unknown) => await ctx.waterfall('tools/pre-execute' as never, exec as never, (async () => 'allow') as never)

    // Concealing child edit -> deny
    const concealedRes = await callPre(makeExec('orchestrator_report', 'p1', { state: 'ready', summary: 'done', declared_paths: ['src/a.ts'] }, 'worker-t1'))
    expect(concealedRes).toMatchObject({ kind: 'deny' })

    // Fabricating path -> deny
    const fabricatedRes = await callPre(makeExec('orchestrator_report', 'p2', { state: 'ready', summary: 'done', declared_paths: ['src/a.ts', 'src/child.ts', 'src/ghost.ts'] }, 'worker-t1'))
    expect(fabricatedRes).toMatchObject({ kind: 'deny' })

    // Verify rerun failure -> deny
    nextCmdResult = { exitCode: 1, stderr: 'test failed' }
    const failVerifyRes = await callPre(makeExec('orchestrator_report', 'p3', { state: 'ready', summary: 'done', declared_paths: ['src/a.ts', 'src/child.ts'] }, 'worker-t1'))
    expect(failVerifyRes).toMatchObject({ kind: 'deny' })

    // Verify timeout -> unmeasured(timeout) -> refuse deny
    nextCmdResult = { exitCode: null, timedOut: true }
    const timeoutRes = await callPre(makeExec('orchestrator_report', 'p4', { state: 'ready', summary: 'done', declared_paths: ['src/a.ts', 'src/child.ts'] }, 'worker-t1'))
    expect(timeoutRes).toMatchObject({ kind: 'deny' })

    // Clean verify exitCode 0 -> allow, and second call hits idempotent cache
    nextCmdResult = { exitCode: 0, stdout: 'all pass' }
    const pass1 = await callPre(makeExec('orchestrator_report', 'p5', { state: 'ready', summary: 'done', declared_paths: ['src/a.ts', 'src/child.ts'] }, 'worker-t1'))
    expect(pass1).toBe('allow')
    const countAfterPass1 = verifyResults.length
    const pass2 = await callPre(makeExec('orchestrator_report', 'p6', { state: 'ready', summary: 'done', declared_paths: ['src/a.ts', 'src/child.ts'] }, 'worker-t1'))
    expect(pass2).toBe('allow')
    expect(verifyResults.length).toBe(countAfterPass1)
    expect(events.some(e => e.type === 'gate.evaluated')).toBe(true)

    // In-place second edit to same dirty file MUST bust cache revision and rerun verification
    writeFileSync(join(repoDir, 'src/a.ts'), 'export const a = 999 // broken in-place edit\n', 'utf8')
    nextCmdResult = { exitCode: 1, stderr: 'broken after second edit' }
    const rerunAfterEdit = await callPre(makeExec('orchestrator_report', 'p6b', { state: 'ready', summary: 'done', declared_paths: ['src/a.ts', 'src/child.ts'] }, 'worker-t1'))
    expect(rerunAfterEdit).toMatchObject({ kind: 'deny' })
    expect(verifyResults.length).toBe(countAfterPass1 + 1)
    nextCmdResult = { exitCode: 0, stdout: 'all pass' }

    // Secret-path-guard integration: touching .env.local even when declared -> deny
    store.tickets.save(makeTicket('t-sec', repoDir, undefined, 'Check ```verify\nnode -e "process.exit(0)"\n```'))
    expect(extractVerifyCommandsFromText('run:\n```verify\nnode -e "process.exit(0)"\n```')).toEqual(['node -e "process.exit(0)"'])
    writeFileSync(join(repoDir, '.env.local'), 'SECRET=dummy\n', 'utf8')
    const secDeny = await callPre(makeExec('orchestrator_report', 'p7', { state: 'ready', summary: 'done', declared_paths: ['src/a.ts', 'src/child.ts', '.env.local'] }, 'worker-t-sec'))
    expect(secDeny).toMatchObject({ kind: 'deny' })

    // Shell-blind on child subagent intercepts team_task_update(complete) & present
    store.tickets.save(makeTicket('t2', repoDir))
    ctx.emit('tools/result', makeExec('bash', 'b1', { command: 'touch x' }, 'sub-t2', 'worker-t2') as never, { isError: false, content: [] })
    const blindTeam = await callPre(makeExec('team_task_update', 'p8', { action: 'complete' }, 'worker-t2'))
    expect(blindTeam).toMatchObject({ kind: 'deny' })
    expect((blindTeam as { reason: string }).reason).toContain('shell-blind')

    ctx.emit('tools/result', makeExec('str_replace_editor', 'b2', {}, 'worker-t3') as never, { isError: false, content: [] })
    store.tickets.save(makeTicket('t3', repoDir))
    const blindPresent = await callPre(makeExec('present', 'p9', {}, 'worker-t3'))
    expect(blindPresent).toMatchObject({ kind: 'deny' })

    // Check executorTools schema exposes optional declared_paths
    const execTools = executorTools({ engine: {}, store, sessions: {}, resources: {}, github: { deployment: { github: { login: 'bot' } } }, sendReplies: async () => {} } as never, makeTicket('t1', repoDir))
    const reportTool = execTools.find(t => t.name === 'orchestrator_report')!
    const parsed = reportTool.schema.parse({ state: 'ready', summary: 'ok', declared_paths: ['src/a.ts'] }) as { declared_paths?: string[] }
    expect(parsed.declared_paths).toEqual(['src/a.ts'])

    // B3: 缺少受沙箱约束的会话 shell 执行器时，禁止在宿主进程裸跑 sh -c，诚实返回 unmeasured('no-sandbox')
    const noSandboxOut = await executeVerifyRerunCommands(['node -e "console.log(123)"'], repoDir, { ticketId: 't-nosb', revision: 1 })
    expect(noSandboxOut.verdict).toMatchObject({ kind: 'unmeasured', cause: 'no-sandbox' })

    // B3: 挂载真实形态的 ctx.shell + ctx.sandboxPolicy 且回传 sandbox 事实时，在会话沙箱内重跑放行；无 sandbox 事实时拒放！
    const sandboxCtx = new Context()
    const resolvedSpecs: unknown[] = []
    let fakeSandboxFact: { mode: string; denied: boolean; runnerFailed?: boolean } | undefined = { mode: 'workspace-write', denied: false }
    sandboxCtx.reflect.provide('sandboxPolicy', {
      resolve: ({ session }: { session?: { id?: string; header?: { cwd?: string } } } = {}) => ({
        mode: 'danger-full-access', workspaceRoot: session?.header?.cwd ?? repoDir, sessionId: session?.id,
      }),
    })
    sandboxCtx.reflect.provide('shell', {
      resolve: (req: unknown) => { resolvedSpecs.push(req); return req },
      execute: async () => ({
        result: async () => ({
          exitCode: 0, timedOut: false, aborted: false,
          stdout: { text: '123\n' }, stderr: { text: '' },
          ...(fakeSandboxFact ? { sandbox: fakeSandboxFact } : {}),
        }),
      }),
    })
    const sbGuard = new PreExecuteCompletionGuard({ context: sandboxCtx, store, registry })
    store.tickets.save(makeTicket('t-sb', repoDir, ['pnpm test'], '```verify\necho evil_from_assignment\n```'))
    const sbPass = await sandboxCtx.waterfall('tools/pre-execute' as never,
      makeExec('orchestrator_report', 'sb1', { state: 'ready', summary: 'ok', declared_paths: ['src/a.ts', 'src/child.ts', '.env.local'] }, 'worker-t-sb') as never,
      (async () => 'allow') as never)
    // .env.local 已被 secret-path-guard 拦下，清理 .env.local 后走通 verify.rerun 会话沙箱路径
    expect(sbPass).toMatchObject({ kind: 'deny' })
    rmSync(join(repoDir, '.env.local'), { force: true })
    const sbCleanPass = await sandboxCtx.waterfall('tools/pre-execute' as never,
      makeExec('orchestrator_report', 'sb2', { state: 'ready', summary: 'ok', declared_paths: ['src/a.ts', 'src/child.ts'] }, 'worker-t-sb') as never,
      (async () => 'allow') as never)
    expect(sbCleanPass).toBe('allow')
    expect((resolvedSpecs[0] as { command: string; sandboxPolicy: { mode: string } })).toMatchObject({
      command: 'pnpm test',
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: repoDir },
    })

    // 若 shell 执行器未回传 sandbox 事实（如未隔离的 bash-local），必须判 no-sandbox 并拦截！
    fakeSandboxFact = undefined
    store.tickets.save(makeTicket('t-unsb', repoDir, ['pnpm lint']))
    const unsbDeny = await sandboxCtx.waterfall('tools/pre-execute' as never,
      makeExec('orchestrator_report', 'sb3', { state: 'ready', summary: 'ok', declared_paths: ['src/a.ts', 'src/child.ts'] }, 'worker-t-unsb') as never,
      (async () => 'allow') as never)
    expect(unsbDeny).toMatchObject({ kind: 'deny' })
    expect((unsbDeny as { reason: string }).reason).toContain('no-sandbox')
    sbGuard.dispose()

    guard.dispose()
    store.close()
  })
})
