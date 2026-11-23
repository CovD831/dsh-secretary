/** M0 事件脊与 A1 分片落盘公共契约。 */
import type { ActorRef } from '../core/model.ts'

export const SPINE_VERSION = 1 as const
export type StreamId = `${string}:${string}`
export type EventType = `${string}.${string}`
export type Taint = 'trusted' | 'derived' | 'untrusted'

export const joinTaint = (a: Taint, b: Taint): Taint =>
  (a === 'untrusted' || b === 'untrusted') ? 'untrusted'
    : (a === 'derived' || b === 'derived') ? 'derived' : 'trusted'

export interface SpineSource {
  kind: 'trigger' | 'secretary' | 'worker' | 'human' | 'system' | 'standing-order'
  ref: string
  actor?: ActorRef
}

export interface EvidenceRef {
  kind: 'event' | 'file' | 'command' | 'commit' | 'url'
  ref: string
  digest?: string
}

export interface SpineEnvelope<P = unknown> {
  v: typeof SPINE_VERSION
  seq: number
  id: string
  at: string
  stream: StreamId
  type: EventType
  causationId?: string
  correlationId?: string
  source: SpineSource
  evidence: readonly EvidenceRef[]
  taint: Taint
  redacted?: readonly string[]
  payload: P
}

export type SpineDraft<P = unknown> = Omit<SpineEnvelope<P>, 'v' | 'seq' | 'at'> & { at?: string }

/** M1-M6 实体页指向 M0 的引用，附 id 用于发现库重建后 seq 撞号。 */
export interface SourceRef { seq: number; id: string }

export interface SpineAppender { append<P>(draft: SpineDraft<P>): SourceRef }

export interface ShardSink {
  latest(): Promise<{ shard: string; tail?: SourceRef; torn: boolean } | undefined>
  repairTorn(shard: string): Promise<number>
  append(shard: string, lines: readonly string[]): Promise<void>
  commit(message: string): Promise<string | undefined>
}

export interface FlushReport {
  from: number
  to: number
  shard?: string
  commit?: string
  truncated: number
}

export interface SpineFlusher {
  kick(): void
  recover(): Promise<FlushReport>
  flush(): Promise<FlushReport>
}
