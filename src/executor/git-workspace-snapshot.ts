/** 工作区 Git 脏路径快照采集与校验缓存修订号计算。 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Store } from '../app/store.ts'
import { isIgnoredBuildArtifact } from '../judgement/gates/changed-paths.ts'
import { readM0Events } from '../rsi/index.ts'

const execFileAsync = promisify(execFile)

export interface GitStatusSnapshot {
  readonly gitDirtyPaths: string[] | null
  readonly untrackedPaths: string[] | null
  readonly headRev: string
}

const unquoteGitPath = (raw: string): string => {
  const s = raw.trim()
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : s
}

const stripRenameArrow = (raw: string): string => {
  const idx = raw.lastIndexOf(' -> ')
  return idx >= 0 ? unquoteGitPath(raw.slice(idx + 4)) : unquoteGitPath(raw)
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
  if (isIgnoredBuildArtifact(norm) || isIgnoredBuildArtifact(`${norm}/`)) return true
  return cowPaths.some(c => {
    const clean = c.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    return clean !== '' && (norm === clean || norm.startsWith(`${clean}/`))
  })
}

async function resolveProvisionedAnchor(store: Store, rootId: string, memoryDir?: string): Promise<{ branch: string; base: string } | undefined> {
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

/** 用 M0 `workspace.provisioned` 基线、--ignored 扫描与结构化写工具 sha256 校验验证可信工作树是否脱离 shell 盲区。 */
export async function auditProvisionedWorktree(input: {
  rootId: string; workdir?: string; store: Store; memoryDir?: string
  cowPaths?: readonly string[]; sessionDiffs: ReadonlySet<string>; structuredDigests: ReadonlyMap<string, string>
}): Promise<{ ok: true; base: string; branch: string; gitDirtyPaths: string[]; untrackedPaths: string[] } | { ok: false; reason: string }> {
  const { rootId, workdir, store, memoryDir, cowPaths = [], sessionDiffs, structuredDigests } = input
  if (!workdir || !(await stat(workdir).then(s => s.isDirectory(), () => false))) return { ok: false, reason: 'missing-workdir' }
  const anchor = await resolveProvisionedAnchor(store, rootId, memoryDir)
  if (!anchor) return { ok: false, reason: 'missing-provisioned-anchor' }
  const run = (args: readonly string[]) => execFileAsync('git', [...args], { cwd: workdir, timeout: 8000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
  try {
    const [prefixOut, branchOut] = await Promise.all([run(['rev-parse', '--show-prefix']), run(['symbolic-ref', '--quiet', '--short', 'HEAD'])])
    if (prefixOut.stdout.trim() !== '' || branchOut.stdout.trim() !== anchor.branch) return { ok: false, reason: 'branch-mismatch' }
    await run(['merge-base', '--is-ancestor', anchor.base, 'HEAD'])
    const [diffOut, statusOut] = await Promise.all([
      run(['-c', 'core.quotepath=false', 'diff', '--name-only', anchor.base]),
      run(['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '--ignored']),
    ])
    const dirty = new Set(diffOut.stdout.split(/\r?\n/).map(s => unquoteGitPath(s).replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))
    const untracked = new Set<string>()
    for (const line of statusOut.stdout.split(/\r?\n/)) {
      if (line.length < 4) continue
      const xy = line.slice(0, 2)
      const p = (xy.includes('R') || xy.includes('C') ? stripRenameArrow(line.slice(3)) : unquoteGitPath(line.slice(3))).replace(/\\/g, '/').replace(/^\.\//, '')
      if (!p) continue
      if (xy === '!!') { if (!isExpectedIgnored(p, cowPaths)) return { ok: false, reason: `unexpected-ignored:${p}` } }
      else if (xy === '??') untracked.add(p)
      else dirty.add(p)
    }
    const realChanged = [...new Set([...dirty, ...untracked])].filter(p => !isIgnoredBuildArtifact(p))
    for (const p of realChanged) {
      const recorded = structuredDigests.get(p)
      if (!sessionDiffs.has(p) || !recorded || hashWorkspaceFileSync(workdir, p) !== recorded) return { ok: false, reason: `unstructured-or-tampered:${p}` }
    }
    for (const p of sessionDiffs) {
      if (isIgnoredBuildArtifact(p)) continue
      const recorded = structuredDigests.get(p)
      if (!recorded || hashWorkspaceFileSync(workdir, p) !== recorded) return { ok: false, reason: `reverted-or-tampered:${p}` }
    }
    return { ok: true, base: anchor.base, branch: anchor.branch, gitDirtyPaths: [...dirty], untrackedPaths: [...untracked] }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'git-audit-failed' }
  }
}
