import { appendFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GovernanceRuntime } from '../src/app/governance.ts'
import { registerHttp, type HttpHost } from '../src/app/http.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/model.ts'
import { MemoryWriter } from '../src/memory/index.ts'
import {
  compileAvatarState,
  compileDailySchedule,
  readDepositsProjection,
  readNotebookProjection,
  readSpineProjection,
} from '../src/projection/index.ts'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  while (stores.length) stores.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})
const makeDir = () => { const d = mkdtempSync(join(tmpdir(), 'proj-spec-')); dirs.push(d); return d }

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, prefix: string) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(dir, e.name), rel)
      else if (e.isFile()) out[rel] = readFileSync(join(dir, e.name), 'base64')
    }
  }
  walk(root, '')
  return out
}

function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  const now = '2026-11-26T01:00:00.000Z'
  return {
    id, title: `Ticket ${id}`, decisionId: `dec-${id}`,
    mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'addressed', addressed: 'mention' }, actor: { source: 'github', id: 'u1' }, scope: 'repo' },
    channels: [], assignments: [{ id: `a-${id}`, state: 'running', createdAt: now, startedAt: now }],
    inputs: [], undelivered: [], createdAt: now, updatedAt: now, origin: { triggerId: `tr-${id}`, triggerIds: [`tr-${id}`] },
    ...overrides,
  }
}

