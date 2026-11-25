/** 严格只读投影读取器：零 SQLite/记忆目录写入，消费 Store 与 stateDir 生成视图。 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store } from '../app/store.ts'
import { ticketStage } from '../core/stage.ts'
import { packagePath } from '../infra/paths.ts'
import { KV } from '../kv.ts'
import { loadDepositPackage } from '../judgement/deposit.ts'
import { readMemoryPage } from '../memory/codec.ts'
import type { AttentionItem, LedgerPage } from '../memory/types.ts'
import type { SourceRef, SpineEnvelope } from '../spine/types.ts'
import { compileAvatarState, compileDailySchedule, isValidSourceRef } from './avatar-state.ts'
import { getProjectionShardCacheStats, parseSpineEnvelope, readCachedShardEvents, type ProjectionShardCacheStats } from './shard-cache.ts'
import type {
  DepositGateStats, DepositProjectionItem, DepositsProjectionView, M2MonikerRef,
  NotebookItem, NotebookProjectionView, SpineProjectionView, SpineQuery, StateProjectionView, TicketStateRef,
} from './types.ts'

export { getProjectionShardCacheStats, type ProjectionShardCacheStats }

const SHARD_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const isRecord = (val: unknown): val is Record<string, unknown> => Boolean(val && typeof val === 'object' && !Array.isArray(val))

function isDueAttention(item: AttentionItem, nowMs: number): { due: boolean; cooldownExpired: boolean } {
  if (item.status === 'approved' || item.status === 'dismissed' || item.status === 'expired') return { due: false, cooldownExpired: false }
  const hasCooldown = Boolean(item.cooldownUntil)
  const cooldownMs = item.cooldownUntil ? Date.parse(item.cooldownUntil) : NaN
  const cooldownExpired = hasCooldown && Number.isFinite(cooldownMs) && cooldownMs <= nowMs
  if (item.seenCount < item.delaySeen) return { due: false, cooldownExpired }
  if (hasCooldown && (!Number.isFinite(cooldownMs) || cooldownMs > nowMs)) return { due: false, cooldownExpired: false }
  return { due: true, cooldownExpired }
}

/** B4 M6 Notebook 只读视图：解析 `<stateDir>/memory/m6/ledger.md`，缺失时优雅返回空账本。 */
export async function readNotebookProjection(stateDir: string, now = new Date()): Promise<NotebookProjectionView> {
  let page: LedgerPage | undefined
  try {
    const loaded = await readMemoryPage(join(stateDir, 'memory'), 'm6/ledger.md')
    if (loaded?.layer === 'm6') page = loaded
  } catch { page = undefined }
  if (!page) {
    return {
      exists: false, revision: 0, updatedAt: null,
      counts: { total: 0, pending: 0, asked: 0, resolved: 0, conflicts: 0, rulings: 0, verifications: 0, depositProposals: 0, dueReminders: 0 },
      groups: { pending: [], asked: [], resolved: [] },
    }
  }
  const nowMs = now.getTime()
  const pending: NotebookItem[] = [], asked: NotebookItem[] = [], resolved: NotebookItem[] = []
  let conflicts = 0, rulings = 0, verifications = 0, depositProposals = 0, dueReminders = 0
  for (const item of page.items) {
    const entry: NotebookItem = { ...item, ...isDueAttention(item, nowMs) }
    if (item.status === 'pending') pending.push(entry)
    else if (item.status === 'asked') asked.push(entry)
    else resolved.push(entry)
    if (item.status === 'pending' || item.status === 'asked') {
      if (item.kind === 'conflict') conflicts++
      else if (item.kind === 'ruling') rulings++
      else if (item.kind === 'verification') verifications++
      else if (item.kind === 'deposit-proposal') depositProposals++
      if (entry.due) dueReminders++
    }
  }
  return {
    exists: true, revision: page.revision, updatedAt: page.updatedAt || null,
    counts: { total: page.items.length, pending: pending.length, asked: asked.length, resolved: resolved.length, conflicts, rulings, verifications, depositProposals, dueReminders },
    groups: { pending, asked, resolved },
  }
}

async function readDiskShards(stateDir: string): Promise<SpineEnvelope[]> {
  const m0Dir = join(stateDir, 'memory', 'm0')
  let names: string[]
  try { names = (await readdir(m0Dir)).filter(n => SHARD_FILE_RE.test(n)).sort() } catch { return [] }
  const out: SpineEnvelope[] = []
  for (const name of names) {
    try { for (const ev of await readCachedShardEvents(join(m0Dir, name))) out.push(ev) } catch { continue }
  }
  return out
}

