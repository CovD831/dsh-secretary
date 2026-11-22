// DEPS: node:crypto, node:fs, node:fs/promises, node:path
// RESPONSIBILITY: 构造统一信封并串行、幂等地追加 JSONL
// MODULE: secretary
// ---
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface EventEnvelope {
  v: '0'
  id: string
  ts: string
  kind: string
  sessionId: string
  workspaceId: string | null
  source: 'dsh' | 'plugin'
  causedBy: string | null
  payload: Record<string, unknown>
}

export function createEnvelope(input: Omit<EventEnvelope, 'v' | 'ts'>): EventEnvelope {
  return { v: '0', ts: new Date().toISOString(), ...input }
}

export function pluginEvent(kind: string, sessionId: string, payload: Record<string, unknown>): EventEnvelope {
  return createEnvelope({
    id: `plugin:${randomUUID()}`, kind, sessionId, workspaceId: null, source: 'plugin', causedBy: null, payload,
  })
}

export class LogWriter {
  private readonly seen = new Set<string>()
  private readonly outbox: EventEnvelope[] = []
  private queue: Promise<void> = Promise.resolve()
  failure: string | null = null

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line) this.seen.add((JSON.parse(line) as EventEnvelope).id)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  append(event: EventEnvelope, action = false): Promise<void> {
    if (action && (this.failure !== null || this.outbox.length >= 1000)) {
      return Promise.reject(new Error(`事件日志写入失败，读数可能不完整：${this.failure ?? '积压超过 1000 条'}`))
    }
    const write = async (): Promise<void> => {
      if (this.seen.has(event.id)) return
      try {
        appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8')
        this.seen.add(event.id)
        this.failure = null
      } catch (error) {
        this.failure = error instanceof Error ? error.message : String(error)
        console.error(`事件日志写入失败，读数可能不完整：${this.failure}`)
        if (action) throw new Error('事件日志写入失败，动作未生效', { cause: error })
        if (!this.outbox.some(item => item.id === event.id)) this.outbox.push(event)
      }
    }
    this.queue = this.queue.then(write, write)
    return this.queue
  }

  async flush(): Promise<void> {
    await this.queue
    while (this.outbox.length > 0) {
      const event = this.outbox[0]!
      await this.append(event)
      await this.queue
      if (this.failure !== null) throw new Error(`事件日志补写失败：${this.failure}`)
      this.outbox.shift()
    }
  }
}

export async function readRecentEvents(path: string, limit = 20): Promise<EventEnvelope[]> {
  try {
    const lines = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean)
    return lines.slice(-limit).map(line => JSON.parse(line) as EventEnvelope)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
