/** 事件脊 M0 与 A1 分片落盘模块统一导出。 */
export { SPINE_VERSION, joinTaint } from './types.ts'
export type {
  StreamId, EventType, Taint, SpineSource, EvidenceRef, SpineEnvelope,
  SpineDraft, SourceRef, SpineAppender, ShardSink, FlushReport, SpineFlusher,
} from './types.ts'
export { REDACTED, redactValue, redactDraft } from './redact.ts'
export type { RedactResult } from './redact.ts'
export { ensureSpineSchema, createSpineAppender } from './store.ts'
export type { SpineStore } from './store.ts'
export { GitRepoLock, GitShardSink, createGitShardSink, pickShard, todayUtcShard } from './git-sink.ts'
export type { GitShardSinkOptions } from './git-sink.ts'
export { createSpineFlusher } from './flusher.ts'
export type { SpineFlusherOptions } from './flusher.ts'
