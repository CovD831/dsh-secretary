/** 自动化做梦闭环编排：游标推进、两步失败熔断、宿主三道硬门准入、深度 M4 晋升与常驻压缩。 */
import { randomUUID } from 'node:crypto'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { Ticket } from '../core/model.ts'
import type { SpineAppender } from '../spine/types.ts'
import { runDeepConsolidation } from './dreamer-deep.ts'
import type { DreamExtractorFn } from './dreamer-llm.ts'
import type { MemoryFtsIndex } from './fts-index.ts'
import type { PersistentBotMemoryPolicy } from './policy.ts'
import { readUnextractedSessionWindow, type SessionWindowSlice } from './session-window.ts'
import type { TranscriptFtsIndex } from './transcript-fts.ts'
import type { MemoryScope } from './types.ts'
import type { MemoryWriter } from './writer.ts'

export interface DreamCursorState {
  readonly lastSeq: number
  readonly lastRunAt?: string
  readonly lastDeepAt?: string
  readonly failCount: number
  readonly lastFailedRange?: { readonly fromSeq: number; readonly throughSeq: number }
  readonly totalRuns: number
  readonly lastSummary?: string
}

export interface DreamRunReport {
  readonly sessionId: string
  readonly trigger: 'compaction' | 'idle' | 'scheduled' | 'ticket_end' | 'manual'
  readonly status: 'completed' | 'skipped' | 'failed' | 'unmeasured'
  readonly fromSeq: number
  readonly throughSeq: number
  readonly batchesProcessed?: number
  readonly extracted: number
  readonly accepted: number
  readonly conflicted: number
  readonly rejectedQuotes: number
  readonly promotedM4: number
  readonly demotedResident: number
  readonly deduped: number
  readonly detail?: string
  readonly at: string
}

export interface DreamStatusSummary {
  readonly running: boolean
  readonly cursors: Readonly<Record<string, DreamCursorState>>
  readonly lastReport?: DreamRunReport
}

export interface MemoryDreamerOptions {
  readonly memoryDir: string
  readonly persistence?: Pick<SessionPersistence, 'flush' | 'open'>
  readonly ftsIndex: MemoryFtsIndex
  readonly transcriptFts?: TranscriptFtsIndex
  readonly memory: MemoryWriter
  readonly appender: SpineAppender
  readonly policy: PersistentBotMemoryPolicy
  readonly extractFn: DreamExtractorFn
  readonly getCursors: () => Record<string, DreamCursorState>
  readonly saveCursors: (cursors: Record<string, DreamCursorState>) => void
  readonly classifyTrigger?: (text: string) => { taint: 'trusted' | 'untrusted'; triggerId?: string; isBoss?: boolean }
  readonly now: () => Date
  readonly onUpdated?: (modifiedIds: readonly string[]) => void
}

