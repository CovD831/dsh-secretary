/** 执行期事前完成态硬闸守护：监听根会话与子代理工具结果、采样工作区 git 状态、强制路径核对与独立验证重跑。 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from '../app/store.ts'
import type { Ticket } from '../core/index.ts'
import { executeVerifyRerunCommands, type ExecuteVerifyRerunOptions, type ExecuteVerifyRerunReport } from '../judgement/gates/verify-rerun.ts'
import { evaluatePointAtGeneration, type ExtendedJudgementRegistry, type JudgementRegistry, type PointEvaluation } from '../judgement/index.ts'
import { KV, type PersistedCompletionObs } from '../kv.ts'
import { redactValue } from '../spine/redact.ts'
import type { SpineAppender } from '../spine/types.ts'
import { resolveRootTicketId } from './runtime-guard.ts'

const execFileAsync = promisify(execFile)
const SHELL_TOOL_RE = /^(?:bash|pwsh|bash_persistent|pwsh_persistent|sh|shell|powershell|zsh|cmd)$/i
const EDITOR_BLIND_RE = /^str_replace_editor$/i
const MAX_OBSERVED_TICKETS = 500

declare module '../judgement/types.ts' {
  interface PointCatalog {
    'verify.secret-path-guard': { readonly changedPaths: readonly string[] }
  }
}

interface TicketObservation { readonly sessionDiffs: Set<string>; sawShellWrite: boolean; sawUnmeasuredTool: boolean; readonly unmeasuredTools: Set<string> }
interface GitStatusSnapshot { readonly gitDirtyPaths: string[] | null; readonly untrackedPaths: string[] | null; readonly headRev: string }
export type PreExecuteDecision = 'allow' | { readonly kind: 'deny'; readonly reason: string }

/** `PreExecuteCompletionGuard` 依赖注入契约。 */
export interface PreExecuteCompletionGuardDeps {
  readonly context: Context; readonly store: Store; readonly registry: ExtendedJudgementRegistry | JudgementRegistry
  readonly appender?: SpineAppender; readonly now?: () => Date; readonly runVerifyCommand?: ExecuteVerifyRerunOptions['runCommand']
  readonly rerunCache?: Map<string, ExecuteVerifyRerunReport>; readonly verifyTimeoutMs?: number; readonly autoInstall?: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const unquoteGitPath = (raw: string): string => {
  const s = raw.trim()
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : s
}
const stripRenameArrow = (raw: string): string => { const idx = raw.lastIndexOf(' -> '); return idx >= 0 ? unquoteGitPath(raw.slice(idx + 4)) : unquoteGitPath(raw) }
function formatBlockReason(point: string, ev: PointEvaluation): string {
  if (ev.verdict.kind === 'deny') return `[${point}] ${ev.verdict.blockers.join('；')}`
  if (ev.verdict.kind === 'unmeasured') return `[${point}] 判据不可测 (${ev.verdict.cause})：${ev.verdict.detail}`
  return `[${point}] 硬闸未通过`
}

/** 挂载于宿主 `Context` 的完成态事前硬闸守卫，拦截伪造/漏报路径、shell 盲区与验证未通过的完成申报。 */
export class PreExecuteCompletionGuard {
  private readonly observed = new Map<string, TicketObservation>()
  private readonly realpathCache = new Map<string, string>()
  private readonly disposers: Array<() => void> = []

  constructor(private readonly deps: PreExecuteCompletionGuardDeps) {
    this.hydrateObs()
    if (deps.autoInstall !== false) this.install()
  }

  private hydrateObs(): void {
    const saved = this.deps.store.get?.(KV.governance.completionObs)
    if (!saved) return
    for (const [id, o] of Object.entries(saved).slice(-MAX_OBSERVED_TICKETS)) {
      this.observed.set(id, { sessionDiffs: new Set(o.sessionDiffs ?? []), sawShellWrite: Boolean(o.sawShellWrite), sawUnmeasuredTool: Boolean(o.sawUnmeasuredTool), unmeasuredTools: new Set(o.unmeasuredTools ?? []) })
    }
  }

