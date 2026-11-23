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

  async function flushOnce(): Promise<FlushReport> {
    let head = await sink.latest()
    let truncated = 0
    if (head?.torn) {
      truncated = await sink.repairTorn(head.shard)
      head = await sink.latest()
    }
    const tailSeq = head?.tail?.seq ?? 0
    ensureSpineSchema(db, tailSeq)

    if (head?.tail) {
      const collided = db.prepare('SELECT id FROM event_spine WHERE seq = ?').get(head.tail.seq) as { id: string } | undefined
      if (collided && collided.id !== head.tail.id) {
        throw new Error(`event_spine seq=${head.tail.seq} 与分片尾 id 冲突 (${collided.id} !== ${head.tail.id})`)
      }
    }

    const rows = db.prepare('SELECT seq, id, value FROM event_spine WHERE seq > ? ORDER BY seq ASC').all(tailSeq) as unknown as SpineRow[]
    const stale = db.prepare('SELECT MIN(seq) AS minSeq, MAX(seq) AS maxSeq FROM event_spine WHERE seq <= ?').get(tailSeq) as unknown as RangeRow
    const hasStale = stale.minSeq !== null && stale.maxSeq !== null

    if (!rows.length && !hasStale && truncated === 0) {
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

    const message = to > 0 ? `m0: flush ${from}..${to}` : `m0: repair ${shard ?? 'shard'}`
    const commit = await sink.commit(message)
    // 仅在 git commit 成功后删缓冲行，确保 append/commit 间崩溃可重放。
    const deleteUpTo = rows.length ? to : tailSeq
    if (deleteUpTo > 0) db.prepare('DELETE FROM event_spine WHERE seq <= ?').run(deleteUpTo)
    return { from, to, ...(shard ? { shard } : {}), ...(commit ? { commit } : {}), truncated }
  }

  function flush(): Promise<FlushReport> {
    if (!running) {
      running = flushOnce().finally(() => { running = undefined })
      return running
    }
    const next = () => { again = undefined; return flush() }
    return again ??= running.then(next, next)
  }

  function kick(): void {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void flush().catch(onError)
    })
  }

  return { kick, recover: flush, flush }
}
