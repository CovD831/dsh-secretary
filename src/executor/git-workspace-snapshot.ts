/** 工作区 Git 脏路径快照采集、受控撤回核验与校验缓存修订号计算。 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Store } from '../app/store.ts'
import { isIgnoredBuildArtifact } from '../judgement/gates/changed-paths.ts'
import { readM0Events } from '../rsi/index.ts'

const execFileAsync = promisify(execFile)
const GIT_MAX_BUFFER = 32 * 1024 * 1024

export const SENSITIVE_PATH_RE = /(?:^|\/)(?:\.env(?:\.[^/]+|rc)?|secrets(?:\/|$)|[^/]*\.(?:pem|key)|[^/]*id_rsa[^/]*|\.dsh(?:\/|$))/i
const COW_FORBIDDEN_RE = /(?:^|\/)(?:\.env(?:\.[^/]+|rc)?|\.dsh)(?=$|\/)/i

export interface GitStatusSnapshot {
  readonly gitDirtyPaths: string[] | null
  readonly untrackedPaths: string[] | null
  readonly headRev: string
}

export const unquoteGitPath = (raw: string): string => {
  const s = raw.trim()
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : s
}
const normalizeGitPath = (raw: string): string => unquoteGitPath(raw).replace(/\\/g, '/').replace(/^\.\//, '')

const stripRenameArrow = (raw: string): string => {
  const idx = raw.lastIndexOf(' -> ')
  return idx >= 0 ? unquoteGitPath(raw.slice(idx + 4)) : unquoteGitPath(raw)
}

export function isRealpathWithin(rootReal: string, candidate: string, allowRoot = true): boolean {
  try {
    const r = realpathSync(candidate)
    const rel = relative(rootReal, r)
    if (rel === '') return allowRoot
    return !rel.startsWith('..') && !isAbsolute(rel)
  } catch { return false }
}

/** 校验路径为不越出 workdir（含软链与祖先软链逃逸）的安全相对路径。 */
export function isSafeRelativeWorktreePath(workdir: string, raw: string): boolean {
  const slash = raw.trim().replace(/\\/g, '/')
  if (!slash || slash.startsWith('/') || slash.startsWith('~') || /^[A-Za-z]:/.test(slash)) return false
  const segs = slash.split('/').filter(s => s !== '' && s !== '.')
  if (segs.length === 0 || segs.some(s => s === '..')) return false
  let rootReal: string
  try { rootReal = realpathSync(workdir) } catch { return false }
  const abs = resolve(rootReal, ...segs)
  try {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return false
    return isRealpathWithin(rootReal, abs, false)
  } catch (err) {
    if ((err as { code?: unknown })?.code !== 'ENOENT') return false
    let cur = dirname(abs)
    while (cur && cur.length >= rootReal.length) {
      try {
        const st = lstatSync(cur)
        if (st.isSymbolicLink() && cur !== rootReal) return false
        return isRealpathWithin(rootReal, cur, true)
      } catch { const next = dirname(cur); if (next === cur) break; cur = next }
    }
    return cur === rootReal
  }
}

export async function collectGitStatus(cwd?: string): Promise<GitStatusSnapshot> {
  if (!cwd) return { gitDirtyPaths: null, untrackedPaths: null, headRev: 'no-cwd' }
  if (!(await stat(cwd).then(s => s.isDirectory(), () => false))) return { gitDirtyPaths: null, untrackedPaths: null, headRev: 'no-dir' }
  try {
    const inside = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5000, encoding: 'utf8' })
    if (inside.stdout.trim() !== 'true') return { gitDirtyPaths: null, untrackedPaths: null, headRev: 'no-git' }
  } catch { return { gitDirtyPaths: null, untrackedPaths: null, headRev: 'no-git' } }
  const prefix = await execFileAsync('git', ['rev-parse', '--show-prefix'], { cwd, timeout: 5000, encoding: 'utf8' }).then(r => r.stdout.trim(), () => '')
  const headRev = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeout: 5000, encoding: 'utf8' }).then(r => r.stdout.trim() || 'unborn', () => 'unborn')
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall'], { cwd, timeout: 10_000, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' })
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

export async function computeWorkspaceRevision(workdir: string | undefined, git: GitStatusSnapshot, sessionDiffs: readonly string[]): Promise<string> {
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

export function hashWorkspaceFileSync(workdir: string | undefined, relPath: string): string {
  if (!workdir || !relPath) return 'UNREADABLE'
  try {
    const abs = isAbsolute(relPath) ? relPath : resolve(workdir, relPath)
    const st = lstatSync(abs)
    if (st.isSymbolicLink() || !st.isFile()) return 'UNREADABLE'
    return `sha256:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`
  } catch (err) {
    return (err as { code?: unknown })?.code === 'ENOENT' ? 'DELETED' : 'UNREADABLE'
  }
}

function isExpectedIgnored(raw: string, cowPaths: readonly string[]): boolean {
  const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!norm) return true
  if (COW_FORBIDDEN_RE.test(norm)) return false
  const inCow = cowPaths.some(c => {
    const clean = c.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    return clean !== '' && (norm === clean || norm.startsWith(`${clean}/`))
  })
  if (inCow) return true
  if (SENSITIVE_PATH_RE.test(norm)) return false
  return isIgnoredBuildArtifact(norm) || isIgnoredBuildArtifact(`${norm}/`)
}

