/** 事件脊薄账本与 DSH 原生会话轨迹按指针关联的事实提取桥。 */
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { isoTime, type DomainEvent } from '../core/index.ts'
import type { EvidenceRef, SpineDraft, SpineEnvelope, StreamId } from '../spine/types.ts'
import type {
  CommandOutcome,
  DomainEventBridgeMeta,
  JoinedSessionMetricRow,
  SessionEventPtr,
  SessionTokenSummary,
} from './types.ts'

export type SessionEventsReader = (
  sessionId: string,
) => Promise<readonly SessionEvent[] | undefined> | readonly SessionEvent[] | undefined

const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'bash_persistent', 'pwsh_persistent'])
const MAX_REASON_CHARS = 200
const clip = (text?: string): string | undefined =>
  text === undefined ? undefined : text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS)}…`
const isRecord = (val: unknown): val is Record<string, unknown> =>
  Boolean(val && typeof val === 'object' && !Array.isArray(val))

function assertNever(value: never): never {
  throw new Error(`未处理的 DomainEvent 类型：${JSON.stringify(value)}`)
}

function projectDomainEvent(event: DomainEvent): { stream: StreamId; entityKey: string; payload: Record<string, unknown> } {
  switch (event.type) {
    case 'trigger.received':
      return { stream: `trigger:${event.data.triggerId}`, entityKey: event.data.triggerId, payload: { triggerId: event.data.triggerId, threads: [...event.data.threads] } }
    case 'eval.started':
      return { stream: `thread:${event.data.threadKey}`, entityKey: event.data.evalId, payload: { evalId: event.data.evalId, threadKey: event.data.threadKey, triggerIds: [...event.data.triggerIds], strength: event.data.strength } }
    case 'decision.recorded':
      return { stream: `thread:${event.data.threadKey}`, entityKey: event.data.decisionId, payload: { decisionId: event.data.decisionId, kind: event.data.kind, threadKey: event.data.threadKey } }
    case 'ticket.created':
      return { stream: `ticket:${event.data.ticketId}`, entityKey: event.data.ticketId, payload: { ticketId: event.data.ticketId, decisionId: event.data.decisionId, strength: event.data.strength } }
    case 'ticket.resumed':
      return { stream: `ticket:${event.data.ticketId}`, entityKey: `${event.data.ticketId}:${event.data.triggerId}`, payload: { ticketId: event.data.ticketId, triggerId: event.data.triggerId } }
    case 'ticket.ended': {
      const reason = clip(event.data.reason)
      return { stream: `ticket:${event.data.ticketId}`, entityKey: event.data.ticketId, payload: { ticketId: event.data.ticketId, by: event.data.by, outcome: event.data.outcome, ...(reason !== undefined ? { reason } : {}) } }
    }
    case 'assignment.started':
      return { stream: `ticket:${event.data.ticketId}`, entityKey: event.data.assignmentId, payload: { ticketId: event.data.ticketId, assignmentId: event.data.assignmentId } }
    case 'assignment.ended':
      return { stream: `ticket:${event.data.ticketId}`, entityKey: event.data.assignmentId, payload: { ticketId: event.data.ticketId, assignmentId: event.data.assignmentId, reason: clip(event.data.reason) } }
    case 'thread.subscribed':
      return { stream: `ticket:${event.data.ticketId}`, entityKey: `${event.data.ticketId}:${event.data.threadKey}`, payload: { threadKey: event.data.threadKey, ticketId: event.data.ticketId } }
    case 'thread.unsubscribed': {
      const reason = clip(event.data.reason)
      return { stream: `ticket:${event.data.ticketId}`, entityKey: `${event.data.ticketId}:${event.data.threadKey}`, payload: { threadKey: event.data.threadKey, ticketId: event.data.ticketId, by: event.data.by, ...(reason !== undefined ? { reason } : {}) } }
    }
    case 'trigger.requeued':
    case 'trigger.followup':
      return { stream: `trigger:${event.data.triggerId}`, entityKey: event.data.triggerId, payload: { triggerId: event.data.triggerId } }
    case 'policy.changed':
      return { stream: 'policy:global', entityKey: `${event.data.from}->${event.data.to}`, payload: { from: event.data.from, to: event.data.to } }
    default: return assertNever(event)
  }
}

/** 将 DomainEvent 转为只含状态迁移与指针引用的薄 SpineDraft，绝不复制聊天正文。 */
export function domainEventToSpineDraft(
  event: DomainEvent,
  meta: DomainEventBridgeMeta = {},
): SpineDraft<Record<string, unknown>> {
  const projected = projectDomainEvent(event)
  const at = isoTime(event.at)
  const rawRefs: EvidenceRef[] = []
  if (meta.sessionId) {
    const suffix = meta.sessionFromSeq !== undefined || meta.sessionToSeq !== undefined
      ? `#${meta.sessionFromSeq ?? ''}-${meta.sessionToSeq ?? ''}`
      : meta.sessionSeq !== undefined ? `#${meta.sessionSeq}` : ''
    rawRefs.push({ kind: 'event', ref: `session:${meta.sessionId}${suffix}` })
  }
  if (meta.commit) rawRefs.push({ kind: 'commit', ref: meta.commit })
  if (meta.evidence) rawRefs.push(...meta.evidence)
  const seen = new Set<string>()
  const evidence = rawRefs.filter(r => {
    const k = `${r.kind}|${r.ref}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return {
    id: meta.id ?? `dom:${event.type}:${projected.entityKey}:${at}`,
    at,
    stream: meta.stream ?? projected.stream,
    type: event.type,
    ...(meta.causationId !== undefined ? { causationId: meta.causationId } : {}),
    ...(meta.correlationId !== undefined ? { correlationId: meta.correlationId } : {}),
    source: meta.source ?? { kind: 'system', ref: 'core.engine' },
    evidence,
    taint: meta.taint ?? (event.type === 'trigger.received' ? 'derived' : 'trusted'),
    payload: { ...projected.payload, ...(meta.sessionId ? { sessionId: meta.sessionId } : {}), ...(meta.commit ? { commit: meta.commit } : {}) },
  }
}

/** 从事件脊信封的 evidence/payload 中解析原生会话与 commit 指针。 */
export function extractSessionPtr(envelope: Pick<SpineEnvelope, 'evidence' | 'payload'>): SessionEventPtr | undefined {
  let sessionId: string | undefined
  let seq: number | undefined
  let fromSeq: number | undefined
  let toSeq: number | undefined
  let commit: string | undefined
  for (const ref of envelope.evidence) {
    if (ref.kind === 'commit' && !commit) commit = ref.ref
    if (ref.kind === 'event' && ref.ref.startsWith('session:') && !sessionId) {
      const [idPart, seqPart] = ref.ref.slice('session:'.length).split('#', 2)
      if (idPart && idPart.trim() !== '') sessionId = idPart
      if (seqPart !== undefined) {
        const range = /^(\d*)-(\d*)$/.exec(seqPart)
        if (range && (range[1] !== '' || range[2] !== '')) {
          if (range[1]) fromSeq = Number(range[1])
          if (range[2]) toSeq = Number(range[2])
        } else if (/^\d+$/.test(seqPart)) {
          seq = Number(seqPart)
        }
      }
    }
  }
  if (isRecord(envelope.payload)) {
    if (!sessionId && typeof envelope.payload['sessionId'] === 'string' && envelope.payload['sessionId'].trim() !== '') sessionId = envelope.payload['sessionId']
    if (!commit && typeof envelope.payload['commit'] === 'string' && envelope.payload['commit'].trim() !== '') commit = envelope.payload['commit']
    if (seq === undefined && typeof envelope.payload['seq'] === 'number' && Number.isSafeInteger(envelope.payload['seq'])) seq = envelope.payload['seq']
    if (fromSeq === undefined && typeof envelope.payload['fromSeq'] === 'number' && Number.isSafeInteger(envelope.payload['fromSeq'])) fromSeq = envelope.payload['fromSeq']
    if (toSeq === undefined && typeof envelope.payload['toSeq'] === 'number' && Number.isSafeInteger(envelope.payload['toSeq'])) toSeq = envelope.payload['toSeq']
  }
  return sessionId
    ? { sessionId, ...(seq !== undefined ? { seq } : {}), ...(fromSeq !== undefined ? { fromSeq } : {}), ...(toSeq !== undefined ? { toSeq } : {}), ...(commit ? { commit } : {}) }
    : undefined
}

function parseShellOutcome(callId: string, tool: string, text: string, isError: boolean, meta: unknown): CommandOutcome | undefined {
  if (isRecord(meta) && typeof meta['exitCode'] === 'number' && Number.isFinite(meta['exitCode'])) return { callId, tool, exitCode: meta['exitCode'], isError }
  const sig = /\n?\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (sig?.[1] !== undefined) return { callId, tool, exitCode: undefined, signal: sig[1], isError }
  const exit = /\n?\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { callId, tool, exitCode: Number(exit[1]), isError }
  const pending = /^started background job |\[still running after \d+ms; moved to background job /.test(text)
  if (SHELL_TOOLS.has(tool) && !isError && !pending) return { callId, tool, exitCode: 0, isError: false }
  return isError ? { callId, tool, exitCode: undefined, isError: true } : undefined
}

function extractMetricsFromEvents(events: readonly SessionEvent[]) {
  const callNames = new Map<string, string>()
  const commandExitCodes: CommandOutcome[] = []
  let toolCallCount = 0, toolResultCount = 0, usageCount = 0
  let minTime = Number.POSITIVE_INFINITY, maxTime = Number.NEGATIVE_INFINITY, timeCount = 0
  let inputTokens = 0, outputTokens = 0, totalTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0
  for (const ev of events) {
    if (typeof ev.time === 'number' && Number.isFinite(ev.time)) {
      if (ev.time < minTime) minTime = ev.time
      if (ev.time > maxTime) maxTime = ev.time
      timeCount += 1
    }
    if (ev.type === 'tool/call') {
      toolCallCount += 1
      callNames.set(String(ev.data.callId), ev.data.name)
    } else if (ev.type === 'tool/result') {
      toolResultCount += 1
      const callId = String(ev.data.message.toolCallId ?? ev.data.message.source?.callId ?? '')
      const text = ev.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      const outcome = parseShellOutcome(callId, callNames.get(callId) ?? '', text, Boolean(ev.data.message.isError), ev.data.meta)
      if (outcome) commandExitCodes.push(outcome)
    } else if (ev.type === 'assistant/message' && ev.data.usage) {
      const u = ev.data.usage
      usageCount += 1; inputTokens += u.inputTokens; outputTokens += u.outputTokens
      cacheReadTokens += u.cacheReadTokens ?? 0; cacheWriteTokens += u.cacheWriteTokens ?? 0; reasoningTokens += u.reasoningTokens ?? 0
      totalTokens += u.totalTokens ?? (u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0))
    }
  }
  const durationMs = timeCount >= 2 ? Math.max(0, maxTime - minTime) : undefined
  const tokens: SessionTokenSummary | undefined = usageCount > 0 ? {
    inputTokens, outputTokens, totalTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}), ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}), ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  } : undefined
  const failedCommandCount = commandExitCodes.filter(c => c.isError || c.signal !== undefined || (c.exitCode !== undefined && c.exitCode !== 0)).length
  return {
    toolCalls: toolCallCount > 0 || toolResultCount === 0 ? toolCallCount : toolResultCount,
    commandExitCodes,
    failedCommandCount,
    durationMs,
    tokens,
    metricsState: tokens !== undefined && durationMs !== undefined ? 'measured' as const : 'partial' as const,
  }
}

const unmeasuredRow = (
  env: Pick<SpineEnvelope, 'seq' | 'id' | 'type' | 'stream' | 'causationId' | 'correlationId'>,
  ptr: SessionEventPtr | undefined,
  reason: string,
): JoinedSessionMetricRow => ({
  envelopeSeq: env.seq, envelopeId: env.id, eventType: env.type, stream: env.stream,
  ...(env.causationId !== undefined ? { causationId: env.causationId } : {}),
  ...(env.correlationId !== undefined ? { correlationId: env.correlationId } : {}),
  ...(ptr?.sessionId ? { sessionId: ptr.sessionId } : {}),
  ...(ptr?.commit ? { commit: ptr.commit } : {}),
  metricsState: 'unmeasured', unmeasuredReason: reason,
  toolCalls: undefined, commandExitCodes: [], failedCommandCount: undefined, durationMs: undefined, tokens: undefined,
})

/** 构造基于宿主 SessionPersistence.open 只读通道的会话事件读取器（缺失返回 undefined）。 */
export function createPersistenceSessionReader(
  persistence: Pick<SessionPersistence, 'flush' | 'open'>,
  signal?: AbortSignal,
): SessionEventsReader {
  return async (sessionId: string) => {
    try {
      await persistence.flush()
      await using handle = await persistence.open(SessionId(sessionId), 'read', { signal })
      const events: SessionEvent[] = []
      for (let offset = 0; ;) {
        const page = await handle.read(offset, 512, { signal })
        if (!page.events.length) break
        events.push(...page.events)
        offset += page.events.length
      }
      return events
    } catch { return undefined }
  }
}

/** 按事件脊指针关联原生 DSH 会话日志，提取真实运行指标；日志缺失时诚实标 unmeasured。 */
export async function joinNativeSessionMetrics(
  envelopes: readonly Pick<SpineEnvelope, 'seq' | 'id' | 'at' | 'stream' | 'type' | 'causationId' | 'correlationId' | 'evidence' | 'payload'>[],
  readSessionEvents: SessionEventsReader,
): Promise<JoinedSessionMetricRow[]> {
  const cache = new Map<string, Promise<readonly SessionEvent[] | undefined>>()
  const load = (id: string) => {
    let p = cache.get(id)
    if (!p) { p = Promise.resolve().then(() => readSessionEvents(id)).catch(() => undefined); cache.set(id, p) }
    return p
  }
  const rows: JoinedSessionMetricRow[] = []
  for (const env of envelopes) {
    const ptr = extractSessionPtr(env)
    if (!ptr) { rows.push(unmeasuredRow(env, undefined, 'no-session-pointer')); continue }
    const raw = await load(ptr.sessionId)
    if (!raw) { rows.push(unmeasuredRow(env, ptr, 'session-log-unavailable')); continue }
    const sliced = ptr.fromSeq !== undefined || ptr.toSeq !== undefined
      ? raw.filter(e => (ptr.fromSeq === undefined || Number(e.seq) >= ptr.fromSeq) && (ptr.toSeq === undefined || Number(e.seq) <= ptr.toSeq))
      : raw
    if (sliced.length === 0) { rows.push(unmeasuredRow(env, ptr, 'empty-session-slice')); continue }
    rows.push({
      envelopeSeq: env.seq, envelopeId: env.id, eventType: env.type, stream: env.stream,
      ...(env.causationId !== undefined ? { causationId: env.causationId } : {}),
      ...(env.correlationId !== undefined ? { correlationId: env.correlationId } : {}),
      sessionId: ptr.sessionId, ...(ptr.commit ? { commit: ptr.commit } : {}),
      ...extractMetricsFromEvents(sliced),
    })
  }
  return rows
}