  private persistObs(): void {
    if (typeof this.deps.store.set !== 'function') return
    const out: Record<string, PersistedCompletionObs> = {}
    for (const [id, o] of this.observed) {
      if (!o.sawShellWrite && !o.sawUnmeasuredTool && o.sessionDiffs.size === 0 && o.unmeasuredTools.size === 0) continue
      out[id] = { sessionDiffs: [...o.sessionDiffs], sawShellWrite: o.sawShellWrite, sawUnmeasuredTool: o.sawUnmeasuredTool, unmeasuredTools: [...o.unmeasuredTools] }
    }
    this.deps.store.set(KV.governance.completionObs, out)
  }

  /** 注册 `tools/result` 与 `tools/pre-execute` 监听（幂等，返回卸载函数）。 */
  install(): () => void {
    if (this.disposers.length > 0) return () => this.dispose()
    const offResult = this.deps.context.on('tools/result', (exec, result) => { this.onToolResult(exec, result) })
    const offPre = this.deps.context.on('tools/pre-execute', async (exec, next) => {
      const args = isRecord(exec.arguments) ? exec.arguments : {}
      const isReadyReport = exec.name === 'orchestrator_report' && args['state'] === 'ready'
      const isTeamComplete = exec.name === 'team_task_update' && (args['action'] === 'complete' || args['status'] === 'completed')
      if (!isReadyReport && !isTeamComplete && exec.name !== 'present') return next()
      const rootId = exec.agent ? resolveRootTicketId(this.deps.context, exec.agent.session ?? exec.agent.id) : undefined
      if (!rootId) return next()
      const decision = await this.evaluateCompletion(rootId, exec, args, isReadyReport)
      return decision === 'allow' ? next() : decision
    })
    this.disposers.push(offResult, offPre)
    return () => this.dispose()
  }

  /** 卸载所有事件监听。 */
  dispose(): void { while (this.disposers.length > 0) this.disposers.pop()?.() }

  /** 读取某工单累计的工具观测状态（测试与诊断用只读视图）。 */
  getObservation(ticketId: string) {
    const obs = this.observed.get(ticketId)
    return {
      sessionDiffs: obs ? [...obs.sessionDiffs].sort() : [] as string[],
      sawShellWrite: obs?.sawShellWrite ?? false,
      sawUnmeasuredTool: obs?.sawUnmeasuredTool ?? false,
      unmeasuredTools: obs ? [...obs.unmeasuredTools].sort() : [] as string[],
    }
  }

  private ensureObs(ticketId: string): TicketObservation {
    let obs = this.observed.get(ticketId)
    if (!obs) {
      if (this.observed.size >= MAX_OBSERVED_TICKETS) {
        const oldest = this.observed.keys().next().value
        if (oldest !== undefined) this.observed.delete(oldest)
      }
      obs = { sessionDiffs: new Set(), sawShellWrite: false, sawUnmeasuredTool: false, unmeasuredTools: new Set() }
      this.observed.set(ticketId, obs)
    }
    return obs
  }

  private realDir(dir: string): string {
    const cached = this.realpathCache.get(dir)
    if (cached !== undefined) return cached
    try { const r = realpathSync(dir); this.realpathCache.set(dir, r); return r }
    catch { this.realpathCache.set(dir, dir); return dir }
  }

