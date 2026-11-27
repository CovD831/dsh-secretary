/** 完工期轻量代码改动度量：O(改动文件数) 统计实质代码路径、测试路径与净变更行数（零全仓扫描）。 */
import { execFile } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Store } from '../app/store.ts'
import type { Ticket } from '../core/index.ts'
import { evaluatePointAtGeneration, type ExtendedJudgementRegistry, type JudgementRegistry, type PointEvaluation } from '../judgement/index.ts'
import { DEFAULT_DIFF_REVIEW_PARAMS, type DiffReviewOutcome } from '../judgement/gates/index.ts'
import { isIgnoredBuildArtifact } from '../judgement/gates/changed-paths.ts'
import type { VerifyCommandResult } from '../judgement/gates/verify-rerun.ts'
import { KV, type PersistedCompletionObs, type PersistedTicketGeneration } from '../kv.ts'
import { redactValue } from '../spine/redact.ts'
import type { DiffReviewEscalationInfo, HostDiffReviewRunner } from './adversarial-review.ts'
import { SENSITIVE_PATH_RE, isSafeRelativeWorktreePath, resolveProvisionedAnchor } from './git-workspace-snapshot.ts'
import { isTestOverlayPath } from './red-green-probe.ts'
import { classifyWorkflowRisk, type WorkflowRiskResult } from './workflow-risk.ts'

export const BUILTIN_VERIFY_POINTS = new Set([
  'verify.changed-paths', 'verify.secret-path-guard', 'verify.rerun', 'verify.command-contract', 'verify.change-test-coverage', 'verify.diff-review',
])

export interface CompletionObservationState {
  readonly sessionDiffs: Set<string>
  readonly structuredDigests: Map<string, string>
  sawShellWrite: boolean
  sawUnmeasuredTool: boolean
  readonly unmeasuredTools: Set<string>
  readonly reviewRejectedRevs: Set<string>
  readonly reviewEscalatedRevs: Set<string>
  reviewCycle: number
}

export function createEmptyObservation(): CompletionObservationState {
  return {
    sessionDiffs: new Set(), structuredDigests: new Map(), sawShellWrite: false, sawUnmeasuredTool: false,
    unmeasuredTools: new Set(), reviewRejectedRevs: new Set(), reviewEscalatedRevs: new Set(), reviewCycle: 0,
  }
}

export function hydrateObservationMap(
  target: Map<string, CompletionObservationState>,
  saved: Record<string, PersistedCompletionObs> | undefined,
  maxTickets: number,
): void {
  if (!saved) return
  for (const [id, o] of Object.entries(saved).slice(-maxTickets)) {
    target.set(id, {
      sessionDiffs: new Set(o.sessionDiffs ?? []), structuredDigests: new Map(Object.entries(o.structuredDigests ?? {})),
      sawShellWrite: Boolean(o.sawShellWrite), sawUnmeasuredTool: Boolean(o.sawUnmeasuredTool), unmeasuredTools: new Set(o.unmeasuredTools ?? []),
      reviewRejectedRevs: new Set(o.reviewRejectedRevs ?? []), reviewEscalatedRevs: new Set(o.reviewEscalatedRevs ?? []),
      reviewCycle: Number.isInteger(o.reviewCycle) && o.reviewCycle! >= 0 ? o.reviewCycle! : 0,
    })
  }
}

