/** 单飞串行合并刷盘器，保证 SQLite 缓冲到 Git 分片的幂等落盘与崩溃恢复。 */
import type { DatabaseSync } from 'node:sqlite'
import { pickShard } from './git-sink.ts'
import { ensureSpineSchema } from './store.ts'
import type { FlushReport, ShardSink, SpineFlusher } from './types.ts'

export interface SpineFlusherOptions {
  onError?: (error: unknown) => void
  now?: () => Date
}

interface SpineRow { seq: number; id: string; value: string }
interface RangeRow { minSeq: number | null; maxSeq: number | null }

export function createSpineFlusher(db: DatabaseSync, sink: ShardSink, options: SpineFlusherOptions = {}): SpineFlusher {
  const { onError = () => {}, now = () => new Date() } = options
  let running: Promise<FlushReport> | undefined
  let again: Promise<FlushReport> | undefined
  let scheduled = false
  let pendingSettle = false

  async function flushOnce(settleHead: boolean): Promise<FlushReport> {
    let head = await sink.latest()
    let truncated = 0
    if (head?.torn) {
      truncated = await sink.repairTorn(head.shard)
      head = await sink.latest()
    }
    const tailSeq = head?.tail?.seq ?? 0
    ensureSpineSchema(db, tailSeq)

    const stale = db.prepare('SELECT MIN(seq) AS minSeq, MAX(seq) AS maxSeq FROM event_spine WHERE seq <= ?').get(tailSeq) as unknown as RangeRow
    const hasStale = stale.minSeq !== null && stale.maxSeq !== null
    if (hasStale) {
      if (!head?.tail || Number(stale.maxSeq) !== tailSeq) {
        throw new Error(`event_spine 残留序列 (${stale.maxSeq}) 与分片尾 seq=${tailSeq} 不一致，疑似 seq 撞号`)
      }
      const tailRow = db.prepare('SELECT id FROM event_spine WHERE seq = ?').get(tailSeq) as { id: string } | undefined
      if (!tailRow || tailRow.id !== head.tail.id) {
        throw new Error(`event_spine seq=${tailSeq} 与分片尾 id 冲突 (${tailRow?.id ?? '缺失'} !== ${head.tail.id})`)
      }
    }

    const rows = db.prepare('SELECT seq, id, value FROM event_spine WHERE seq > ? ORDER BY seq ASC').all(tailSeq) as unknown as SpineRow[]

    if (!rows.length && !hasStale && truncated === 0 && !(settleHead && head)) {
      return { from: 0, to: 0, truncated: 0 }
    }

    let shard = head?.shard
    let from = 0
    let to = 0
    if (rows.length) {
      shard = pickShard(head?.shard, now())
      await sink.append(shard, rows.map(row => row.value))
      from = hasStale ? Math.min(Number(stale.minSeq), rows[0]!.seq) : rows[0]!.seq
      to = rows[rows.length - 1]!.seq
    } else if (hasStale) {
      from = Number(stale.minSeq)
      to = Number(stale.maxSeq)
    }

    const message = to > 0 ? `m0: flush ${from}..${to}` : `m0: recover ${shard ?? 'shard'}`
    const commit = await sink.commit(message)
    // 仅在 git commit 成功后删缓冲行，确保 append/commit 间崩溃可重放。
    const deleteUpTo = rows.length ? to : tailSeq
    if (deleteUpTo > 0) db.prepare('DELETE FROM event_spine WHERE seq <= ?').run(deleteUpTo)
    return { from, to, ...(shard ? { shard } : {}), ...(commit ? { commit } : {}), truncated }
  }

  function schedule(settleHead: boolean): Promise<FlushReport> {
    pendingSettle ||= settleHead
    if (!running) {
      const settle = pendingSettle
      pendingSettle = false
      running = flushOnce(settle).finally(() => { running = undefined })
      return running
    }
    const next = () => { again = undefined; return schedule(pendingSettle) }
    return again ??= running.then(next, next)
  }

  function kick(): void {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void schedule(false).catch(onError)
    })
  }

  return { kick, recover: () => schedule(true), flush: () => schedule(false) }
}
