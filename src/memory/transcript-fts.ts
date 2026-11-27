/** 可删可重建的 DSH 会话原始转录 FTS5 派生索引（专补压缩后旧对话召回，零修改真源）。 */
import { existsSync, rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { redactValue } from '../spine/redact.ts'
import { extractSessionText, isInjectedSystemContext } from './session-window.ts'
import { buildSmartFtsQueries, scoreTokenCoverage, tokenizeForSearch } from './text-search.ts'
import type { Clearance, RecallCaller } from './types.ts'

export const TRANSCRIPT_RECIPE_FINGERPRINT = 'dsh-transcript-fts5-cjk2-v1'
const CLEARANCE_ORDER: Record<Clearance, number> = { public: 0, workspace: 1, private: 2 }

export interface TranscriptHit {
  readonly sessionId: string
  readonly seq: number
  readonly at: string
  readonly role: 'user' | 'assistant'
  readonly clearance: Clearance
  readonly score: number
  readonly snippet: string
}

export interface TranscriptFtsOptions {
  readonly dbPath: string
  readonly recipeFingerprint?: string
  readonly now?: () => Date
}

function isoTime(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw).toISOString()
  if (typeof raw === 'string' && raw) return raw
  return new Date(0).toISOString()
}

/** 增量同步与检索 DSH 持久化会话原始事件（含 compaction 已遮蔽片段），支持坏库自愈重建。 */
export class TranscriptFtsIndex {
  readonly dbPath: string
  readonly recipeFingerprint: string
  private readonly now: () => Date
  private db: DatabaseSync | undefined

  constructor(options: TranscriptFtsOptions) {
    this.dbPath = options.dbPath === ':memory:' ? ':memory:' : resolve(options.dbPath)
    this.recipeFingerprint = options.recipeFingerprint ?? TRANSCRIPT_RECIPE_FINGERPRINT
    this.now = options.now ?? (() => new Date())
  }

  private get isInMemory(): boolean { return this.dbPath === ':memory:' }

  close(): void {
    try { this.db?.close() } catch { /* 忽略已关闭连接 */ }
    this.db = undefined
  }