export function serializeObservationMap(map: ReadonlyMap<string, CompletionObservationState>): Record<string, PersistedCompletionObs> {
  const out: Record<string, PersistedCompletionObs> = {}
  for (const [id, o] of map) {
    if (!o.sawShellWrite && !o.sawUnmeasuredTool && o.sessionDiffs.size === 0 && o.unmeasuredTools.size === 0 && o.reviewRejectedRevs.size === 0 && o.reviewCycle === 0) continue
    out[id] = {
      sessionDiffs: [...o.sessionDiffs], sawShellWrite: o.sawShellWrite, sawUnmeasuredTool: o.sawUnmeasuredTool, unmeasuredTools: [...o.unmeasuredTools],
      ...(o.structuredDigests.size > 0 ? { structuredDigests: Object.fromEntries(o.structuredDigests) } : {}),
      ...(o.reviewRejectedRevs.size > 0 ? { reviewRejectedRevs: [...o.reviewRejectedRevs] } : {}),
      ...(o.reviewEscalatedRevs.size > 0 ? { reviewEscalatedRevs: [...o.reviewEscalatedRevs] } : {}),
      ...(o.reviewCycle > 0 ? { reviewCycle: o.reviewCycle } : {}),
    }
  }
  return out
}

export function formatBlockReason(point: string, ev: PointEvaluation): string {
  if (ev.verdict.kind === 'deny') return `[${point}] ${ev.verdict.blockers.join('；')}`
  if (ev.verdict.kind === 'unmeasured') return `[${point}] 判据不可测 (${ev.verdict.cause})：${ev.verdict.detail}`
  return `[${point}] 硬闸未通过`
}

const execFileAsync = promisify(execFile)
const NON_PRODUCT_PATH_RE = /(?:^docs\/|\.(?:md|mdx|txt|rst|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|mov|pdf|wasm|sqlite3?|db|bin|zip|tar|gz|tgz|exe|dll|so|dylib|node|class|jar|pyc|o|a|lock|d\.ts)$|(?:^|\/)(?:\.gitignore|\.editorconfig|LICENSE|CHANGELOG|pnpm-lock\.ya?ml|package-lock\.json|yarn\.lock|bun\.lockb?)$)/i

export interface CompletionCodeMetrics {
  readonly codeChangedPaths: string[]
  readonly testChangedPaths: string[]
  readonly changedCodeLines: number | null
}

/** 判断路径是否属于需验收命令与测试覆盖度检验的实质业务/配置代码文件（排除文档、图片、构建产物、.d.ts 与测试）。 */
export function isProductCodePath(relPath: string): boolean {
  const norm = relPath.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!norm || isIgnoredBuildArtifact(norm) || SENSITIVE_PATH_RE.test(norm)) return false
  if (isTestOverlayPath(norm) || NON_PRODUCT_PATH_RE.test(norm)) return false
  return true
}

