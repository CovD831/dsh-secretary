/** 持久化会话原始窗口读取器（剥离记忆自注入、越过 compaction 遮蔽读取原文）与确定性 Epoch 状态锚点。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { redactValue } from '../spine/redact.ts'

export interface SessionDialogLine {
  readonly seq: number
  readonly at: string
  readonly role: 'boss' | 'user' | 'assistant'
  readonly text: string
  readonly taint: 'trusted' | 'untrusted'
  readonly triggerId?: string
}

export interface SessionWindowSlice {
  readonly sessionId: string
  readonly fromSeq: number
  readonly throughSeq: number
  readonly lines: readonly SessionDialogLine[]
  readonly totalChars: number
  readonly hasMore: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))

const SELF_INJECT_PREFIXES = [
  '[Memory notes',
  '[Memory delta',
  '[Epoch state anchor',
  '[dsh-superagent prompt revision',
]

export function extractSessionText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (isRecord(b) && b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text'])
  }
  return parts.join('\n')
}

/** 识别系统注入的 recall/snapshot/notice 或记忆块回声，严禁再次喂给做梦提取防止自我放大循环。 */
export function isInjectedSystemContext(ev: SessionEvent, text: string): boolean {
  const trimmed = text.trim()
  if (SELF_INJECT_PREFIXES.some(prefix => trimmed.startsWith(prefix))) return true
  if (ev.type === 'user/message') {
    const src = ev.data?.source as { kind?: unknown; form?: unknown } | undefined
    if (src?.kind === 'system-prompt') return true
    if (src?.form === 'recall' || src?.form === 'snapshot' || src?.form === 'notice') return true
  }
  return false
}

function isoTime(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw).toISOString()
  if (typeof raw === 'string' && raw) return raw
  return new Date(0).toISOString()
}

/** 从 SessionPersistence 读取 `seq > afterSeq` 的真实用户/助手对话（含已 compaction 遮蔽旧轮次）。 */
export async function readUnextractedSessionWindow(
  persistence: Pick<SessionPersistence, 'flush' | 'open'> | undefined,
  sessionId: string,
  options: {
    readonly afterSeq: number
    readonly maxChars?: number
    readonly classifyTrigger?: (text: string) => { taint: 'trusted' | 'untrusted'; triggerId?: string; isBoss?: boolean }
  },
): Promise<SessionWindowSlice> {
  const maxChars = Math.max(500, options.maxChars ?? 12_000)
  const empty: SessionWindowSlice = { sessionId, fromSeq: options.afterSeq, throughSeq: options.afterSeq, lines: [], totalChars: 0, hasMore: false }
  if (!persistence) return empty
  try { await persistence.flush() } catch { /* 会话尚未持久化时返回空窗口 */ }

  const events: SessionEvent[] = []
  try {
    await using handle = await persistence.open(sessionId as never, 'read')
    for (let offset = 0; ;) {
      const page = await handle.read(offset, 512)
      if (!page.events.length) break
      for (const ev of page.events) {
        if (typeof ev.seq === 'number' && ev.seq > options.afterSeq) events.push(ev)
      }
      offset += page.events.length
    }
  } catch {
    return empty
  }

  const lines: SessionDialogLine[] = []
  let fromSeq = options.afterSeq
  let throughSeq = options.afterSeq
  let totalChars = 0
  let hasMore = false

  for (const ev of events) {
    const seq = typeof ev.seq === 'number' ? ev.seq : throughSeq
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') {
      throughSeq = Math.max(throughSeq, seq)
      continue
    }
    if (ev.type === 'assistant/message' && ev.data?.interrupted === true) {
      throughSeq = Math.max(throughSeq, seq)
      continue
    }
    const raw = ev.type === 'user/message' ? extractSessionText(ev.data?.content) : extractSessionText(ev.data?.message?.content)
    if (!raw.trim() || isInjectedSystemContext(ev, raw)) {
      throughSeq = Math.max(throughSeq, seq)
      continue
    }
    const safe = redactValue(raw).value.trim()
    if (!safe) {
      throughSeq = Math.max(throughSeq, seq)
      continue
    }
    if (lines.length > 0 && totalChars + safe.length > maxChars) {
      hasMore = true
      break
    }
    let role: SessionDialogLine['role'] = ev.type === 'assistant/message' ? 'assistant' : 'user'
    let taint: 'trusted' | 'untrusted' = 'trusted'
    let triggerId: string | undefined
    if (ev.type === 'user/message') {
      const src = ev.data?.source as { kind?: unknown; form?: unknown } | undefined
      if (src?.kind === 'dsh-superagent' && options.classifyTrigger) {
        const cls = options.classifyTrigger(safe)
        taint = cls.taint
        triggerId = cls.triggerId
        if (cls.isBoss) role = 'boss'
      } else if (src?.kind === 'dsh-superagent') {
        const looksExternal = /\[(?:Feishu|GitHub|external|relay)/i.test(safe)
        taint = looksExternal ? 'untrusted' : 'trusted'
      }
    }
    if (lines.length === 0) fromSeq = seq
    throughSeq = Math.max(throughSeq, seq)
    lines.push({ seq, at: isoTime(ev.time), role, text: safe, taint, ...(triggerId ? { triggerId } : {}) })
    totalChars += safe.length
  }

  return { sessionId, fromSeq, throughSeq, lines, totalChars, hasMore }
}

/** Compaction 后确定性重建 Epoch 运行态实时锚点（零 LLM、受硬字符预算约束）。 */
export function renderEpochStateAnchor(input: {
  readonly openTickets: readonly { readonly id: string; readonly title: string; readonly stage: string; readonly workspace?: string }[]
  readonly pendingRulings: readonly { readonly id: string; readonly question: string; readonly kind: string }[]
  readonly workspaces: readonly { readonly id: string; readonly baseBranch?: string }[]
  readonly maxChars?: number
}): string {
  const maxChars = Math.max(200, input.maxChars ?? 1200)
  const parts: string[] = ['[Epoch state anchor — live runtime facts, authoritative over older summaries]']
  parts.push(
    input.workspaces.length > 0
      ? `Workspaces: ${input.workspaces.map(w => w.baseBranch ? `${w.id}(${w.baseBranch})` : w.id).join(', ')}`
      : 'Workspaces: none',
  )
  if (input.openTickets.length > 0) {
    parts.push('Open tickets:')
    for (const tk of input.openTickets.slice(0, 8)) {
      parts.push(`- ${tk.id} [${tk.stage}${tk.workspace ? `@${tk.workspace}` : ''}]: ${tk.title.slice(0, 80)}`)
    }
  } else {
    parts.push('Open tickets: none')
  }
  if (input.pendingRulings.length > 0) {
    parts.push('Pending rulings:')
    for (const r of input.pendingRulings.slice(0, 5)) {
      parts.push(`- ${r.id} (${r.kind}): ${r.question.slice(0, 90)}`)
    }
  } else {
    parts.push('Pending rulings: none')
  }
  const full = parts.join('\n')
  return full.length <= maxChars ? full : `${full.slice(0, maxChars - 1)}…`
}
