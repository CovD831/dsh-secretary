/** 常驻巡检（standing-order）与结合 `defaultShardCache` 的 M0 事件信封读取。 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluateCompiledEntry, type RegistryEntry } from '../judgement/index.ts'
import { readCachedShardEvents } from '../projection/shard-cache.ts'
import { buildWorkspaceOneHopGraph, clusterProblemEvents, readM0Events } from '../rsi/index.ts'
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

/** 扫描未结单工单与 M0 摩擦/验证信号，评估 `ticket.stale`、`deposit.friction`、`friction.repeated` 与 `verify.failed`。 */
export async function runStandingOrderPatrol(
  gov: GovernanceRuntime,
  options: { maxIdleMinutes?: number } = {},
): Promise<PatrolRunReport> {
  const orders = gov.registry.standingOrders('ticket.stale')
  const openTickets = gov.storeRef.tickets.list().filter(t => !t.ended && t.assignments.some(a => a.state === 'running'))
  const stageById = new Map(gov.registry.list().filter(e => e.kind === 'standing-order').map(e => [e.id, e.stage]))
  const now = gov.nowDate(), nowMs = now.getTime(), maxIdleMinutes = options.maxIdleMinutes ?? 30
  const m0Events = await readM0Events({ db: gov.storeRef.db, memoryDir: gov.memoryDir }).catch(() => [])
  const lastFiredAt = new Map<string, number>()
  const seenSignals = new Set<string>()
  for (const ev of m0Events) {
    const p = ev.payload as Record<string, unknown> | undefined
    const v = p?.['verdict'] as { kind?: unknown } | undefined
    if (ev.type === 'standing_order.evaluated' && typeof p?.['orderId'] === 'string') {
      const ts = Date.parse(ev.at)
      if (v?.kind === 'allow' && typeof p?.['ticketId'] === 'string' && Number.isFinite(ts)) lastFiredAt.set(`${p['orderId']}:${p['ticketId']}`, ts)
      if (typeof p?.['dedupKey'] === 'string') seenSignals.add(`${p['orderId']}:${p['dedupKey']}`)
    } else if (ev.type === 'gate.evaluated' && p?.['point'] === 'deposit.friction' && typeof p?.['dedupKey'] === 'string') {
      seenSignals.add(`deposit.friction:${p['dedupKey']}`)
    }
  }
  let evaluated = 0, reminded = 0
  if (orders.length > 0 && openTickets.length > 0) {
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
  }

  const hasFrictionGate = gov.registry.list().some(e => e.kind === 'gate' && (e.point as string) === 'deposit.friction' && e.stage !== 'retired')
  const frictionOrders = gov.registry.standingOrders('friction.repeated')
  const verifyOrders = gov.registry.standingOrders('verify.failed')
  if (m0Events.length > 0 && (hasFrictionGate || frictionOrders.length > 0 || verifyOrders.length > 0)) {
    const wsDirs = Object.fromEntries(gov.workspaces.list().map(w => [w.id, w.repository]))
    const oneHopGraph = Object.keys(wsDirs).length > 0 ? await buildWorkspaceOneHopGraph(wsDirs) : undefined
    const patrolInput = m0Events.filter(ev => !(ev.type === 'gate.evaluated' && (ev.payload as { point?: unknown })?.point === 'deposit.friction'))
    const problemClusters = clusterProblemEvents(patrolInput, { mode: 'e2e', ...(oneHopGraph ? { oneHopGraph } : {}) })
    for (const ev of m0Events) {
      const p = (ev.payload ?? {}) as Record<string, unknown>
      const tid = typeof p['ticketId'] === 'string' ? p['ticketId'] : ev.stream.startsWith('ticket:') ? ev.stream.slice(7) : undefined
      const vKind = (p['verdict'] as { kind?: unknown } | undefined)?.kind
      if (ev.type === 'gate.evaluated' && typeof p['point'] === 'string' && p['point'].startsWith('verify.') && p['point'] !== 'deposit.friction' && vKind === 'deny') {
        const blockers = Array.isArray(p['verdict'] && (p['verdict'] as { blockers?: unknown }).blockers) ? ((p['verdict'] as { blockers: unknown[] }).blockers).length : 1
        for (const order of verifyOrders) {
          const dedupKey = `vf:${ev.id}`
          if (seenSignals.has(`${order.id}:${dedupKey}`)) continue
          seenSignals.add(`${order.id}:${dedupKey}`)
          const verdict = await evaluateCompiledEntry(order as unknown as RegistryEntry, { signal: 'verify.failed', elapsedMs: Number.MAX_SAFE_INTEGER, isolation: 'I1', payload: { ticketId: tid ?? 'unknown', point: p['point'], blockerCount: blockers } })
          gov.appender.append({
            id: `patrol:vf:${order.id}:${ev.seq}`, at: now.toISOString(), stream: tid ? `ticket:${tid}` : 'patrol:verify',
            type: 'standing_order.evaluated', source: { kind: 'system', ref: 'governance.patrol' }, evidence: [{ kind: 'event', ref: ev.id }], taint: 'trusted',
            payload: { orderId: order.id, signal: 'verify.failed', dedupKey, ticketId: tid, point: p['point'], verdict, action: order.action },
          })
        }
      }
    }
    for (const c of problemClusters) {
      const key = c.key, seenCount = c.refs.length
      const dedupKey = `${key}:${seenCount}`, distinctWorkspaces = c.workspaces.length > 0 ? c.workspaces.length : Math.max(1, c.ticketIds.length)
      if (hasFrictionGate && !seenSignals.has(`deposit.friction:${dedupKey}`)) {
        seenSignals.add(`deposit.friction:${dedupKey}`)
        const evRes = await gov.registry.evaluate('deposit.friction' as never, { seenCount, distinctWorkspaces } as never)
        gov.appender.append({
          id: `patrol:fric-gate:${key}:${seenCount}`, at: now.toISOString(), stream: `deposit:${key}`,
          type: 'gate.evaluated', source: { kind: 'system', ref: 'governance.patrol' }, evidence: [], taint: 'trusted',
          payload: { point: 'deposit.friction', dedupKey, clusterKey: key, seenCount, distinctWorkspaces, verdict: evRes.verdict, ran: evRes.ran, observed: evRes.observed },
        })
      }
      for (const order of frictionOrders) {
        if (seenSignals.has(`${order.id}:${dedupKey}`)) continue
        seenSignals.add(`${order.id}:${dedupKey}`)
        const verdict = await evaluateCompiledEntry(order as unknown as RegistryEntry, { signal: 'friction.repeated', elapsedMs: Number.MAX_SAFE_INTEGER, isolation: 'I1', payload: { patternId: key, seenCount, distinctWorkspaces } })
        gov.appender.append({
          id: `patrol:fric:${order.id}:${key}:${seenCount}`, at: now.toISOString(), stream: `deposit:${key}`,
          type: 'standing_order.evaluated', source: { kind: 'system', ref: 'governance.patrol' }, evidence: [], taint: 'trusted',
          payload: { orderId: order.id, signal: 'friction.repeated', dedupKey, clusterKey: key, seenCount, distinctWorkspaces, verdict, action: order.action },
        })
      }
    }
  }
  return { checkedTickets: openTickets.length, evaluated, reminded }
}
