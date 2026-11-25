/** 可删可重建的 SQLite FTS5 派生记忆索引（只读消费 M1–M4 真源，支持 M0 原文受控降级）。 */
import { existsSync, rmSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { redactValue } from '../spine/redact.ts'
import type { SpineEnvelope } from '../spine/types.ts'
import { listMemoryPages } from './codec.ts'
import { canCallerReadEntry, isEntryActiveAt } from './recall.ts'
import type { Clearance, FactLayer, FactPage, MemoryEntry, RecallCaller } from './types.ts'

export const RECIPE_FINGERPRINT = 'm1-m4-fts5-unicode61-cjk2-v1'
const SHARD_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const CLEARANCE_ORDER: Record<Clearance, number> = { public: 0, workspace: 1, private: 2 }

export interface FtsSearchOptions {
  readonly now?: Date | string
  readonly limit?: number
  readonly fallbackToM0?: boolean
}

export interface FtsSearchHit {
  readonly entry: MemoryEntry
  readonly layer: FactLayer
  readonly relPath: string
  readonly score: number
}

export interface M0FallbackHit {
  readonly seq: number
  readonly id: string
  readonly at: string
  readonly type: string
  readonly stream: string
  readonly taint: SpineEnvelope['taint']
  readonly score: number
  readonly snippet: string
}

export interface FtsSearchResult {
  readonly hits: readonly FtsSearchHit[]
  readonly m0FallbackHits: readonly M0FallbackHit[]
  readonly usedFallback: boolean
  readonly rebuilt: boolean
}

export interface MemoryFtsIndexOptions {
  readonly memoryDir: string
  readonly dbPath: string
  readonly recipeFingerprint?: string
  readonly now?: () => Date
}

/** 提取中英文检索词元（英文单词与中文一元/二元切片），统一供 FTS5 与词法打分使用。 */
export function tokenizeForSearch(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens = new Set<string>()
  for (const m of lower.matchAll(/[a-z0-9_-]{2,}/g)) {
    tokens.add(m[0]!)
    for (const part of m[0]!.split(/[_-]+/)) {
      if (part.length >= 3) tokens.add(part)
    }
  }
  const hanRuns = lower.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of hanRuns) {
    for (let i = 0; i < run.length; i += 1) {
      tokens.add(run[i]!)
      if (i + 1 < run.length) tokens.add(run.slice(i, i + 2))
    }
  }
  return [...tokens]
}

function buildFtsMatchExpr(tokens: readonly string[]): string | undefined {
  if (tokens.length === 0) return undefined
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

function resolveNowMs(now?: Date | string): number {
  const ms = now instanceof Date ? now.getTime() : (now !== undefined ? Date.parse(now) : Date.now())
  if (!Number.isFinite(ms)) throw new Error(`非法检索时间戳 now: "${String(now)}"`)
  return ms
}

function canCallerReadM0Event(caller: RecallCaller, ev: SpineEnvelope): boolean {
  const callerRank = CLEARANCE_ORDER[caller.maxClearance]
  if (callerRank === undefined) return false
  const payload = (ev.payload && typeof ev.payload === 'object' ? ev.payload : {}) as Record<string, unknown>
  const evClearance = typeof payload['clearance'] === 'string' && payload['clearance'] in CLEARANCE_ORDER
    ? CLEARANCE_ORDER[payload['clearance'] as Clearance] : undefined
  if (evClearance !== undefined && evClearance > callerRank) return false
  if (caller.role === 'worker') {
    if (ev.stream.startsWith('secretary:') || ev.stream === 'memory:m2' || ev.stream === 'memory:m6') return false
    if (payload['layer'] === 'm2' || payload['layer'] === 'm6' || payload['clearance'] === 'private') return false
    const ws = typeof payload['workspaceId'] === 'string' ? payload['workspaceId']
      : typeof payload['workspace'] === 'string' ? payload['workspace']
        : typeof payload['scope'] === 'string' && payload['scope'].startsWith('workspace:') ? payload['scope'].slice(10) : undefined
    if (ws && ws !== caller.workspaceId) return false
  }
  return true
}

/** 受控 M0 原文分片降级检索：严守权限隔离、防软链与忽略半行损坏尾。 */
export async function searchM0Fallback(
  memoryDir: string,
  query: string,
  caller: RecallCaller,
  options: { readonly limit?: number } = {},
): Promise<M0FallbackHit[]> {
  const tokens = tokenizeForSearch(query)
  const queryLower = query.trim().toLowerCase()
  if (tokens.length === 0 && queryLower.length === 0) return []
  const m0Dir = join(resolve(memoryDir), 'm0')
  let shards: string[]
  try {
    const dirInfo = await lstat(m0Dir)
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) return []
    shards = (await readdir(m0Dir)).filter(n => SHARD_FILE_RE.test(n)).sort()
  } catch { return [] }

  const hits: M0FallbackHit[] = []
  for (let i = shards.length - 1; i >= 0; i--) {
    const filePath = join(m0Dir, shards[i]!)
    let raw = ''
    try {
      const info = await lstat(filePath)
      if (!info.isFile() || info.isSymbolicLink()) continue
      raw = await readFile(filePath, 'utf8')
    } catch { continue }
    const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1)
    for (const line of complete.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let ev: SpineEnvelope
      try { ev = JSON.parse(trimmed) as SpineEnvelope } catch { continue }
      if (!ev || typeof ev.seq !== 'number' || typeof ev.id !== 'string' || typeof ev.type !== 'string') continue
      if (!canCallerReadM0Event(caller, ev)) continue
      const safePayload = redactValue(ev.payload).value
      const text = `${ev.type} ${ev.stream} ${JSON.stringify(safePayload)}`.toLowerCase()
      let score = 0
      for (const tok of tokens) if (text.includes(tok)) score += tok.length > 1 ? 2 : 1
      if (queryLower.length >= 2 && text.includes(queryLower)) score += 3
      if (score <= 0) continue
      const snippetRaw = typeof safePayload === 'object' && safePayload !== null && 'statement' in safePayload
        ? String((safePayload as Record<string, unknown>)['statement'])
        : JSON.stringify(safePayload)
      hits.push({
        seq: ev.seq, id: ev.id, at: ev.at, type: ev.type, stream: ev.stream,
        taint: ev.taint, score, snippet: snippetRaw.slice(0, 240),
      })
    }
  }
  const limit = Math.max(1, options.limit ?? 10)
  return hits.sort((a, b) => b.score - a.score || b.seq - a.seq).slice(0, limit)
}

