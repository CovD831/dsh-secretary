/** 执行期事前完成态硬闸守护：监听根会话与子代理工具结果、采样工作区 git 状态、强制路径核对与独立验证重跑。 */
import { realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Store } from '../app/store.ts'
import type { Ticket } from '../core/index.ts'
import type { DiffReviewOutcome } from '../judgement/gates/index.ts'
import type { ExecuteVerifyRerunOptions, ExecuteVerifyRerunReport } from '../judgement/gates/verify-rerun.ts'
import { evaluatePointAtGeneration, type ExtendedJudgementRegistry, type JudgementRegistry, type Point, type PointEvaluation } from '../judgement/index.ts'
import { KV } from '../kv.ts'
import { redactValue } from '../spine/redact.ts'
import type { SpineAppender } from '../spine/types.ts'
import { runHostDiffReview, type DiffReviewEscalationInfo, type HostDiffReviewRunner } from './adversarial-review.ts'
import {
  auditProvisionedWorktree, collectGitStatus, computeWorkspaceRevision,
  findRevertedSessionPaths, hashWorkspaceFileSync, resolveProvisionedAnchor,
} from './git-workspace-snapshot.ts'
import {
  BUILTIN_VERIFY_POINTS, createEmptyObservation, formatBlockReason, hydrateObservationMap, runReadyAcceptanceChecks,
  runReadyDiffReviewCheck, serializeObservationMap, type CompletionCodeMetrics, type CompletionObservationState,
} from './completion-metrics.ts'
import { inferTicketTaskType, runVerifyRerunPhase } from './red-green-probe.ts'
import { resolveRootTicketId } from './runtime-guard.ts'
import { buildSessionSandboxRunner } from './sandbox-runner.ts'
import type { WorkflowRiskResult } from './workflow-risk.ts'

const SHELL_TOOL_RE = /^(?:bash|pwsh|bash_persistent|pwsh_persistent|sh|shell|powershell|zsh|cmd)$/i
const EDITOR_BLIND_RE = /^str_replace_editor$/i
const MAX_OBSERVED_TICKETS = 500

declare module '../judgement/types.ts' {
  interface PointCatalog { 'verify.secret-path-guard': { readonly changedPaths: readonly string[] } }
}

export type PreExecuteDecision = 'allow' | { readonly kind: 'deny'; readonly reason: string }

/** `PreExecuteCompletionGuard` 依赖注入契约。 */
export interface PreExecuteCompletionGuardDeps {
  readonly context: Context; readonly store: Store; readonly registry: ExtendedJudgementRegistry | JudgementRegistry
  readonly appender?: SpineAppender; readonly memoryDir?: string; readonly now?: () => Date; readonly runVerifyCommand?: ExecuteVerifyRerunOptions['runCommand']
  readonly rerunCache?: Map<string, ExecuteVerifyRerunReport>; readonly verifyTimeoutMs?: number; readonly autoInstall?: boolean
  readonly runDiffReview?: HostDiffReviewRunner; readonly diffReviewCache?: Map<string, DiffReviewOutcome>
  readonly onReviewEscalated?: (info: DiffReviewEscalationInfo) => void
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))

/** 挂载于宿主 `Context` 的完成态事前硬闸守卫，拦截伪造/漏报路径、shell 盲区与验证未通过的完成申报。 */
export class PreExecuteCompletionGuard {
  private readonly observed = new Map<string, CompletionObservationState>()
  private readonly realpathCache = new Map<string, string>()
  private readonly localRerunCache = new Map<string, ExecuteVerifyRerunReport>()
  private readonly localDiffReviewCache = new Map<string, DiffReviewOutcome>()
  private readonly probeMetaCache = new Map<string, { base?: string; reason?: string }>()
  private readonly disposers: Array<() => void> = []

  constructor(private readonly deps: PreExecuteCompletionGuardDeps) {
    hydrateObservationMap(this.observed, this.deps.store.get?.(KV.governance.completionObs), MAX_OBSERVED_TICKETS)
    if (deps.autoInstall !== false) this.install()
  }

