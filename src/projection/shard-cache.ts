/** 有界只读 M0 分片内存缓存：支持历史不可变分片复用与活跃分片尾部字节偏移增量解析。 */
import { lstat, open, readFile } from 'node:fs/promises'
import type { SpineEnvelope } from '../spine/types.ts'

interface CachedShard {
  readonly mtimeMs: number
  readonly size: number
  readonly completeBytes: number
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

function putCachedShard(filePath: string, entry: CachedShard): void {
  if (shardCache.has(filePath)) shardCache.delete(filePath)
  else if (shardCache.size >= MAX_SHARD_CACHE) {
    const oldest = shardCache.keys().next().value
    if (oldest !== undefined) shardCache.delete(oldest)
  }
  shardCache.set(filePath, entry)
}

/** 读取单个非符号链接 M0 分片文件，优先复用未变更缓存或按字节偏移增量读取尾部追加行。 */
export async function readCachedShardEvents(filePath: string): Promise<readonly SpineEnvelope[]> {
  let info
  try { info = await lstat(filePath) } catch { shardCache.delete(filePath); return [] }
  if (!info.isFile() || info.isSymbolicLink()) { shardCache.delete(filePath); return [] }
  const cached = shardCache.get(filePath)
  if (cached && info.mtimeMs === cached.mtimeMs && info.size === cached.size) {
    cacheStats.hits += 1
    putCachedShard(filePath, cached)
    return cached.events
  }
  if (cached && info.size > cached.size && info.size > cached.completeBytes && info.mtimeMs >= cached.mtimeMs) {
    if (cached.completeBytes > 0) {
      const raw = await readByteRange(filePath, cached.completeBytes - 1, info.size - cached.completeBytes + 1)
      if (raw[0] === 0x0a) {
        const parsed = parseCompleteBuffer(raw.subarray(1))
        const events = parsed.events.length ? [...cached.events, ...parsed.events] : cached.events
        cacheStats.incrementalHits += 1
        putCachedShard(filePath, { mtimeMs: info.mtimeMs, size: info.size, completeBytes: cached.completeBytes + parsed.completeBytes, events })
        return events
      }
    } else {
      const parsed = parseCompleteBuffer(await readByteRange(filePath, 0, info.size))
      cacheStats.incrementalHits += 1
      putCachedShard(filePath, { mtimeMs: info.mtimeMs, size: info.size, ...parsed })
      return parsed.events
    }
  }
  const parsed = parseCompleteBuffer(await readFile(filePath))
  cacheStats.misses += 1
  putCachedShard(filePath, { mtimeMs: info.mtimeMs, size: info.size, ...parsed })
  return parsed.events
}