  private createSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS index_meta (id INTEGER PRIMARY KEY CHECK (id = 1), recipe_fingerprint TEXT NOT NULL, built_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_cursors (session_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(session_id UNINDEXED, seq UNINDEXED, at UNINDEXED, role UNINDEXED, clearance UNINDEXED, tokens, snippet, tokenize='unicode61');
    `)
  }

  private async openFresh(): Promise<{ rebuilt: true }> {
    this.close()
    if (!this.isInMemory) {
      await mkdir(dirname(this.dbPath), { recursive: true })
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${this.dbPath}${suffix}`, { force: true })
    }
    const db = new DatabaseSync(this.dbPath)
    this.createSchema(db)
    db.prepare('INSERT INTO index_meta (id, recipe_fingerprint, built_at) VALUES (1, ?, ?)')
      .run(this.recipeFingerprint, this.now().toISOString())
    this.db = db
    return { rebuilt: true }
  }

  async open(): Promise<{ rebuilt: boolean }> {
    if (!this.isInMemory && this.db && !existsSync(this.dbPath)) this.close()
    if (this.db) {
      try {
        const meta = this.db.prepare('SELECT recipe_fingerprint FROM index_meta WHERE id = 1').get() as { recipe_fingerprint?: string } | undefined
        if (meta?.recipe_fingerprint === this.recipeFingerprint) return { rebuilt: false }
      } catch { /* 损坏则清空重来 */ }
      return this.openFresh()
    }
    if (!this.isInMemory && !existsSync(this.dbPath)) return this.openFresh()
    let db: DatabaseSync | undefined
    try {
      if (!this.isInMemory) await mkdir(dirname(this.dbPath), { recursive: true })
      db = new DatabaseSync(this.dbPath)
      const meta = db.prepare('SELECT recipe_fingerprint FROM index_meta WHERE id = 1').get() as { recipe_fingerprint?: string } | undefined
      if (meta?.recipe_fingerprint !== this.recipeFingerprint) {
        db.close()
        return this.openFresh()
      }
      this.db = db
      return { rebuilt: false }
    } catch {
      try { db?.close() } catch { /* 忽略关闭异常 */ }
      return this.openFresh()
    }
  }

  /** 按会话游标增量读取 SessionPersistence 原始 JSONL（先脱敏再建索引，跳过 recall/snapshot 自注入）。 */
  async syncSession(
    persistence: Pick<SessionPersistence, 'flush' | 'open'> | undefined,
    sessionId: string,
    clearance: Clearance = 'private',
  ): Promise<{ indexed: number; lastSeq: number }> {
    if (!persistence) return { indexed: 0, lastSeq: -1 }
    await this.open()
    const db = this.db!
    const cursorRow = db.prepare('SELECT last_seq FROM session_cursors WHERE session_id = ?').get(sessionId) as { last_seq?: number } | undefined
    const prevSeq = typeof cursorRow?.last_seq === 'number' ? cursorRow.last_seq : -1
    try { await persistence.flush() } catch { /* 未落盘或无脏页时继续只读读取 */ }

    const events: SessionEvent[] = []
    try {
      await using handle = await persistence.open(sessionId as never, 'read')
      for (let offset = 0; ;) {
        const page = await handle.read(offset, 512)
        if (!page.events.length) break
        for (const ev of page.events) {
          if (typeof ev.seq === 'number' && ev.seq > prevSeq) events.push(ev)
        }
        offset += page.events.length
      }
    } catch {
      return { indexed: 0, lastSeq: prevSeq }
    }
    if (events.length === 0) return { indexed: 0, lastSeq: prevSeq }

    let indexed = 0
    let maxSeq = prevSeq
    const insert = db.prepare(
      'INSERT INTO transcript_fts (session_id, seq, at, role, clearance, tokens, snippet) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const upsertCursor = db.prepare(
      'INSERT INTO session_cursors (session_id, last_seq, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at',
    )
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const ev of events) {
        if (typeof ev.seq === 'number' && ev.seq > maxSeq) maxSeq = ev.seq
        if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
        if (ev.type === 'assistant/message' && ev.data?.interrupted === true) continue
        const raw = ev.type === 'user/message' ? extractSessionText(ev.data?.content) : extractSessionText(ev.data?.message?.content)
        if (!raw.trim() || isInjectedSystemContext(ev, raw)) continue
        const safe = redactValue(raw).value.trim()
        if (!safe) continue
        const tokens = tokenizeForSearch(safe)
        if (tokens.length === 0) continue
        const role: 'user' | 'assistant' = ev.type === 'user/message' ? 'user' : 'assistant'
        insert.run(sessionId, ev.seq ?? 0, isoTime(ev.time), role, clearance, tokens.join(' '), safe.slice(0, 600))
        indexed += 1
      }
      upsertCursor.run(sessionId, maxSeq, this.now().toISOString())
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* 忽略回滚失败 */ }
      throw err
    }
    return { indexed, lastSeq: maxSeq }
  }

  /** 按两阶段 AND -> OR 覆盖率查询已索引的历史对话片段，严格按调用方密级与允许会话过滤。 */
  async search(
    query: string,
    caller: RecallCaller,
    options: { readonly sessionIds?: readonly string[]; readonly limit?: number } = {},
  ): Promise<TranscriptHit[]> {
    const tokens = tokenizeForSearch(query)
    const queryLower = query.trim().toLowerCase()
    const queries = buildSmartFtsQueries(tokens)
    if (!queries.primary) return []
    const callerRank = CLEARANCE_ORDER[caller.maxClearance]
    if (callerRank === undefined) return []
    const allowedSessions = options.sessionIds ? new Set(options.sessionIds) : undefined
    const limit = Math.max(1, options.limit ?? 8)
    try {
      await this.open()
      const db = this.db
      if (!db) return []
      const hits: TranscriptHit[] = []
      const seen = new Set<string>()
      const collect = (expr: string, requireCov: boolean): void => {
        const rows = db.prepare(
          'SELECT session_id, seq, at, role, clearance, snippet, bm25(transcript_fts) AS rank FROM transcript_fts WHERE transcript_fts MATCH ? ORDER BY rank ASC LIMIT ?',
        ).all(expr, Math.max(limit * 4, 40)) as { session_id: string; seq: number; at: string; role: 'user' | 'assistant'; clearance: Clearance; snippet: string; rank: number }[]
        for (const r of rows) {
          if (hits.length >= limit) break
          const k = `${r.session_id}:${r.seq}`
          if (seen.has(k)) continue
          const cRank = CLEARANCE_ORDER[r.clearance]
          if (cRank === undefined || cRank > callerRank) continue
          if (caller.role === 'worker' && (r.clearance === 'private' || (allowedSessions && !allowedSessions.has(r.session_id)))) continue
          if (allowedSessions && !allowedSessions.has(r.session_id)) continue
          if (requireCov && !scoreTokenCoverage(tokens, r.snippet.toLowerCase(), queryLower, 0.4).enough) continue
          seen.add(k)
          hits.push({
            sessionId: r.session_id,
            seq: Number(r.seq),
            at: r.at,
            role: r.role,
            clearance: r.clearance,
            score: Math.max(0.0001, -Number(r.rank)),
            snippet: r.snippet,
          })
        }
      }
      collect(queries.primary, false)
      if (hits.length < limit && queries.fallback) collect(queries.fallback, true)
      return hits
    } catch {
      return []
    }
  }
}
