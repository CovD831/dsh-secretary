import type { GateDef, Verdict } from '../types.ts'

export interface ChangedPathsParams {
  readonly strict_untracked: boolean
  readonly require_both_surfaces: boolean
}

export const DEFAULT_CHANGED_PATHS_PARAMS: ChangedPathsParams = Object.freeze({
  strict_untracked: true,
  require_both_surfaces: false,
})

export interface ObservedToolCall {
  readonly tool: string
  readonly hasDiff?: boolean
}

export interface ChangedPathsCtx {
  readonly allowedPaths?: readonly string[]
  readonly declaredPaths?: readonly string[] | null
  readonly taskKind?: string
  readonly sessionDiffs?: readonly string[] | null
  readonly sessionDiffPaths?: readonly string[] | null
  readonly gitDirtyPaths: readonly string[] | null
  readonly untrackedPaths?: readonly string[] | null
  readonly ignoreBuildGlobs?: readonly string[]
  readonly sawShellWrite?: boolean
  readonly sawUnmeasuredTool?: boolean
  readonly unmeasuredTools?: readonly string[]
  readonly toolCalls?: readonly ObservedToolCall[]
  readonly params?: Partial<ChangedPathsParams>
}

declare module '../types.ts' {
  interface PointCatalog {
    'verify.changed-paths': ChangedPathsCtx
  }
}

export const BUILD_OUTPUT_IGNORE_RULES: readonly string[] = Object.freeze([
  'dist/', 'build/', 'out/', 'lib/', 'node_modules/', '.pnpm-store/',
  '*.tsbuildinfo', 'coverage/', '.local/', '.DS_Store', '*.log',
])

const UNMEASURED_TOOL_RE = /^(?:bash|bash_persistent|sh|pwsh|pwsh_persistent|powershell|zsh|shell|cmd|str_replace_editor)$/i
const BUILD_DIR_SEGMENT_RE = /(?:^|\/)(?:dist|build|out|node_modules|\.pnpm-store|coverage|\.local)\//
const TOP_LIB_DIR_RE = /^lib\//
const BUILD_FILE_RE = /(?:(?:^|\/)\.DS_Store|\.tsbuildinfo|\.log)$/

function normalizePath(raw: string): { ok: true; path: string; isDir: boolean } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: '路径为空' }
  const slash = trimmed.replace(/\\/g, '/')
  if (slash.startsWith('/') || slash.startsWith('~') || /^[A-Za-z]:/.test(slash)) {
    return { ok: false, reason: `禁止绝对路径或主目录路径 "${raw}"` }
  }
  const isDir = slash.endsWith('/')
  const segs = slash.split('/').filter(s => s !== '' && s !== '.')
  if (segs.some(s => s === '..')) return { ok: false, reason: `禁止包含上级穿越 ".." 的路径 "${raw}"` }
  const norm = segs.join('/')
  if (norm === '') return { ok: false, reason: `路径规范化后为空 "${raw}"` }
  return { ok: true, path: norm, isDir }
}