/** 基于 `git diff --numstat` 与未跟踪新文件直读统计净变动代码行数（O(改动文件数)，避免完工期全仓扫描）。 */
export async function collectCompletionCodeMetrics(input: {
  workdir?: string
  changedPaths: readonly string[]
  untrackedPaths: readonly string[] | null
  baseRef?: string
}): Promise<CompletionCodeMetrics> {
  const normList = [...new Set(input.changedPaths.map(p => p.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))]
  const testChangedPaths = normList.filter(isTestOverlayPath).sort()
  const codeChangedPaths = normList.filter(isProductCodePath).sort()
  if (codeChangedPaths.length === 0) return { codeChangedPaths, testChangedPaths, changedCodeLines: 0 }
  if (!input.workdir) return { codeChangedPaths, testChangedPaths, changedCodeLines: null }

  const untrackedSet = new Set((input.untrackedPaths ?? []).map(p => p.trim().replace(/\\/g, '/').replace(/^\.\//, '')))
  const baseRef = input.baseRef ?? 'HEAD'
  const counted = new Set<string>()
  let totalLines = 0
  try {
    const { stdout } = await execFileAsync('git', [
      '-c', 'core.quotepath=false', 'diff', '--numstat', '--no-renames', '--relative', '--no-ext-diff', '--no-textconv', baseRef, '--', ...codeChangedPaths,
    ], { cwd: input.workdir, timeout: 8000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const file = parts.slice(2).join('\t').trim().replace(/\\/g, '/').replace(/^\.\//, '')
      counted.add(file)
      const add = parts[0] === '-' ? 0 : Number.parseInt(parts[0]!, 10)
      const del = parts[1] === '-' ? 0 : Number.parseInt(parts[1]!, 10)
      if (Number.isFinite(add)) totalLines += add
      if (Number.isFinite(del)) totalLines += del
    }
    if (input.untrackedPaths === null && codeChangedPaths.some(rel => !counted.has(rel))) {
      return { codeChangedPaths, testChangedPaths, changedCodeLines: null }
    }
    for (const rel of codeChangedPaths) {
      if (counted.has(rel) || !untrackedSet.has(rel) || !isSafeRelativeWorktreePath(input.workdir, rel)) continue
      const abs = resolve(input.workdir, rel)
      try {
        const st = lstatSync(abs)
        if (st.isSymbolicLink() || !st.isFile()) continue
        const buf = await readFile(abs)
        if (buf.subarray(0, 8192).includes(0)) continue
        totalLines += buf.toString('utf8').split(/\r?\n/).filter(l => l.trim() !== '').length
      } catch { /* deleted or unreadable */ }
    }
    return { codeChangedPaths, testChangedPaths, changedCodeLines: totalLines }
  } catch {
    return { codeChangedPaths, testChangedPaths, changedCodeLines: null }
  }
}

export interface ReadyAcceptanceCheck {
  readonly point: 'verify.command-contract' | 'verify.change-test-coverage'
  readonly ev: PointEvaluation
  readonly extra: Record<string, unknown>
}

export async function runReadyAcceptanceChecks(input: {
  workdir?: string; store: Store; rootId: string; memoryDir?: string; shellBase?: string
  registry: ExtendedJudgementRegistry | JudgementRegistry; gen?: PersistedTicketGeneration
  entries: readonly { kind: string; stage: string; point?: string }[]; union: readonly string[]
  untrackedPaths: readonly string[] | null; verifyCommands: readonly string[]; taskType: string; ticket?: Ticket
}): Promise<{ metrics: CompletionCodeMetrics; workflowRisk: WorkflowRiskResult; checks: ReadyAcceptanceCheck[] }> {
  const anchorBase = input.shellBase ?? (input.union.length > 0 ? (await resolveProvisionedAnchor(input.store, input.rootId, input.memoryDir))?.base : undefined)
  const metrics = await collectCompletionCodeMetrics({
    workdir: input.workdir, changedPaths: input.union, untrackedPaths: input.untrackedPaths, ...(anchorBase ? { baseRef: anchorBase } : {}),
  })
  const retryCount = input.ticket
    ? input.ticket.assignments.filter(a => a.state === 'ended' && (a.report?.state === 'failed' || a.endedReason === 'retried')).length
    : 0
  const workflowRisk = classifyWorkflowRisk({
    paths: input.union, title: input.ticket?.title, assignment: input.ticket?.execution?.assignment, retryCount,
    ...(input.ticket?.execution?.executionMode ? { executionMode: input.ticket.execution.executionMode } : {}),
    ...(metrics.changedCodeLines !== null ? { diffLineCount: metrics.changedCodeLines } : {}),
  })
  const checks: ReadyAcceptanceCheck[] = []
  if (input.entries.some(e => e.kind === 'gate' && e.stage !== 'retired' && e.point === 'verify.command-contract')) {
    const ev = await evaluatePointAtGeneration(input.registry, 'verify.command-contract', {
      verifyCommands: input.verifyCommands, codeChangedPaths: metrics.codeChangedPaths,
    }, input.gen)
    checks.push({ point: 'verify.command-contract', ev, extra: { verifyCommandsCount: input.verifyCommands.length, codeFiles: metrics.codeChangedPaths.length, workflowRisk } })
  }
  if (input.entries.some(e => e.kind === 'gate' && e.stage !== 'retired' && e.point === 'verify.change-test-coverage')) {
    const ev = await evaluatePointAtGeneration(input.registry, 'verify.change-test-coverage', {
      taskType: input.taskType, codeChangedPaths: metrics.codeChangedPaths,
      testChangedPaths: metrics.testChangedPaths, changedCodeLines: metrics.changedCodeLines,
    }, input.gen)
    checks.push({
      point: 'verify.change-test-coverage', ev,
      extra: { changedCodeLines: metrics.changedCodeLines, codeFiles: metrics.codeChangedPaths.length, testFiles: metrics.testChangedPaths.length, workflowRisk },
    })
  }
  return { metrics, workflowRisk, checks }
}

/** 采集仅含非敏感且安全路径的改动 diff 与未跟踪新增文本，经 redactValue 脱敏并在上限字节截断。 */
export async function collectSanitizedDiffBundle(input: {
  workdir?: string; baseRef?: string; codeChangedPaths: readonly string[]
  untrackedPaths: readonly string[] | null; maxBytes?: number
}): Promise<string> {
  if (!input.workdir) return ''
  const maxBytes = input.maxBytes ?? 24_000
  const safePaths = [...new Set(
    input.codeChangedPaths.map(p => p.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
      .filter(p => p && !SENSITIVE_PATH_RE.test(p) && isSafeRelativeWorktreePath(input.workdir!, p)),
  )].sort()
  if (safePaths.length === 0) return ''

  const chunks: string[] = []
  try {
    const { stdout } = await execFileAsync('git', [
      '-c', 'core.quotepath=false', 'diff', '--no-renames', '--relative', '--no-ext-diff', '--no-textconv',
      input.baseRef ?? 'HEAD', '--', ...safePaths,
    ], { cwd: input.workdir, timeout: 8000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
    if (stdout.trim()) chunks.push(stdout.trimEnd())
  } catch { /* fall through to untracked reads below */ }

  const untrackedSet = new Set((input.untrackedPaths ?? []).map(p => p.trim().replace(/\\/g, '/').replace(/^\.\//, '')))
  for (const rel of safePaths) {
    if (!untrackedSet.has(rel)) continue
    try {
      const abs = resolve(input.workdir, rel), st = lstatSync(abs)
      if (st.isSymbolicLink() || !st.isFile()) continue
      const buf = await readFile(abs)
      if (buf.subarray(0, 8192).includes(0)) continue
      chunks.push(`--- /dev/null\n+++ b/${rel} (untracked)\n${buf.toString('utf8')}`)
    } catch { continue }
  }
  const combined = chunks.join('\n\n').trim()
  if (!combined) return ''
  const redacted = redactValue(combined).value
  const buf = Buffer.from(redacted, 'utf8')
  return buf.length > maxBytes ? `${buf.subarray(0, maxBytes).toString('utf8')}\n...[truncated]` : redacted
}

/** 完工前执行 `verify.diff-review`：按 revision 缓存、验证老板精确豁免与防刷轮次升级。 */
export async function runReadyDiffReviewCheck(input: {
  rootId: string; revision: string; workdir?: string; shellBase?: string; summary?: string; ticket?: Ticket
  store: Store; memoryDir?: string; registry: ExtendedJudgementRegistry | JudgementRegistry; gen?: PersistedTicketGeneration
  entries: readonly { id: string; kind: string; stage: string; point?: string }[]
  union: readonly string[]; untrackedPaths: readonly string[] | null
  readyMeta: { metrics: CompletionCodeMetrics; workflowRisk: WorkflowRiskResult }; commandResults: readonly VerifyCommandResult[]
  obs: { readonly reviewRejectedRevs: Set<string>; readonly reviewEscalatedRevs: Set<string>; readonly reviewCycle: number }
  runDiffReview: HostDiffReviewRunner; diffReviewCache?: Map<string, DiffReviewOutcome>
  onReviewEscalated?: (info: DiffReviewEscalationInfo) => void; signal?: AbortSignal
}): Promise<{ check?: { point: 'verify.diff-review'; ev: PointEvaluation; extra: Record<string, unknown> }; obsChanged: boolean; diffReview?: DiffReviewOutcome }> {
  const diffEntry = input.entries.find(e => e.kind === 'gate' && e.stage !== 'retired' && (e.point as string | undefined) === 'verify.diff-review')
  if (!diffEntry) return { obsChanged: false }
  const { metrics, workflowRisk } = input.readyMeta
  if (workflowRisk.tier !== 'elevated' || metrics.codeChangedPaths.length === 0) {
    const ev = await evaluatePointAtGeneration(input.registry, 'verify.diff-review', {
      workflowRiskTier: workflowRisk.tier, codeChangedPaths: metrics.codeChangedPaths, changedPaths: input.union,
    }, input.gen)
    return { check: { point: 'verify.diff-review', ev, extra: { workflowRisk, codeFiles: metrics.codeChangedPaths.length, skipped: true } }, obsChanged: false }
  }
  const waived = Boolean(input.revision) && (input.store.get?.(KV.governance.reviewWaivers)?.[input.rootId] ?? '') === input.revision
  const rejectedRounds = input.obs.reviewRejectedRevs.size
  const maxRounds = DEFAULT_DIFF_REVIEW_PARAMS.max_review_rounds
  let review: DiffReviewOutcome | undefined
  if (!waived && rejectedRounds < maxRounds) {
    const cacheKey = `${input.rootId}:${input.revision}`
    review = input.diffReviewCache?.get(cacheKey)
    if (!review) {
      const baseRef = input.shellBase ?? (await resolveProvisionedAnchor(input.store, input.rootId, input.memoryDir))?.base
      const diffBundle = await collectSanitizedDiffBundle({
        ...(input.workdir ? { workdir: input.workdir } : {}), ...(baseRef ? { baseRef } : {}),
        codeChangedPaths: metrics.codeChangedPaths, untrackedPaths: input.untrackedPaths,
      })
      review = await input.runDiffReview({
        ticketId: input.rootId, title: input.ticket?.title ?? input.rootId,
        ...(input.summary ? { summary: input.summary } : {}), revision: input.revision, diffBundle,
        codeChangedPaths: metrics.codeChangedPaths, testChangedPaths: metrics.testChangedPaths,
        commandResults: input.commandResults, risk: workflowRisk, ...(input.signal ? { signal: input.signal } : {}),
      })
      if (review.status === 'ok') input.diffReviewCache?.set(cacheKey, review)
    }
  }
  const ev = await evaluatePointAtGeneration(input.registry, 'verify.diff-review', {
    workflowRiskTier: workflowRisk.tier, codeChangedPaths: metrics.codeChangedPaths, changedPaths: input.union,
    rejectedRounds, waived, ...(review ? { review } : {}),
  }, input.gen)
  let obsChanged = false
  if (ev.verdict.kind === 'deny') {
    if (review?.status === 'ok' && !input.obs.reviewRejectedRevs.has(input.revision)) {
      input.obs.reviewRejectedRevs.add(input.revision); obsChanged = true
    }
    if (input.obs.reviewRejectedRevs.size >= maxRounds && input.obs.reviewEscalatedRevs.size === 0) {
      input.obs.reviewEscalatedRevs.add(input.revision); obsChanged = true
      input.onReviewEscalated?.({
        ticketId: input.rootId, revision: input.revision, rejectedRounds: input.obs.reviewRejectedRevs.size,
        escalationCycle: input.obs.reviewCycle, reason: ev.verdict.blockers.join('；'),
      })
    }
  }
  return {
    check: {
      point: 'verify.diff-review', ev,
      extra: {
        revision: input.revision, workflowRisk, waived, rejectedRounds: input.obs.reviewRejectedRevs.size,
        ...(review ? { reviewStatus: review.status, ...(review.status === 'ok' ? { reviewVerdict: review.verdict, reviewerModel: review.reviewerModel } : {}) } : {}),
      },
    },
    obsChanged, ...(review ? { diffReview: review } : {}),
  }
}