export async function resolveProvisionedAnchor(store: Store, rootId: string, memoryDir?: string): Promise<{ branch: string; base: string } | undefined> {
  const dbLoc = (store.db as unknown as { location?: () => string | null }).location?.()
  const resolvedMem = memoryDir ?? (dbLoc ? join(dirname(dbLoc), 'memory') : undefined)
  const events = await readM0Events({ db: store.db, ...(resolvedMem ? { memoryDir: resolvedMem } : {}) }).catch(() => [])
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!
    const p = ev.payload as Record<string, unknown> | undefined
    if (ev.type !== 'workspace.provisioned' || ev.source?.kind !== 'system' || p?.['ticketId'] !== rootId) continue
    const branch = typeof p['branch'] === 'string' ? p['branch'].trim() : ''
    const base = typeof p['base'] === 'string' ? p['base'].trim() : ''
    if (branch && /^[0-9a-f]{40}$/i.test(base)) return { branch, base }
  }
  return undefined
}

/** 密码学级核验哪些 sessionDiffs 路径已完整撤回至基线（防范 skip-worktree、提交后删除、gitignored 残留及越界伪造）。 */
export async function findRevertedSessionPaths(input: {
  workdir?: string; sessionDiffs: ReadonlySet<string>; dirty: ReadonlySet<string>
  untracked: ReadonlySet<string>; ignored?: ReadonlySet<string>; anchor?: { branch: string; base: string }
  committedInBranch?: ReadonlySet<string>; cowPaths?: readonly string[]; allowNonShellTrackedRevert?: boolean
}): Promise<Set<string>> {
  const reverted = new Set<string>()
  const { workdir, sessionDiffs, dirty, untracked } = input
  if (!workdir || sessionDiffs.size === 0) return reverted
  const runText = (args: readonly string[]) => execFileAsync('git', [...args], { cwd: workdir, timeout: 8000, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' })
  try {
    const safeCandidates = [...sessionDiffs].filter(p => isSafeRelativeWorktreePath(workdir, p))
    if (safeCandidates.length === 0) return reverted
    const baseRef = input.anchor?.base ?? 'HEAD'
    const committedInBranch = new Set<string>(input.committedInBranch ?? [])
    if (input.anchor && !input.committedInBranch) {
      const logOut = await runText(['-c', 'core.quotepath=false', 'log', '-m', '--format=', '--name-only', `${input.anchor.base}..HEAD`])
      for (const line of logOut.stdout.split(/\r?\n/)) { const n = normalizeGitPath(line); if (n) committedInBranch.add(n) }
    }
    const flaggedIndexPaths = new Set<string>()
    const lsOut = await runText(['-c', 'core.quotepath=false', 'ls-files', '-v', '--', ...safeCandidates])
    for (const line of lsOut.stdout.split(/\r?\n/)) {
      if (line.length >= 3 && line[0] !== 'H') { const n = normalizeGitPath(line.slice(2)); if (n) flaggedIndexPaths.add(n) }
    }
    const ignored = new Set<string>(input.ignored ?? [])
    if (!input.ignored) {
      const stOut = await runText(['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '--ignored', '--', ...safeCandidates])
      for (const line of stOut.stdout.split(/\r?\n/)) {
        if (line.length < 4) continue
        const p = normalizeGitPath(line.slice(3))
        if (line.slice(0, 2) === '!!' && p) ignored.add(p)
      }
    }
    for (const p of safeCandidates) {
      if (dirty.has(p) || untracked.has(p) || ignored.has(p) || committedInBranch.has(p) || flaggedIndexPaths.has(p)) continue
      const existsInBase = await runText(['cat-file', '-e', `${baseRef}:${p}`]).then(() => true, () => false)
      if (!existsInBase) {
        if (hashWorkspaceFileSync(workdir, p) === 'DELETED') reverted.add(p)
        continue
      }
      if (!input.anchor) {
        if (!input.allowNonShellTrackedRevert) continue
        const wtDiff = await runText(['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv', '--name-only', 'HEAD', '--', p])
        if (wtDiff.stdout.trim() !== '') continue
      }
      const { stdout: blob } = await execFileAsync('git', ['cat-file', 'blob', `${baseRef}:${p}`], { cwd: workdir, timeout: 8000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' })
      const baseHash = `sha256:${createHash('sha256').update(blob).digest('hex')}`
      if (hashWorkspaceFileSync(workdir, p) === baseHash) reverted.add(p)
    }
  } catch { return new Set() }
  return reverted
}

/** 用 M0 `workspace.provisioned` 基线、--ignored 扫描与结构化写工具 sha256 校验验证可信工作树是否脱离 shell 盲区。 */
export async function auditProvisionedWorktree(input: {
  rootId: string; workdir?: string; store: Store; memoryDir?: string
  cowPaths?: readonly string[]; sessionDiffs: ReadonlySet<string>; structuredDigests: ReadonlyMap<string, string>
}): Promise<{ ok: true; base: string; branch: string; gitDirtyPaths: string[]; untrackedPaths: string[]; revertedPaths: string[] } | { ok: false; reason: string }> {
  const { rootId, workdir, store, memoryDir, cowPaths = [], sessionDiffs, structuredDigests } = input
  if (!workdir || !(await stat(workdir).then(s => s.isDirectory(), () => false))) return { ok: false, reason: 'missing-workdir' }
  const anchor = await resolveProvisionedAnchor(store, rootId, memoryDir)
  if (!anchor) return { ok: false, reason: 'missing-provisioned-anchor' }
  const run = (args: readonly string[]) => execFileAsync('git', [...args], { cwd: workdir, timeout: 8000, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' })
  try {
    const [prefixOut, branchOut] = await Promise.all([run(['rev-parse', '--show-prefix']), run(['symbolic-ref', '--quiet', '--short', 'HEAD'])])
    if (prefixOut.stdout.trim() !== '' || branchOut.stdout.trim() !== anchor.branch) return { ok: false, reason: 'branch-mismatch' }
    await run(['merge-base', '--is-ancestor', anchor.base, 'HEAD'])
    const [diffOut, statusOut, lsOut, logOut] = await Promise.all([
      run(['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv', '--name-only', anchor.base]),
      run(['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '--ignored']),
      run(['-c', 'core.quotepath=false', 'ls-files', '-v']),
      run(['-c', 'core.quotepath=false', 'log', '-m', '--format=', '--name-only', `${anchor.base}..HEAD`]),
    ])
    for (const line of lsOut.stdout.split(/\r?\n/)) {
      if (line.length >= 3 && line[0] !== 'H') {
        return { ok: false, reason: `index-flag-tampered:${normalizeGitPath(line.slice(2))}` }
      }
    }
    const dirty = new Set(diffOut.stdout.split(/\r?\n/).map(normalizeGitPath).filter(Boolean))
    const committedInBranch = new Set(logOut.stdout.split(/\r?\n/).map(normalizeGitPath).filter(Boolean))
    for (const p of committedInBranch) {
      if (!dirty.has(p) || !sessionDiffs.has(p) || SENSITIVE_PATH_RE.test(p)) {
        return { ok: false, reason: `committed-history-tamper:${p}` }
      }
    }
    const untracked = new Set<string>(), ignored = new Set<string>()
    for (const line of statusOut.stdout.split(/\r?\n/)) {
      if (line.length < 4) continue
      const xy = line.slice(0, 2)
      const p = (xy.includes('R') || xy.includes('C') ? stripRenameArrow(line.slice(3)) : unquoteGitPath(line.slice(3))).replace(/\\/g, '/').replace(/^\.\//, '')
      if (!p) continue
      if (xy === '!!') { if (!isExpectedIgnored(p, cowPaths)) return { ok: false, reason: `unexpected-ignored:${p}` }; ignored.add(p) }
      else if (xy === '??') untracked.add(p)
      else dirty.add(p)
    }
    const realChanged = [...new Set([...dirty, ...untracked])].filter(p => !isIgnoredBuildArtifact(p) || SENSITIVE_PATH_RE.test(p))
    for (const p of realChanged) {
      const recorded = structuredDigests.get(p)
      if (!sessionDiffs.has(p) || !recorded || hashWorkspaceFileSync(workdir, p) !== recorded) return { ok: false, reason: `unstructured-or-tampered:${p}` }
    }
    const revertedSet = await findRevertedSessionPaths({ workdir, sessionDiffs, dirty, untracked, ignored, anchor, committedInBranch, cowPaths })
    for (const p of sessionDiffs) {
      if (isIgnoredBuildArtifact(p) && !SENSITIVE_PATH_RE.test(p)) continue
      if (revertedSet.has(p)) continue
      const recorded = structuredDigests.get(p)
      if (!recorded || hashWorkspaceFileSync(workdir, p) !== recorded) return { ok: false, reason: `reverted-or-tampered:${p}` }
    }
    return { ok: true, base: anchor.base, branch: anchor.branch, gitDirtyPaths: [...dirty], untrackedPaths: [...untracked], revertedPaths: [...revertedSet] }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'git-audit-failed' }
  }
}