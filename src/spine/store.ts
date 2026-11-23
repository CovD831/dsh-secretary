/** M0 SQLite 缓冲表初始化与事务内幂等写入器。 */
import type { DatabaseSync } from 'node:sqlite'
import { isoTime } from '../core/model.ts'
import type { Store } from '../app/store.ts'
import { redactDraft } from './redact.ts'
import { SPINE_VERSION, type SourceRef, type SpineAppender, type SpineDraft, type SpineEnvelope, type SpineFlusher } from './types.ts'

export type SpineStore = Pick<Store, 'db' | 'atomic' | 'afterCommit'>

export function ensureSpineSchema(db: DatabaseSync, tailSeq?: number): void {
  if (tailSeq !== undefined && (!Number.isSafeInteger(tailSeq) || tailSeq < 0)) {
    throw new Error(`非法 tailSeq: ${String(tailSeq)}`)
  }
  db.exec('SAVEPOINT spine_schema_init')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS event_spine(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL)')
    const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'event_spine'").get() as { seq?: number } | undefined
    const maxRow = db.prepare('SELECT IFNULL(MAX(seq), 0) AS m FROM event_spine').get() as { m: number }
    const target = Math.max(Number(seqRow?.seq ?? 0), Number(maxRow.m), tailSeq ?? 0)
    if (target > 0) {
      if (seqRow) {
        if (Number(seqRow.seq) < target) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'event_spine'").run(target)
      } else {
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('event_spine', ?)").run(target)
      }
    }
    db.exec('RELEASE spine_schema_init')
  } catch (error) {
    db.exec('ROLLBACK TO spine_schema_init; RELEASE spine_schema_init')
    throw error
  }
}

export function createSpineAppender(store: SpineStore, flusher?: Pick<SpineFlusher, 'kick'>): SpineAppender {
  return {
    append<P>(draft: SpineDraft<P>): SourceRef {
      if (!draft.id) throw new Error('事件 id 不能为空')
      return store.atomic(() => {
        const existing = store.db.prepare('SELECT seq FROM event_spine WHERE id = ?').get(draft.id) as { seq: number } | undefined
        if (existing) {
          store.afterCommit(() => flusher?.kick())
          return { seq: Number(existing.seq), id: draft.id }
        }
        const { draft: clean, redacted } = redactDraft(draft)
        const at = clean.at ? isoTime(clean.at) : new Date().toISOString()
        const { lastInsertRowid } = store.db.prepare("INSERT INTO event_spine (id, value) VALUES (?, '')").run(clean.id)
        const seq = Number(lastInsertRowid)
        const envelope: SpineEnvelope<P> = {
          v: SPINE_VERSION,
          seq,
          id: clean.id,
          at,
          stream: clean.stream,
          type: clean.type,
          ...(clean.causationId !== undefined ? { causationId: clean.causationId } : {}),
          ...(clean.correlationId !== undefined ? { correlationId: clean.correlationId } : {}),
          source: clean.source,
          evidence: clean.evidence,
          taint: clean.taint,
          ...(redacted.length ? { redacted } : {}),
          payload: clean.payload,
        }
        store.db.prepare('UPDATE event_spine SET value = ? WHERE seq = ?').run(JSON.stringify(envelope), seq)
        store.afterCommit(() => flusher?.kick())
        return { seq, id: clean.id }
      })
    },
  }
}