function readSqliteBuffer(store: Pick<Store, 'db'> | undefined): SpineEnvelope[] {
  const db = store?.db
  if (!db) return []
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_spine'").get()) return []
    const rows = db.prepare('SELECT value FROM event_spine ORDER BY seq ASC').all() as { value?: unknown }[]
    const out: SpineEnvelope[] = []
    for (const r of rows) {
      if (typeof r.value !== 'string') continue
      const ev = parseSpineEnvelope(r.value)
      if (ev) out.push(ev)
    }
    return out
  } catch { return [] }
}

async function readMergedSpine(store: Pick<Store, 'db'> | undefined, stateDir: string): Promise<SpineEnvelope[]> {
  const bySeq = new Map<number, SpineEnvelope>()
  for (const ev of readSqliteBuffer(store)) bySeq.set(ev.seq, ev)
  for (const ev of await readDiskShards(stateDir)) if (!bySeq.has(ev.seq)) bySeq.set(ev.seq, ev)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

/** 合并磁盘 M0 分片完整行与 SQLite `event_spine` 未刷盘缓冲，按 `seq` 去重升序分页。 */
export async function readSpineProjection(
  store: Pick<Store, 'db'> | undefined,
  stateDir: string,
  query: SpineQuery = {},
): Promise<SpineProjectionView> {
  const all = await readMergedSpine(store, stateDir)
  const headSeq = all.length ? all[all.length - 1]!.seq : 0
  const sinceSeq = query.sinceSeq !== undefined && Number.isFinite(query.sinceSeq) ? Math.max(0, Math.floor(query.sinceSeq)) : 0
  const limit = Math.min(200, Math.max(1, query.limit !== undefined && Number.isFinite(query.limit) ? Math.floor(query.limit) : 50))
  const ticketId = query.ticketId?.trim() || undefined
  const type = query.type?.trim() || undefined
  const matched = all.filter(ev =>
    (sinceSeq <= 0 || ev.seq > sinceSeq)
    && (!ticketId || ev.stream === `ticket:${ticketId}` || (isRecord(ev.payload) && ev.payload['ticketId'] === ticketId))
    && (!type || ev.type === type),
  )
  const items = matched.slice(0, limit)
  return { items, totalMatched: matched.length, headSeq, nextSinceSeq: items.length ? items[items.length - 1]!.seq : null, hasMore: matched.length > limit }
}

interface MutableStats { triggers: number; allow: number; deny: number; unmeasured: number; lastEvaluatedAt?: string; lastRef?: SourceRef }

function bumpStats(stats: MutableStats, outcome: string, ev: SpineEnvelope): void {
  if (outcome !== 'allow' && outcome !== 'deny' && outcome !== 'unmeasured') return
  stats.triggers += 1; stats[outcome] += 1; stats.lastEvaluatedAt = ev.at; stats.lastRef = { seq: ev.seq, id: ev.id }
}

function collectGateStats(events: readonly SpineEnvelope[], deposits: readonly DepositProjectionItem[]): MutableStats[] {
  const statsList = deposits.map<MutableStats>(() => ({ triggers: 0, allow: 0, deny: 0, unmeasured: 0 }))
  const byId = new Map<string, number[]>(), byPoint = new Map<string, number[]>()
  deposits.forEach((d, idx) => {
    if (d.id) byId.set(d.id, [...(byId.get(d.id) ?? []), idx])
    if (d.point) byPoint.set(d.point, [...(byPoint.get(d.point) ?? []), idx])
  })
  for (const ev of events) {
    if (ev.type !== 'gate.evaluated' || !isRecord(ev.payload)) continue
    const p = ev.payload, seenIds = new Set<string>()
    let attributed = false
    for (const entry of [...(Array.isArray(p['ran']) ? p['ran'] : []), ...(Array.isArray(p['observed']) ? p['observed'] : [])]) {
      if (!isRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['outcome'] !== 'string' || seenIds.has(entry['id'])) continue
      seenIds.add(entry['id']); attributed = true
      for (const idx of byId.get(entry['id']) ?? []) bumpStats(statsList[idx]!, entry['outcome'], ev)
    }
    if (!attributed && isRecord(p['verdict']) && typeof p['verdict']['kind'] === 'string') {
      const explicitId = typeof p['depositId'] === 'string' ? p['depositId'] : typeof p['gateId'] === 'string' ? p['gateId'] : undefined
      const indices = explicitId ? (byId.get(explicitId) ?? []) : (typeof p['point'] === 'string' ? (byPoint.get(p['point']) ?? []) : [])
      for (const idx of indices) bumpStats(statsList[idx]!, p['verdict']['kind'], ev)
    }
  }
  return statsList
}

async function scanDepositRoot(rootDir: string, source: 'builtin' | 'state'): Promise<DepositProjectionItem[]> {
  let entries
  try { entries = (await readdir(rootDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)) } catch { return [] }
  const out: DepositProjectionItem[] = []
  const empty = (): DepositGateStats => ({ triggers: 0, allow: 0, deny: 0, unmeasured: 0 })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const { admission, cases } = await loadDepositPackage(join(rootDir, entry.name))
      if (admission.admitted) {
        const m = admission.manifest
        out.push({
          id: m.id, dirName: entry.name, source, admitted: true, version: m.version, kind: m.kind, trust: m.trust, params: m.params,
          casesCount: cases.length, stats: empty(),
          ...(m.point ? { point: m.point } : {}), ...(m.stage ? { stage: m.stage } : {}), ...(m.enforce !== undefined ? { enforce: m.enforce } : {}),
        })
      } else {
        out.push({
          id: entry.name, dirName: entry.name, source, admitted: false, casesCount: cases.length,
          violations: admission.violations.map(v => ({ rule: v.rule, field: v.field, reason: v.reason })), stats: empty(),
        })
      }
    } catch { /* 跳过非沉淀包目录 */ }
  }
  return out
}

