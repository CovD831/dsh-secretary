import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'
import { PreExecuteCompletionGuard } from '../src/executor/pre-execute-gates.ts'
import { RuntimeGuard } from '../src/executor/runtime-guard.ts'
import { createJudgementRegistry, discoverAndRegisterDeposits } from '../src/judgement/index.ts'
import { MemoryFtsIndex, MemoryWriter, writeMemoryPage } from '../src/memory/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { getProjectionShardCacheStats, readSpineProjection } from '../src/projection/index.ts'
import { GitRepoLock } from '../src/spine/git-sink.ts'
import type { SpineAppender, SpineDraft, SpineEnvelope } from '../src/spine/types.ts'

const tempDirs: string[] = []
const stores: Store[] = []
function makeDir(prefix = 'dsh-p2-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}
function makeStore(): Store {
  const s = new Store(join(makeDir('dsh-p2-db-'), 'orch.sqlite'))
  stores.push(s)
  return s
}
function makeAppender(): { events: SpineEnvelope[]; appender: SpineAppender } {
  const events: SpineEnvelope[] = []
  let seq = 0
  return {
    events,
    appender: {
      append(draft: SpineDraft) {
        const env: SpineEnvelope = { v: 1, seq: ++seq, at: draft.at ?? new Date().toISOString(), ...draft }
        events.push(env)
        return { seq: env.seq, id: env.id }
      },
    } as unknown as SpineAppender,
  }
}
function makeTicket(id: string, dir: string, state: 'running' | 'ended' = 'running'): Ticket {
  return {
    id, title: `Ticket ${id}`, body: 'task',
    origin: { source: 'github', thread: { source: 'github', kind: 'issue', id: '1' }, trigger: 'tr-1' },
    createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z',
    execution: { workspace: 'ws-1', directory: dir, verifyCommands: [] },
    assignments: [{ id: `asg-${id}`, state, createdAt: '2026-11-26T00:00:00Z' }],
    ...(state === 'ended' ? { ended: { at: '2026-11-26T01:00:00Z', disposition: 'resolved' as const } } : {}),
  } as unknown as Ticket
}

afterEach(() => {
  for (const s of stores.splice(0)) try { s.close() } catch { /* ignore */ }
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('P2 core hardening', () => {
  it('persists PreExecuteCompletionGuard observations across restarts to prevent shell-blind washout', async () => {
    const store = makeStore()
    const dir = makeDir('dsh-p2-repo-')
    store.tickets.save(makeTicket('t1', dir))
    const registry = createJudgementRegistry()
    await discoverAndRegisterDeposits({ registry, dirs: [join(process.cwd(), 'deposits')] })

    const ctx1 = new Context()
    const g1 = new PreExecuteCompletionGuard({ context: ctx1, store, registry })
    ctx1.emit('tools/result', {
      callId: 'c1', rootCallId: 'c1', name: 'bash', arguments: { command: 'echo hi > a.txt' },
      signal: new AbortController().signal, token: Symbol('t') as never,
      agent: { id: 'worker-t1', session: { id: 'worker-t1', header: { cwd: dir } } as never } as never,
    } as never, { isError: false, content: [], meta: { diffs: [{ path: join(dir, 'a.txt') }] } })
    g1.dispose()

    const ctx2 = new Context()
    const g2 = new PreExecuteCompletionGuard({ context: ctx2, store, registry })
    expect(g2.getObservation('t1')).toMatchObject({ sawShellWrite: true, unmeasuredTools: ['bash'], sessionDiffs: ['a.txt'] })
    const res = await ctx2.waterfall('tools/pre-execute' as never, {
      callId: 'c2', rootCallId: 'c2', name: 'orchestrator_report',
      arguments: { state: 'ready', summary: 'done', declared_paths: ['a.txt'] },
      signal: new AbortController().signal, token: Symbol('t2') as never,
      agent: { id: 'worker-t1', session: { id: 'worker-t1', header: { cwd: dir } } as never } as never,
    } as never, (async () => 'allow') as never)
    expect(res).toMatchObject({ kind: 'deny' })
    expect((res as { reason: string }).reason).toContain('shell-blind')
    g2.dispose()
  })

  it('persists RuntimeGuard budgets across restarts and cancels stale approval if ticket ended while parked', async () => {
    const store = makeStore()
    store.saveSettings(SettingsSchema.parse({ executor: { maxTokens: 1000 } }))
    const dir = makeDir('dsh-p2-rg-')
    store.tickets.save(makeTicket('t1', dir))
    const { events, appender } = makeAppender()

    let resolveApproval: ((v: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable') => void) | undefined
    const rulings = {
      requestDshApproval: () => new Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>(r => { resolveApproval = r }),
      enqueue: async () => {},
    } as never

    const ctx1 = new Context()
    ctx1.reflect.provide('agents', { get: () => undefined })
    const g1 = new RuntimeGuard({ context: ctx1, store, engine: { report: () => {} } as never, appender, rulings, relayToMaster: () => {} })
    g1.install()
    ctx1.emit('session/event', { id: 'worker-t1', header: {} } as never, {
      type: 'assistant/message', data: { usage: { inputTokens: 300, outputTokens: 200, totalTokens: 500 } },
    } as never)
    g1.dispose()

    const ctx2 = new Context()
    ctx2.reflect.provide('agents', { get: () => undefined })
    const g2 = new RuntimeGuard({ context: ctx2, store, engine: { report: () => {} } as never, appender, rulings, relayToMaster: () => {} })
    g2.install()
    ctx2.emit('session/event', { id: 'worker-t1', header: {} } as never, {
      type: 'assistant/message', data: { usage: { inputTokens: 400, outputTokens: 200, totalTokens: 600 } },
    } as never)
    expect(events.some(e => e.type === 'ticket.circuit_broken')).toBe(true)

    store.tickets.save(makeTicket('t2', dir, 'running'))
    const approvalPromise = ctx2.waterfall('approval/request' as never, {
      agent: { id: 'worker-t2', session: { snapshotEvents: () => [] } } as never, toolName: 'bash', callId: 'call-9',
    } as never, (async () => 'rejected') as never)
    store.tickets.save(makeTicket('t2', dir, 'ended'))
    resolveApproval?.('allowed-once')
    expect(await approvalPromise).toBe('cancelled')
    expect(events.some(e => e.type === 'approval.stale_cancelled')).toBe(true)
    g2.dispose()
  })

  it('auto-refreshes MemoryFtsIndex on disk .md add, modify, and delete', async () => {
    const root = makeDir('dsh-p2-fts-')
    const memoryDir = join(root, 'memory')
    const fts = new MemoryFtsIndex({ memoryDir, dbPath: join(root, 'fts.sqlite') })
    const caller = { role: 'secretary' as const, maxClearance: 'private' as const }

    await writeMemoryPage(memoryDir, 'm3/ws1/notes.md', {
      version: 1, layer: 'm3', pageKey: 'm3/ws1/notes', scope: 'workspace:ws1', revision: 1, updatedAt: '2026-11-26T00:00:00Z',
      entries: [{
        id: 'mem-1', statement: 'alpha_initial_fact', scope: 'workspace:ws1', sourceType: 'user_direct',
        sourceRef: { seq: 1, id: 'e1' }, observedAt: '2026-11-26T00:00:00Z', validFrom: '2026-11-26T00:00:00Z',
        confidence: 'stated', author: 'user', taint: 'clean', clearance: 'workspace',
      }],
      changeLog: [],
    })
    const r1 = await fts.search('alpha_initial_fact', caller)
    expect(r1.rebuilt).toBe(true)
    expect(r1.hits.map(h => h.entry.id)).toEqual(['mem-1'])

    const r2 = await fts.search('alpha_initial_fact', caller)
    expect(r2.rebuilt).toBe(false)

    await writeMemoryPage(memoryDir, 'm3/ws1/notes.md', {
      version: 1, layer: 'm3', pageKey: 'm3/ws1/notes', scope: 'workspace:ws1', revision: 2, updatedAt: '2026-11-26T00:01:00Z',
      entries: [{
        id: 'mem-2', statement: 'beta_updated_fact', scope: 'workspace:ws1', sourceType: 'user_direct',
        sourceRef: { seq: 2, id: 'e2' }, observedAt: '2026-11-26T00:01:00Z', validFrom: '2026-11-26T00:01:00Z',
        confidence: 'stated', author: 'user', taint: 'clean', clearance: 'workspace',
      }],
      changeLog: [],
    })
    const r3 = await fts.search('beta_updated_fact', caller)
    expect(r3.rebuilt).toBe(true)
    expect(r3.hits.map(h => h.entry.id)).toEqual(['mem-2'])

    rmSync(join(memoryDir, 'm3', 'ws1', 'notes.md'))
    const r4 = await fts.search('beta_updated_fact', caller, { fallbackToM0: false })
    expect(r4.rebuilt).toBe(true)
    expect(r4.hits).toHaveLength(0)
    fts.close()
  })

  it('rolls back disk .md files when MemoryWriter git commit fails', async () => {
    const memDir = makeDir('dsh-p2-writer-')
    const writer = new MemoryWriter({ dir: memDir, lock: new GitRepoLock() })
    await writer.init()
    const seed = await writer.propose({
      layer: 'm1', slug: 'keep', scope: 'global', sourceType: 'user_direct',
      sourceRef: { seq: 1, id: 's1' }, statement: 'original fact', author: 'user',
    })
    expect(seed.kind).toBe('accepted')
    const origPath = join(memDir, 'm1', 'keep.md')
    const origContent = readFileSync(origPath, 'utf8')

    const hookPath = join(memDir, '.git', 'hooks', 'pre-commit')
    mkdirSync(join(memDir, '.git', 'hooks'), { recursive: true })
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', 'utf8')
    chmodSync(hookPath, 0o755)

    await expect(writer.propose({
      layer: 'm1', slug: 'brand-new', scope: 'global', sourceType: 'user_direct',
      sourceRef: { seq: 2, id: 's2' }, statement: 'should rollback', author: 'user',
    })).rejects.toThrow()
    expect(existsSync(join(memDir, 'm1', 'brand-new.md'))).toBe(false)

    if (seed.kind === 'accepted') {
      await expect(writer.tombstone({
        target: { layer: 'm1', slug: 'keep' }, entryId: seed.entry.id,
        reason: 'rollback test', sourceRef: { seq: 3, id: 's3' }, author: 'user',
      })).rejects.toThrow()
    }
    expect(readFileSync(origPath, 'utf8')).toBe(origContent)
  })

  it('scans newest shards first and stops early in readSpineProjection when tail=true without sinceSeq', async () => {
    const stateDir = makeDir('dsh-p2-tail-')
    const m0Dir = join(stateDir, 'memory', 'm0')
    mkdirSync(m0Dir, { recursive: true })
    const dates = ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']
    let seq = 0
    for (const d of dates) {
      const lines: string[] = []
      for (let i = 0; i < 5; i++) {
        seq += 1
        lines.push(JSON.stringify({ v: 1, seq, id: `ev-${seq}`, at: `${d}T00:00:00Z`, stream: 'ticket:t1', type: 'worker.turn', payload: { ticketId: 't1' } }))
      }
      writeFileSync(join(m0Dir, `${d}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
    }
    const store = makeStore()
    store.db.exec('CREATE TABLE IF NOT EXISTS event_spine (seq INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    store.db.prepare('INSERT INTO event_spine (seq, value) VALUES (?, ?)').run(21, JSON.stringify({
      v: 1, seq: 21, id: 'ev-21', at: '2026-11-24T01:00:00Z', stream: 'ticket:t1', type: 'worker.turn', payload: { ticketId: 't1' },
    }))

    const before = getProjectionShardCacheStats()
    const view = await readSpineProjection(store, stateDir, { tail: true, limit: 3 })
    const after = getProjectionShardCacheStats()
    expect(view.items.map(e => e.seq)).toEqual([19, 20, 21])
    expect(view.headSeq).toBe(21)
    expect(view.hasMore).toBe(true)
    expect(view.nextSinceSeq).toBe(21)
    expect(after.misses - before.misses).toBe(1)
  })
})
