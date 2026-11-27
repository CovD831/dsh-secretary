/** 受控 I2 影子基线红绿探针：仅信 M0 锚点、只读本地克隆基线、重写回指软链并隔离执行测试验证撤修复必红。 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Store } from '../app/store.ts'
import type { Ticket } from '../core/index.ts'
import { evaluatePointAtGeneration, type ExtendedJudgementRegistry, type JudgementRegistry, type PointEvaluation } from '../judgement/index.ts'
import { isIgnoredBuildArtifact } from '../judgement/gates/changed-paths.ts'
import {
  executeVerifyRerunCommands, isFixTaskType,
  type ExecuteVerifyRerunOptions, type ExecuteVerifyRerunReport, type RedGreenRecord, type VerifyRerunCtx,
} from '../judgement/gates/verify-rerun.ts'
import type { PersistedTicketGeneration } from '../kv.ts'
import {
  SENSITIVE_PATH_RE, isRealpathWithin, isSafeRelativeWorktreePath, resolveProvisionedAnchor, unquoteGitPath,
} from './git-workspace-snapshot.ts'

const execFileAsync = promisify(execFile)
const FORBIDDEN_PROBE_NAME_RE = /^\.env(?:\..+|rc)?$/i
const TEST_OVERLAY_RE = /^(?:tests?|specs?|__tests__)\/|\/(?:tests|__tests__)\/|\.(?:spec|test)\.[a-z0-9]+$|_test\.go$|(?:^|\/)test_[^/]+\.py$|^deposits\/[^/]+\/cases\//i
const FIX_TEXT_RE = /(?<![\w-])(?:fix|bug|bugfix|hotfix|repair)(?![\w-])|修复|排障|缺陷/i
const STANDALONE_REGRESSION_RE = /\bregression\b/i
const NEGATED_REGRESSION_RE = /\b(?:no|zero|without|prevent(?:ing)?|avoid(?:ing)?|guard(?:\s+against)?|ensure\s+no)\s+regression\b/i

/** 优先读取显式 `ticket.execution.taskType`，否则以收紧后的关键词推断；绝不因工人仅改文档文件而降级。 */
export function inferTicketTaskType(ticket?: Ticket): 'feature' | 'bugfix' | 'refactor' | 'docs' {
  const explicit = ticket?.execution?.taskType
  if (explicit) return explicit
  const text = `${ticket?.title ?? ''} ${ticket?.execution?.assignment ?? ''}`
  if (FIX_TEXT_RE.test(text)) return 'bugfix'
  if (STANDALONE_REGRESSION_RE.test(text) && !NEGATED_REGRESSION_RE.test(text)) return 'bugfix'
  return 'feature'
}

export function isTestOverlayPath(relPath: string): boolean {
  return TEST_OVERLAY_RE.test(relPath.replace(/\\/g, '/').replace(/^\.\//, ''))
}

async function scrubProbeTree(
  dir: string, tempReal: string, workdirReal: string, deadline: number, signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || Date.now() > deadline) throw new Error('probe-aborted-or-timed-out')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (signal?.aborted || Date.now() > deadline) throw new Error('probe-aborted-or-timed-out')
    const full = join(dir, ent.name)
    if (FORBIDDEN_PROBE_NAME_RE.test(ent.name)) { await rm(full, { recursive: true, force: true }); continue }
    if (ent.isSymbolicLink()) {
      let real: string | undefined
      try { real = realpathSync(full) } catch { real = undefined }
      if (!real) { await rm(full, { force: true }); continue }
      if (isRealpathWithin(tempReal, real)) continue
      if (isRealpathWithin(workdirReal, real)) {
        const mapped = join(tempReal, relative(workdirReal, real))
        await rm(full, { force: true })
        if (existsSync(mapped)) await symlink(relative(dirname(full), mapped), full).catch(() => {})
        continue
      }
      await rm(full, { force: true })
      continue
    }
    if (ent.isDirectory()) await scrubProbeTree(full, tempReal, workdirReal, deadline, signal)
  }
}

