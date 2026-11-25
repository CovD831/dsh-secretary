/** B1–B5 零 LLM 确定性小人状态算子：例程映射表、偏差优先、查表 Barks 与账本编译日程。 */
import type { AttentionKind } from '../memory/types.ts'
import type { SourceRef } from '../spine/types.ts'
import type {
  AttentionRefItem, AvatarBark, AvatarDeviation, AvatarPosture, AvatarProjectionState,
  AvatarShift, AvatarStateInput, AvatarZone, BarkCode, M2MonikerRef, ScheduleItem, SpineEventRef, TicketStateRef,
} from './types.ts'

interface BarkContext {
  readonly deviation?: AvatarDeviation
  readonly workingCount?: number
  readonly moniker?: string
  readonly eventType?: string
  readonly seq: number
}
type BarkTemplate = (ctx: BarkContext) => { readonly textZh: string; readonly textEn: string }

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)
const isRecord = (val: unknown): val is Record<string, unknown> => Boolean(val && typeof val === 'object' && !Array.isArray(val))

export const BARK_TEMPLATES: Readonly<Record<BarkCode, BarkTemplate>> = {
  BARK_DEVIATION_FAILED: ({ deviation, seq }) => ({ textZh: `工单 ${deviation?.ticketId ?? ''} 执行失败，已定位到事件 #${seq}`.trim(), textEn: `Ticket ${deviation?.ticketId ?? ''} failed (event #${seq})`.trim() }),
  BARK_DEVIATION_BLOCKED: ({ deviation, seq }) => ({ textZh: `工单 ${deviation?.ticketId ?? ''} 受阻待处理 (#${seq})`.trim(), textEn: `Ticket ${deviation?.ticketId ?? ''} blocked (#${seq})`.trim() }),
  BARK_M6_CONFLICT: ({ seq }) => ({ textZh: `M6 账本有记忆冲突待裁决 (#${seq})`, textEn: `M6 memory conflict awaits ruling (#${seq})` }),
  BARK_M6_RULING: ({ seq }) => ({ textZh: `M6 账本有待裁决事项 (#${seq})`, textEn: `M6 ruling awaits decision (#${seq})` }),
  BARK_M6_VERIFICATION: ({ seq }) => ({ textZh: `M6 账本有巩固提议待核实 (#${seq})`, textEn: `M6 consolidation item awaits verification (#${seq})` }),
  BARK_PERSON_WAITING: ({ deviation, seq }) => ({ textZh: `工单 ${deviation?.ticketId ?? ''} 等待人工确认 (#${seq})`.trim(), textEn: `Ticket ${deviation?.ticketId ?? ''} awaits person (#${seq})`.trim() }),
  BARK_MORNING_BRIEFING: ({ seq }) => ({ textZh: `晨间汇总就绪，最新记录 #${seq}`, textEn: `Morning briefing ready (latest #${seq})` }),
  BARK_NIGHT_WATCH: ({ seq }) => ({ textZh: `夜间值班中，最近事件 #${seq}`, textEn: `Night watch active (latest #${seq})` }),
  BARK_M2_MONIKER: ({ moniker, seq }) => ({ textZh: `按约定「${clip(moniker ?? '', 28)}」推进中 (#${seq})`, textEn: `Following convention "${clip(moniker ?? '', 28)}" (#${seq})` }),
  BARK_WORKING_TICKET: ({ workingCount, seq }) => ({ textZh: `正在处理 ${workingCount ?? 1} 项在途任务 (#${seq})`, textEn: `Working on ${workingCount ?? 1} active ticket(s) (#${seq})` }),
  BARK_RECENT_SPINE_EVENT: ({ eventType, seq }) => ({ textZh: `已记录事件 ${eventType ?? ''} (#${seq})`.trim(), textEn: `Recorded ${eventType ?? 'event'} (#${seq})`.trim() }),
}

export function isValidSourceRef(ref?: SourceRef | null): ref is SourceRef {
  return Boolean(ref && Number.isSafeInteger(ref.seq) && ref.seq > 0 && typeof ref.id === 'string' && ref.id.trim().length > 0)
}

function resolveHourMinute(now: Date, offsetMinutes?: number, timeZone?: string): { hour: number; minute: number } {
  if (offsetMinutes !== undefined && Number.isFinite(offsetMinutes)) {
    const shifted = new Date(now.getTime() + offsetMinutes * 60_000)
    return { hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() }
  }
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(now)
      const h = Number(parts.find(p => p.type === 'hour')?.value ?? NaN)
      const m = Number(parts.find(p => p.type === 'minute')?.value ?? NaN)
      if (Number.isFinite(h) && Number.isFinite(m)) return { hour: h % 24, minute: m }
    } catch { /* 无效时区回退本地时钟 */ }
  }
  return { hour: now.getHours(), minute: now.getMinutes() }
}

export function resolveShift(now: Date, offsetMinutes?: number, timeZone?: string): AvatarShift {
  const { hour, minute } = resolveHourMinute(now, offsetMinutes, timeZone)
  if (hour >= 23 || hour < 7) return 'night'
  const mins = hour * 60 + minute
  return mins >= 420 && mins < 570 ? 'morning' : 'day'
}

