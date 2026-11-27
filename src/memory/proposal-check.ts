/** 记忆提案校验、Git 隔离环境变量与条目实体构建辅助（供 MemoryWriter 单写者服务复用）。 */
import { isoTime } from '../core/model.ts'
import { redactValue } from '../spine/redact.ts'
import type { SourceRef } from '../spine/types.ts'
import { resolveMemoryRelPath } from './codec.ts'
import type { MemoryEntry, MemoryProposal, WriteRejectReason, WriteResult } from './types.ts'

const ISOLATED_ENV_KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL',
] as const

export const validSourceRef = (ref?: SourceRef): ref is SourceRef =>
  Boolean(ref && Number.isSafeInteger(ref.seq) && ref.seq > 0 && typeof ref.id === 'string' && ref.id.trim())

export const hasSecretShape = (vals: readonly (string | undefined)[]): boolean =>
  vals.some(v => v !== undefined && redactValue(v).redacted.length > 0)

export const makeWriteReject = (
  reason: WriteRejectReason,
  detail: string,
  extra?: Partial<Extract<WriteResult, { kind: 'rejected' }>>,
): WriteResult => ({ kind: 'rejected', reason, detail, ...extra })

/** 构造隔离的 Git 子进程环境，阻断宿主全局/系统 gitconfig 与环境变量污染记忆仓提交。 */
export function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1' }
  for (const key of ISOLATED_ENV_KEYS) delete env[key]
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return env
}

/** 静态校验 MemoryProposal：拦 caller-id、ChangeLog 篡改、秘密形状、作用域错配与 M4 晋升门槛。 */
export function validateMemoryProposal(p: MemoryProposal): { error: WriteResult } | { targetRel: string } {
  if ('id' in p && (p as { id?: unknown }).id !== undefined) return { error: makeWriteReject('caller-id-forbidden', '记忆 id 必须由宿主分配') }
  if ('changeLog' in p && (p as { changeLog?: unknown }).changeLog !== undefined) return { error: makeWriteReject('invalid-input', '禁止篡改 Change Log') }
  if (hasSecretShape([p.statement, p.verbatimQuote, p.evidenceText, p.invalidationReason, p.topicKey, p.scope, p.author, p.sourceRef?.id,
    ...(p.workspacesSeen ?? []), ...(p.triggerKeys?.primary ?? []), ...(p.triggerKeys?.secondary ?? [])])) {
    return { error: makeWriteReject('secret-detected', '检测到秘密或凭据形状，已触发拒写门') }
  }
  if (!validSourceRef(p.sourceRef)) return { error: makeWriteReject('missing-source-ref', '缺少有效的 M0 sourceRef (seq > 0 且 id 非空)') }
  if (!p.statement.trim() || !p.author.trim()) return { error: makeWriteReject('invalid-input', 'statement 与 author 不能为空') }
  if (p.expectedRevision !== undefined && (!Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 0)) return { error: makeWriteReject('invalid-input', 'expectedRevision 必须为非负整数') }
  if (p.importance !== undefined && (!Number.isFinite(p.importance) || p.importance < 0 || p.importance > 10)) return { error: makeWriteReject('invalid-input', 'importance 须在 0–10 间') }
  if ([p.observedAt, p.validFrom, p.lastAccessedAt].some(ts => ts !== undefined && !Number.isFinite(Date.parse(ts)))) return { error: makeWriteReject('invalid-input', '时间戳格式非法') }
  const validScope = p.scope === 'global' || /^workspace:[^\s]+$/.test(p.scope) || /^person:[^\s]+$/.test(p.scope)
  if (!validScope || (p.layer === 'm4' && p.scope !== 'global') || (p.layer === 'm2' && p.scope.startsWith('workspace:'))) {
    return { error: makeWriteReject('scope-mismatch', `层级 ${p.layer} 不允许作用域 "${p.scope}"`) }
  }
  if (p.layer === 'm2' && (p.taint === 'external_untrusted' || p.sourceType === 'external_doc')) {
    return { error: makeWriteReject('untrusted-m2-forbidden', '禁止不可信外部来源 (external_untrusted/external_doc) 写入 M2 偏好层') }
  }
  if (p.layer === 'm3' && (!p.scope.startsWith('workspace:') || (p.workspaceKey && p.workspaceKey !== p.scope.slice(10)))) {
    return { error: makeWriteReject('scope-mismatch', `M3 作用域与 workspaceKey 不匹配: "${p.scope}"`) }
  }
  if (p.layer === 'm4') {
    const uniq = new Set((p.workspacesSeen ?? []).map(s => s.trim()).filter(Boolean))
    if ((uniq.size < 2 || (p.seenCount ?? 0) < 2) && p.sourceType !== 'user_ruling') {
      return { error: makeWriteReject('m4-threshold-not-met', '写 M4 须满足 workspacesSeen 去重 >= 2 且 seenCount >= 2，或显式 user_ruling') }
    }
  }
  try { return { targetRel: resolveMemoryRelPath({ layer: p.layer, slug: p.slug, workspaceKey: p.layer === 'm3' ? (p.workspaceKey ?? p.scope.slice(10)) : undefined }) } }
  catch (err) { return { error: makeWriteReject('invalid-input', err instanceof Error ? err.message : String(err)) } }
}

/** 根据已校验提案构造完整落盘 MemoryEntry（宿主分配 ID、双时态与默认密级）。 */
export function buildMemoryEntry(p: MemoryProposal, id: string, nowIso: string, isInf: boolean, isUserAuth: boolean, supersedes?: string): MemoryEntry {
  return {
    id, statement: p.statement.trim(), scope: p.scope, sourceType: p.sourceType, sourceRef: p.sourceRef,
    observedAt: isoTime(p.observedAt ?? nowIso), validFrom: isoTime(p.validFrom ?? nowIso),
    confidence: isInf ? 'inferred' : (p.confidence ?? (isUserAuth ? 'stated' : 'corroborated')), author: p.author.trim(),
    taint: p.taint ?? (p.sourceType === 'external_doc' ? 'external_untrusted' : 'clean'),
    clearance: p.clearance ?? (p.layer === 'm2' ? 'private' : p.layer === 'm3' ? 'workspace' : 'public'),
    ...(supersedes ? { supersedes } : {}), ...(p.topicKey?.trim() ? { topicKey: p.topicKey.trim() } : {}),
    ...(p.verbatimQuote ? { verbatimQuote: p.verbatimQuote.trim() } : {}), ...(p.workspacesSeen ? { workspacesSeen: [...p.workspacesSeen] } : {}),
    ...(p.seenCount !== undefined ? { seenCount: p.seenCount } : {}), ...(p.importance !== undefined ? { importance: p.importance } : {}),
    ...(p.lastAccessedAt ? { lastAccessedAt: isoTime(p.lastAccessedAt) } : {}), ...(p.triggerKeys ? { triggerKeys: p.triggerKeys } : {}),
    ...(p.m2Kind ? { m2Kind: p.m2Kind } : {}), ...(p.resident !== undefined ? { resident: p.resident } : {}),
  }
}