  private normalizeObservedPath(rawPath: string, workdir?: string): string {
    const slash = rawPath.trim().replace(/\\/g, '/')
    if (!slash) return ''
    if (!isAbsolute(slash) && !slash.startsWith('~') && !/^[A-Za-z]:/.test(slash)) return slash.replace(/^\.\//, '')
    if (!workdir) return slash
    for (const [base, target] of [[workdir, rawPath], [this.realDir(workdir), this.realDir(rawPath)]] as const) {
      const rel = relative(base, target)
      if (!isAbsolute(rel) && !rel.startsWith('..') && rel !== '') return rel.replace(/\\/g, '/')
    }
    return slash
  }

  private onToolResult(
    exec: { readonly name: string; readonly agent?: { readonly id: string; readonly session?: { readonly id: string; readonly header: { readonly cwd?: string; readonly parentSession?: string } } } },
    result: { readonly meta?: unknown },
  ): void {
    if (!exec.agent) return
    const rootId = resolveRootTicketId(this.deps.context, (exec.agent.session as never) ?? exec.agent.id)
    if (!rootId) return
    const obs = this.ensureObs(rootId), tool = exec.name.trim()
    let changed = false
    if (SHELL_TOOL_RE.test(tool)) {
      if (!obs.sawShellWrite || !obs.unmeasuredTools.has(tool)) changed = true
      obs.sawShellWrite = true; obs.unmeasuredTools.add(tool)
    } else if (EDITOR_BLIND_RE.test(tool)) {
      if (!obs.sawUnmeasuredTool || !obs.unmeasuredTools.has(tool)) changed = true
      obs.sawUnmeasuredTool = true; obs.unmeasuredTools.add(tool)
    }
    if (isRecord(result.meta) && Array.isArray(result.meta['diffs'])) {
      const workdir = this.deps.store.tickets.get(rootId)?.execution?.directory ?? exec.agent.session?.header?.cwd
      for (const diff of result.meta['diffs']) {
        if (!isRecord(diff) || typeof diff['path'] !== 'string') continue
        const norm = this.normalizeObservedPath(diff['path'], workdir)
        if (norm && !obs.sessionDiffs.has(norm)) { obs.sessionDiffs.add(norm); changed = true }
      }
    }
    if (changed) this.persistObs()
  }

  private async collectGitStatus(cwd?: string): Promise<GitStatusSnapshot> {
    if (!cwd) return { gitDirtyPaths: null, untrackedPaths: null, headRev: 'no-cwd' }
    if (!(await stat(cwd).then(s => s.isDirectory(), () => false))) return { gitDirtyPaths: null, untrackedPaths: null, headRev: 'no-dir' }
    try {
      const inside = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5000, encoding: 'utf8' })
      if (inside.stdout.trim() !== 'true') return { gitDirtyPaths: null, untrackedPaths: null, headRev: 'no-git' }
    } catch { return { gitDirtyPaths: null, untrackedPaths: null, headRev: 'no-git' } }
    const prefix = await execFileAsync('git', ['rev-parse', '--show-prefix'], { cwd, timeout: 5000, encoding: 'utf8' }).then(r => r.stdout.trim(), () => '')
    const headRev = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeout: 5000, encoding: 'utf8' }).then(r => r.stdout.trim() || 'unborn', () => 'unborn')
    try {
      const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall'], { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
      const dirty: string[] = [], untracked: string[] = []
      for (const line of stdout.split(/\r?\n/)) {
        if (line.length < 4) continue
        const xy = line.slice(0, 2)
        let p = xy.includes('R') || xy.includes('C') ? stripRenameArrow(line.slice(3)) : unquoteGitPath(line.slice(3))
        if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length)
        p = p.replace(/\\/g, '/').replace(/^\.\//, '')
        if (p) (xy === '??' ? untracked : dirty).push(p)
      }
      return { gitDirtyPaths: [...new Set(dirty)], untrackedPaths: [...new Set(untracked)], headRev }
    } catch { return { gitDirtyPaths: null, untrackedPaths: null, headRev } }
  }

  private appendGateEvent(
    rootId: string,
    exec: { readonly callId: string; readonly name: string; readonly agent?: { readonly id: string } },
    point: string,
    ev: PointEvaluation,
    extra: Record<string, unknown>,
  ): void {
    if (!this.deps.appender) return
    const nowIso = (this.deps.now ?? (() => new Date()))().toISOString()
    const refused = ev.verdict.kind === 'deny' || ev.verdict.kind === 'unmeasured'
    const { value: payload, redacted } = redactValue({
      ticketId: rootId, sessionId: exec.agent?.id, toolName: exec.name, point,
      verdict: ev.verdict, disposition: refused ? 'refuse' : ev.observed.some(o => o.outcome === 'deny') ? 'warn' : 'proceed',
      registered: ev.registered, ran: ev.ran, observed: ev.observed, ...extra,
    })
    this.deps.appender.append({
      id: `gate:pre-execute:${rootId}:${exec.callId}:${point}`, at: nowIso, stream: `ticket:${rootId}`, type: 'gate.evaluated',
      source: { kind: 'system', ref: 'executor.pre-execute-gates' }, evidence: [], taint: 'trusted',
      ...(redacted.length > 0 ? { redacted } : {}), payload,
    })
  }

  private async evaluateCompletion(
    rootId: string,
    exec: { readonly callId: string; readonly name: string; readonly signal: AbortSignal; readonly agent?: { readonly id: string; readonly session?: { readonly header: { readonly cwd?: string } } } },
    args: Record<string, unknown>,
    isReadyReport: boolean,
  ): Promise<PreExecuteDecision> {
    const ticket: Ticket | undefined = this.deps.store.tickets.get(rootId), obs = this.ensureObs(rootId)
    const gen = this.deps.store.get?.(KV.governance.ticketGenerations)?.[rootId]
    const workdir = ticket?.execution?.directory ?? exec.agent?.session?.header?.cwd
    const git = await this.collectGitStatus(workdir)
    const declaredPaths: string[] | null = Array.isArray(args['declared_paths'])
      ? args['declared_paths'].map(String)
      : (isReadyReport ? [] : null)
    const sessionDiffPaths = [...obs.sessionDiffs]

    const pathEval = await evaluatePointAtGeneration(this.deps.registry, 'verify.changed-paths', {
      declaredPaths, sessionDiffPaths, gitDirtyPaths: git.gitDirtyPaths, untrackedPaths: git.untrackedPaths,
      sawShellWrite: obs.sawShellWrite, sawUnmeasuredTool: obs.sawUnmeasuredTool,
      ...(obs.unmeasuredTools.size > 0 ? { unmeasuredTools: [...obs.unmeasuredTools] } : {}),
    }, gen)
    this.appendGateEvent(rootId, exec, 'verify.changed-paths', pathEval, { declaredPaths, gitHead: git.headRev })
    const blindDetected = obs.sawShellWrite || obs.sawUnmeasuredTool || obs.unmeasuredTools.size > 0
    const pureSkip = declaredPaths === null && !blindDetected && pathEval.verdict.kind === 'unmeasured'
      && pathEval.verdict.cause === 'all-skipped' && pathEval.ran.every(r => r.skip === 'not-applicable')
    if (pathEval.registered > 0 && (pathEval.verdict.kind === 'deny' || (pathEval.verdict.kind === 'unmeasured' && !pureSkip))) {
      return { kind: 'deny', reason: formatBlockReason('verify.changed-paths', pathEval) }
    }

    const entries = 'list' in this.deps.registry ? this.deps.registry.list() : []
    if (entries.some(e => e.kind === 'gate' && e.point === 'verify.secret-path-guard')) {
      const union = [...new Set([...(declaredPaths ?? []), ...sessionDiffPaths, ...(git.gitDirtyPaths ?? []), ...(git.untrackedPaths ?? [])])]
      const guardEval = await evaluatePointAtGeneration(this.deps.registry, 'verify.secret-path-guard', { changedPaths: union }, gen)
      this.appendGateEvent(rootId, exec, 'verify.secret-path-guard', guardEval, { checkedCount: union.length })
      if (guardEval.registered > 0 && (guardEval.verdict.kind === 'deny' || guardEval.verdict.kind === 'unmeasured')) {
        return { kind: 'deny', reason: formatBlockReason('verify.secret-path-guard', guardEval) }
      }
    }

    const rerunActive = entries.length === 0 || entries.some(e => e.kind === 'gate' && e.point === 'verify.rerun' && (e.stage === 'enforce' || e.stage === 'observe'))
    const verifyCommands = ticket?.execution?.verifyCommands ?? []
    if (rerunActive && verifyCommands.length > 0) {
      const revision = await this.computeWorkspaceRevision(workdir, git, sessionDiffPaths)
      const runCommand = this.deps.runVerifyCommand ?? this.buildSessionSandboxRunner(exec.agent?.session)
      const rerunReport = await executeVerifyRerunCommands(verifyCommands, workdir ?? '', {
        ticketId: rootId, revision, builderRole: 'worker', verifierRole: 'verifier', taskType: 'feature', signal: exec.signal,
        runCommand,
        ...(this.deps.rerunCache ? { cache: this.deps.rerunCache } : {}),
        ...(this.deps.verifyTimeoutMs !== undefined ? { timeoutMs: this.deps.verifyTimeoutMs } : {}),
      })
      const rerunEval = await evaluatePointAtGeneration(this.deps.registry, 'verify.rerun', rerunReport.ctx, gen)
      this.appendGateEvent(rootId, exec, 'verify.rerun', rerunEval, { cmdHash: rerunReport.cmdHash, cached: rerunReport.cached, results: rerunReport.results })
      if (rerunEval.registered > 0 && (rerunEval.verdict.kind === 'deny' || rerunEval.verdict.kind === 'unmeasured')) {
        return { kind: 'deny', reason: formatBlockReason('verify.rerun', rerunEval) }
      }
    }
    return 'allow'
  }

  private buildSessionSandboxRunner(session: unknown): NonNullable<ExecuteVerifyRerunOptions['runCommand']> {
    return async (command, cwd, opts) => {
      const shell = this.deps.context.get('shell' as never) as {
        resolve(req: Record<string, unknown>): unknown
        execute(spec: unknown): Promise<{ result(): Promise<{ exitCode: number | null; timedOut: boolean; aborted: boolean; stdout: { text: string }; stderr: { text: string }; sandbox?: { mode: string; denied: boolean; runnerFailed?: boolean } }> }>
      } | undefined
      const sandboxPolicySvc = this.deps.context.get('sandboxPolicy' as never) as {
        resolve(req?: { session?: unknown }): { mode: string; workspaceRoot: string; additionalWritableRoots?: readonly string[]; sessionId?: string }
      } | undefined
      if (!shell || !sandboxPolicySvc || !session) return { exitCode: null, noSandbox: true }
      try {
        const base = sandboxPolicySvc.resolve({ session })
        const sandboxPolicy = base.mode === 'danger-full-access' ? { ...base, mode: 'workspace-write' } : base
        const spec = shell.resolve({
          command, workdir: cwd, timeoutMs: opts.timeoutMs, onExpiry: 'kill', stdoutMaxBytes: 4 * 1024 * 1024,
          ...(opts.signal ? { signal: opts.signal } : {}), sandboxPolicy,
        })
        const res = await (await shell.execute(spec)).result()
        if (!res.sandbox || res.sandbox.runnerFailed) return { exitCode: null, noSandbox: true }
        return { exitCode: res.exitCode, timedOut: res.timedOut, aborted: res.aborted, stdout: res.stdout.text, stderr: res.stderr.text }
      } catch {
        return { exitCode: null, noSandbox: true }
      }
    }
  }

  private async computeWorkspaceRevision(workdir: string | undefined, git: GitStatusSnapshot, sessionDiffs: readonly string[]): Promise<string> {
    if (!workdir || git.gitDirtyPaths === null || git.untrackedPaths === null) return `untracked-${randomUUID()}`
    const h = createHash('sha256').update(git.headRev).update('\0')
    const touched = [...new Set([...git.gitDirtyPaths, ...git.untrackedPaths, ...sessionDiffs])].sort()
    for (const rel of touched) {
      h.update(rel).update('\0')
      const abs = isAbsolute(rel) ? rel : resolve(workdir, rel)
      try { h.update(await readFile(abs)).update('\0') }
      catch (err) {
        const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
        h.update(code === 'ENOENT' ? 'DELETED' : `UNREADABLE:${randomUUID()}`).update('\0')
      }
    }
    return h.digest('hex').slice(0, 16)
  }
}
