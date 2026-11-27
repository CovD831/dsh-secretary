/** 老板黄金评测集执行器：端到端测准直接召回率、话中纠偏覆写率、红线防复活、压缩后转录检索与零误召回。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { GitRepoLock, createGitShardSink, createSpineAppender, createSpineFlusher, ensureSpineSchema } from '../spine/index.ts'
import { Store } from '../app/store.ts'
import { MemoryFtsIndex } from './fts-index.ts'
import { assembleMemoryPrompt } from './recall.ts'
import { TranscriptFtsIndex } from './transcript-fts.ts'
import type { FactLayer, M2Kind, MemoryScope, SourceType, TriggerKeys } from './types.ts'
import { MemoryWriter } from './writer.ts'

export type GoldCaseBucket =
  | 'direct_recall' | 'live_override' | 'veto_anti_resurrection' | 'post_compaction_transcript' | 'anti_noise_empty'

export interface GoldSeedEntry {
  readonly layer: FactLayer
  readonly scope: MemoryScope
  readonly sourceType: SourceType
  readonly statement: string
  readonly slug?: string
  readonly workspaceKey?: string
  readonly topicKey?: string
  readonly m2Kind?: M2Kind
  readonly triggerKeys?: TriggerKeys
  readonly verbatimQuote?: string
  readonly evidenceText?: string
  readonly workspacesSeen?: readonly string[]
  readonly seenCount?: number
  readonly tombstoneReason?: string
}

export interface GoldEvalCase {
  readonly id: string
  readonly bucket: GoldCaseBucket
  readonly query: string
  readonly seed?: readonly GoldSeedEntry[]
  readonly resurrectAttempt?: GoldSeedEntry
  readonly transcriptLines?: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[]
  readonly expectContains?: readonly string[]
  readonly expectAbsent?: readonly string[]
  readonly expectEmpty?: boolean
}

export interface GoldEvalReport {
  readonly totalCases: number
  readonly recallAt5: number
  readonly overrideAccuracy: number
  readonly vetoBlockRate: number
  readonly transcriptRecallRate: number
  readonly falseRecallCount: number
  readonly avgLatencyMs: number
  readonly failures: readonly { readonly id: string; readonly bucket: GoldCaseBucket; readonly reason: string }[]
  readonly passed: boolean
}

function makeFakePersistence(sessionId: string, lines: readonly { role: 'user' | 'assistant'; text: string }[]): Pick<SessionPersistence, 'flush' | 'open'> {
  const events: SessionEvent[] = lines.map((l, idx) => (l.role === 'user'
    ? { seq: idx, time: 1_760_000_000_000 + idx * 1000, type: 'user/message', op: 'append', sourceEventSeqs: [], data: { id: `u-${idx}`, role: 'user', content: [{ type: 'text', text: l.text }], source: { kind: 'user' } } }
    : { seq: idx, time: 1_760_000_000_000 + idx * 1000, type: 'assistant/message', op: 'append', sourceEventSeqs: [], data: { id: `a-${idx}`, role: 'assistant', message: { id: `m-${idx}`, role: 'assistant', content: [{ type: 'text', text: l.text }] } } }) as unknown as SessionEvent)
  return {
    flush: async () => undefined,
    open: (async (id: string) => ({
      async read(offset: number, limit: number) {
        if (id !== sessionId) return { events: [], eof: true }
        const slice = events.slice(offset, offset + limit)
        return { events: slice, eof: offset + slice.length >= events.length }
      },
      async [Symbol.asyncDispose]() {},
    })) as unknown as SessionPersistence['open'],
  }
}

/** 对给定黄金评测集执行隔离端到端回放（临时目录，绝不触碰宿主 `~/.dsh`）。 */
export async function evaluateMemoryGoldSet(cases: readonly GoldEvalCase[]): Promise<GoldEvalReport> {
  const now = new Date('2026-11-28T08:00:00.000Z')
  const caller = { role: 'secretary' as const, maxClearance: 'private' as const }
  const counters = { directHit: 0, directTot: 0, overHit: 0, overTot: 0, vetoBlocked: 0, vetoTot: 0, trHit: 0, trTot: 0, falseRecallCount: 0 }
  const failures: { id: string; bucket: GoldCaseBucket; reason: string }[] = []
  let latencySum = 0

  for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), `gold-eval-${c.id}-`))
    const store = new Store(join(dir, 's.sqlite'))
    try {
      ensureSpineSchema(store.db)
      const lock = new GitRepoLock(), memDir = join(dir, 'mem')
      const sink = createGitShardSink({ dir: memDir, lock })
      const flusher = createSpineFlusher(store.db, sink)
      const appender = createSpineAppender(store, { kick: () => {} })
      const writer = new MemoryWriter({ dir: memDir, lock, now: () => now })
      const fts = new MemoryFtsIndex({ memoryDir: memDir, dbPath: join(dir, 'fts.sqlite'), now: () => now })
      const tFts = new TranscriptFtsIndex({ dbPath: join(dir, 'tfts.sqlite'), now: () => now })
      await writer.init()

      const seedWrite = async (s: GoldSeedEntry, idx: number) => {
        const ref = appender.append({ id: `${c.id}-${idx}`, at: now.toISOString(), stream: `memory:${s.layer}`, type: 'trigger.received', source: { kind: 'human', ref: 'boss' }, evidence: [], taint: 'trusted', payload: {} })
        return writer.propose({
          layer: s.layer, scope: s.scope, sourceType: s.sourceType, sourceRef: ref, author: s.sourceType.startsWith('user_') ? 'user' : 'secretary',
          statement: s.statement, ...(s.slug ? { slug: s.slug } : {}), ...(s.workspaceKey ? { workspaceKey: s.workspaceKey } : {}),
          ...(s.topicKey ? { topicKey: s.topicKey } : {}), ...(s.m2Kind ? { m2Kind: s.m2Kind } : {}), ...(s.triggerKeys ? { triggerKeys: s.triggerKeys } : {}),
          ...(s.verbatimQuote ? { verbatimQuote: s.verbatimQuote } : {}), ...(s.evidenceText ? { evidenceText: s.evidenceText } : {}),
          ...(s.workspacesSeen ? { workspacesSeen: s.workspacesSeen } : {}), ...(s.seenCount !== undefined ? { seenCount: s.seenCount } : {}),
        })
      }

      for (const [idx, s] of (c.seed ?? []).entries()) {
        const res = await seedWrite(s, idx)
        if (s.tombstoneReason && res.kind === 'accepted') {
          await writer.tombstone({
            target: { layer: s.layer, ...(s.slug ? { slug: s.slug } : {}), ...(s.workspaceKey ? { workspaceKey: s.workspaceKey } : {}) },
            entryId: res.entry.id, reason: s.tombstoneReason, sourceRef: res.entry.sourceRef, author: 'user',
          })
        }
      }

      let blockedResurrect = true
      if (c.resurrectAttempt) {
        const rr = await seedWrite(c.resurrectAttempt, 99)
        blockedResurrect = rr.kind !== 'accepted'
      }
      if (c.transcriptLines?.length) {
        await tFts.syncSession(makeFakePersistence('sess-gold', c.transcriptLines), 'sess-gold', 'private')
      }

      await fts.rebuild()
      const t0 = Date.now()
      const memRes = await assembleMemoryPrompt({ dir: memDir, caller, query: c.query, ftsIndex: fts, now })
      const trHits = c.bucket === 'post_compaction_transcript' ? await tFts.search(c.query, caller, { limit: 5 }) : []
      latencySum += Date.now() - t0
      fts.close(); tFts.close()
      await flusher.flush()

      const combined = [memRes.text, ...trHits.map(h => h.snippet)].join('\n')
      const hasAll = (c.expectContains ?? []).every(sub => combined.includes(sub))
      const absentOk = (c.expectAbsent ?? []).every(sub => !combined.includes(sub))
      const isEmpty = memRes.triggeredEntries.length === 0 && memRes.retrievedEntries.length === 0 && trHits.length === 0
      const ok = hasAll && absentOk && (!c.expectEmpty || isEmpty) && blockedResurrect

      if (c.bucket === 'direct_recall') { counters.directTot += 1; if (ok) counters.directHit += 1 }
      else if (c.bucket === 'live_override') { counters.overTot += 1; if (ok) counters.overHit += 1 }
      else if (c.bucket === 'veto_anti_resurrection') { counters.vetoTot += 1; if (blockedResurrect && ok) counters.vetoBlocked += 1 }
      else if (c.bucket === 'post_compaction_transcript') { counters.trTot += 1; if (ok) counters.trHit += 1 }
      else if (c.bucket === 'anti_noise_empty' && !ok) counters.falseRecallCount += 1
      if (!ok) failures.push({ id: c.id, bucket: c.bucket, reason: `hasAll=${hasAll}, absentOk=${absentOk}, blocked=${blockedResurrect}, isEmpty=${isEmpty}` })
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const ratio = (hit: number, tot: number) => tot > 0 ? hit / tot : 1
  const recallAt5 = ratio(counters.directHit, counters.directTot)
  const overrideAccuracy = ratio(counters.overHit, counters.overTot)
  const vetoBlockRate = ratio(counters.vetoBlocked, counters.vetoTot)
  const transcriptRecallRate = ratio(counters.trHit, counters.trTot)
  const passed = recallAt5 >= 0.9 && overrideAccuracy === 1 && vetoBlockRate === 1 && transcriptRecallRate >= 0.9 && counters.falseRecallCount === 0
  return {
    totalCases: cases.length, recallAt5, overrideAccuracy, vetoBlockRate, transcriptRecallRate,
    falseRecallCount: counters.falseRecallCount, avgLatencyMs: cases.length ? latencySum / cases.length : 0, failures, passed,
  }
}