/** 扫描内置与状态目录沉淀包并关联 M0 `gate.evaluated` 统计，生成战绩面只读视图。 */
export async function readDepositsProjection(
  store: Pick<Store, 'db' | 'get'> | undefined,
  stateDir: string,
  repoDepositsDir = packagePath('deposits'),
): Promise<DepositsProjectionView> {
  const stageOverrides = store && 'get' in store ? (store.get(KV.governance.depositStages) ?? {}) : {}
  const rawItems = [...await scanDepositRoot(repoDepositsDir, 'builtin'), ...await scanDepositRoot(join(stateDir, 'deposits'), 'state')]
    .map(item => item.admitted && stageOverrides[item.id] ? { ...item, stage: stageOverrides[item.id] } : item)
  const statsList = collectGateStats(await readMergedSpine(store, stateDir), rawItems)
  const items = rawItems.map((item, idx) => ({ ...item, stats: statsList[idx] ?? item.stats }))
  return {
    total: items.length, admittedCount: items.filter(i => i.admitted).length,
    totalTriggers: items.reduce((s, i) => s + i.stats.triggers, 0),
    allowCount: items.reduce((s, i) => s + i.stats.allow, 0),
    denyCount: items.reduce((s, i) => s + i.stats.deny, 0),
    unmeasuredCount: items.reduce((s, i) => s + i.stats.unmeasured, 0),
    items,
  }
}

async function readM2Monikers(stateDir: string): Promise<M2MonikerRef[]> {
  try {
    const page = await readMemoryPage(join(stateDir, 'memory'), 'm2/profile.md')
    if (!page || page.layer === 'm6') return []
    return page.entries.filter(e => e.m2Kind === 'internal_moniker' && isValidSourceRef(e.sourceRef))
  } catch { return [] }
}

/** 聚合工单状态、M6 账本、M2 内部指称与最近 M0 事件，生成只读状态与编译日程。 */
export async function readStateProjection(
  store: Pick<Store, 'db' | 'settings' | 'tickets'>,
  stateDir: string,
  now = new Date(),
): Promise<StateProjectionView> {
  const paused = store.settings().paused
  const failedTickets: TicketStateRef[] = [], blockedTickets: TicketStateRef[] = [], personWaitingTickets: TicketStateRef[] = []
  let workingCount = 0
  for (const ticket of store.tickets.open()) {
    const stage = ticketStage(ticket)
    if (stage.stage === 'working') { workingCount++; continue }
    if (stage.stage !== 'person') continue
    const ref: TicketStateRef = { id: ticket.id, title: ticket.title, action: stage.action, updatedAt: ticket.updatedAt }
    if (stage.action === 'failed') failedTickets.push(ref)
    else if (stage.action === 'blocked') blockedTickets.push(ref)
    else personWaitingTickets.push(ref)
  }
  const [notebook, spineEvents, m2Monikers] = await Promise.all([
    readNotebookProjection(stateDir, now), readMergedSpine(store, stateDir), readM2Monikers(stateDir),
  ])
  const input = {
    workingCount, personWaitingTickets, failedTickets, blockedTickets,
    pendingConflicts: notebook.counts.conflicts, pendingRulings: notebook.counts.rulings, pendingVerifications: notebook.counts.verifications,
    paused, now, attentionItems: [...notebook.groups.pending, ...notebook.groups.asked], recentSpineEvents: spineEvents.slice(-200), m2Monikers,
  }
  return { avatar: compileAvatarState(input), schedule: compileDailySchedule(input), updatedAt: now.toISOString() }
}