function escapeGlob(pattern: string): string {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\0DSTARSLASH\0')
    .replace(/\*\*/g, '\0DOUBLE\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0DSTARSLASH\0/g, '(?:.*/)?')
    .replace(/\0DOUBLE\0/g, '.*')
  return `^${escaped}$`
}

export function isIgnoredBuildArtifact(normPath: string, extraGlobs?: readonly string[]): boolean {
  if (TOP_LIB_DIR_RE.test(normPath) || BUILD_DIR_SEGMENT_RE.test(normPath) || BUILD_FILE_RE.test(normPath)) return true
  for (const raw of extraGlobs ?? []) {
    const g = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (!g) continue
    if (g.endsWith('/') && (normPath.startsWith(g) || normPath.includes(`/${g}`))) return true
    if (new RegExp(escapeGlob(g)).test(normPath)) return true
  }
  return false
}

function matchesAllowed(observedPath: string, allowed: readonly { path: string; isDir: boolean }[]): boolean {
  for (const rule of allowed) {
    if (rule.path.includes('*') || rule.path.includes('?')) {
      if (new RegExp(escapeGlob(rule.path)).test(observedPath)) return true
      continue
    }
    if (rule.isDir) { if (observedPath.startsWith(`${rule.path}/`)) return true; continue }
    if (observedPath === rule.path || observedPath.startsWith(`${rule.path}/`)) return true
  }
  return false
}

function detectBlindTools(ctx: ChangedPathsCtx): string[] {
  const hits: string[] = []
  if (ctx.sawShellWrite) hits.push('shell-write')
  if (ctx.sawUnmeasuredTool) hits.push('str_replace_editor/unmeasured-tool')
  for (const t of ctx.unmeasuredTools ?? []) if (t.trim() !== '') hits.push(t.trim())
  for (const call of ctx.toolCalls ?? []) if (UNMEASURED_TOOL_RE.test(call.tool.trim())) hits.push(call.tool.trim())
  return [...new Set(hits)]
}

function evaluateDeclaredPathsMode(ctx: ChangedPathsCtx, p: ChangedPathsParams): Verdict {
  if (ctx.declaredPaths === null) return { kind: 'allow', produced: { skipped: 'not-applicable' } }
  const declaredNorms: string[] = []
  const illegal: string[] = []
  for (const raw of ctx.declaredPaths!) {
    const res = normalizePath(raw)
    if (!res.ok) illegal.push(res.reason)
    else if (res.isDir) illegal.push(`禁止尾斜杠目录声明 "${raw}"，请精确声明相对文件路径`)
    else declaredNorms.push(res.path)
  }
  if (illegal.length > 0) return { kind: 'deny', blockers: illegal as [string, ...string[]] }

  const sessionSurf = ctx.sessionDiffPaths !== undefined ? ctx.sessionDiffPaths : (ctx.sessionDiffs === undefined ? null : ctx.sessionDiffs)
  const gitSurf = ctx.gitDirtyPaths ?? null
  if (p.require_both_surfaces && (sessionSurf === null || gitSurf === null)) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: 'require_both_surfaces=true 但缺失一面观测数据' }
  }
  if (p.strict_untracked && ctx.untrackedPaths === null) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: 'strict_untracked=true 但 untrackedPaths 不可观测（null）' }
  }

  const observedList: string[] = []
  for (const raw of [...(sessionSurf ?? []), ...(gitSurf ?? []), ...(p.strict_untracked ? (ctx.untrackedPaths ?? []) : [])]) {
    const res = normalizePath(raw)
    observedList.push(res.ok ? res.path : raw.trim())
  }
  const uniqueObserved = [...new Set(observedList)]
  const unignoredObserved = uniqueObserved.filter(obs => !isIgnoredBuildArtifact(obs, ctx.ignoreBuildGlobs))

  if (declaredNorms.length === 0 && unignoredObserved.length > 0) {
    return { kind: 'deny', blockers: unignoredObserved.map(o => `声明为空但观测到未声明变更路径：${o}（修法：补充 declared_paths）`) as [string, ...string[]] }
  }
  if (sessionSurf === null && gitSurf === null) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: 'sessionDiffPaths 与 gitDirtyPaths 均不可观测' }
  }

  // 第 6 步伪造检查：在原始观测并集（不过滤忽略清单）中校验，防用构建产物目录洗白伪造路径。
  const rawSet = new Set(uniqueObserved)
  const surfaceSummary = `sessionDiffPaths(${sessionSurf ? sessionSurf.length : 'null'}), gitDirtyPaths(${gitSurf ? gitSurf.length : 'null'})`
  const blockers: string[] = []
  for (const decl of declaredNorms) {
    if (!rawSet.has(decl)) {
      blockers.push(`疑似伪造声明路径 "${decl}"：在 [${surfaceSummary}] 均未观测到（修法：仅申报实际改动的相对路径）`)
    }
  }
  if (blockers.length > 0) return { kind: 'deny', blockers: blockers as [string, ...string[]] }

  // 第 7 步漏报检查：剔除构建产物忽略清单后，禁止观测面存在未声明路径。
  const declaredSet = new Set(declaredNorms)
  for (const obs of unignoredObserved) {
    if (!declaredSet.has(obs)) blockers.push(`观测到未声明变更路径（漏报）：${obs}（修法：补充申报或清理无关改动）`)
  }
  if (blockers.length > 0) return { kind: 'deny', blockers: blockers as [string, ...string[]] }
  return { kind: 'allow', produced: { verifiedPaths: uniqueObserved.filter(o => declaredSet.has(o)).sort(), declaredPaths: declaredNorms } }
}

