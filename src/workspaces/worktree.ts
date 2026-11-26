import { execFile } from 'node:child_process'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SpineAppender } from '../spine/types.ts'
import { validateWorkspaceDef } from './registry.ts'
import type { Provisioned, ProvisionedDraft, WorkspaceDef, WorktreeObservation } from './types.ts'

const execFileAsync = promisify(execFile)
const DEFAULT_GIT_TIMEOUT_MS = 30_000
export const UNSAFE_REF_RE = /(?:^\/|\/\/|\.\.|[\x00-\x20\x7f~^:?*\[\\]|\/$|\.lock$|^@\{|^-$)/

export interface GitRunOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ProvisionWorktreeInput extends GitRunOptions {
  ticketId: string
  workspace: WorkspaceDef
  executionName: string
  targetDir: string
  appender?: SpineAppender
}

interface ParsedStanza extends Omit<WorktreeObservation, 'dirty'> {
  bare?: boolean
}

function normalizePath(p: string): string {
  try { return realpathSync(p) } catch {
    const parent = dirname(p)
    return parent === p ? resolve(p) : join(normalizePath(parent), basename(p))
  }
}

function sameDir(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

function sameOrWithin(candidate: string, parent: string): boolean {
  const rel = relative(normalizePath(parent), normalizePath(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const repoLocks = new Map<string, Promise<void>>()
const GIT_LOCK_RETRY_MS = [40, 120, 250] as const

async function withRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoKey) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(fn)
  const tail = run.then(() => undefined, () => undefined)
  repoLocks.set(repoKey, tail)
  try { return await run } finally { if (repoLocks.get(repoKey) === tail) repoLocks.delete(repoKey) }
}

async function runGit(args: readonly string[], cwd: string, options: GitRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const timeout = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  for (let i = 0; ; i++) {
    try {
      return await execFileAsync('git', [...args], {
        cwd, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      const msg = `${(error as { stderr?: string })?.stderr ?? ''} ${(error as { message?: string })?.message ?? ''}`
      if (i >= GIT_LOCK_RETRY_MS.length || options.signal?.aborted || !/could not lock config file|\.lock': File exists/i.test(msg)) throw error
      await new Promise(res => setTimeout(res, GIT_LOCK_RETRY_MS[i]))
    }
  }
}

export function deriveBranchName(branchPrefix: string, executionName: string): string {
  const name = executionName.trim()
  if (!name) throw new Error('execution.name 不能为空')
  const branch = `${branchPrefix}${name}`
  if (!branch || branch.startsWith('-') || UNSAFE_REF_RE.test(branch)) {
    throw new Error(`派生分支名 "${branch}" 非法`)
  }
  return branch
}

export function recordProvisioned(
  appender: SpineAppender,
  draft: ProvisionedDraft,
  meta: { correlationId?: string; causationId?: string } = {},
): Provisioned {
  const at = appender.append({
    id: `workspace.provisioned:${draft.ticketId}:${draft.branch}`,
    stream: `ticket:${draft.ticketId}`,
    type: 'workspace.provisioned',
    ...(meta.causationId ? { causationId: meta.causationId } : {}),
    ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
    source: { kind: 'system', ref: `workspace:${draft.workspace}` },
    evidence: [{ kind: 'commit', ref: draft.base }],
    taint: 'trusted',
    payload: draft,
  })
  return { ...draft, at }
}

/** 按 Orca 真分支纪律创建 worktree 并登记 `branch.<name>.base` 谱系，严禁 detached HEAD 与 shell 拼接。 */
export async function provisionWorktree(input: ProvisionWorktreeInput & { appender: SpineAppender }): Promise<Provisioned>
export async function provisionWorktree(input: ProvisionWorktreeInput): Promise<ProvisionedDraft | Provisioned>
export async function provisionWorktree(input: ProvisionWorktreeInput): Promise<ProvisionedDraft | Provisioned> {
  const workspace = validateWorkspaceDef(input.workspace)
  if (!isAbsolute(input.targetDir) || input.targetDir.startsWith('-')) {
    throw new Error(`worktree 目标路径非法: "${input.targetDir}"`)
  }
  if (sameDir(input.targetDir, workspace.repository) || sameOrWithin(input.targetDir, join(workspace.repository, '.git'))) {
    throw new Error(`worktree 目标路径不得与主仓库相同或位于 .git 内: "${input.targetDir}"`)
  }
  if (!workspace.baseBranch || workspace.baseBranch.startsWith('-') || UNSAFE_REF_RE.test(workspace.baseBranch)) {
    throw new Error(`baseBranch "${workspace.baseBranch}" 非法`)
  }
  const branch = deriveBranchName(workspace.branchPrefix, input.executionName)
  const opts: GitRunOptions = { timeoutMs: input.timeoutMs, signal: input.signal }
  // 同一仓库下 git config 写入共用 .git/config，串行化可避免并发建树时的 .git/config.lock 竞态。
  const base = await withRepoLock(normalizePath(workspace.repository), async () => {
    const { stdout: shaOut } = await runGit(['rev-parse', '--verify', `${workspace.baseBranch}^{commit}`], workspace.repository, opts)
    const rev = shaOut.trim()
    if (!rev) throw new Error(`无法解析 baseBranch "${workspace.baseBranch}" 的提交哈希`)
    await runGit(['worktree', 'add', '--no-track', '-b', branch, input.targetDir, workspace.baseBranch], workspace.repository, opts)
    try {
      await runGit(['config', `branch.${branch}.base`, rev], workspace.repository, opts)
    } catch (error) {
      // config 登记失败必须回滚刚创建的 worktree 与分支，防止留下无谱系半成品。
      await runGit(['worktree', 'remove', '--', input.targetDir], workspace.repository, opts).catch(() => {})
      await runGit(['branch', '-d', '--', branch], workspace.repository, opts).catch(() => {})
      throw error
    }
    return rev
  })
  const draft: ProvisionedDraft = { ticketId: input.ticketId, workspace: workspace.id, branch, base }
  if (workspace.cowPaths?.length) {
    await copyCowDependencies(workspace.repository, input.targetDir, workspace.cowPaths, opts)
  }
  return input.appender ? recordProvisioned(input.appender, draft) : draft
}

const FORBIDDEN_COW_NAME_RE = /^\.env(?:\..+|rc)?$/i

async function scrubCowTree(rootDst: string, repoReal: string, targetReal: string): Promise<void> {
  const entries = await readdir(rootDst, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    const full = join(rootDst, ent.name)
    if (FORBIDDEN_COW_NAME_RE.test(ent.name)) {
      await rm(full, { recursive: true, force: true })
      continue
    }
    if (ent.isSymbolicLink()) {
      const escaped = (() => {
        try {
          const real = realpathSync(full)
          return !sameOrWithin(real, targetReal) && !sameOrWithin(real, repoReal)
        } catch { return true }
      })()
      if (escaped) await rm(full, { force: true })
      continue
    }
    if (ent.isDirectory()) await scrubCowTree(full, repoReal, targetReal)
  }
}

/** 将主仓已声明的依赖目录（如 `node_modules`）以 APFS CoW `cp -Rc` 快拷至新 worktree，严禁拷入 `.env*`/`.envrc` 或越界软链。 */
export async function copyCowDependencies(
  repoDir: string,
  targetDir: string,
  cowPaths: readonly string[],
  options: GitRunOptions = {},
): Promise<string[]> {
  const copied: string[] = []
  const repoReal = normalizePath(repoDir)
  const targetReal = normalizePath(targetDir)
  for (const rawRel of cowPaths) {
    const clean = rawRel.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!clean || clean.split('/').some(seg => seg === '..' || FORBIDDEN_COW_NAME_RE.test(seg))) continue
    const src = resolve(repoReal, clean)
    if (!existsSync(src) || !sameOrWithin(src, repoReal)) continue
    const stat = lstatSync(src)
    if (stat.isSymbolicLink() && !sameOrWithin(realpathSync(src), repoReal)) continue
    const dst = resolve(targetReal, clean)
    if (!sameOrWithin(dst, targetReal) || existsSync(dst)) continue
    await mkdir(dirname(dst), { recursive: true })
    let cloned = false
    if (process.platform === 'darwin') {
      try {
        await execFileAsync('cp', ['-Rc', src, dst], { timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, signal: options.signal })
        cloned = true
      } catch {
        // 非 APFS 卷自动回退 Node 递归拷贝（过滤 .env*）。
      }
    }
    if (!cloned) {
      await cp(src, dst, {
        recursive: true,
        filter: candidate => !FORBIDDEN_COW_NAME_RE.test(basename(candidate)),
      })
    }
    await scrubCowTree(dst, repoReal, targetReal)
    copied.push(clean)
  }
  return copied
}

export function parseWorktreeListPorcelain(output: string): ParsedStanza[] {
  const entries: ParsedStanza[] = []
  let current: Partial<ParsedStanza> | undefined
  const flush = () => {
    if (!current?.path) return
    entries.push({
      path: current.path,
      head: current.head ?? '',
      ...(current.branch ? { branch: current.branch } : {}),
      locked: current.locked ?? false,
      prunable: current.prunable ?? false,
      ...(current.bare ? { bare: true } : {}),
    })
    current = undefined
  }
  for (const line of output.split(/\r?\n/)) {
    if (line === '') { flush(); continue }
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length), locked: false, prunable: false }
      continue
    }
    if (!current) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length)
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (line === 'locked' || line.startsWith('locked ')) current.locked = true
    else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true
    else if (line === 'bare') current.bare = true
  }
  flush()
  return entries
}

/** 观测仓库全部 worktree 状态；单棵树 status 失败或超时诚实置 `dirty: undefined`。 */
export async function observeWorktrees(repoDir: string, options: GitRunOptions = {}): Promise<WorktreeObservation[]> {
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], repoDir, options)
  const parsed = parseWorktreeListPorcelain(stdout)
  return Promise.all(parsed.map(async entry => {
    const base: WorktreeObservation = {
      path: entry.path,
      head: entry.head,
      ...(entry.branch ? { branch: entry.branch } : {}),
      locked: entry.locked,
      prunable: entry.prunable,
    }
    if (entry.bare || entry.prunable) return base
    try {
      const { stdout: statusOut } = await runGit(['status', '--porcelain'], entry.path, options)
      return { ...base, dirty: statusOut.split(/\r?\n/).some(line => line.length > 0) }
    } catch {
      return base
    }
  }))
}

export async function isBranchMergedIntoBase(
  repoDir: string,
  branch: string,
  baseBranch: string,
  options: GitRunOptions = {},
): Promise<boolean | undefined> {
  if (!branch || !baseBranch || branch.startsWith('-') || baseBranch.startsWith('-') || UNSAFE_REF_RE.test(branch) || UNSAFE_REF_RE.test(baseBranch)) return undefined
  try {
    await runGit(['merge-base', '--is-ancestor', branch, baseBranch], repoDir, options)
    return true
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code
    return code === 1 ? false : undefined
  }
}

export function findWorktreeObservation(observations: readonly WorktreeObservation[], directory: string): WorktreeObservation | undefined {
  return observations.find(item => sameDir(item.path, directory))
}