/** 可删可重建的 SQLite FTS5 派生记忆索引（仅从 Markdown M1–M4 重建，绝不回写真源）。 */
export class MemoryFtsIndex {
  readonly memoryDir: string
  readonly dbPath: string
  readonly recipeFingerprint: string
  private readonly now: () => Date
  private db: DatabaseSync | undefined

  constructor(options: MemoryFtsIndexOptions) {
    this.memoryDir = resolve(options.memoryDir)
    this.dbPath = options.dbPath === ':memory:' ? ':memory:' : resolve(options.dbPath)
    this.recipeFingerprint = options.recipeFingerprint ?? RECIPE_FINGERPRINT
    this.now = options.now ?? (() => new Date())
  }

  private get isInMemory(): boolean { return this.dbPath === ':memory:' }

  close(): void {
    try { this.db?.close() } catch { /* 忽略已关闭连接 */ }
    this.db = undefined
  }

  getMeta(): { recipeFingerprint: string; builtAt: string } | undefined {
    if (!this.db) return undefined
    try {
      const row = this.db.prepare('SELECT recipe_fingerprint, built_at FROM index_meta WHERE id = 1').get() as
        | { recipe_fingerprint?: string; built_at?: string } | undefined
      return row?.recipe_fingerprint && row.built_at
        ? { recipeFingerprint: row.recipe_fingerprint, builtAt: row.built_at } : undefined
    } catch { return undefined }
  }

