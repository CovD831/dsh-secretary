/** 工位现场终端卷宗只读投影：合并 DSH 持久会话事件与 M0 事件脊并全量脱敏，零落盘。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { readSpineProjection } from '../projection/index.ts'
import { unwrapToolCall, unwrapToolResult } from '../rsi/sop-miner.ts'
import { redactValue } from '../spine/redact.ts'
import type { Store } from './store.ts'

export type TranscriptEntryKind = 'assistant' | 'tool_call' | 'tool_result' | 'gate' | 'spine' | 'user'

export interface TranscriptEntry {
  id: string
  at: string
  kind: TranscriptEntryKind
  summary: string
  detail?: string
  status?: 'ok' | 'warn' | 'error'
  seq?: number
}

export interface TicketTranscriptView {
  ticketId: string
  sessionId: string
  entries: TranscriptEntry[]
  headSeq: number
  truncated: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))

function clipHead(text: string, max: number): string {
  const clean = text.trim()
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`
}

function clipTail(text: string, max = 400): string {
  const clean = text.trim()
  return clean.length <= max ? clean : `…${clean.slice(-max)}`
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (isRecord(b) && b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text'])
  }
  return parts.join('\n')
}

function isoFromTime(time: unknown): string {
  if (typeof time === 'number' && Number.isFinite(time)) return new Date(time).toISOString()
  if (typeof time === 'string' && time) return time
  return new Date(0).toISOString()
}

async function readSessionEvents(
  persistence: Pick<SessionPersistence, 'flush' | 'open'> | undefined,
  sessionId: string,
): Promise<SessionEvent[]> {
  if (!persistence) return []
  try { await persistence.flush() } catch { /* 会话可能尚未创建或刷盘失败，继续尝试只读打开 */ }
  try {
    await using handle = await persistence.open(sessionId as never, 'read')
    const events: SessionEvent[] = []
    for (let offset = 0; ;) {
      const page = await handle.read(offset, 512)
      if (!page.events.length) break
      events.push(...page.events)
      offset += page.events.length
    }
    return events
  } catch {
    return []
  }
}

function mapSessionEvents(events: readonly SessionEvent[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  const callNames = new Map<string, string>()
  for (const ev of events) {
    const at = isoFromTime(ev.time)
    const seq = typeof ev.seq === 'number' ? ev.seq : undefined
    if (ev.type === 'user/message') {
      const text = redactValue(extractText(ev.data?.content)).value
      if (!text) continue
      out.push({ id: `sess:${seq ?? out.length}:user`, at, kind: 'user', summary: clipHead(text, 160), detail: clipTail(text, 400), ...(seq !== undefined ? { seq } : {}) })
    } else if (ev.type === 'assistant/message') {
      const content = ev.data?.message?.content
      const text = redactValue(extractText(content)).value
      if (text) {
        out.push({ id: `sess:${seq ?? out.length}:assistant`, at, kind: 'assistant', summary: clipHead(text, 160), detail: clipTail(text, 400), ...(seq !== undefined ? { seq } : {}) })
      }
      if (Array.isArray(content)) {
        for (const [idx, block] of content.entries()) {
          if (isRecord(block) && block['type'] === 'toolCall' && typeof block['name'] === 'string') {
            if (typeof block['id'] === 'string') callNames.set(block['id'], block['name'])
            out.push({ id: `sess:${seq ?? out.length}:tc:${idx}`, at, kind: 'tool_call', summary: block['name'], ...(seq !== undefined ? { seq } : {}) })
          }
        }
      }
    } else if (ev.type === 'tool/call') {
      const call = unwrapToolCall(ev.data)
      if (call.callId) callNames.set(call.callId, call.name || 'tool')
      out.push({ id: `sess:${seq ?? out.length}:tc`, at, kind: 'tool_call', summary: call.name || 'tool', ...(seq !== undefined ? { seq } : {}) })
    } else if (ev.type === 'tool/result') {
      const res = unwrapToolResult(ev.data)
      const toolName = callNames.get(res.callId) ?? 'tool'
      const text = redactValue(res.text).value
      const tail = clipTail(text, 400)
      out.push({
        id: `sess:${seq ?? out.length}:tr`, at, kind: 'tool_result',
        summary: `${toolName}${res.isError ? ' (error)' : ''}`,
        ...(tail ? { detail: tail } : {}),
        status: res.isError ? 'error' : 'ok',
        ...(seq !== undefined ? { seq } : {}),
      })
    }
  }
  return out
}

function mapSpineEvents(items: Awaited<ReturnType<typeof readSpineProjection>>['items']): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  for (const ev of items) {
    const payload = redactValue(isRecord(ev.payload) ? ev.payload : {}).value
    const safeJson = JSON.stringify(payload)
    if (ev.type === 'gate.evaluated') {
      const point = typeof payload['point'] === 'string' ? payload['point'] : 'gate'
      const verdict = isRecord(payload['verdict']) && typeof payload['verdict']['kind'] === 'string' ? payload['verdict']['kind'] : 'unknown'
      const status = verdict === 'allow' ? 'ok' : verdict === 'deny' ? 'error' : 'warn'
      out.push({
        id: `spine:${ev.seq}`, at: ev.at, kind: 'gate', summary: `${point} -> ${verdict}`,
        detail: clipTail(safeJson, 400), status, seq: ev.seq,
      })
    } else {
      out.push({
        id: `spine:${ev.seq}`, at: ev.at, kind: 'spine', summary: ev.type,
        detail: clipTail(safeJson, 400), seq: ev.seq,
      })
    }
  }
  return out
}

/** 读取工单对应的只读终端转录视图（合并会话日志与 M0 事件脊，输出前全量脱敏）。 */
export async function readTicketTranscript(input: {
  ticketId: string
  store: Store
  stateDir: string
  persistence?: Pick<SessionPersistence, 'flush' | 'open'>
  limit?: number
}): Promise<TicketTranscriptView | undefined> {
  if (!input.store.tickets.get(input.ticketId)) return undefined
  const sessionId = `worker-${input.ticketId}`
  const maxEntries = Math.min(500, Math.max(1, Math.floor(input.limit ?? 200)))
  const [sessionEvents, spine] = await Promise.all([
    readSessionEvents(input.persistence, sessionId),
    readSpineProjection(input.store, input.stateDir, { ticketId: input.ticketId, limit: 200, tail: true }),
  ])
  const merged = [...mapSessionEvents(sessionEvents), ...mapSpineEvents(spine.items)]
  merged.sort((a, b) => {
    const dt = Date.parse(a.at) - Date.parse(b.at)
    if (dt !== 0 && Number.isFinite(dt)) return dt
    return (a.seq ?? 0) - (b.seq ?? 0)
  })
  const truncated = merged.length > maxEntries
  const sliced = truncated ? merged.slice(-maxEntries) : merged
  const entries = sliced.map(entry => redactValue(entry).value)
  return { ticketId: input.ticketId, sessionId, entries, headSeq: spine.headSeq, truncated }
}