function evaluateAllowedPathsMode(ctx: ChangedPathsCtx, p: ChangedPathsParams): Verdict {
  const sessionSurf = ctx.sessionDiffs ?? ctx.sessionDiffPaths ?? null
  if (sessionSurf === null && ctx.gitDirtyPaths === null) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: 'sessionDiffs 与 gitDirtyPaths 均不可观测' }
  }
  if (p.require_both_surfaces && (sessionSurf === null || ctx.gitDirtyPaths === null)) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: 'require_both_surfaces=true 但缺失一面观测数据' }
  }
  if (p.strict_untracked && ctx.untrackedPaths === null) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: 'strict_untracked=true 但 untrackedPaths 不可观测（null）' }
  }
  const normalizedAllowed: { path: string; isDir: boolean }[] = []
  const illegalAllowed: string[] = []
  for (const raw of ctx.allowedPaths ?? []) {
    const res = normalizePath(raw)
    if (!res.ok) illegalAllowed.push(res.reason); else normalizedAllowed.push({ path: res.path, isDir: res.isDir })
  }
  if (illegalAllowed.length > 0) return { kind: 'deny', blockers: illegalAllowed as [string, ...string[]] }
  const verifiedSet = new Set<string>()
  const blockers: string[] = []
  for (const raw of [...(sessionSurf ?? []), ...(ctx.gitDirtyPaths ?? []), ...(p.strict_untracked ? (ctx.untrackedPaths ?? []) : [])]) {
    const res = normalizePath(raw)
    if (!res.ok) { blockers.push(`观测到非法变更路径：${res.reason}`); continue }
    if (!matchesAllowed(res.path, normalizedAllowed)) blockers.push(`越界写入未授权路径：${res.path}`)
    else verifiedSet.add(res.path)
  }
  if (blockers.length > 0) return { kind: 'deny', blockers: [...new Set(blockers)] as [string, ...string[]] }
  return { kind: 'allow', produced: { verifiedPaths: [...verifiedSet].sort(), allowedPaths: normalizedAllowed.map(a => a.path) } }
}

/** 防自报路径归属硬门：优先拦截 shell/不可测写工具盲区，并校验伪造与漏报路径。 */
export function evaluateChangedPaths(ctx: ChangedPathsCtx, boundParams?: Partial<ChangedPathsParams>): Verdict {
  const p: ChangedPathsParams = { ...DEFAULT_CHANGED_PATHS_PARAMS, ...ctx.params, ...boundParams }
  const blind = detectBlindTools(ctx)
  if (blind.length > 0) {
    return {
      kind: 'unmeasured', cause: 'shell-blind',
      detail: `会话存在无完整 diff 保障的潜在写工具（${blind.join(', ')}），请改用可观测的编辑工具重做`,
    }
  }
  if (ctx.taskKind !== undefined && ctx.taskKind !== 'implementation' && ctx.taskKind !== 'repair') {
    return { kind: 'allow', produced: { skipped: 'not-applicable', taskKind: ctx.taskKind } }
  }
  if (ctx.declaredPaths !== undefined && ctx.declaredPaths !== null) {
    const declVerdict = evaluateDeclaredPathsMode(ctx, p)
    if (declVerdict.kind !== 'allow' || ctx.allowedPaths === undefined) return declVerdict
    return evaluateAllowedPathsMode(ctx, p)
  }
  if (ctx.allowedPaths !== undefined) return evaluateAllowedPathsMode(ctx, p)
  if (ctx.declaredPaths === null) return { kind: 'allow', produced: { skipped: 'not-applicable' } }
  return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少 declaredPaths 或 allowedPaths 输入' }
}

export function createChangedPathsGate(boundParams?: Partial<ChangedPathsParams>): GateDef<'verify.changed-paths'> {
  return {
    kind: 'gate', id: 'verify.changed-paths', version: 1, point: 'verify.changed-paths',
    description: '核对声明变更路径与双面实际观测写入，拦截伪造/漏报与无 diff 的 shell 写盲区',
    side: 'hard', placement: { timing: 'pre', enforce: true }, requires: [],
    appliesTo: ctx => {
      if (detectBlindTools(ctx).length > 0) return true
      if (ctx.taskKind !== undefined && ctx.taskKind !== 'implementation' && ctx.taskKind !== 'repair') return false
      if (ctx.declaredPaths === null && ctx.allowedPaths === undefined) return false
      return true
    },
    gate: ctx => evaluateChangedPaths(ctx, boundParams),
  }
}

export const verifyChangedPathsGate: GateDef<'verify.changed-paths'> = createChangedPathsGate()
