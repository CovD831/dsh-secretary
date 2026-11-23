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
  readonly allowedPaths: readonly string[]
  readonly sessionDiffs: readonly string[] | null
  readonly gitDirtyPaths: readonly string[] | null
  readonly untrackedPaths?: readonly string[] | null
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

const UNMEASURED_TOOL_RE = /^(?:bash|bash_persistent|sh|pwsh|pwsh_persistent|powershell|zsh|shell|cmd|str_replace_editor)$/i

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
    .replace(/\*\*/g, '\0DOUBLE\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0DOUBLE\0/g, '.*')
  return `^${escaped}$`
}

function matchesAllowed(observedPath: string, allowed: readonly { path: string; isDir: boolean }[]): boolean {
  for (const rule of allowed) {
    if (rule.path.includes('*') || rule.path.includes('?')) {
      if (new RegExp(escapeGlob(rule.path)).test(observedPath)) return true
      continue
    }
    if (rule.isDir) {
      if (observedPath.startsWith(`${rule.path}/`)) return true
      continue
    }
    if (observedPath === rule.path) return true
    if (observedPath.startsWith(`${rule.path}/`)) return true
  }
  return false
}

function detectBlindTools(ctx: ChangedPathsCtx): string[] {
  const hits: string[] = []
  if (ctx.sawShellWrite) hits.push('shell-write')
  if (ctx.sawUnmeasuredTool) hits.push('str_replace_editor/unmeasured-tool')
  for (const t of ctx.unmeasuredTools ?? []) {
    if (t.trim() !== '') hits.push(t.trim())
  }
  for (const call of ctx.toolCalls ?? []) {
    if (UNMEASURED_TOOL_RE.test(call.tool.trim())) {
      hits.push(call.tool.trim())
    }
  }
  return [...new Set(hits)]
}

/** 防自报路径归属硬门：对齐声明范围与双面实际观测写入，严禁对 shell 盲区放行。 */
export function evaluateChangedPaths(
  ctx: ChangedPathsCtx,
  boundParams?: Partial<ChangedPathsParams>,
): Verdict {
  const p: ChangedPathsParams = { ...DEFAULT_CHANGED_PATHS_PARAMS, ...ctx.params, ...boundParams }
  const blind = detectBlindTools(ctx)
  if (blind.length > 0) {
    return {
      kind: 'unmeasured',
      cause: 'shell-blind',
      detail: `会话存在无完整 diff 保障的潜在写工具（${blind.join(', ')}），无法确定性归因变更路径`,
    }
  }

  if (ctx.sessionDiffs === null && ctx.gitDirtyPaths === null) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: 'sessionDiffs 与 gitDirtyPaths 均不可观测' }
  }
  if (p.require_both_surfaces && (ctx.sessionDiffs === null || ctx.gitDirtyPaths === null)) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: 'require_both_surfaces=true 但缺失一面观测数据' }
  }
  if (p.strict_untracked && ctx.untrackedPaths === null) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: 'strict_untracked=true 但 untrackedPaths 不可观测（null）' }
  }

  const normalizedAllowed: { path: string; isDir: boolean }[] = []
  const illegalAllowed: string[] = []
  for (const raw of ctx.allowedPaths) {
    const res = normalizePath(raw)
    if (!res.ok) illegalAllowed.push(res.reason)
    else normalizedAllowed.push({ path: res.path, isDir: res.isDir })
  }
  if (illegalAllowed.length > 0) return { kind: 'deny', blockers: illegalAllowed as [string, ...string[]] }

  const rawObserved = [
    ...(ctx.sessionDiffs ?? []),
    ...(ctx.gitDirtyPaths ?? []),
    ...(p.strict_untracked ? (ctx.untrackedPaths ?? []) : []),
  ]
  const verifiedSet = new Set<string>()
  const blockers: string[] = []
  for (const raw of rawObserved) {
    const res = normalizePath(raw)
    if (!res.ok) { blockers.push(`观测到非法变更路径：${res.reason}`); continue }
    if (!matchesAllowed(res.path, normalizedAllowed)) {
      blockers.push(`越界写入未授权路径：${res.path}`)
    } else {
      verifiedSet.add(res.path)
    }
  }
  if (blockers.length > 0) return { kind: 'deny', blockers: [...new Set(blockers)] as [string, ...string[]] }
  return {
    kind: 'allow',
    produced: { verifiedPaths: [...verifiedSet].sort(), allowedPaths: normalizedAllowed.map(a => a.path) },
  }
}

export function createChangedPathsGate(boundParams?: Partial<ChangedPathsParams>): GateDef<'verify.changed-paths'> {
  return {
    kind: 'gate',
    id: 'verify.changed-paths',
    version: 1,
    point: 'verify.changed-paths',
    description: '核对允许路径范围与实际观测写入集，并拦截无 diff 的 shell 写盲区',
    side: 'hard',
    placement: { timing: 'pre', enforce: true },
    requires: ['allowedPaths', 'sessionDiffs', 'gitDirtyPaths'],
    gate: ctx => evaluateChangedPaths(ctx, boundParams),
  }
}

export const verifyChangedPathsGate: GateDef<'verify.changed-paths'> = createChangedPathsGate()