function mountHttp(store: Store, stateDir: string) {
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => {}
  const ctx = { webServer: { host: '127.0.0.1', port: 3099, register: (r: { handler: typeof handler }) => { handler = r.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), store, machine: { stateDir } } as unknown as HttpHost)
  return async (path: string, headers: Record<string, string | undefined> = {}) => {
    let status = 0, text = ''
    const merged = Object.fromEntries(Object.entries({ host: '127.0.0.1:3099', 'x-orchestrator-request': '1', ...headers }).filter(([, v]) => v !== undefined))
    await handler({ method: 'GET', url: `/orchestrator/api/${path}`, headers: merged, async *[Symbol.asyncIterator]() {} },
      { writeHead: (c: number) => { status = c }, end: (d: string) => { text = d } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

describe('avatar-state deterministic compiler (B1-B3, B5)', () => {
  const base = {
    workingCount: 0, personWaitingTickets: [], failedTickets: [], blockedTickets: [],
    pendingConflicts: 0, pendingRulings: 0, pendingVerifications: 0, paused: false,
    now: new Date('2026-11-26T04:00:00.000Z'), timezoneOffsetMinutes: 480,
  }

  it('enforces posture priority: paused > fault > raising_hand > working > morning > night > patrol_idle', () => {
    const failed = [{ id: 't-fail', sourceRef: { seq: 11, id: 'ev-11' } }]
    const waiting = [{ id: 't-wait', sourceRef: { seq: 12, id: 'ev-12' } }]
    expect(compileAvatarState({ ...base, paused: true, failedTickets: failed, workingCount: 2 }).posture).toBe('paused_standby')
    const fault = compileAvatarState({ ...base, failedTickets: failed, personWaitingTickets: waiting, workingCount: 2 })
    expect(fault.posture).toBe('alert_fault')
    expect(fault.deviation).toMatchObject({ kind: 'ticket_failed', priority: 'critical', ticketId: 't-fail', sourceRef: { seq: 11, id: 'ev-11' } })
    expect(fault.bark).toMatchObject({ code: 'BARK_DEVIATION_FAILED', sourceRef: { seq: 11, id: 'ev-11' } })
    expect(compileAvatarState({ ...base, pendingConflicts: 1, pendingRulings: 1, workingCount: 1 }).posture).toBe('alert_fault')
    expect(compileAvatarState({ ...base, personWaitingTickets: waiting, workingCount: 2 }).posture).toBe('raising_hand')
    expect(compileAvatarState({ ...base, workingCount: 1, now: new Date('2026-11-26T00:00:00.000Z') }).posture).toBe('working_desk')
    expect(compileAvatarState({ ...base, now: new Date('2026-11-26T00:30:00.000Z') }).posture).toBe('morning_briefing')
    expect(compileAvatarState({ ...base, now: new Date('2026-11-25T16:00:00.000Z') }).posture).toBe('night_watch')
    expect(compileAvatarState({ ...base, now: new Date('2026-11-26T06:00:00.000Z') }).posture).toBe('patrol_idle')
  })

  it('keeps bark strictly null when no valid SourceRef (seq > 0) is hit or paused_standby has no deviation', () => {
    expect(compileAvatarState(base).bark).toBeNull()
    expect(compileAvatarState({ ...base, failedTickets: [{ id: 't1' }], recentSpineEvents: [{ seq: 0, id: 'bad', at: '', stream: 'ticket:t1', type: 'ticket.created', payload: {} }] }).bark).toBeNull()
    expect(compileAvatarState({ ...base, now: new Date('2026-11-26T00:30:00.000Z') }).bark).toBeNull()
    const validMoniker = { id: 'm2-1', statement: '老办法走 TDD', sourceRef: { seq: 5, id: 'ev-5' }, m2Kind: 'internal_moniker' as const }
    const ev = { seq: 6, id: 'ev-6', at: '2026-11-26T01:00:00Z', stream: 'ticket:t1' as const, type: 'ticket.created' as const, payload: {} }
    expect(compileAvatarState({ ...base, paused: true, m2Monikers: [validMoniker], recentSpineEvents: [ev] }).bark).toBeNull()
    expect(compileAvatarState({ ...base, workingCount: 0, m2Monikers: [validMoniker] }).bark).toBeNull()
    expect(compileAvatarState({ ...base, workingCount: 1, m2Monikers: [{ ...validMoniker, statement: '   ' }, { ...validMoniker, id: 'm2-future', validFrom: '2026-11-27T00:00:00.000Z' }] }).bark).toBeNull()
    expect(compileAvatarState({ ...base, workingCount: 1, m2Monikers: [validMoniker] }).bark).toMatchObject({ code: 'BARK_M2_MONIKER', sourceRef: { seq: 5, id: 'ev-5' } })
  })

  it('compiles schedule solely from real counts and refs', () => {
    const sched = compileDailySchedule({
      ...base, workingCount: 2, pendingRulings: 1,
      recentSpineEvents: [{ seq: 3, id: 'ev-3', at: '2026-11-26T01:00:00Z', stream: 'ticket:t1', type: 'ticket.created', payload: {} }],
    })
    expect(sched.map(s => s.kind)).toEqual(['ruling_queue', 'active_tickets', 'morning_briefing', 'consolidation_window'])
    expect(sched[0]!.count).toBe(1)
    expect(sched[2]!.sourceRefs).toEqual([{ seq: 3, id: 'ev-3' }])
  })
})

describe('projection readers and HTTP endpoints (read-only invariant)', () => {
  it('handles empty store without event_spine and missing m6/ledger gracefully', async () => {
    const stateDir = makeDir()
    const store = new Store(join(stateDir, 'orchestrator.sqlite')); stores.push(store)
    const nb = await readNotebookProjection(stateDir)
    expect(nb.exists).toBe(false)
    expect(nb.counts.total).toBe(0)
    const sp = await readSpineProjection(store, stateDir)
    expect(sp).toEqual({ items: [], totalMatched: 0, headSeq: 0, nextSinceSeq: null, hasMore: false })
  })

  it('merges disk m0 shards (skipping torn lines) with sqlite buffer and filters/paginates', async () => {
    const stateDir = makeDir()
    const store = new Store(join(stateDir, 'orchestrator.sqlite')); stores.push(store)
    const gov = new GovernanceRuntime({ store, stateDir })
    await gov.recover()
    const ref1 = gov.appender.append({ id: 'ev-1', stream: 'ticket:t1', type: 'ticket.created', source: { kind: 'system', ref: 't' }, evidence: [], taint: 'trusted', payload: { ticketId: 't1' } })
    const ref2 = gov.appender.append({ id: 'ev-2', stream: 'ticket:t2', type: 'gate.evaluated', source: { kind: 'system', ref: 't' }, evidence: [], taint: 'trusted', payload: { ticketId: 't2', point: 'verify.changed-paths', verdict: { kind: 'deny' } } })
    await gov.flush()
    gov.appender.append({ id: 'ev-3', stream: 'ticket:t1', type: 'ticket.ended', source: { kind: 'system', ref: 't' }, evidence: [], taint: 'trusted', payload: { ticketId: 't1' } })
    const m0Dir = join(stateDir, 'memory', 'm0')
    const shard = readdirSync(m0Dir).find(n => n.endsWith('.jsonl'))!
    appendFileSync(join(m0Dir, shard), '{"v":1,"seq":999,"id":"torn', 'utf8')
    const page1 = await readSpineProjection(store, stateDir, { limit: 2 })
    expect(page1.items.map(e => e.seq)).toEqual([ref1.seq, ref2.seq])
    expect(page1.hasMore).toBe(true)
    expect(page1.headSeq).toBe(3)
    const page2 = await readSpineProjection(store, stateDir, { sinceSeq: page1.nextSinceSeq!, ticketId: 't1' })
    expect(page2.items.map(e => e.id)).toEqual(['ev-3'])
    const depView = await readDepositsProjection(store, stateDir)
    const changed = depView.items.find(i => i.id === 'verify.changed-paths')!
    expect(changed.stats.triggers).toBe(1)
    expect(changed.stats.deny).toBe(1)
  })

  it('serves all 4 projection HTTP endpoints with same-origin guard and zero writes', async () => {
    const stateDir = makeDir()
    const store = new Store(join(stateDir, 'orchestrator.sqlite')); stores.push(store)
    const gov = new GovernanceRuntime({ store, stateDir })
    await gov.recover()
    const r1 = gov.appender.append({ id: 'e-fail', stream: 'ticket:t-err', type: 'gate.evaluated', source: { kind: 'system', ref: 'g' }, evidence: [], taint: 'trusted', payload: { ticketId: 't-err', point: 'ticket.adaptive-dispatch', ran: [{ id: 'ticket.adaptive-dispatch', outcome: 'allow' }], observed: [{ id: 'verify.rerun', outcome: 'unmeasured' }] } })
    await gov.flush()
    store.tickets.save(makeTicket('t-err', { assignments: [{ id: 'a1', state: 'ended', createdAt: '2026-11-26T01:00:00Z', report: { state: 'failed', summary: 'boom', at: '2026-11-26T01:01:00Z' } }] }))
    const writer = new MemoryWriter({ dir: gov.memoryDir, lock: gov.memoryRepoLock })
    await writer.upsertAttention({ kind: 'conflict', question: '选择哪种重试策略？', sourceRefs: [r1], delaySeen: 1 })
    const customDeposit = join(stateDir, 'deposits', 'custom-rule')
    mkdirSync(join(customDeposit, 'cases'), { recursive: true })
    writeFileSync(join(customDeposit, 'cases', 'cases.json'), '[]', 'utf8')
    writeFileSync(join(customDeposit, 'DEPOSIT.md'), '---\nid: custom.rule\nversion: 1\nkind: gate\npoint: ticket.custom\ntrust: owner\ncases: cases/\nparams: {}\n---\n## 意图\nx\n## 判据\nx\n## 正反例\nx\n## 例外\nx\n## 修复指引\nx\n', 'utf8')

    const call = mountHttp(store, stateDir)
    expect((await call('projection/state', { 'x-orchestrator-request': undefined })).status).toBe(403)
    expect((await call('projection/state', { origin: 'http://evil.example' })).status).toBe(403)

    const memBefore = snapshotTree(join(stateDir, 'memory'))
    const dbVerBefore = Number((store.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)

    const st = await call('projection/state')
    const nb = await call('projection/notebook')
    const sp = await call('projection/spine?limit=500&ticketId=t-err')
    const dp = await call('projection/deposits')

    expect(st.status).toBe(200)
    expect(st.body.avatar).toMatchObject({ posture: 'alert_fault', deviation: { kind: 'ticket_failed', ticketId: 't-err', sourceRef: r1 } })
    expect(nb.status).toBe(200)
    expect(nb.body.counts).toMatchObject({ total: 1, pending: 1, conflicts: 1, dueReminders: 1 })
    expect(sp.status).toBe(200)
    expect((sp.body.items as unknown[]).length).toBe(1)
    expect(dp.status).toBe(200)
    const items = dp.body.items as { id: string; source: string; stats: { allow: number; unmeasured: number } }[]
    expect(items.some(i => i.id === 'custom.rule' && i.source === 'state')).toBe(true)
    expect(items.find(i => i.id === 'ticket.adaptive-dispatch')?.stats.allow).toBe(1)
    expect(items.find(i => i.id === 'verify.rerun')?.stats.unmeasured).toBe(1)

    expect(snapshotTree(join(stateDir, 'memory'))).toEqual(memBefore)
    const dbVerAfter = Number((store.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version)
    expect(dbVerAfter).toBe(dbVerBefore)
  })

  it('returns latest gate.evaluated deny event when tail=true (B1)', async () => {
    const stateDir = makeDir()
    const store = new Store(join(stateDir, 'orchestrator.sqlite')); stores.push(store)
    const gov = new GovernanceRuntime({ store, stateDir })
    await gov.recover()
    for (let i = 1; i <= 8; i++) {
      gov.appender.append({
        id: `gate-${i}`, stream: 'ticket:t-tail', type: 'gate.evaluated',
        source: { kind: 'system', ref: 'g' }, evidence: [], taint: 'trusted',
        payload: { ticketId: 't-tail', point: 'verify.rerun', verdict: { kind: i === 8 ? 'deny' : 'allow' } },
      })
    }
    const tailView = await readSpineProjection(store, stateDir, { type: 'gate.evaluated', limit: 5, tail: true })
    expect(tailView.items.map(e => e.seq)).toEqual([4, 5, 6, 7, 8])
    expect((tailView.items[tailView.items.length - 1]!.payload as { verdict: { kind: string } }).verdict.kind).toBe('deny')

    const call = mountHttp(store, stateDir)
    const httpTail = await call('projection/spine?type=gate.evaluated&limit=5&tail=1')
    expect(httpTail.status).toBe(200)
    expect((httpTail.body.items as { seq: number }[]).map(e => e.seq)).toEqual([4, 5, 6, 7, 8])
    await gov.shutdown()
  })
})