  private createSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS index_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        recipe_fingerprint TEXT NOT NULL,
        built_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        entry_id UNINDEXED,
        layer UNINDEXED,
        rel_path UNINDEXED,
        entry_json UNINDEXED,
        tokens,
        statement,
        topic_key,
        verbatim_quote,
        tokenize='unicode61'
      );
    `)
  }

  private async openFreshAndRebuild(): Promise<{ rebuilt: true; indexedEntries: number }> {
    this.close()
    if (!this.isInMemory) {
      await mkdir(dirname(this.dbPath), { recursive: true })
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${this.dbPath}${suffix}`, { force: true })
    }
    const db = new DatabaseSync(this.dbPath)
    this.createSchema(db)
    this.db = db
    const res = await this.rebuild()
    return { rebuilt: true, indexedEntries: res.indexedEntries }
  }

  async open(): Promise<{ rebuilt: boolean; indexedEntries: number }> {
    if (!this.isInMemory && this.db && !existsSync(this.dbPath)) this.close()
    if (this.db) {
      try {
        const meta = this.getMeta()
        const countRow = this.db.prepare('SELECT count(*) AS c FROM memory_fts').get() as { c: number }
        if (meta?.recipeFingerprint === this.recipeFingerprint) return { rebuilt: false, indexedEntries: Number(countRow.c) }
      } catch { /* 损坏则重建 */ }
      return this.openFreshAndRebuild()
    }
    if (!this.isInMemory && !existsSync(this.dbPath)) return this.openFreshAndRebuild()
    try {
      if (!this.isInMemory) await mkdir(dirname(this.dbPath), { recursive: true })
      const db = new DatabaseSync(this.dbPath)
      const meta = db.prepare('SELECT recipe_fingerprint, built_at FROM index_meta WHERE id = 1').get() as
        | { recipe_fingerprint?: string; built_at?: string } | undefined
      const countRow = db.prepare('SELECT count(*) AS c FROM memory_fts').get() as { c: number }
      if (meta?.recipe_fingerprint !== this.recipeFingerprint) {
        db.close()
        return this.openFreshAndRebuild()
      }
      this.db = db
      return { rebuilt: false, indexedEntries: Number(countRow.c) }
    } catch {
      return this.openFreshAndRebuild()
    }
  }

  async rebuild(): Promise<{ indexedEntries: number; builtAt: string; recipeFingerprint: string }> {
    if (!this.db) {
      if (!this.isInMemory) await mkdir(dirname(this.dbPath), { recursive: true })
      this.db = new DatabaseSync(this.dbPath)
      this.createSchema(this.db)
    }
    const pages = existsSync(this.memoryDir) ? await listMemoryPages(this.memoryDir, ['m1', 'm2', 'm3', 'm4']) : []
    const builtAt = this.now().toISOString()
    const db = this.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM memory_fts; DELETE FROM index_meta;')
      db.prepare('INSERT INTO index_meta (id, recipe_fingerprint, built_at) VALUES (1, ?, ?)').run(this.recipeFingerprint, builtAt)
      const insert = db.prepare(
        'INSERT INTO memory_fts (entry_id, layer, rel_path, entry_json, tokens, statement, topic_key, verbatim_quote) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      let indexedEntries = 0
      for (const { relPath, page } of pages) {
        if (page.layer === 'm6') continue
        for (const entry of (page as FactPage).entries) {
          const textBlob = [entry.statement, entry.topicKey ?? '', entry.verbatimQuote ?? '',
            ...(entry.triggerKeys?.primary ?? []), ...(entry.triggerKeys?.secondary ?? [])].join(' ')
          insert.run(entry.id, page.layer, relPath, JSON.stringify(entry), tokenizeForSearch(textBlob).join(' '),
            entry.statement, entry.topicKey ?? '', entry.verbatimQuote ?? '')
          indexedEntries += 1
        }
      }
      db.exec('COMMIT')
      return { indexedEntries, builtAt, recipeFingerprint: this.recipeFingerprint }
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* 忽略回滚失败 */ }
      throw err
    }
  }

  async search(query: string, caller: RecallCaller, options: FtsSearchOptions = {}): Promise<FtsSearchResult> {
    const nowMs = resolveNowMs(options.now)
    const limit = Math.max(1, options.limit ?? 20)
    const tokens = tokenizeForSearch(query)
    const matchExpr = buildFtsMatchExpr(tokens)
    let rebuilt = false
    let hits: FtsSearchHit[] = []
    let indexFailed = false
    try {
      const opened = await this.open()
      rebuilt = opened.rebuilt
      if (matchExpr && this.db) {
        const rows = this.db.prepare(
          'SELECT layer, rel_path, entry_json, bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank ASC LIMIT ?',
        ).all(matchExpr, Math.max(limit * 4, 40)) as { layer: FactLayer; rel_path: string; entry_json: string; rank: number }[]
        for (const r of rows) {
          const entry = JSON.parse(r.entry_json) as MemoryEntry
          if (!isEntryActiveAt(entry, nowMs) || !canCallerReadEntry(caller, r.layer, entry, r.rel_path)) continue
          hits.push({ entry, layer: r.layer, relPath: r.rel_path, score: Math.max(0.0001, -Number(r.rank)) })
          if (hits.length >= limit) break
        }
      }
    } catch {
      indexFailed = true
      hits = []
    }
    const wantFallback = options.fallbackToM0 !== false && (indexFailed || hits.length === 0)
    const m0FallbackHits = wantFallback ? await searchM0Fallback(this.memoryDir, query, caller, { limit }) : []
    return { hits, m0FallbackHits, usedFallback: indexFailed || (hits.length === 0 && m0FallbackHits.length > 0), rebuilt }
  }
}