async function copyProbeDeps(
  workdirReal: string, tempReal: string, cowPaths: readonly string[], deadline: number, signal?: AbortSignal,
): Promise<void> {
  const targets = [...new Set([...cowPaths, ...(existsSync(join(workdirReal, 'node_modules')) ? ['node_modules'] : [])])]
  for (const raw of targets) {
    if (signal?.aborted || Date.now() > deadline) throw new Error('probe-aborted-or-timed-out')
    const clean = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!clean || clean.split('/').some(s => s === '..' || FORBIDDEN_PROBE_NAME_RE.test(s))) continue
    const src = resolve(workdirReal, clean), dst = resolve(tempReal, clean)
    if (!isRealpathWithin(workdirReal, src) || !isRealpathWithin(tempReal, dst) || !existsSync(src) || existsSync(dst)) continue
    try {
      const st = lstatSync(src)
      if (st.isSymbolicLink() && !isRealpathWithin(workdirReal, realpathSync(src))) continue
    } catch { continue }
    await mkdir(dirname(dst), { recursive: true })
    let cloned = false
    if (process.platform === 'darwin') {
      try {
        await execFileAsync('cp', ['-Rc', src, dst], { timeout: Math.max(1000, deadline - Date.now()), ...(signal ? { signal } : {}) })
        cloned = true
      } catch {
        if (signal?.aborted || Date.now() > deadline) throw new Error('probe-aborted-or-timed-out')
      }
    }
    if (!cloned) {
      if (signal?.aborted || Date.now() > deadline) throw new Error('probe-aborted-or-timed-out')
      await cp(src, dst, { recursive: true, filter: p => !FORBIDDEN_PROBE_NAME_RE.test(basename(p)) })
    }
    await scrubProbeTree(dst, tempReal, workdirReal, deadline, signal)
  }
}

