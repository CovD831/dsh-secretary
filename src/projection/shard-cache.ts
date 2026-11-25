/** 有界只读 M0 分片内存缓存：校验 inode/dev 与末尾指纹，支持历史分片复用及尾部字节偏移增量解析。 */
import { lstat, open, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SpineEnvelope } from '../spine/types.ts'

interface CachedShard {
  readonly ino: number
  readonly dev: number
  readonly mtimeMs: number
  readonly size: number
  readonly completeBytes: number
  readonly tailSig: Buffer
  readonly events: readonly SpineEnvelope[]
}

export interface ProjectionShardCacheStats {
  readonly size: number
  readonly maxEntries: number
  readonly hits: number
  readonly incrementalHits: number
  readonly misses: number
}

const MAX_SHARD_CACHE = 128
const TAIL_SIG_BYTES = 32
const shardCache = new Map<string, CachedShard>()
const cacheStats = { hits: 0, incrementalHits: 0, misses: 0 }

/** 返回只读分片缓存的命中、增量命中与容量统计，供诊断与单元测试断言使用。 */
export function getProjectionShardCacheStats(): ProjectionShardCacheStats {
  return { size: shardCache.size, maxEntries: MAX_SHARD_CACHE, ...cacheStats }
}

export function parseSpineEnvelope(rawLine: string): SpineEnvelope | undefined {
  const line = rawLine.trim()
  if (!line) return undefined
  try {
    const obj = JSON.parse(line) as Partial<SpineEnvelope>
    if (!obj || typeof obj.seq !== 'number' || !Number.isSafeInteger(obj.seq) || obj.seq <= 0) return undefined
    return typeof obj.id === 'string' && obj.id.trim() && typeof obj.type === 'string' ? (obj as SpineEnvelope) : undefined
  } catch { return undefined }
}

function parseCompleteBuffer(buf: Buffer): { completeBytes: number; events: SpineEnvelope[] } {
  const lastNl = buf.lastIndexOf(0x0a)
  if (lastNl < 0) return { completeBytes: 0, events: [] }
  const completeBytes = lastNl + 1
  const events: SpineEnvelope[] = []
  for (const line of buf.subarray(0, completeBytes).toString('utf8').split('\n')) {
    const ev = parseSpineEnvelope(line)
    if (ev) events.push(ev)
  }
  return { completeBytes, events }
}

async function readByteRange(filePath: string, offset: number, length: number): Promise<Buffer> {
  const fh = await open(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await fh.read(buf, filled, length - filled, offset + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return filled === length ? buf : buf.subarray(0, filled)
  } finally { await fh.close() }
}

function putCachedShard(key: string, entry: CachedShard): void {
  if (shardCache.has(key)) shardCache.delete(key)
  else if (shardCache.size >= MAX_SHARD_CACHE) {
    const oldest = shardCache.keys().next().value
    if (oldest !== undefined) shardCache.delete(oldest)
  }
  shardCache.set(key, entry)
}

function tailSlice(buf: Buffer, end: number): Buffer {
  return Buffer.from(buf.subarray(Math.max(0, end - TAIL_SIG_BYTES), end))
}

/** 读取单个非符号链接 M0 分片文件，校验 dev/ino 与 32B 尾指纹后复用缓存或增量读取尾部追加行。 */
export async function readCachedShardEvents(filePath: string): Promise<readonly SpineEnvelope[]> {
  const key = resolve(filePath)
  let info
  try { info = await lstat(key) } catch { shardCache.delete(key); return [] }
  if (!info.isFile() || info.isSymbolicLink()) { shardCache.delete(key); return [] }
  const cached = shardCache.get(key)
  if (cached && info.ino === cached.ino && info.dev === cached.dev && info.mtimeMs === cached.mtimeMs && info.size === cached.size) {
    cacheStats.hits += 1
    putCachedShard(key, cached)
    return cached.events
  }
  if (cached && info.ino === cached.ino && info.dev === cached.dev && info.size > cached.size && info.size > cached.completeBytes) {
    const sigLen = cached.tailSig.length
    const startOffset = cached.completeBytes - sigLen
    const raw = await readByteRange(key, startOffset, info.size - startOffset)
    if (raw.length >= sigLen && raw.subarray(0, sigLen).equals(cached.tailSig)) {
      const delta = raw.subarray(sigLen)
      const parsed = parseCompleteBuffer(delta)
      const events = parsed.events.length ? [...cached.events, ...parsed.events] : cached.events
      const completeBytes = cached.completeBytes + parsed.completeBytes
      const mergedTail = parsed.completeBytes >= TAIL_SIG_BYTES
        ? tailSlice(delta, parsed.completeBytes)
        : Buffer.from(Buffer.concat([cached.tailSig, delta.subarray(0, parsed.completeBytes)]).subarray(-TAIL_SIG_BYTES))
      cacheStats.incrementalHits += 1
      putCachedShard(key, {
        ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs, size: info.size,
        completeBytes, tailSig: mergedTail, events,
      })
      return events
    }
  }
  const fullBuf = await readFile(key)
  const parsed = parseCompleteBuffer(fullBuf)
  cacheStats.misses += 1
  putCachedShard(key, {
    ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs, size: info.size,
    completeBytes: parsed.completeBytes, tailSig: tailSlice(fullBuf, parsed.completeBytes), events: parsed.events,
  })
  return parsed.events
}
