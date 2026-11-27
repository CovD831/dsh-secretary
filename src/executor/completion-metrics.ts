/** 完工期轻量代码改动度量：O(改动文件数) 统计实质代码路径、测试路径与净变更行数（零全仓扫描）。 */
import { execFile } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Store } from '../app/store.ts'
import type { Ticket } from '../core/index.ts'
import { evaluatePointAtGeneration, type ExtendedJudgementRegistry, type JudgementRegistry, type PointEvaluation } from '../judgement/index.ts'
import { isIgnoredBuildArtifact } from '../judgement/gates/changed-paths.ts'
import type { PersistedTicketGeneration } from '../kv.ts'
import { SENSITIVE_PATH_RE, isSafeRelativeWorktreePath, resolveProvisionedAnchor } from './git-workspace-snapshot.ts'
import { isTestOverlayPath } from './red-green-probe.ts'
import { classifyWorkflowRisk, type WorkflowRiskResult } from './workflow-risk.ts'

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