import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { GateDef, JudgementRegistry, Stage, Verdict } from '../judgement/types.ts'
import type { GcPlan, GcSubject } from './types.ts'
import { UNSAFE_REF_RE, type GitRunOptions } from './worktree.ts'

const execFileAsync = promisify(execFile)
const DEFAULT_GC_TIMEOUT_MS = 30_000

export interface GcExecutionResult {
  removed: boolean
  branchRemoved: boolean
  branchPreserved?: string
  error?: string
  plan: GcPlan
}

function evaluateGcSubject(subject: GcSubject): Verdict {
  if (!subject.ticket.ended) {
    return { kind: 'deny', blockers: ['Ticket 尚未结束，禁止回收 worktree'] }
  }
  if (subject.ticket.follows?.some(follow => follow.own && !follow.closed)) {
    return { kind: 'deny', blockers: ['Ticket 尚有未关闭的自建跟进线程 (follows)，禁止回收'] }
  }
  if (!subject.tree) {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少 worktree 观测状态，保守保留', disposition: 'refuse' }
  }
  if (subject.tree.locked) {
    return { kind: 'deny', blockers: ['worktree 处于锁定 (locked) 状态，禁止回收'] }
  }
  if (subject.tree.dirty === true) {
    return { kind: 'deny', blockers: ['worktree 存在未提交变更 (dirty)，禁止回收'] }
  }
  if (subject.mergedIntoBase === false) {
    return { kind: 'deny', blockers: ['分支尚未合并进 baseBranch，禁止回收'] }
  }
  if (subject.tree.dirty === undefined) {
    return { kind: 'unmeasured', cause: 'parse-failed', detail: 'worktree 脏状态无法测定 (dirty === undefined)，保守保留', disposition: 'refuse' }
  }
  if (subject.mergedIntoBase === undefined) {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '分支合并态无法测定 (mergedIntoBase === undefined)，保守保留', disposition: 'refuse' }
  }
  return { kind: 'allow' }
}

/** `workspace.gc` 事前硬闸：任何未测定态返回 `unmeasured`，上层一律转换为 `keep`。 */
export const WORKSPACE_GC_GATE: GateDef<'workspace.gc'> = {
  kind: 'gate',
  id: 'workspace.gc.safety',
  version: 1,
  point: 'workspace.gc',
  description: 'worktree 回收事前硬闸：仅在 Ticket 已结束、未锁、干净且已合并时放行；未测定一律保守保留',
  side: 'hard',
  placement: { timing: 'pre', enforce: true },
  requires: ['ticket', 'ticket.id', 'now'],
  gate: evaluateGcSubject,
}

export function registerWorkspaceGcGate(registry: Pick<JudgementRegistry, 'register'>, stage: Stage = 'enforce'): void {
  registry.register(WORKSPACE_GC_GATE, stage)
}

export async function planWorkspaceGc(registry: Pick<JudgementRegistry, 'evaluate'>, subject: GcSubject): Promise<GcPlan> {
  const evaluation = await registry.evaluate('workspace.gc', subject)
  if (evaluation.verdict.kind !== 'allow') {
    return { kind: 'keep', because: evaluation.verdict }
  }
  const gateAllow = evaluation.evaluated > 0
    && evaluation.ran.some(entry => entry.id === WORKSPACE_GC_GATE.id && entry.outcome === 'allow')
  if (!gateAllow) {
    return {
      kind: 'keep',
      because: { kind: 'unmeasured', cause: 'no-evidence', detail: 'workspace.gc 事前硬闸未注册或未启用 enforce', disposition: 'refuse' },
    }
  }
  if (!subject.tree) {
    return {
      kind: 'keep',
      because: { kind: 'unmeasured', cause: 'missing-input', detail: '缺少 worktree 观测状态', disposition: 'refuse' },
    }
  }
  return subject.tree.branch
    ? { kind: 'remove-worktree-and-branch', path: subject.tree.path, branch: subject.tree.branch }
    : { kind: 'remove-worktree', path: subject.tree.path }
}

async function gitGcExec(args: readonly string[], cwd: string, options: GitRunOptions = {}): Promise<void> {
  await execFileAsync('git', [...args], {
    cwd,
    timeout: options.timeoutMs ?? DEFAULT_GC_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

/** 执行回收计划：严禁 `--force`，加 `--` 与前缀校验防选项注入，删分支只用 `-d`。 */
export async function executeWorkspaceGc(repoDir: string, plan: GcPlan, options: GitRunOptions = {}): Promise<GcExecutionResult> {
  if (plan.kind === 'keep') return { removed: false, branchRemoved: false, plan }
  if (!isAbsolute(plan.path) || plan.path.startsWith('-')) {
    return { removed: false, branchRemoved: false, error: `非法 worktree 路径: "${plan.path}"`, plan }
  }
  if (plan.kind === 'remove-worktree-and-branch' && (!plan.branch || plan.branch.startsWith('-') || UNSAFE_REF_RE.test(plan.branch))) {
    return { removed: false, branchRemoved: false, error: `非法分支名: "${plan.branch}"`, plan }
  }
  try {
    await gitGcExec(['worktree', 'remove', '--', plan.path], repoDir, options)
  } catch (error) {
    return {
      removed: false,
      branchRemoved: false,
      error: error instanceof Error ? error.message : String(error),
      plan,
    }
  }
  if (plan.kind === 'remove-worktree') return { removed: true, branchRemoved: false, plan }
  try {
    await gitGcExec(['branch', '-d', '--', plan.branch], repoDir, options)
    return { removed: true, branchRemoved: true, plan }
  } catch (error) {
    return {
      removed: true,
      branchRemoved: false,
      branchPreserved: plan.branch,
      error: error instanceof Error ? error.message : String(error),
      plan,
    }
  }
}

export async function runWorkspaceGc(
  repoDir: string,
  registry: Pick<JudgementRegistry, 'evaluate'>,
  subject: GcSubject,
  options: GitRunOptions = {},
): Promise<GcExecutionResult> {
  const plan = await planWorkspaceGc(registry, subject)
  return executeWorkspaceGc(repoDir, plan, options)
}
