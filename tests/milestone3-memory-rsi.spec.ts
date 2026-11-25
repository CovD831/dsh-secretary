/** 里程碑 3 红绿与防作弊验证：可信记忆硬护栏、SQLite FTS5 重建与 M0 降级、生命周期指标、M0 在线收集回填、LOO 消融与温度校准。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { validateDepositDraft } from '../src/authoring/funnel.ts'
import { matchPitfalls } from '../src/context/capsule.ts'
import { createJudgementRegistry } from '../src/judgement/registry.ts'
import type { RegistryEntry } from '../src/judgement/types.ts'
import {
  assembleMemoryPrompt, computeMemoryBelievabilityMetrics, loadWorkspacePitfallNotes,
  MemoryFtsIndex, MemoryWriter, proposeTicketMemoryPatches, RECIPE_FINGERPRINT,
  searchM0Fallback, tickM6AttentionLifecycle, writeUserDirectMemory,
} from '../src/memory/index.ts'
import {
  bootstrapDeltaCI, buildCalibratedGateRecord, calibrateProbability, classifyThresholdBand,
  collectOnlineRsiSnapshot, computeExpectedCalibrationError, evaluateSealedHoldout,
  evaluateSweepAndHoldout, fitTemperatureScaler, runLeaveOneOutAblation, splitByFamily,
  type ReplayCase,
} from '../src/rsi/index.ts'
import { createGitShardSink, createSpineAppender, createSpineFlusher, ensureSpineSchema, GitRepoLock } from '../src/spine/index.ts'
import type { SpineDraft, SpineEnvelope } from '../src/spine/types.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const mkDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }

describe('里程碑 3A：记忆写时护栏、FTS5 可删重建与 M0 原文降级', () => {
  it('resident-budget-exceeded、expectedRevision CAS 冲突拒绝与全路径脱敏审计事件', async () => {
    const dir = mkDir('h3-mem-guard-')
    const audits: SpineDraft<Record<string, unknown>>[] = []
    let now = new Date('2026-11-25T10:00:00.000Z')
    const writer = new MemoryWriter({
      dir, lock: new GitRepoLock(), now: () => now, residentMaxChars: 110,
      onAuditEvent: d => audits.push(d),
    })

    const w1 = await writer.propose({
      layer: 'm2', scope: 'global', sourceType: 'user_direct', m2Kind: 'preference',
      resident: true, expectedRevision: 0, author: 'user', sourceRef: { seq: 1, id: 'ev-1' },
      statement: 'Always report conclusion before evidence',
    })
    expect(w1.kind).toBe('accepted')
    expect(audits.map(a => a.type)).toEqual(['memory.proposed', 'memory.accepted'])

    const casFail = await writer.propose({
      layer: 'm2', scope: 'global', sourceType: 'user_direct', m2Kind: 'preference',
      expectedRevision: 0, author: 'user', sourceRef: { seq: 2, id: 'ev-2' },
      statement: 'Stale revision proposal must fail',
    })
    expect(casFail).toMatchObject({ kind: 'rejected', reason: 'revision-conflict' })
    expect(audits.at(-1)?.type).toBe('memory.rejected')

    const budgetFail = await writer.propose({
      layer: 'm2', scope: 'global', sourceType: 'user_direct', m2Kind: 'preference',
      resident: true, expectedRevision: 1, author: 'user', sourceRef: { seq: 3, id: 'ev-3' },
      statement: 'Second long resident preference exceeding one hundred ten characters total budget',
    })
    expect(budgetFail).toMatchObject({ kind: 'rejected', reason: 'resident-budget-exceeded' })

    const secretFail = await writer.propose({
      layer: 'm1', slug: 'sec', scope: 'global', sourceType: 'session', author: 'secretary',
      sourceRef: { seq: 4, id: 'ev-4' }, statement: 'Leak sk-proj-abc1234567890SECRETKEY',
    })
    expect(secretFail).toMatchObject({ kind: 'rejected', reason: 'secret-detected' })
    expect(JSON.stringify(audits)).not.toContain('sk-proj-abc1234567890SECRETKEY')

    if (w1.kind !== 'accepted') throw new Error('expected accepted')
    const att = await writer.upsertAttention({ kind: 'ruling', question: 'Confirm?', sourceRefs: [{ seq: 5, id: 'ev-5' }] })
    await writer.transitionAttention({ id: att.item.id, action: 'approve' }, 'user')
    await writer.tombstone({ target: { layer: 'm2' }, entryId: w1.entry.id, reason: 'obsolete', sourceRef: { seq: 6, id: 'ev-6' }, author: 'user' })
    expect(audits.some(a => a.type === 'memory.tombstoned')).toBe(true)
  })

  it('SQLite FTS5 删库/损坏/指纹失配自动重建 + M0 权限受控降级 + assembleMemoryPrompt 集成', async () => {
    const dir = mkDir('h3-fts-')
    const memDir = join(dir, 'memory')
    const dbPath = join(dir, 'derived', 'fts.sqlite')
    const store = new Store(join(dir, 'orch.sqlite'))
    ensureSpineSchema(store.db)
    const sink = createGitShardSink({ dir: memDir })
    const flusher = createSpineFlusher(store.db, sink)
    const appender = createSpineAppender(store, { kick: () => {} })
    const writer = new MemoryWriter({ dir: memDir, lock: sink.lock })

    const r1 = appender.append({ id: 'ev-fts-1', stream: 'memory:m1', type: 'note.recorded', source: { kind: 'secretary', ref: 'sec' }, evidence: [], taint: 'trusted', payload: { statement: 'FTS note' } })
    const r2 = appender.append({ id: 'ev-fts-2', stream: 'ticket:T-B', type: 'ticket.note', source: { kind: 'worker', ref: 'w' }, evidence: [], taint: 'trusted', payload: { workspace: 'ws-b', statement: 'Secret ws-b deployment token hint' } })
    const r3 = appender.append({ id: 'ev-fts-3', stream: 'ticket:T-A', type: 'ticket.note', source: { kind: 'worker', ref: 'w' }, evidence: [], taint: 'trusted', payload: { workspace: 'ws-a', statement: 'Legacy ws-a retry fallback evidence' } })
    await flusher.flush()

    const m1 = await writer.propose({ layer: 'm1', slug: 'tdd', scope: 'global', sourceType: 'user_direct', author: 'user', sourceRef: r1, statement: '强制执行红绿测试与 SQLite WAL 检查' })
    await writer.propose({ layer: 'm3', workspaceKey: 'ws-a', slug: 'build', scope: 'workspace:ws-a', sourceType: 'session', author: 'secretary', sourceRef: r3, statement: 'Run pnpm typecheck in ws-a' })
    await writer.propose({ layer: 'm2', scope: 'global', sourceType: 'user_direct', author: 'user', clearance: 'private', sourceRef: r2, statement: '老板私人偏好：禁止自动合并' })

    const fts = new MemoryFtsIndex({ memoryDir: memDir, dbPath })
    const open1 = await fts.open()
    expect(open1).toEqual({ rebuilt: true, indexedEntries: 3 })
    expect(fts.getMeta()?.recipeFingerprint).toBe(RECIPE_FINGERPRINT)

    const zhHit = await fts.search('红绿测试', { role: 'worker', workspaceId: 'ws-a', maxClearance: 'workspace' })
    expect(zhHit.hits.map(h => h.entry.statement)).toEqual(['强制执行红绿测试与 SQLite WAL 检查'])
    expect(zhHit.usedFallback).toBe(false)

    // 删库后自动从 Markdown 重建
    fts.close()
    rmSync(dbPath, { force: true })
    const afterDelete = await fts.search('SQLite WAL', { role: 'secretary', maxClearance: 'private' })
    expect(afterDelete.rebuilt).toBe(true)
    expect(afterDelete.hits.length).toBeGreaterThanOrEqual(1)

    // 指纹失配 & 文件损坏均自动从 Markdown 重建
    fts.close()
    const rawDb = new DatabaseSync(dbPath)
    rawDb.exec("UPDATE index_meta SET recipe_fingerprint = 'stale-v0' WHERE id = 1")
    rawDb.close()
    expect((await fts.open()).rebuilt).toBe(true)

    fts.close()
    writeFileSync(dbPath, 'CORRUPT-BYTES-NOT-SQLITE', 'utf8')
    expect((await fts.open()).rebuilt).toBe(true)

    // FTS 空结果时走 M0 原文受控降级（严守 worker 工作区与密级隔离）
    const fallbackWorkerA = await fts.search('fallback evidence', { role: 'worker', workspaceId: 'ws-a', maxClearance: 'workspace' })
    expect(fallbackWorkerA.usedFallback).toBe(true)
    expect(fallbackWorkerA.m0FallbackHits.some(h => h.id === 'ev-fts-3')).toBe(true)
    const fallbackBlockedB = await searchM0Fallback(memDir, 'ws-b deployment', { role: 'worker', workspaceId: 'ws-a', maxClearance: 'workspace' })
    expect(fallbackBlockedB).toHaveLength(0)

    // assembleMemoryPrompt 挂载 ftsIndex：已墓碑条目即使 FTS 未重刷也绝不复活
    if (m1.kind !== 'accepted') throw new Error('expected m1 accepted')
    const promptBefore = await assembleMemoryPrompt({ dir: memDir, caller: { role: 'secretary', maxClearance: 'private' }, query: '红绿测试', ftsIndex: fts })
    expect(promptBefore.retrievedEntries.some(e => e.id === m1.entry.id)).toBe(true)
    await writer.tombstone({ target: { layer: 'm1', slug: 'tdd' }, entryId: m1.entry.id, reason: 'superseded', sourceRef: r1, author: 'user' })
    const promptAfter = await assembleMemoryPrompt({ dir: memDir, caller: { role: 'secretary', maxClearance: 'private' }, query: '红绿测试', ftsIndex: fts })
    expect(promptAfter.retrievedEntries.some(e => e.id === m1.entry.id)).toBe(false)

    fts.close()
    store.close()
  })
})

describe('里程碑 3B：老板直改、M3 避坑桥接、逐字 Patch、M6 衰减与三项可信指标', () => {
  it('writeUserDirectMemory、loadWorkspacePitfallNotes、proposeTicketMemoryPatches、tickM6 与可信指标', async () => {
    const dir = mkDir('h3-lifecycle-')
    const memDir = join(dir, 'memory')
    const store = new Store(join(dir, 'orch.sqlite'))
    ensureSpineSchema(store.db)
    const appender = createSpineAppender(store, { kick: () => {} })
    let now = new Date('2026-11-25T00:00:00.000Z')
    const writer = new MemoryWriter({ dir: memDir, lock: new GitRepoLock(), now: () => now })

    const first = await writeUserDirectMemory(writer, appender, { statement: 'Reply in English only', topicKey: 'reply-lang', resident: true, now })
    expect(first.writeResult.kind).toBe('accepted')
    const second = await writeUserDirectMemory(writer, appender, { statement: 'Reply in concise Chinese', topicKey: 'reply-lang', resident: true, now })
    expect(second.writeResult.kind).toBe('accepted')
    expect(second.tombstonedIds).toHaveLength(1)

    if (second.writeResult.kind !== 'accepted') throw new Error('expected accepted')
    await writer.tombstone({ target: { layer: 'm2' }, entryId: second.writeResult.entry.id, reason: 'removed by owner', sourceRef: second.sourceRef, author: 'user' })
    const blocked = await writeUserDirectMemory(writer, appender, { statement: 'Reply in concise Chinese', topicKey: 'reply-lang', now })
    expect(blocked.writeResult).toMatchObject({ kind: 'rejected', reason: 'tombstone-blocked' })
    const overridden = await writeUserDirectMemory(writer, appender, { statement: 'Reply in concise Chinese', topicKey: 'reply-lang', overrideTombstone: true, now })
    expect(overridden.writeResult.kind).toBe('accepted')

    const ref3 = appender.append({ id: 'm3-ref', stream: 'ticket:T1', type: 'ticket.created', source: { kind: 'system', ref: 'test' }, evidence: [], taint: 'trusted', payload: {} })
    await writer.propose({
      layer: 'm3', workspaceKey: 'repo-a', slug: 'pitfalls', scope: 'workspace:repo-a', sourceType: 'session', sourceRef: ref3, author: 'secretary',
      statement: 'Use node:sqlite instead of better-sqlite3', triggerKeys: { primary: ['sqlite'], secondary: ['legacy'], logic: 'NOT_ANY' },
    })
    const notes = await loadWorkspacePitfallNotes(memDir, 'repo-a', now)
    expect(notes).toHaveLength(1)
    expect(matchPitfalls('migrate sqlite schema', notes)).toHaveLength(1)
    expect(matchPitfalls('migrate legacy sqlite schema', notes)).toHaveLength(0)
    await expect(loadWorkspacePitfallNotes(memDir, '../escape')).rejects.toThrow(/非法记忆路径段/)

    const patches = await proposeTicketMemoryPatches({
      memoryDir: memDir,
      candidates: [
        { layer: 'm3', workspaceKey: 'repo-a', slug: 'p1', scope: 'workspace:repo-a', sourceRef: ref3, statement: 'Missing quote', verbatimQuote: 'not in evidence', evidenceText: 'actual log text' },
        { layer: 'm3', workspaceKey: 'repo-a', slug: 'p2', scope: 'workspace:repo-a', sourceRef: ref3, topicKey: 'verify-before-commit', patternKey: 'verify-before-commit', statement: 'Run typecheck before commit', verbatimQuote: 'Run typecheck before commit', evidenceText: 'Log: Run typecheck before commit passed' },
        { layer: 'm3', workspaceKey: 'repo-b', slug: 'p2', scope: 'workspace:repo-b', sourceRef: ref3, topicKey: 'verify-before-commit', patternKey: 'verify-before-commit', statement: 'Run typecheck before commit', verbatimQuote: 'Run typecheck before commit', evidenceText: 'Log: Run typecheck before commit passed' },
      ],
    })
    expect(patches.rejected).toHaveLength(1)
    expect(patches.rejected[0]!.reason).toBe('verbatim-quote-mismatch')
    expect(patches.m4Proposals).toHaveLength(1)
    expect(patches.m4Proposals[0]).toMatchObject({ layer: 'm4', expectedRevision: 0, workspacesSeen: ['repo-a', 'repo-b'] })

    const { item: attAsk } = await writer.upsertAttention({ kind: 'ruling', question: 'Confirm deploy?', sourceRefs: [ref3], stickyTurns: 1, delaySeen: 1 })
    const { item: attDelay } = await writer.upsertAttention({ kind: 'verification', question: 'Verify flake?', sourceRefs: [ref3], delaySeen: 3, seenCount: 1 })
    const { item: attOld } = await writer.upsertAttention({ kind: 'conflict', question: 'Old conflict?', sourceRefs: [ref3] })
    await writer.transitionAttention({ id: attAsk.id, action: 'ask' })
    const tick1 = await tickM6AttentionLifecycle(writer, memDir, now)
    expect(tick1.tickedIds).toContain(attAsk.id)
    expect(tick1.seenIds).toContain(attDelay.id)
    now = new Date('2026-12-12T00:00:00.000Z')
    const tickExpire = await tickM6AttentionLifecycle(writer, memDir, now)
    expect(tickExpire.expiredIds).toContain(attOld.id)

    const spineForMetrics: SpineEnvelope[] = [
      { v: 1, seq: 1, id: 'q1', at: '2026-11-24T00:00:00Z', stream: 'secretary:dialog', type: 'secretary.ask', source: { kind: 'secretary', ref: 's' }, evidence: [], taint: 'trusted', payload: { rulingId: 'r1', question: 'Enable auto deploy?' } },
      { v: 1, seq: 2, id: 'q2', at: '2026-11-25T00:00:00Z', stream: 'secretary:dialog', type: 'secretary.ask', source: { kind: 'secretary', ref: 's' }, evidence: [], taint: 'trusted', payload: { rulingId: 'r2', question: 'Enable auto deploy?' } },
      { v: 1, seq: 3, id: 'fr1', at: '2026-11-25T01:00:00Z', stream: 'memory:recall', type: 'memory.recall.dropped', source: { kind: 'secretary', ref: 's' }, evidence: [], taint: 'trusted', payload: { citedEntryIds: [second.writeResult.entry.id, 'mem-m1-nonexistent'] } },
      { v: 1, seq: 4, id: 'old-c', at: '2026-11-01T00:00:00Z', stream: 'memory:m1', type: 'memory.tombstoned', source: { kind: 'human', ref: 'user' }, evidence: [], taint: 'trusted', payload: { entryId: 'mem-old-1' } },
    ]
    const metrics = await computeMemoryBelievabilityMetrics(memDir, spineForMetrics, '2026-11-25T12:00:00.000Z')
    expect(metrics.repeatQuestionRate).toBeGreaterThan(0)
    expect(metrics.falseRecallCount).toBe(2)
    expect(metrics.weeklyCorrectedMemories).toBeGreaterThanOrEqual(2)
    store.close()
  })
})

describe('里程碑 3C：M0 在线收集回填、Seen>=3 跨日聚类、Bootstrap CI、Holdout、LOO 消融与温度校准', () => {
  it('M0 -> L1–L13 回填、四分归因分母、Seen>=3 跨 3 自然日才产 Rung 1 草案与原生指标串联', async () => {
    const mkEv = (seq: number, at: string, type: SpineEnvelope['type'], ticketId: string, payload: Record<string, unknown>, taint: SpineEnvelope['taint'] = 'trusted'): SpineEnvelope => ({
      v: 1, seq, id: `ev-${seq}`, at, stream: `ticket:${ticketId}`, type, source: { kind: 'system', ref: 'test' },
      evidence: [{ kind: 'event', ref: `session:w-${ticketId}#0-1` }], taint, payload: { ticketId, ...payload },
    })
    const events: SpineEnvelope[] = [
      mkEv(1, '2026-11-20T10:00:00Z', 'gate.evaluated', 'T1', { point: 'verify.rerun', verdict: { kind: 'deny', blockers: ['b'] }, clusterKey: 'same-day-cluster' }),
      mkEv(2, '2026-11-20T11:00:00Z', 'gate.evaluated', 'T1', { point: 'verify.rerun', verdict: { kind: 'deny', blockers: ['b'] }, clusterKey: 'same-day-cluster' }),
      mkEv(3, '2026-11-21T10:00:00Z', 'gate.evaluated', 'T1', { point: 'verify.rerun', verdict: { kind: 'deny', blockers: ['b'] }, clusterKey: 'same-day-cluster' }),
      mkEv(4, '2026-11-21T12:00:00Z', 'gate.evaluated', 'T1', { point: 'verify.rerun', verdict: { kind: 'allow' } }),
      mkEv(5, '2026-11-21T13:00:00Z', 'worker.tool_finished', 'T1', { toolName: 'bash', callId: 'c1', isError: true, clusterKey: 'bash-err-3days' }),
      mkEv(6, '2026-11-22T13:00:00Z', 'worker.tool_finished', 'T2', { toolName: 'bash', callId: 'c2', isError: true, clusterKey: 'bash-err-3days' }),
      mkEv(7, '2026-11-23T13:00:00Z', 'worker.tool_finished', 'T3', { toolName: 'bash', callId: 'c3', isError: true, clusterKey: 'bash-err-3days' }),
      mkEv(8, '2026-11-23T14:00:00Z', 'ticket.circuit_broken', 'T2', { reason: 'maxTurns' }),
      mkEv(9, '2026-11-23T15:00:00Z', 'ticket.resumed', 'T2', { triggerId: 'tr2' }),
      mkEv(10, '2026-11-23T16:00:00Z', 'ruling.queued', 'T2', { question: 'Allow?' }, 'untrusted'),
      mkEv(11, '2026-11-23T17:00:00Z', 'escalation.ruled', 'T2', { attribution: 'missing_rule', decision: 'reject', naturalLabel: 'L7:ruling_decided' }),
      mkEv(12, '2026-11-23T18:00:00Z', 'memory.rejected', 'T2', { reason: 'topic-conflict' }),
      mkEv(13, '2026-11-23T19:00:00Z', 'memory.tombstoned', 'T2', { entryId: 'mem-1' }),
      mkEv(14, '2026-11-23T20:00:00Z', 'memory.recall.dropped', 'T2', { droppedIds: ['mem-2'] }),
      mkEv(15, '2026-11-23T21:00:00Z', 'gate.evaluated', 'T3', { point: 'verify.changed-paths', verdict: { kind: 'unmeasured', cause: 'shell-blind', detail: 'bash' } }),
      mkEv(16, '2026-11-23T22:00:00Z', 'authoring.abandoned_at', 'T3', { atStage: 'S2_cases' }),
      mkEv(17, '2026-11-24T10:00:00Z', 'ticket.ended', 'T1', { outcome: 'completed' }),
      mkEv(18, '2026-11-24T11:00:00Z', 'ticket.ended', 'T4', { outcome: 'completed' }),
      mkEv(19, '2026-11-24T12:00:00Z', 'escalation.ruled', 'T4', { attribution: 'wrong_rule', decision: 'approve', naturalLabel: 'L7:ruling_decided' }),
    ]
    const sessionLog: SessionEvent[] = [
      { type: 'tool/call', seq: SessionSeq(0), time: 1000, data: { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'bash', arguments: '{}' } },
      { type: 'tool/result', seq: SessionSeq(1), time: 2000, surfaceOp: 'append', data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'err\n[exit code: 1]' }], isError: true }) } },
      { type: 'assistant/message', seq: SessionSeq(2), time: 3000, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'm1' as never, role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [], usage: { inputTokens: 10, outputTokens: 5 } } },
    ]
    const snap = await collectOnlineRsiSnapshot({
      events,
      persistence: {
        flush: async () => {},
        open: async id => {
          if (String(id) !== 'w-T1') throw new Error('missing')
          let done = false
          return { read: async () => ({ eventState: 'detached', events: done ? [] : (done = true, sessionLog) }), close: async () => {}, [Symbol.asyncDispose]: async () => {} } as never
        },
      },
    })
    for (const k of ['L1:verify_failed', 'L2:gate_denied_fixed', 'L3:rework_retry', 'L4:circuit_broken', 'L5:tool_error', 'L6:escalation_queued', 'L7:ruling_decided', 'L8:memory_rejected', 'L9:memory_corrected', 'L10:recall_dropped', 'L11:unmeasured_gap', 'L12:external_taint', 'L13:draft_abandoned'] as const) {
      expect(snap.labelCounts[k], k).toBeGreaterThanOrEqual(1)
    }
    expect(snap.attribution.totalTickets).toBe(4)
    expect(snap.attribution.totalToolExecutions).toBeGreaterThanOrEqual(3)
    expect(snap.attribution.counts).toMatchObject({ missing_rule: 2, wrong_rule: 1, unmeasurable: 1, rule_conflict: 1 })
    expect(snap.behavioralMetrics.executedTasks).toBeGreaterThanOrEqual(2)
    expect(snap.clusters.find(c => c.key === 'same-day-cluster')?.qualifiesForRung1).toBe(false)
    expect(snap.candidateDrafts).toHaveLength(1)
    const draft = snap.candidateDrafts[0]!
    expect(draft).toMatchObject({ kind: 'counter-rule', stage: 'shadow', enforce: false, actionClass: 'observe' })
    expect(validateDepositDraft(draft)).toMatchObject({ ok: false, gate: 'evidence' })
  })

  it('Bootstrap 95% CI 跨 0 返回 unmeasured、Holdout <0.5 拒晋升 + holdout.opened、LOO 消融与温度校准 ECE 改善', async () => {
    expect(() => bootstrapDeltaCI([1, 2], { seeds: [1, 2] })).toThrow(/3/)
    const crossing = bootstrapDeltaCI([1, -1, 1, -1, 0, 1, -1, 0])
    expect(crossing).toMatchObject({ verdict: 'unmeasured', crossesZero: true })
    const clearGain = bootstrapDeltaCI([1, 1, 1, 1, 1, 1, 1, 1])
    expect(clearGain).toMatchObject({ verdict: 'improved', crossesZero: false })

    const cases: ReplayCase<{ inTrain: boolean; isDefect: boolean }>[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `tr-${i}`, family: `fam-t-${i % 3}`, expectedOutcome: (i % 2 === 0 ? 'defect' : 'clean') as 'defect' | 'clean', input: { inTrain: true, isDefect: i % 2 === 0 } })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `ho-${i}`, family: `fam-h-${i % 3}`, expectedOutcome: (i % 2 === 0 ? 'defect' : 'clean') as 'defect' | 'clean', input: { inTrain: false, isDefect: i % 2 === 0 } })),
    ]
    const split = splitByFamily(cases, { train: 0.5, validation: 0, holdout: 0.5 }, 1)
    const trainIds = new Set(split.train.map(c => c.id))
    const baseGate = () => ({ kind: 'allow' as const })
    const overfitGate = (inp: { inTrain: boolean; isDefect: boolean }, item: ReplayCase<{ inTrain: boolean; isDefect: boolean }>) =>
      trainIds.has(item.id) && inp.isDefect ? { kind: 'deny' as const, blockers: ['train-only'] as const } : { kind: 'allow' as const }
    const rejectedHo = await evaluateSealedHoldout({ baselineGate: baseGate, candidateGate: overfitGate, split, candidateId: 'overfit-1' })
    expect(rejectedHo.promoted).toBe(false)
    expect(rejectedHo.generalizationRatio!).toBeLessThan(0.5)
    expect(rejectedHo.auditEvent.type).toBe('holdout.opened')

    const goodGate = (inp: { inTrain: boolean; isDefect: boolean }) =>
      inp.isDefect ? { kind: 'deny' as const, blockers: ['caught'] as const } : { kind: 'allow' as const }
    const passedHo = await evaluateSealedHoldout({ baselineGate: baseGate, candidateGate: goodGate, split, candidateId: 'good-1' })
    expect(passedHo.promoted).toBe(true)
    expect(passedHo.generalizationRatio!).toBeGreaterThanOrEqual(0.5)
    expect(passedHo.auditEvent.type).toBe('holdout.opened')

    const sweepRes = await evaluateSweepAndHoldout(
      (p: { catchDefects: boolean }) => (inp: { inTrain: boolean; isDefect: boolean }) => p.catchDefects && inp.isDefect ? { kind: 'deny' as const, blockers: ['caught'] as const } : { kind: 'allow' as const },
      [{ catchDefects: false }, { catchDefects: true }], cases, { baseline: { catchDefects: false }, openHoldout: true, candidateId: 'sweep-1' },
    )
    expect(sweepRes.sweep.recommended?.params).toEqual({ catchDefects: true })
    expect(sweepRes.holdout?.promoted).toBe(true)

    const reg = createJudgementRegistry()
    const mkGate = (id: string, fn: (ctx: { bad: boolean; noisyClean: boolean }) => 'allow' | 'deny') => ({
      kind: 'gate', id, version: 1, point: 'verify.preflight', description: id,
      placement: { timing: 'pre', enforce: true }, requires: ['bad'],
      gate: (ctx: { bad: boolean; noisyClean: boolean }) => fn(ctx) === 'deny' ? { kind: 'deny', blockers: [id] } : { kind: 'allow' },
    }) as unknown as RegistryEntry
    reg.register(mkGate('primary.gate', c => c.bad ? 'deny' : 'allow'), 'enforce')
    reg.register(mkGate('redundant.gate', c => c.bad ? 'deny' : 'allow'), 'enforce')
    reg.register(mkGate('harmful.gate', c => c.noisyClean ? 'deny' : 'allow'), 'enforce')
    const loo = await runLeaveOneOutAblation(reg, [
      { id: 'c1', family: 'f1', point: 'verify.preflight' as never, expectedOutcome: 'defect', input: { bad: true, noisyClean: false } },
      { id: 'c2', family: 'f2', point: 'verify.preflight' as never, expectedOutcome: 'clean', input: { bad: false, noisyClean: true } },
    ])
    expect(loo.redundantGateIds).toContain('redundant.gate')
    expect(loo.harmfulGateIds).toContain('harmful.gate')
    expect(loo.conflicts.some(c => c.gateB === 'harmful.gate')).toBe(true)

    // 过自信未校准分数 (0.95 -> 65% 缺陷, 0.05 -> 35% 缺陷) 温度校准后 ECE 显著改善
    const rawSamples = [
      ...Array.from({ length: 20 }, (_, i) => ({ rawScore: 0.95, groundTruthBackfill: (i < 13 ? 'defect' : 'clean') as 'defect' | 'clean' })),
      ...Array.from({ length: 20 }, (_, i) => ({ rawScore: 0.05, groundTruthBackfill: (i < 7 ? 'defect' : 'clean') as 'defect' | 'clean' })),
    ]
    const scaler = fitTemperatureScaler(rawSamples)
    expect(scaler.fitted).toBe(true)
    expect(scaler.temperature).toBeGreaterThan(1)
    expect(scaler.lossAfter).toBeLessThan(scaler.lossBefore)
    const calRecords = rawSamples.map((s, idx) => buildCalibratedGateRecord({ gateId: 'smart-auto', callId: `c-${idx}`, ticketId: `T-${idx}`, rawScore: s.rawScore, groundTruthBackfill: s.groundTruthBackfill }, scaler))
    const eceReport = computeExpectedCalibrationError(calRecords, 10)
    expect(eceReport.state).toBe('measured')
    expect(eceReport.rawEce!).toBeGreaterThan(0.25)
    expect(eceReport.ece!).toBeLessThan(0.03)
    expect(calibrateProbability(0.95, scaler)).toBeCloseTo(0.65, 1)
    expect(classifyThresholdBand(0.1, [0.2, 0.8])).toBe('allow')
    expect(classifyThresholdBand(0.5, [0.2, 0.8])).toBe('deterministic_gate')
    expect(classifyThresholdBand(0.9, [0.2, 0.8])).toBe('block')
    expect(computeExpectedCalibrationError([{ gateId: 'g', callId: '1', ticketId: 't', rawScore: 0.5, calibratedProb: 0.5, thresholdBand: [0.2, 0.8], decision: 'deterministic_gate' }]).state).toBe('unmeasured')
  })
})