export async function probeRedGreenBaseline(input: {
  rootId: string; workdir?: string; store: Store; memoryDir?: string; cowPaths?: readonly string[]
  commands: readonly string[]; runCommand: NonNullable<ExecuteVerifyRerunOptions['runCommand']>
  timeoutMs: number; signal?: AbortSignal; verifierRole?: string
}): Promise<{ redGreen: RedGreenRecord | null; base?: string; reason?: string }> {
  const { rootId, workdir, store, memoryDir, cowPaths = [], commands, runCommand, timeoutMs, verifierRole = 'verifier' } = input
  if (!workdir || commands.length === 0) return { redGreen: null, reason: 'missing-workdir-or-commands' }
  const anchor = await resolveProvisionedAnchor(store, rootId, memoryDir)
  if (!anchor) return { redGreen: null, reason: 'missing-provisioned-anchor' }

  let workdirReal: string
  try { workdirReal = realpathSync(workdir) } catch { return { redGreen: null, reason: 'invalid-workdir' } }
  if (timeoutMs <= 0) {
    return { redGreen: { command: commands[0]!, exitCodeWithoutFix: null, exitCodeWithFix: 0, verifierRole, timedOut: true }, base: anchor.base, reason: 'probe-timeout' }
  }
  const budgetMs = Math.min(timeoutMs, 600_000)
  const deadline = Date.now() + budgetMs
  const ac = new AbortController()
  const onParentAbort = () => ac.abort()
  input.signal?.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => ac.abort(), budgetMs)
  let tempRoot: string | undefined

  try {
    const runGit = (args: readonly string[], cwd = workdirReal) => execFileAsync('git', [...args], {
      cwd, timeout: Math.max(1000, deadline - Date.now()), maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', signal: ac.signal,
    })
    const [diffOut, stOut] = await Promise.all([
      runGit(['-c', 'core.quotepath=false', 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--name-only', anchor.base]),
      runGit(['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall']),
    ])
    const changedSet = new Set<string>()
    for (const line of diffOut.stdout.split(/\r?\n/)) {
      const p = unquoteGitPath(line).replace(/\\/g, '/').replace(/^\.\//, '')
      if (p) changedSet.add(p)
    }
    for (const line of stOut.stdout.split(/\r?\n/)) {
      if (line.length < 4 || line.slice(0, 2) !== '??') continue
      const p = unquoteGitPath(line.slice(3)).replace(/\\/g, '/').replace(/^\.\//, '')
      if (p) changedSet.add(p)
    }
    const relevant = [...changedSet].filter(p => !isIgnoredBuildArtifact(p) && !SENSITIVE_PATH_RE.test(p))
    const testChanges = relevant.filter(isTestOverlayPath)
    const nonTestChanges = relevant.filter(p => !isTestOverlayPath(p))

    tempRoot = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-rg-')))
    const tempDir = join(tempRoot, 'repo')
    await runGit(['clone', '--local', '--no-checkout', '--', workdirReal, tempDir], workdirReal)
    await runGit(['checkout', '--detach', '--quiet', anchor.base], tempDir)
    const tempReal = realpathSync(tempDir)
    await copyProbeDeps(workdirReal, tempReal, cowPaths, deadline, ac.signal)

    if (nonTestChanges.length > 0 && testChanges.length > 0) {
      for (const rel of testChanges) {
        if (!isSafeRelativeWorktreePath(workdirReal, rel)) return { redGreen: null, base: anchor.base, reason: `unsafe-test-path:${rel}` }
        const src = resolve(workdirReal, rel), dst = resolve(tempReal, rel)
        let st: ReturnType<typeof lstatSync> | undefined
        try { st = lstatSync(src) } catch (err) {
          if ((err as { code?: unknown })?.code === 'ENOENT') { await rm(dst, { force: true }); continue }
          return { redGreen: null, base: anchor.base, reason: `unreadable-test-path:${rel}` }
        }
        if (st.isSymbolicLink() || !st.isFile() || !isRealpathWithin(workdirReal, realpathSync(src))) {
          return { redGreen: null, base: anchor.base, reason: `unsafe-test-symlink:${rel}` }
        }
        await mkdir(dirname(dst), { recursive: true })
        await writeFile(dst, await readFile(src))
      }
    }

    for (const command of commands) {
      const remMs = deadline - Date.now()
      if (remMs <= 0 || ac.signal.aborted) {
        return { redGreen: { command, exitCodeWithoutFix: null, exitCodeWithFix: 0, verifierRole, timedOut: true }, base: anchor.base, reason: 'probe-timeout' }
      }
      const raw = await runCommand(command, tempReal, { timeoutMs: Math.max(1000, remMs), signal: ac.signal })
      if (raw.timedOut || raw.aborted || ac.signal.aborted) {
        return {
          redGreen: {
            command, exitCodeWithoutFix: raw.exitCode, exitCodeWithFix: 0, verifierRole,
            ...(raw.timedOut || Date.now() >= deadline ? { timedOut: true } : {}), ...(raw.aborted || ac.signal.aborted ? { aborted: true } : {}),
          },
          base: anchor.base, reason: 'probe-timeout',
        }
      }
      if (raw.noSandbox || raw.sandboxDenied) {
        return {
          redGreen: {
            command, exitCodeWithoutFix: raw.exitCode, exitCodeWithFix: 0, verifierRole,
            ...(raw.noSandbox ? { noSandbox: true } : {}), ...(raw.sandboxDenied ? { sandboxDenied: true } : {}),
          },
          base: anchor.base, reason: 'probe-sandbox-failed',
        }
      }
      if (raw.exitCode === null || raw.exitCode !== 0) {
        return { redGreen: { command, exitCodeWithoutFix: raw.exitCode, exitCodeWithFix: 0, verifierRole }, base: anchor.base }
      }
    }
    return { redGreen: { command: commands.join(' && '), exitCodeWithoutFix: 0, exitCodeWithFix: 0, verifierRole }, base: anchor.base }
  } catch (err) {
    if (ac.signal.aborted || Date.now() >= deadline) {
      return { redGreen: { command: commands[0]!, exitCodeWithoutFix: null, exitCodeWithFix: 0, verifierRole, timedOut: true }, base: anchor.base, reason: 'probe-timeout' }
    }
    return { redGreen: null, base: anchor.base, reason: err instanceof Error ? err.message : 'probe-failed' }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onParentAbort)
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export interface RerunExecutionPhaseResult {
  readonly commandResults: ExecuteVerifyRerunReport['results']
  readonly rerunReport?: ExecuteVerifyRerunReport
  readonly rerunEval?: PointEvaluation
  readonly rerunExtra?: Record<string, unknown>
}

/** 运行 verify.rerun 正向重跑与 fix/bugfix 红绿探针（含生成哈希隔离缓存命中）。 */
export async function runVerifyRerunPhase(input: {
  rootId: string; workdir?: string; store: Store; registry: ExtendedJudgementRegistry | JudgementRegistry
  gen?: PersistedTicketGeneration; memoryDir?: string; cowPaths?: readonly string[]; verifyCommands: readonly string[]
  revision: string; taskType: string; rerunActive: boolean; timeoutMs: number; signal: AbortSignal
  cache: Map<string, ExecuteVerifyRerunReport>; probeMetaCache: Map<string, { base?: string; reason?: string }>
  runCommand: NonNullable<ExecuteVerifyRerunOptions['runCommand']>
}): Promise<RerunExecutionPhaseResult> {
  const { rootId, workdir, store, registry, gen, memoryDir, cowPaths, verifyCommands, revision, taskType, rerunActive, timeoutMs, signal, cache, probeMetaCache, runCommand } = input
  const normalizedCmds = verifyCommands.map(c => c.trim()).filter(Boolean)
  const cmdHash = createHash('sha256').update(JSON.stringify(normalizedCmds)).digest('hex').slice(0, 16)
  const fixStoreKey = isFixTaskType(taskType) && rerunActive ? `${resolve(workdir || '.')}|${rootId}:${revision}:${cmdHash}:${taskType}:${gen?.hash ?? 'd'}:rg` : undefined
  const fixHit = fixStoreKey ? cache.get(fixStoreKey) : undefined
  if (fixHit && fixHit.verdict.kind === 'allow') {
    const rerunEval = await evaluatePointAtGeneration(registry, 'verify.rerun', fixHit.ctx, gen)
    if (rerunEval.verdict.kind === 'allow') {
      const probeMeta = probeMetaCache.get(fixStoreKey!)
      return {
        commandResults: fixHit.results, rerunReport: { ...fixHit, cached: true }, rerunEval,
        rerunExtra: {
          cmdHash: fixHit.cmdHash, cached: true, results: fixHit.results, taskType,
          ...(fixHit.ctx.redGreen ? { redGreen: fixHit.ctx.redGreen } : {}),
          ...(probeMeta?.base ? { probeBase: probeMeta.base } : {}), ...(probeMeta?.reason ? { probeReason: probeMeta.reason } : {}),
        },
      }
    }
  }
  const startedAt = Date.now()
  const rerunReport = await executeVerifyRerunCommands(verifyCommands, workdir ?? '', {
    ticketId: rootId, revision, builderRole: 'worker', verifierRole: 'verifier', taskType, signal,
    runCommand, cache, timeoutMs, ...(gen?.hash ? { cacheVariant: gen.hash } : {}),
  })
  if (!rerunActive) return { commandResults: rerunReport.results }
  let rerunCtx: VerifyRerunCtx = rerunReport.ctx
  let rerunEval = await evaluatePointAtGeneration(registry, 'verify.rerun', rerunCtx, gen)
  let probeMeta: { base?: string; reason?: string } | undefined
  if (isFixTaskType(taskType) && rerunEval.verdict.kind === 'unmeasured' && rerunEval.verdict.cause === 'no-evidence'
    && rerunCtx.rerun?.exitCode === 0 && !rerunCtx.rerun.noSandbox && !rerunCtx.rerun.sandboxDenied && !rerunCtx.rerun.timedOut && !rerunCtx.rerun.aborted) {
    const probe = await probeRedGreenBaseline({
      rootId, workdir, store, ...(memoryDir ? { memoryDir } : {}), ...(cowPaths ? { cowPaths } : {}),
      commands: normalizedCmds, runCommand, timeoutMs: timeoutMs - (Date.now() - startedAt), signal, verifierRole: 'verifier',
    })
    probeMeta = { ...(probe.base ? { base: probe.base } : {}), ...(probe.reason ? { reason: probe.reason } : {}) }
    rerunCtx = { ...rerunCtx, redGreen: probe.redGreen }
    rerunEval = await evaluatePointAtGeneration(registry, 'verify.rerun', rerunCtx, gen)
  }
  if (fixStoreKey && rerunEval.verdict.kind === 'allow') {
    if (cache.size >= 500) { const k = cache.keys().next().value; if (k !== undefined) cache.delete(k) }
    cache.set(fixStoreKey, { ...rerunReport, ctx: rerunCtx, verdict: rerunEval.verdict })
    if (probeMeta) {
      if (probeMetaCache.size >= 500) { const k = probeMetaCache.keys().next().value; if (k !== undefined) probeMetaCache.delete(k) }
      probeMetaCache.set(fixStoreKey, probeMeta)
    }
  }
  return {
    commandResults: rerunReport.results, rerunReport, rerunEval,
    rerunExtra: {
      cmdHash: rerunReport.cmdHash, cached: rerunReport.cached, results: rerunReport.results, taskType,
      ...(rerunCtx.redGreen ? { redGreen: rerunCtx.redGreen } : {}),
      ...(probeMeta?.base ? { probeBase: probeMeta.base } : {}), ...(probeMeta?.reason ? { probeReason: probeMeta.reason } : {}),
    },
  }
}