  private persistObs(): void {
    if (typeof this.deps.store.set === 'function') this.deps.store.set(KV.governance.completionObs, serializeObservationMap(this.observed))
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

  dispose(): void { while (this.disposers.length > 0) this.disposers.pop()?.() }

  resetDiffReviewRounds(ticketId: string): void {
    const obs = this.observed.get(ticketId)
    if (!obs) return
    obs.reviewRejectedRevs.clear(); obs.reviewEscalatedRevs.clear(); obs.reviewCycle += 1; this.persistObs()
  }

  getObservation(ticketId: string) {
    const obs = this.observed.get(ticketId)
    return {
      sessionDiffs: obs ? [...obs.sessionDiffs].sort() : [] as string[],
      sawShellWrite: obs?.sawShellWrite ?? false,
      sawUnmeasuredTool: obs?.sawUnmeasuredTool ?? false,
      unmeasuredTools: obs ? [...obs.unmeasuredTools].sort() : [] as string[],
    }
  }

  private ensureObs(ticketId: string): CompletionObservationState {
    let obs = this.observed.get(ticketId)
    if (!obs) {
      if (this.observed.size >= MAX_OBSERVED_TICKETS) this.observed.delete(this.observed.keys().next().value!)
      obs = createEmptyObservation(); this.observed.set(ticketId, obs)
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
    const obs = this.ensureObs(rootId), tool = exec.name.trim(), isShell = SHELL_TOOL_RE.test(tool), isBlind = EDITOR_BLIND_RE.test(tool)
    let changed = false
    if (isShell) {
      if (!obs.sawShellWrite || !obs.unmeasuredTools.has(tool)) changed = true
      obs.sawShellWrite = true; obs.unmeasuredTools.add(tool)
    } else if (isBlind) {
      if (!obs.sawUnmeasuredTool || !obs.unmeasuredTools.has(tool)) changed = true
      obs.sawUnmeasuredTool = true; obs.unmeasuredTools.add(tool)
    }
    if (isRecord(result.meta) && Array.isArray(result.meta['diffs'])) {
      const workdir = this.deps.store.tickets.get(rootId)?.execution?.directory ?? exec.agent.session?.header?.cwd
      for (const diff of result.meta['diffs']) {
        if (!isRecord(diff) || typeof diff['path'] !== 'string') continue
        const norm = this.normalizeObservedPath(diff['path'], workdir)
        if (!norm) continue
        if (!obs.sessionDiffs.has(norm)) { obs.sessionDiffs.add(norm); changed = true }
        if (!isShell && !isBlind) {
          const digest = hashWorkspaceFileSync(workdir, norm)
          if (obs.structuredDigests.get(norm) !== digest) { obs.structuredDigests.set(norm, digest); changed = true }
        }
      }
    }
    if (changed) this.persistObs()
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
    const cowPaths = this.deps.store.settings().workspaces?.find(w => w.id === ticket?.execution?.workspace)?.cowPaths
    const git = await collectGitStatus(workdir)
    const declaredPaths: string[] | null = Array.isArray(args['declared_paths']) ? args['declared_paths'].map(String) : (isReadyReport ? [] : null)
    const sessionDiffPaths = [...obs.sessionDiffs], taskType = inferTicketTaskType(ticket)

    let effectiveSawShell = obs.sawShellWrite, effectiveUnmeasured = [...obs.unmeasuredTools], effGit = git
    let shellAudit: { unlocked: boolean; base?: string; reason?: string } | undefined
    const revertedSet = new Set<string>()
    if (obs.sawShellWrite && !obs.sawUnmeasuredTool && effectiveUnmeasured.every(t => SHELL_TOOL_RE.test(t))) {
      const audit = await auditProvisionedWorktree({
        rootId, workdir, store: this.deps.store, sessionDiffs: obs.sessionDiffs, structuredDigests: obs.structuredDigests,
        ...(this.deps.memoryDir ? { memoryDir: this.deps.memoryDir } : {}), ...(cowPaths ? { cowPaths } : {}),
      })
      if (audit.ok) {
        effectiveSawShell = false; effectiveUnmeasured = []
        effGit = { gitDirtyPaths: audit.gitDirtyPaths, untrackedPaths: audit.untrackedPaths, headRev: git.headRev }
        for (const rp of audit.revertedPaths) revertedSet.add(rp)
        shellAudit = { unlocked: true, base: audit.base }
      } else { shellAudit = { unlocked: false, reason: audit.reason } }
    } else if (!obs.sawShellWrite && !obs.sawUnmeasuredTool && obs.sessionDiffs.size > 0 && effGit.gitDirtyPaths !== null && effGit.untrackedPaths !== null) {
      const anchor = await resolveProvisionedAnchor(this.deps.store, rootId, this.deps.memoryDir)
      const nonShellRev = await findRevertedSessionPaths({
        workdir, sessionDiffs: obs.sessionDiffs, dirty: new Set(effGit.gitDirtyPaths), untracked: new Set(effGit.untrackedPaths),
        ...(anchor ? { anchor } : { allowNonShellTrackedRevert: true }), ...(cowPaths ? { cowPaths } : {}),
      })
      for (const rp of nonShellRev) revertedSet.add(rp)
    }

    const revertedPaths = [...revertedSet].sort()
    const effectiveSessionDiffPaths = sessionDiffPaths.filter(p => !revertedSet.has(p))
    const revMeta = revertedPaths.length > 0 ? { revertedPaths } : {}
    const pathEval = await evaluatePointAtGeneration(this.deps.registry, 'verify.changed-paths', {
      declaredPaths, sessionDiffPaths: effectiveSessionDiffPaths, gitDirtyPaths: effGit.gitDirtyPaths, untrackedPaths: effGit.untrackedPaths,
      sawShellWrite: effectiveSawShell, sawUnmeasuredTool: obs.sawUnmeasuredTool,
      ...(effectiveUnmeasured.length > 0 ? { unmeasuredTools: effectiveUnmeasured } : {}),
    }, gen)
    this.appendGateEvent(rootId, exec, 'verify.changed-paths', pathEval, { declaredPaths, gitHead: git.headRev, ...(shellAudit ? { shellAudit } : {}), ...revMeta })
    const blindDetected = effectiveSawShell || obs.sawUnmeasuredTool || effectiveUnmeasured.length > 0
    const pureSkip = declaredPaths === null && !blindDetected && pathEval.verdict.kind === 'unmeasured'
      && pathEval.verdict.cause === 'all-skipped' && pathEval.ran.every(r => r.skip === 'not-applicable')
    if (pathEval.registered > 0 && (pathEval.verdict.kind === 'deny' || (pathEval.verdict.kind === 'unmeasured' && !pureSkip))) {
      return { kind: 'deny', reason: formatBlockReason('verify.changed-paths', pathEval) }
    }

    const entries = 'list' in this.deps.registry ? this.deps.registry.list() : []
    const union = [...new Set([...(declaredPaths ?? []), ...effectiveSessionDiffPaths, ...(effGit.gitDirtyPaths ?? []), ...(effGit.untrackedPaths ?? [])])]
    if (entries.some(e => e.kind === 'gate' && e.point === 'verify.secret-path-guard')) {
      const guardEval = await evaluatePointAtGeneration(this.deps.registry, 'verify.secret-path-guard', { changedPaths: union }, gen)
      this.appendGateEvent(rootId, exec, 'verify.secret-path-guard', guardEval, { checkedCount: union.length, ...revMeta })
      if (guardEval.registered > 0 && (guardEval.verdict.kind === 'deny' || guardEval.verdict.kind === 'unmeasured')) {
        return { kind: 'deny', reason: formatBlockReason('verify.secret-path-guard', guardEval) }
      }
    }

    const verifyCommands = ticket?.execution?.verifyCommands ?? []
    let readyMeta: { metrics: CompletionCodeMetrics; workflowRisk: WorkflowRiskResult } | undefined
    if (isReadyReport) {
      const acc = await runReadyAcceptanceChecks({
        workdir, store: this.deps.store, rootId, ...(this.deps.memoryDir ? { memoryDir: this.deps.memoryDir } : {}),
        ...(shellAudit?.base ? { shellBase: shellAudit.base } : {}), registry: this.deps.registry, gen, entries, union,
        untrackedPaths: effGit.untrackedPaths, verifyCommands, taskType, ticket,
      })
      readyMeta = { metrics: acc.metrics, workflowRisk: acc.workflowRisk }
      for (const c of acc.checks) {
        this.appendGateEvent(rootId, exec, c.point, c.ev, c.extra)
        if (c.ev.registered > 0 && (c.ev.verdict.kind === 'deny' || c.ev.verdict.kind === 'unmeasured')) {
          return { kind: 'deny', reason: formatBlockReason(c.point, c.ev) }
        }
      }
    }

    const customPoints = [...new Set(entries.filter(e => e.kind === 'gate' && e.stage !== 'retired' && e.point?.startsWith('verify.') && !BUILTIN_VERIFY_POINTS.has(e.point)).map(e => e.point!))]
    const rerunActive = entries.length === 0 || entries.some(e => e.kind === 'gate' && e.point === 'verify.rerun' && (e.stage === 'enforce' || e.stage === 'observe'))
    let commandResults: ExecuteVerifyRerunReport['results'] = [], revision: string | undefined
    if (verifyCommands.length > 0 && (rerunActive || customPoints.length > 0)) {
      revision = await computeWorkspaceRevision(workdir, effGit, effectiveSessionDiffPaths)
      const phase = await runVerifyRerunPhase({
        rootId, workdir, store: this.deps.store, registry: this.deps.registry, gen,
        ...(this.deps.memoryDir ? { memoryDir: this.deps.memoryDir } : {}), ...(cowPaths ? { cowPaths } : {}),
        verifyCommands, revision, taskType, rerunActive, timeoutMs: this.deps.verifyTimeoutMs ?? 120_000, signal: exec.signal,
        cache: this.deps.rerunCache ?? this.localRerunCache, probeMetaCache: this.probeMetaCache,
        runCommand: this.deps.runVerifyCommand ?? buildSessionSandboxRunner(this.deps.context, exec.agent?.session, workdir),
      })
      commandResults = phase.commandResults
      if (rerunActive && phase.rerunEval && phase.rerunExtra) {
        this.appendGateEvent(rootId, exec, 'verify.rerun', phase.rerunEval, phase.rerunExtra)
        if (phase.rerunEval.registered > 0 && (phase.rerunEval.verdict.kind === 'deny' || phase.rerunEval.verdict.kind === 'unmeasured')) {
          return { kind: 'deny', reason: formatBlockReason('verify.rerun', phase.rerunEval) }
        }
      }
    }

    let diffReviewOutcome: DiffReviewOutcome | undefined
    if (isReadyReport && readyMeta) {
      revision ??= await computeWorkspaceRevision(workdir, effGit, effectiveSessionDiffPaths)
      const dr = await runReadyDiffReviewCheck({
        rootId, revision, workdir, ...(shellAudit?.base ? { shellBase: shellAudit.base } : {}),
        ...(typeof args['summary'] === 'string' ? { summary: args['summary'] } : {}), ticket,
        store: this.deps.store, ...(this.deps.memoryDir ? { memoryDir: this.deps.memoryDir } : {}),
        registry: this.deps.registry, gen, entries, union, untrackedPaths: effGit.untrackedPaths,
        readyMeta, commandResults, obs,
        runDiffReview: this.deps.runDiffReview ?? (req => runHostDiffReview(this.deps.context, this.deps.store.settings(), req)),
        diffReviewCache: this.deps.diffReviewCache ?? this.localDiffReviewCache,
        ...(this.deps.onReviewEscalated ? { onReviewEscalated: this.deps.onReviewEscalated } : {}), signal: exec.signal,
      })
      diffReviewOutcome = dr.diffReview
      if (dr.obsChanged) this.persistObs()
      if (dr.check) {
        this.appendGateEvent(rootId, exec, 'verify.diff-review', dr.check.ev, dr.check.extra)
        if (dr.check.ev.registered > 0 && (dr.check.ev.verdict.kind === 'deny' || dr.check.ev.verdict.kind === 'unmeasured')) {
          return { kind: 'deny', reason: formatBlockReason('verify.diff-review', dr.check.ev) }
        }
      }
    }

    for (const pt of customPoints) {
      const customEval = await evaluatePointAtGeneration(this.deps.registry, pt as Point, {
        ...args, ticketId: rootId, taskType, declaredPaths, changedPaths: union,
        sessionDiffPaths: effectiveSessionDiffPaths, gitDirtyPaths: effGit.gitDirtyPaths, untrackedPaths: effGit.untrackedPaths,
        commands: commandResults, verifyCommands,
        ...(readyMeta ? { ...readyMeta.metrics, workflowRisk: readyMeta.workflowRisk } : {}),
        ...(diffReviewOutcome ? { diffReview: diffReviewOutcome } : {}),
      } as never, gen)
      this.appendGateEvent(rootId, exec, pt, customEval, { taskType, checkedCount: union.length })
      if (customEval.registered > 0 && (customEval.verdict.kind === 'deny' || customEval.verdict.kind === 'unmeasured')) {
        return { kind: 'deny', reason: formatBlockReason(pt, customEval) }
      }
    }
    return 'allow'
  }
}