const IDLE_MIN_LINES = 8
const IDLE_MIN_CHARS = 4000
const IDLE_COOLDOWN_MS = 10 * 60_000
const DEEP_INTERVAL_MS = 20 * 60 * 60_000
const safeSlug = (raw?: string, fallback = 'dream-notes'): string =>
  (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || fallback

/** 负责持久化会话增量做梦：闲置/压缩/定期/手动触发、单飞互斥、防虚构与防失控熔断。 */
export class MemoryDreamer {
  private readonly opts: MemoryDreamerOptions
  private readonly abortCtrl = new AbortController()
  private inflight: Promise<DreamRunReport> | undefined
  private lastReport: DreamRunReport | undefined
  private closed = false

  constructor(options: MemoryDreamerOptions) {
    this.opts = options
  }

  shutdown(): void {
    this.closed = true
    this.abortCtrl.abort()
  }

  status(): DreamStatusSummary {
    return {
      running: Boolean(this.inflight),
      cursors: this.opts.getCursors(),
      ...(this.lastReport ? { lastReport: this.lastReport } : {}),
    }
  }

  onCompactionEnded(sessionId: string): Promise<DreamRunReport> {
    return this.runNow({ sessionId, force: true, runDeep: true, trigger: 'compaction' })
  }

  onSessionIdle(sessionId: string): Promise<DreamRunReport> {
    return this.runNow({ sessionId, force: false, runDeep: false, trigger: 'idle' })
  }

  maybeRunScheduled(sessionId: string): Promise<DreamRunReport> {
    const cur = this.opts.getCursors()[sessionId]
    const lastDeepMs = cur?.lastDeepAt ? Date.parse(cur.lastDeepAt) : NaN
    const due = !Number.isFinite(lastDeepMs) || this.opts.now().getTime() - lastDeepMs >= DEEP_INTERVAL_MS
    if (!due) return Promise.resolve(this.skippedReport(sessionId, 'scheduled', cur?.lastSeq ?? -1, 'scheduled-not-due'))
    return this.runNow({ sessionId, force: false, runDeep: true, trigger: 'scheduled' })
  }

  onTicketEnded(ticket: Ticket): Promise<DreamRunReport> {
    return this.runNow({ sessionId: `worker-${ticket.id}`, force: true, runDeep: false, trigger: 'ticket_end', defaultWorkspace: ticket.execution?.workspace })
  }

  runNow(input: {
    readonly sessionId: string
    readonly force?: boolean
    readonly runDeep?: boolean
    readonly trigger?: DreamRunReport['trigger']
    readonly defaultWorkspace?: string
    readonly maxBatches?: number
  }): Promise<DreamRunReport> {
    if (this.closed) return Promise.resolve(this.skippedReport(input.sessionId, input.trigger ?? 'manual', -1, 'dreamer-closed'))
    const run = async (): Promise<DreamRunReport> => {
      const report = await this.executeOnce(input)
      this.lastReport = report
      return report
    }
    const chained = (this.inflight ?? Promise.resolve(undefined)).then(run, run)
    this.inflight = chained.finally(() => { if (this.inflight === chained) this.inflight = undefined })
    return this.inflight
  }

  private skippedReport(sessionId: string, trigger: DreamRunReport['trigger'], seq: number, detail: string, batchesProcessed = 0): DreamRunReport {
    return {
      sessionId, trigger, status: 'skipped', fromSeq: seq, throughSeq: seq, batchesProcessed,
      extracted: 0, accepted: 0, conflicted: 0, rejectedQuotes: 0, promotedM4: 0, demotedResident: 0, deduped: 0,
      detail, at: this.opts.now().toISOString(),
    }
  }

  private async admitBatch(input: {
    readonly sessionId: string
    readonly trigger: DreamRunReport['trigger']
    readonly slice: SessionWindowSlice
    readonly candidates: readonly import('./dreamer-llm.ts').DreamExtractCandidate[]
    readonly model: string
    readonly defaultWorkspace?: string
    readonly nowIso: string
  }): Promise<{ accepted: number; conflicted: number; rejectedQuotes: number; modifiedIds: string[] }> {
    const batchRef = this.opts.appender.append({
      id: `mem:dream-batch:${randomUUID().slice(0, 12)}`, at: input.nowIso, stream: 'memory:dream',
      type: 'memory.dream.batch', source: { kind: 'system', ref: 'dreamer' }, evidence: [], taint: 'trusted',
      payload: { sessionId: input.sessionId, trigger: input.trigger, fromSeq: input.slice.fromSeq, throughSeq: input.slice.throughSeq, model: input.model, extracted: input.candidates.length },
    })
    const bySeq = new Map(input.slice.lines.map(l => [l.seq, l])), modifiedIds: string[] = []
    let accepted = 0, conflicted = 0, rejectedQuotes = 0
    for (const cand of input.candidates.slice(0, 8)) {
      if (!this.opts.policy.writableLayers.includes(cand.layer)) continue
      const line = bySeq.get(cand.sourceSeq), quote = cand.verbatimQuote.trim()
      if (!line || quote.length < 4 || !line.text.includes(quote)) { rejectedQuotes += 1; continue }
      const wsKey = cand.layer === 'm3' ? safeSlug(cand.workspaceKey ?? input.defaultWorkspace, 'default') : undefined
      const scope: MemoryScope = cand.layer === 'm3' ? `workspace:${wsKey}` : 'global'
      const res = await this.opts.memory.propose({
        layer: cand.layer,
        ...(cand.layer === 'm1' ? { slug: safeSlug(cand.slug ?? cand.topicKey, 'dream-notes') } : cand.layer === 'm3' ? { workspaceKey: wsKey, slug: safeSlug(cand.slug ?? cand.topicKey, 'pitfalls') } : {}),
        statement: cand.statement, scope, sourceType: 'inference', sourceRef: batchRef, author: 'consolidator',
        taint: line.taint === 'untrusted' ? 'external_untrusted' : 'clean', resident: false, verbatimQuote: quote, evidenceText: line.text,
        ...(cand.topicKey ? { topicKey: cand.topicKey } : {}), ...(cand.layer === 'm2' && cand.m2Kind ? { m2Kind: cand.m2Kind } : {}),
        ...(cand.importance !== undefined ? { importance: cand.importance } : {}), ...(cand.triggerKeys?.length ? { triggerKeys: { primary: cand.triggerKeys } } : {}),
      })
      if (res.kind === 'accepted') { accepted += 1; modifiedIds.push(res.entry.id, ...res.supersededIds) }
      else if (res.kind === 'conflict') conflicted += 1
    }
    return { accepted, conflicted, rejectedQuotes, modifiedIds }
  }

  private async executeOnce(input: {
    readonly sessionId: string
    readonly force?: boolean
    readonly runDeep?: boolean
    readonly trigger?: DreamRunReport['trigger']
    readonly defaultWorkspace?: string
    readonly maxBatches?: number
  }): Promise<DreamRunReport> {
    const trigger = input.trigger ?? 'manual'
    const maxBatches = Math.max(1, input.maxBatches ?? (trigger === 'ticket_end' ? 1 : trigger === 'idle' ? 2 : 4))
    const now = this.opts.now(), nowIso = now.toISOString(), nowMs = now.getTime()
    const cursors = { ...this.opts.getCursors() }
    const cur: DreamCursorState = cursors[input.sessionId] ?? { lastSeq: -1, failCount: 0, totalRuns: 0 }

    await this.opts.transcriptFts?.syncSession(this.opts.persistence, input.sessionId, this.opts.policy.maxClearance).catch(() => undefined)
    const lastDeepMs = cur.lastDeepAt ? Date.parse(cur.lastDeepAt) : NaN
    const doDeep = Boolean(input.runDeep) || !Number.isFinite(lastDeepMs) || nowMs - lastDeepMs >= DEEP_INTERVAL_MS
    let extracted = 0, accepted = 0, conflicted = 0, rejectedQuotes = 0, batchesProcessed = 0
    let firstFromSeq: number | undefined, advanceSeq = cur.lastSeq, failCount = cur.failCount
    let lastFailedRange = cur.lastFailedRange, outcomeStatus: DreamRunReport['status'] = 'completed', detail: string | undefined
    const modifiedIds: string[] = []

    for (let batch = 0; batch < maxBatches; batch++) {
      const slice: SessionWindowSlice = await readUnextractedSessionWindow(this.opts.persistence, input.sessionId, {
        afterSeq: advanceSeq, maxChars: 12_000, ...(this.opts.classifyTrigger ? { classifyTrigger: this.opts.classifyTrigger } : {}),
      })
      if (batch === 0 && !input.force && trigger === 'idle') {
        const lastRunMs = cur.lastRunAt ? Date.parse(cur.lastRunAt) : NaN
        if (Number.isFinite(lastRunMs) && nowMs - lastRunMs < IDLE_COOLDOWN_MS) return this.skippedReport(input.sessionId, trigger, cur.lastSeq, 'idle-cooldown')
        if (slice.lines.length < IDLE_MIN_LINES && slice.totalChars < IDLE_MIN_CHARS) return this.skippedReport(input.sessionId, trigger, cur.lastSeq, 'below-threshold')
      }
      if (slice.lines.length === 0) break
      if (firstFromSeq === undefined) firstFromSeq = slice.fromSeq

      const outcome = await this.opts.extractFn({ sessionId: input.sessionId, slice, signal: this.abortCtrl.signal })
      if (!outcome.ok) {
        if (outcome.status === 'unavailable') {
          detail = outcome.reason
          if (batchesProcessed === 0 && !doDeep) return this.skippedReport(input.sessionId, trigger, cur.lastSeq, outcome.reason)
          outcomeStatus = batchesProcessed > 0 ? 'completed' : 'skipped'
          break
        }
        const sameSpan = lastFailedRange?.fromSeq === slice.fromSeq && lastFailedRange?.throughSeq === slice.throughSeq
        if (sameSpan && failCount >= 1) {
          this.opts.appender.append({
            id: `mem:dream-unmeas:${randomUUID().slice(0, 12)}`, at: nowIso, stream: 'memory:dream',
            type: 'memory.dream.unmeasured', source: { kind: 'system', ref: 'dreamer' }, evidence: [], taint: 'trusted',
            payload: { sessionId: input.sessionId, fromSeq: slice.fromSeq, throughSeq: slice.throughSeq, reason: outcome.reason },
          })
          advanceSeq = slice.throughSeq; failCount = 0; lastFailedRange = undefined; detail = outcome.reason
          cursors[input.sessionId] = { ...cur, lastSeq: advanceSeq, lastRunAt: nowIso, failCount: 0, totalRuns: cur.totalRuns + 1, lastSummary: `circuit-breaker:${outcome.reason}` }
          this.opts.saveCursors(cursors)
          if (batchesProcessed === 0 && !slice.hasMore && !doDeep) {
            return { sessionId: input.sessionId, trigger, status: 'unmeasured', fromSeq: firstFromSeq, throughSeq: advanceSeq, batchesProcessed, extracted, accepted, conflicted, rejectedQuotes, promotedM4: 0, demotedResident: 0, deduped: 0, detail, at: nowIso }
          }
          if (batchesProcessed === 0) outcomeStatus = 'unmeasured'
          break
        }
        failCount = sameSpan ? failCount + 1 : 1
        lastFailedRange = { fromSeq: slice.fromSeq, throughSeq: slice.throughSeq }
        cursors[input.sessionId] = { ...cur, lastSeq: advanceSeq, lastRunAt: nowIso, failCount, lastFailedRange, totalRuns: cur.totalRuns + 1, lastSummary: `failed:${outcome.reason}` }
        this.opts.saveCursors(cursors)
        this.opts.appender.append({
          id: `mem:dream-fail:${randomUUID().slice(0, 12)}`, at: nowIso, stream: 'memory:dream',
          type: 'memory.dream.failed', source: { kind: 'system', ref: 'dreamer' }, evidence: [], taint: 'trusted',
          payload: { sessionId: input.sessionId, fromSeq: slice.fromSeq, throughSeq: slice.throughSeq, reason: outcome.reason },
        })
        if (batchesProcessed === 0) {
          return { sessionId: input.sessionId, trigger, status: 'failed', fromSeq: firstFromSeq, throughSeq: advanceSeq, batchesProcessed, extracted: 0, accepted: 0, conflicted: 0, rejectedQuotes: 0, promotedM4: 0, demotedResident: 0, deduped: 0, detail: outcome.reason, at: nowIso }
        }
        detail = outcome.reason
        break
      }

      extracted += outcome.candidates.length
      const res = await this.admitBatch({ sessionId: input.sessionId, trigger, slice, candidates: outcome.candidates, model: outcome.model, defaultWorkspace: input.defaultWorkspace, nowIso })
      accepted += res.accepted; conflicted += res.conflicted; rejectedQuotes += res.rejectedQuotes; modifiedIds.push(...res.modifiedIds)
      advanceSeq = slice.throughSeq; failCount = 0; lastFailedRange = undefined; batchesProcessed += 1
      cursors[input.sessionId] = { ...cur, lastSeq: advanceSeq, lastRunAt: nowIso, failCount: 0, totalRuns: cur.totalRuns + 1 }
      this.opts.saveCursors(cursors)
      if (!slice.hasMore) break
    }

    let deep = { promotedM4: 0, deduped: 0, demotedResident: 0 }
    if (doDeep) {
      const deepRef = this.opts.appender.append({
        id: `mem:dream-deep:${randomUUID().slice(0, 12)}`, at: nowIso, stream: 'memory:dream',
        type: 'memory.dream.deep', source: { kind: 'system', ref: 'dreamer' }, evidence: [], taint: 'trusted',
        payload: { sessionId: input.sessionId, trigger },
      })
      deep = await runDeepConsolidation({ memoryDir: this.opts.memoryDir, writer: this.opts.memory, policy: this.opts.policy, batchRef: deepRef, now: this.opts.now })
    }

    if (accepted + deep.promotedM4 + deep.deduped + deep.demotedResident > 0) {
      await this.opts.ftsIndex.rebuild().catch(() => undefined)
      this.opts.onUpdated?.(modifiedIds)
    }

    cursors[input.sessionId] = {
      lastSeq: advanceSeq, lastRunAt: nowIso, ...(doDeep ? { lastDeepAt: nowIso } : cur.lastDeepAt ? { lastDeepAt: cur.lastDeepAt } : {}),
      failCount, ...(lastFailedRange ? { lastFailedRange } : {}), totalRuns: cur.totalRuns + 1,
      lastSummary: `ok:b=${batchesProcessed},ext=${extracted},acc=${accepted},m4=${deep.promotedM4},dem=${deep.demotedResident}`,
    }
    this.opts.saveCursors(cursors)
    this.opts.appender.append({
      id: `mem:dream-done:${randomUUID().slice(0, 12)}`, at: nowIso, stream: 'memory:dream',
      type: 'memory.dream.completed', source: { kind: 'system', ref: 'dreamer' }, evidence: [], taint: 'trusted',
      payload: { sessionId: input.sessionId, trigger, status: outcomeStatus, batchesProcessed, extracted, accepted, conflicted, rejectedQuotes, ...deep },
    })
    return {
      sessionId: input.sessionId, trigger, status: outcomeStatus, fromSeq: firstFromSeq ?? advanceSeq, throughSeq: advanceSeq,
      batchesProcessed, extracted, accepted, conflicted, rejectedQuotes, ...deep, ...(detail ? { detail } : {}), at: nowIso,
    }
  }
}
