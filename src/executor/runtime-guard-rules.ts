/** 执行护栏纯规则与 Token 计量：Smart-Auto 风险分类与缓存折算有效 Token 计算。 */
import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Ticket } from '../core/index.ts'
import type { ApprovalMode, Settings } from '../policy.ts'
import { ticketOfSession } from './dsh.ts'

export const SAFE_READ_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'todo_write', 'skill', 'list_agents', 'list_subagent_models', 'wait_agent',
  'job_list', 'job_output', 'orchestrator_read', 'orchestrator_report', 'orchestrator_ack', 'orchestrator_thread_follow',
  'orchestrator_thread_unrelated', 'orchestrator_trigger_handback', 'team_task_list', 'team_task_get',
])
export const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'bash_persistent', 'pwsh_persistent'])
export const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'fs_write', 'fs_edit', 'fs_delete'])

const GH_WRITE_RE = /\bgh\s+(?:(?:-R|--repo)(?:=|\s+)\S+\s+)*(?:(?:pr|issue|release)\s+(?:(?:-R|--repo)(?:=|\s+)\S+\s+)*(?:create|merge|close|reopen|comment|edit|review|delete|ready|lock|unlock|transfer|pin|unpin)|repo\s+(?:create|delete|archive|edit|rename|fork|sync)|api\b[^;&|\n]*(?:(?:-X|--method)(?:=|\s*)(?:POST|PUT|PATCH|DELETE)\b|(?:-f|-F|--field|--raw-field|--input)(?:=|\s|$)))/i

export const HARM_SHELL_PATTERNS: readonly [RegExp, string][] = [
  [/\bgit\s+push\b/i, '外部推送 git push'],
  [GH_WRITE_RE, 'GitHub 远端写操作'],
  [/\blark(?:-cli)?\b.*\b(?:send|reply|create|update|delete)\b/i, '飞书远端发送操作'],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r\b/i, '破坏性删除 rm -rf'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f)/i, '破坏性覆写工作树'],
  [/(?:^|[\s"'=/])\.env(?:\.[a-zA-Z0-9_-]+)?(?=$|[\s"'])/, '触碰敏感凭据文件 .env'],
  [/(?:~|\$HOME)\/\.dsh\b/, '触碰生产 ~/.dsh 目录'],
  [/\bcurl\b.*(?:-d\b|--data|-X\s*(?:POST|PUT|DELETE))/i, '外部网络写请求'],
  [/\bsudo\b/, '提权命令 sudo'],
]

const EXTERNAL_SIDE_EFFECT_RE = new RegExp(`(?:\\b(?:git\\s+push|lark(?:-cli)?\\s+.*(?:send|reply))\\b|${GH_WRITE_RE.source})`, 'i')
const PROTECTED_PATH_RE = /(?:^|\/)(?:\.git|\.github|\.env(?:\.[^/]+)?|.*(?:secret|credential|private[_-]?key).*|.*\.(?:pem|key))(?=$|\/)/i

const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))

function extractStringArg(args: unknown, keys: readonly string[]): string | undefined {
  if (!isRec(args)) return undefined
  for (const k of keys) if (typeof args[k] === 'string' && args[k].trim()) return args[k].trim()
  return undefined
}

/** 按 Smart-Auto 规则评估工具调用风险分值、是否需要人工审批及外部副作用标记。 */
export function classifySmartAutoRisk(
  toolName: string,
  args: unknown,
  worktreeDir: string,
): { rawScore: number; needsAsk: boolean; reason?: string; externalSideEffect?: string } {
  if (SAFE_READ_TOOLS.has(toolName)) return { rawScore: 0.05, needsAsk: false }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const rawPath = extractStringArg(args, ['file_path', 'path', 'filePath', 'target'])
    if (!rawPath) return { rawScore: 0.75, needsAsk: true, reason: `工具 ${toolName} 缺少可校验路径参数` }
    const rel = worktreeDir ? relative(resolve(worktreeDir), resolve(worktreeDir, rawPath)).replace(/\\/g, '/') : '..'
    if (!worktreeDir || rel.startsWith('..') || isAbsolute(rel)) {
      return { rawScore: 0.95, needsAsk: true, reason: `写入路径越出当前工单 Worktree: ${rawPath}` }
    }
    if (PROTECTED_PATH_RE.test(rel)) return { rawScore: 0.92, needsAsk: true, reason: `触碰受保护高危路径: ${rel}` }
    return { rawScore: 0.12, needsAsk: false }
  }
  if (SHELL_TOOLS.has(toolName)) {
    const cmd = extractStringArg(args, ['command', 'cmd', 'script']) ?? ''
    const normCmd = cmd.replace(/\\\r?\n/g, ' ')
    const sideEffect = EXTERNAL_SIDE_EFFECT_RE.exec(normCmd)?.[0]
    for (const [pattern, label] of HARM_SHELL_PATTERNS) {
      if (pattern.test(normCmd)) {
        return {
          rawScore: 0.9,
          needsAsk: true,
          reason: `命令命中高风险规则（${label}）: ${normCmd.slice(0, 120)}`,
          ...(sideEffect ? { externalSideEffect: sideEffect } : {}),
        }
      }
    }
    return { rawScore: 0.18, needsAsk: false, ...(sideEffect ? { externalSideEffect: sideEffect } : {}) }
  }
  return { rawScore: 0.2, needsAsk: false }
}

/** 计算单步模型用量的有效 Token 数（`cacheReadTokens` 按 0.1x 折算，避免重复缓存读虚高熔断）。 */
export function effectiveUsageTokens(u: {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): number {
  const cacheRead = Math.max(0, u.cacheReadTokens ?? 0)
  const nonCacheRead = u.totalTokens !== undefined
    ? Math.max(0, u.totalTokens - cacheRead)
    : Math.max(0, u.inputTokens) + Math.max(0, u.outputTokens) + Math.max(0, u.cacheWriteTokens ?? 0)
  return Math.ceil(nonCacheRead + cacheRead * 0.1)
}

/** 沿 `parentSession` 链向上解析会话所属根工单 ID。 */
export function resolveRootTicketId(ctx: Context, sessionOrId: Session | string): string | undefined {
  const startId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id
  const direct = ticketOfSession(startId)
  if (direct) return direct
  let parent = typeof sessionOrId === 'string'
    ? ctx.agents.get(sessionOrId as never)?.session?.header?.parentSession
    : sessionOrId.header?.parentSession
  for (let depth = 0; parent !== undefined && depth < 8; depth++) {
    const hit = ticketOfSession(parent)
    if (hit) return hit
    parent = ctx.agents.get(parent as never)?.session?.header?.parentSession
  }
  return undefined
}

/** 计算工单当前生效的审批档位（Worktree 覆盖优先于全局默认）。 */
export function effectiveApprovalMode(settings: Settings, ticket: Ticket): ApprovalMode {
  const wsId = ticket.execution?.workspace
  const ws = wsId ? (settings.workspaces ?? []).find(w => w.id === wsId) : undefined
  return ws?.approvalMode ?? settings.executor.approvalMode ?? 'smart-auto'
}
