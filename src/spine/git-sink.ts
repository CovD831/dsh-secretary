/** A1 记忆 Git 仓分片落盘与单写者仓锁实现。 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ShardSink, SourceRef } from './types.ts'

const execFileAsync = promisify(execFile)
const SHARD_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const SHARD_PATH_RE = /^m0\/\d{4}-\d{2}-\d{2}\.jsonl$/
const ISOLATED_ENV_KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL',
] as const

/** 记忆 Git 仓单写者异步互斥锁，供 M0 分片与 M1-M6 实体页共用。 */
export class GitRepoLock {
  private tail: Promise<void> = Promise.resolve()
  run<T>(task: () => Promise<T>): Promise<T> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>(r => { release = r })
    return prev.then(task).finally(() => { release() })
  }
}

export function todayUtcShard(now = new Date()): string {
  return `m0/${now.toISOString().slice(0, 10)}.jsonl`
}

export function pickShard(latestShard?: string, now = new Date()): string {
  const today = todayUtcShard(now)
  return latestShard && SHARD_PATH_RE.test(latestShard) && latestShard > today ? latestShard : today
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of ISOLATED_ENV_KEYS) delete env[key]
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = ''
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return env
}

async function readShardTail(filePath: string): Promise<{ tail?: SourceRef; torn: boolean }> {
  const fh = await open(filePath, 'r')
  try {
    const { size } = await fh.stat()
    if (size === 0) return { torn: false }
    let window = Math.min(size, 64 * 1024)
    for (;;) {
      const offset = size - window
      const buf = Buffer.allocUnsafe(window)
      let filled = 0
      while (filled < window) {
        const { bytesRead } = await fh.read(buf, filled, window - filled, offset + filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      const slice = filled === window ? buf : buf.subarray(0, filled)
      const torn = slice.length > 0 && slice[slice.length - 1] !== 0x0a
      const validEnd = torn ? slice.lastIndexOf(0x0a) + 1 : slice.length
      if (validEnd > 0) {
        let lineEnd = validEnd - 1
        while (lineEnd > 0 && (slice[lineEnd - 1] === 0x0a || slice[lineEnd - 1] === 0x0d)) lineEnd--
        if (lineEnd > 0) {
          const prevNl = slice.lastIndexOf(0x0a, lineEnd - 1)
          if (prevNl >= 0 || offset === 0) {
            const line = slice.subarray(prevNl + 1, lineEnd).toString('utf8').trim()
            if (line) {
              const parsed = JSON.parse(line) as { seq?: unknown; id?: unknown }
              if (typeof parsed.seq !== 'number' || typeof parsed.id !== 'string') {
                throw new Error(`分片尾行缺少有效的 seq/id: ${filePath}`)
              }
              return { tail: { seq: parsed.seq, id: parsed.id }, torn }
            }
          }
        }
      }
      if (offset === 0) return { torn }
      window = Math.min(size, window * 2)
    }
  } finally {
    await fh.close()
  }
}

export interface GitShardSinkOptions {
  dir: string
  lock?: GitRepoLock
  userName?: string
  userEmail?: string
}

export class GitShardSink implements ShardSink {
  readonly dir: string
  readonly lock: GitRepoLock
  private readonly userName: string
  private readonly userEmail: string
  private initialized = false

  constructor(options: GitShardSinkOptions) {
    this.dir = resolve(options.dir)
    this.lock = options.lock ?? new GitRepoLock()
    this.userName = options.userName ?? 'dsh-spine'
    this.userEmail = options.userEmail ?? 'spine@dsh.local'
  }

  init(): Promise<void> { return this.lock.run(() => this.ensureInit()) }

  private resolveShard(shard: string): string {
    if (!SHARD_PATH_RE.test(shard)) throw new Error(`非法分片路径: ${shard}`)
    return join(this.dir, shard)
  }

  private async listShards(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.dir, 'm0'))
      return entries.filter(name => SHARD_FILE_RE.test(name)).sort().map(name => `m0/${name}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: this.dir, env: isolatedGitEnv(), maxBuffer: 8 * 1024 * 1024 })
    return stdout
  }

  private async hasLocalConfig(key: string): Promise<boolean> {
    try {
      const value = (await this.git(['config', '--local', '--get', key])).trim()
      return value.length > 0
    } catch {
      return false
    }
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return
    await mkdir(join(this.dir, 'm0'), { recursive: true })
    if (!existsSync(join(this.dir, '.git'))) await this.git(['init'])
    if (!await this.hasLocalConfig('user.name')) await this.git(['config', '--local', 'user.name', this.userName])
    if (!await this.hasLocalConfig('user.email')) await this.git(['config', '--local', 'user.email', this.userEmail])
    this.initialized = true
  }

  async latest(): Promise<{ shard: string; tail?: SourceRef; torn: boolean } | undefined> {
    const shards = await this.listShards()
    if (!shards.length) return undefined
    const newest = shards[shards.length - 1]!
    const current = await readShardTail(this.resolveShard(newest))
    if (current.tail) return { shard: newest, tail: current.tail, torn: current.torn }
    for (let i = shards.length - 2; i >= 0; i--) {
      const prev = await readShardTail(this.resolveShard(shards[i]!))
      if (prev.tail) return { shard: newest, tail: prev.tail, torn: current.torn }
    }
    return { shard: newest, torn: current.torn }
  }

  async repairTorn(shard: string): Promise<number> {
    const filePath = this.resolveShard(shard)
    let fh
    try { fh = await open(filePath, 'r+') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    try {
      const { size } = await fh.stat()
      if (size === 0) return 0
      const tailByte = Buffer.allocUnsafe(1)
      await fh.read(tailByte, 0, 1, size - 1)
      if (tailByte[0] === 0x0a) return 0
      const chunkSize = 64 * 1024
      const buf = Buffer.allocUnsafe(Math.min(size, chunkSize))
      let cursor = size
      let targetSize = 0
      while (cursor > 0) {
        const len = Math.min(cursor, chunkSize)
        const pos = cursor - len
        await fh.read(buf, 0, len, pos)
        const idx = buf.subarray(0, len).lastIndexOf(0x0a)
        if (idx >= 0) { targetSize = pos + idx + 1; break }
        cursor = pos
      }
      const truncated = size - targetSize
      await fh.truncate(targetSize)
      await fh.sync()
      return truncated
    } finally {
      await fh.close()
    }
  }

  async append(shard: string, lines: readonly string[]): Promise<void> {
    if (!lines.length) return
    const filePath = this.resolveShard(shard)
    await mkdir(dirname(filePath), { recursive: true })
    const normalized = lines.map(line => {
      const clean = line.endsWith('\n') ? line.slice(0, -1) : line
      if (clean.includes('\n') || clean.includes('\r')) throw new Error('JSONL 行不允许包含换行符')
      return clean
    })
    const payload = Buffer.from(`${normalized.join('\n')}\n`, 'utf8')
    const fh = await open(filePath, 'a+')
    try {
      const { size } = await fh.stat()
      if (size > 0) {
        const last = Buffer.allocUnsafe(1)
        await fh.read(last, 0, 1, size - 1)
        if (last[0] !== 0x0a) throw new Error(`拒绝向未修复的半行分片追加: ${shard}`)
      }
      let written = 0
      while (written < payload.length) {
        const { bytesWritten } = await fh.write(payload, written, payload.length - written, null)
        written += bytesWritten
      }
      await fh.sync()
    } finally {
      await fh.close()
    }
  }

  async commit(message: string): Promise<string | undefined> {
    return this.lock.run(async () => {
      await this.ensureInit()
      await this.git(['add', '--', 'm0'])
      const changed = (await this.git(['diff', '--cached', '--name-only', '--', 'm0'])).trim()
      if (!changed) return undefined
      await this.git(['commit', '-m', message, '--', 'm0'])
      return (await this.git(['rev-parse', 'HEAD'])).trim()
    })
  }
}

export const createGitShardSink = (options: GitShardSinkOptions): GitShardSink => new GitShardSink(options)