function findTicketRef(ticket: TicketStateRef, events: readonly SpineEventRef[]): SourceRef | null {
  if (isValidSourceRef(ticket.sourceRef)) return ticket.sourceRef
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!
    const ref = { seq: ev.seq, id: ev.id }
    if (!isValidSourceRef(ref)) continue
    if (ev.stream === `ticket:${ticket.id}` || (isRecord(ev.payload) && ev.payload['ticketId'] === ticket.id)) return ref
  }
  return null
}

function findAttentionMatch(kind: AttentionKind, items: readonly AttentionRefItem[]) {
  const item = items.find(i => (i.status === 'pending' || i.status === 'asked') && i.kind === kind)
  if (!item) return null
  return { attentionId: item.id, sourceRef: item.sourceRefs.find(isValidSourceRef) ?? null, question: item.question }
}

function resolveDeviation(input: AvatarStateInput): AvatarDeviation | null {
  const events = input.recentSpineEvents ?? [], items = input.attentionItems ?? []
  const byTicket = (t: TicketStateRef, kind: 'ticket_failed' | 'ticket_blocked' | 'person_waiting', priority: AvatarDeviation['priority']): AvatarDeviation =>
    ({ kind, priority, ticketId: t.id, sourceRef: findTicketRef(t, events), summary: t.title || t.id })
  if (input.failedTickets.length) return byTicket(input.failedTickets[0]!, 'ticket_failed', 'critical')
  if (input.blockedTickets.length) return byTicket(input.blockedTickets[0]!, 'ticket_blocked', 'high')
  const m6Checks: readonly [number, AttentionKind, AvatarDeviation['kind'], AvatarDeviation['priority'], string][] = [
    [input.pendingConflicts, 'conflict', 'm6_conflict', 'high', 'conflict(s)'],
    [input.pendingRulings, 'ruling', 'm6_ruling', 'medium', 'ruling(s)'],
    [input.pendingVerifications, 'verification', 'm6_verification', 'medium', 'verification(s)'],
  ]
  for (const [count, attKind, devKind, priority, unit] of m6Checks) {
    if (count <= 0) continue
    const m = findAttentionMatch(attKind, items)
    return { kind: devKind, priority, ...(m ? { attentionId: m.attentionId } : {}), sourceRef: m?.sourceRef ?? null, summary: m?.question ?? `${count} ${unit}` }
  }
  if (input.personWaitingTickets.length) return byTicket(input.personWaitingTickets[0]!, 'person_waiting', 'medium')
  return null
}

function resolvePosture(input: AvatarStateInput, shift: AvatarShift): { posture: AvatarPosture; zone: AvatarZone } {
  if (input.paused) return { posture: 'paused_standby', zone: 'lounge' }
  if (input.failedTickets.length || input.blockedTickets.length || input.pendingConflicts > 0) return { posture: 'alert_fault', zone: 'secretary_counter' }
  if (input.pendingRulings > 0 || input.pendingVerifications > 0 || input.personWaitingTickets.length) return { posture: 'raising_hand', zone: 'secretary_counter' }
  if (input.workingCount > 0) return { posture: 'working_desk', zone: 'desk' }
  if (shift === 'morning') return { posture: 'morning_briefing', zone: 'board' }
  if (shift === 'night') return { posture: 'night_watch', zone: 'lounge' }
  return { posture: 'patrol_idle', zone: 'board' }
}

function makeBark(code: BarkCode, sourceRef: SourceRef, ctx: Omit<BarkContext, 'seq'>): AvatarBark {
  return { code, ...BARK_TEMPLATES[code]({ ...ctx, seq: sourceRef.seq }), sourceRef }
}

function latestValidEvent(events: readonly SpineEventRef[]): SpineEventRef | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!
    if (isValidSourceRef({ seq: ev.seq, id: ev.id })) return ev
  }
  return undefined
}

const DEVIATION_BARK: Readonly<Record<AvatarDeviation['kind'], BarkCode>> = {
  ticket_failed: 'BARK_DEVIATION_FAILED',
  ticket_blocked: 'BARK_DEVIATION_BLOCKED',
  m6_conflict: 'BARK_M6_CONFLICT',
  m6_ruling: 'BARK_M6_RULING',
  m6_verification: 'BARK_M6_VERIFICATION',
  person_waiting: 'BARK_PERSON_WAITING',
}

