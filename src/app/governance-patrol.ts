/** 常驻巡检（standing-order）与结合 `defaultShardCache` 的 M0 事件信封读取。 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluateCompiledEntry, type RegistryEntry } from '../judgement/index.ts'
import { readCachedShardEvents } from '../projection/shard-cache.ts'
import { readM0Events } from '../rsi/index.ts'
import type { SourceRef, SpineEnvelope } from '../spine/index.ts'
import type { GovernanceRuntime } from './governance.ts'
import type { Store } from './store.ts'

const SHARD_NAME_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/

export interface PatrolRunReport {
  readonly checkedTickets: number
  readonly evaluated: number
  readonly reminded: number
}

/** 结合 SQLite 与 `defaultShardCache` 只读分片缓存按 SourceRef 精准读取单条 M0 事件信封。 */
export async function readSpineEnvelopeFromStore(
  store: Pick<Store, 'db'>,
  memoryDir: string,
  closed: boolean,
  ref: SourceRef,
): Promise<SpineEnvelope<Record<string, unknown>> | undefined> {
  if (!ref || !Number.isSafeInteger(ref.seq) || ref.seq <= 0 || typeof ref.id !== 'string' || !ref.id.trim()) return undefined
  if (!closed) {
    const row = store.db.prepare('SELECT id, value FROM event_spine WHERE seq = ?').get(ref.seq) as { id?: string; value?: string } | undefined
    if (row) return row.id === ref.id && row.value ? JSON.parse(row.value) as SpineEnvelope<Record<string, unknown>> : undefined
  }
  const m0Dir = join(memoryDir, 'm0')
  let shards: string[]
  try { shards = (await readdir(m0Dir)).filter(n => SHARD_NAME_RE.test(n)).sort() } catch { return undefined }
  for (let i = shards.length - 1; i >= 0; i--) {
    const events = await readCachedShardEvents(join(m0Dir, shards[i]!))
    for (let j = events.length - 1; j >= 0; j--) {
      if (events[j]!.seq === ref.seq) return events[j]!.id === ref.id ? (events[j] as SpineEnvelope<Record<string, unknown>>) : undefined
    }
    if (events.length > 0 && events[events.length - 1]!.seq < ref.seq) return undefined
  }
  return undefined
}

/** 扫描未结单且有运行中 assignment 的工单，评估 `ticket.stale` 常驻巡检并按需写入 M6 温和提醒。 */
export async function runStandingOrderPatrol(
  gov: GovernanceRuntime,
  options: { maxIdleMinutes?: number } = {},
): Promise<PatrolRunReport> {
  const orders = gov.registry.standingOrders('ticket.stale')
  const openTickets = gov.storeRef.tickets.list().filter(t => !t.ended && t.assignments.some(a => a.state === 'running'))
  if (orders.length === 0 || openTickets.length === 0) return { checkedTickets: openTickets.length, evaluated: 0, reminded: 0 }
  const stageById = new Map(gov.registry.list().filter(e => e.kind === 'standing-order').map(e => [e.id, e.stage]))
  const now = gov.nowDate(), nowMs = now.getTime(), maxIdleMinutes = options.maxIdleMinutes ?? 30
  const lastFiredAt = new Map<string, number>()
  for (const ev of await readM0Events({ db: gov.storeRef.db, memoryDir: gov.memoryDir }).catch(() => [])) {
    const p = ev.payload as Record<string, unknown> | undefined
    const v = p?.['verdict'] as { kind?: unknown } | undefined
    if (ev.type === 'standing_order.evaluated' && v?.kind === 'allow' && typeof p?.['orderId'] === 'string' && typeof p?.['ticketId'] === 'string') {
      const ts = Date.parse(ev.at)
      if (Number.isFinite(ts)) lastFiredAt.set(`${p['orderId']}:${p['ticketId']}`, ts)
    }
  }
  let evaluated = 0, reminded = 0
  for (const ticket of openTickets) {
    const running = ticket.assignments.find(a => a.state === 'running')
    const lastIso = running?.idleAt ?? running?.deliveredAt ?? running?.report?.at ?? running?.startedAt ?? running?.createdAt ?? ticket.updatedAt
    const staleMinutes = Math.max(0, (nowMs - Date.parse(lastIso)) / 60_000)
    if (!Number.isFinite(staleMinutes) || staleMinutes < maxIdleMinutes) continue
    for (const order of orders) {
      const prevTs = lastFiredAt.get(`${order.id}:${ticket.id}`)
      const elapsedMs = prevTs !== undefined ? Math.max(0, nowMs - prevTs) : Number.MAX_SAFE_INTEGER
      const verdict = await evaluateCompiledEntry(order as unknown as RegistryEntry, {
        signal: 'ticket.stale', elapsedMs, isolation: 'I1',
        payload: {
          status: 'working', ticketId: ticket.id, staleMinutes, idleExceeded: true,
          ticketOpen: !ticket.ended, completedSteps: ['verify-heartbeat-timeout', 'confirm-open-ticket'],
        },
      })
      evaluated += 1
      const ref = gov.appender.append({
        id: `patrol:${order.id}:${ticket.id}:${nowMs}:${evaluated}`, at: now.toISOString(), stream: `ticket:${ticket.id}`,
        type: 'standing_order.evaluated', source: { kind: 'system', ref: 'governance.patrol' },
        evidence: [{ kind: 'event', ref: `ticket:${ticket.id}` }], taint: 'trusted',
        payload: { orderId: order.id, signal: 'ticket.stale', ticketId: ticket.id, staleMinutes, elapsedMs, verdict, action: order.action },
      })
      if (verdict.kind === 'allow') {
        lastFiredAt.set(`${order.id}:${ticket.id}`, nowMs)
        if (order.action.name === 'ticket.remind' && stageById.get(order.id) !== 'shadow') {
          reminded += 1
          await gov.memory.upsertAttention({
            kind: 'verification', sourceRefs: [ref], delaySeen: 1, seenCount: 1,
            question: `工单「${ticket.title}」(${ticket.id}) 已静默 ${Math.round(staleMinutes)} 分钟，请确认是否需要介入或催办`,
          }, 'standing-order').catch(() => undefined)
        }
      }
    }
  }
  return { checkedTickets: openTickets.length, evaluated, reminded }
}