function lookupBark(input: AvatarStateInput, posture: AvatarPosture, deviation: AvatarDeviation | null): AvatarBark | null {
  if (deviation) return isValidSourceRef(deviation.sourceRef) ? makeBark(DEVIATION_BARK[deviation.kind], deviation.sourceRef, { deviation }) : null
  if (posture === 'paused_standby') return null
  const latestEv = latestValidEvent(input.recentSpineEvents ?? [])
  const latestRef = latestEv ? { seq: latestEv.seq, id: latestEv.id } : undefined
  if (posture === 'morning_briefing') {
    const ref = latestRef ?? (input.attentionItems ?? []).flatMap(i => i.sourceRefs).find(isValidSourceRef)
    return ref ? makeBark('BARK_MORNING_BRIEFING', ref, {}) : null
  }
  if (posture === 'night_watch') return latestRef ? makeBark('BARK_NIGHT_WATCH', latestRef, {}) : null
  const nowMs = input.now.getTime()
  const moniker = posture === 'working_desk'
    ? (input.m2Monikers ?? []).find(m =>
      m.m2Kind === 'internal_moniker'
      && m.statement.trim().length > 0
      && !m.invalidatedBy
      && (!m.validFrom || Date.parse(m.validFrom) <= nowMs)
      && (!m.validTo || Date.parse(m.validTo) > nowMs)
      && isValidSourceRef(m.sourceRef))
    : undefined
  if (moniker) return makeBark('BARK_M2_MONIKER', moniker.sourceRef, { moniker: moniker.statement.trim() })
  if (posture === 'working_desk' && latestRef) return makeBark('BARK_WORKING_TICKET', latestRef, { workingCount: input.workingCount })
  return latestEv && latestRef ? makeBark('BARK_RECENT_SPINE_EVENT', latestRef, { eventType: latestEv.type }) : null
}

/** B1–B3 纯确定性小人状态编译：无 LLM 参与，无合法 SourceRef 时 bark 严格静默。 */
export function compileAvatarState(input: AvatarStateInput): AvatarProjectionState {
  const shift = resolveShift(input.now, input.timezoneOffsetMinutes, input.timeZone)
  const deviation = resolveDeviation(input)
  const { posture, zone } = resolvePosture(input, shift)
  return {
    posture, zone, shift, paused: input.paused, workingCount: input.workingCount, deviation,
    bark: lookupBark(input, posture, deviation),
    counts: {
      failed: input.failedTickets.length, blocked: input.blockedTickets.length, personWaiting: input.personWaitingTickets.length,
      working: input.workingCount, pendingConflicts: input.pendingConflicts, pendingRulings: input.pendingRulings, pendingVerifications: input.pendingVerifications,
    },
  }
}

function dedupeRefs(refs: readonly (SourceRef | null | undefined)[]): SourceRef[] {
  const seen = new Set<string>(), out: SourceRef[] = []
  for (const r of refs) {
    if (!isValidSourceRef(r)) continue
    const k = `${r.seq}:${r.id}`
    if (!seen.has(k)) { seen.add(k); out.push(r) }
  }
  return out
}

/** §5.3 & B5 编译式日程：从 M6 待裁数、活跃工单与固定巩固窗口编译零虚构当日安排。 */
export function compileDailySchedule(input: AvatarStateInput): ScheduleItem[] {
  const shift = resolveShift(input.now, input.timezoneOffsetMinutes, input.timeZone)
  const events = input.recentSpineEvents ?? []
  const validRefs = events.filter(e => isValidSourceRef({ seq: e.seq, id: e.id })).map(e => ({ seq: e.seq, id: e.id }))
  const unresolvedM6 = (input.attentionItems ?? []).filter(i => i.status === 'pending' || i.status === 'asked')
  const m6Count = Math.max(input.pendingConflicts + input.pendingRulings + input.pendingVerifications, unresolvedM6.length)
  const schedule: ScheduleItem[] = []
  if (m6Count > 0) {
    schedule.push({
      id: 'schedule:ruling-queue', kind: 'ruling_queue', window: 'now',
      titleZh: `M6 待裁与核实队列（${m6Count} 项）`, titleEn: `M6 attention queue (${m6Count} item(s))`, status: 'pending',
      count: m6Count, sourceRefs: dedupeRefs(unresolvedM6.flatMap(i => i.sourceRefs)).slice(0, 10), attentionIds: unresolvedM6.map(i => i.id),
    })
  }
  const activeTickets = [...input.failedTickets, ...input.blockedTickets, ...input.personWaitingTickets]
  const activeCount = input.workingCount + activeTickets.length
  if (activeCount > 0) {
    schedule.push({
      id: 'schedule:active-tickets', kind: 'active_tickets', window: 'now',
      titleZh: `在途工单推进（${activeCount} 项）`, titleEn: `Active tickets (${activeCount})`, status: input.paused ? 'pending' : 'active',
      count: activeCount, sourceRefs: dedupeRefs(activeTickets.map(t => findTicketRef(t, events))).slice(0, 10),
      ...(activeTickets.length ? { ticketIds: activeTickets.map(t => t.id) } : {}),
    })
  }
  schedule.push(
    { id: 'schedule:morning-briefing', kind: 'morning_briefing', window: '07:00-09:30', titleZh: '晨间汇总与待裁回顾', titleEn: 'Morning briefing & pending review', status: shift === 'morning' ? 'active' : 'scheduled', count: validRefs.length + m6Count, sourceRefs: validRefs.slice(-3) },
    { id: 'schedule:consolidation-window', kind: 'consolidation_window', window: '23:00-07:00', titleZh: '夜间值班与记忆巩固窗口', titleEn: 'Night watch & memory consolidation window', status: shift === 'night' ? 'active' : 'scheduled', count: validRefs.length, sourceRefs: validRefs.slice(-3) },
  )
  return schedule
}
