import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/app/store.ts'
import { GovernanceRuntime } from '../src/app/governance.ts'
import { adoptDepositDraft, listDepositDrafts } from '../src/app/governance-drafts.ts'
import { changeDepositStage, openRsiSealedHoldout, syncDepositsAndLedger } from '../src/app/governance-ops.ts'
import { governanceRoutes } from '../src/app/http-governance.ts'
import { secretaryGovernanceTools } from '../src/app/tools/secretary-governance.ts'
import { listMemoryPages, readMemoryPage } from '../src/memory/index.ts'
import { readM0Events } from '../src/rsi/index.ts'
import { getProjectionShardCacheStats } from '../src/projection/shard-cache.ts'
import type { Ticket } from '../src/core/index.ts'
import type { HttpHost } from '../src/app/http.ts'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => undefined)
})

async function setupGov(nowIso = '2026-11-26T10:00:00.000Z') {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-p0-gov-'))
  dirs.push(dir)
  const store = new Store(join(dir, 'state.sqlite'))
  const now = new Date(nowIso)
  const errors: unknown[] = []
  const gov = new GovernanceRuntime({ store, stateDir: dir, now: () => now, onError: e => errors.push(e) })
  await gov.recover()
  return { dir, store, gov, errors, setNow: (iso: string) => now.setTime(Date.parse(iso)) }
}

const sampleCases = (id: string) => [
  { name: `${id}-ok`, expected: 'allow' as const, ctx: { ok: true } },
  { name: `${id}-bad`, expected: 'deny' as const, ctx: { ok: false } },
]

describe('P0 governance closure & wired rules', () => {
  it('routes desktop rulings to redacted deposit-draft, M3/M6, M2 and skips duplicate', async () => {
    const { dir, store, gov, errors } = await setupGov()
    const ticket: Ticket = {
      id: 't-ws-1', title: 'ws task', decisionId: 'd-1', channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: '2026-11-26T09:00:00.000Z', updatedAt: '2026-11-26T09:00:00.000Z',
      origin: { triggerId: 'tr-1', triggerIds: ['tr-1'] },
      mandate: { policyVersion: 'v1', reason: 'test' } as never,
      execution: { workspace: 'repo-alpha', directory: dir, dispatchKey: 'k1', short: 's', assignment: 'a' } as never,
    }
    store.tickets.save(ticket)

    await gov.rulings.enqueue({ id: 'rul-gap', kind: 'system_escalation', ticketId: 't-ws-1', question: 'gap?' })
    const r1 = await gov.rulings.decide({
      id: 'rul-gap', decision: 'reject', actorId: 'boss', attribution: 'missing_rule', captureAsRule: true,
      note: 'token sk-secret1234567890abcdef leaked',
    })
    expect(r1.ok).toBe(true)
    const dup = await gov.rulings.decide({ id: 'rul-gap', decision: 'approve', actorId: 'boss', attribution: 'missing_rule' })
    expect(dup.ok && dup.duplicate).toBe(true)

    await gov.rulings.enqueue({ id: 'rul-m3', kind: 'system_escalation', ticketId: 't-ws-1', question: 'm3?' })
    await gov.rulings.decide({ id: 'rul-m3', decision: 'revise', actorId: 'boss', attribution: 'wrong_rule', note: 'check build first' })

    await gov.rulings.enqueue({ id: 'rul-m6', kind: 'system_escalation', question: 'm6?' })
    await gov.rulings.decide({ id: 'rul-m6', decision: 'revise', actorId: 'boss', attribution: 'wrong_rule', note: 'no ws' })

    await gov.rulings.enqueue({ id: 'rul-m2', kind: 'secretary_ask', question: 'm2?' })
    await gov.rulings.decide({ id: 'rul-m2', decision: 'approve', actorId: 'boss', attribution: 'rule_conflict', note: 'prefer terse replies' })

    await gov.flush()
    expect(errors).toEqual([])

    const draftText = await readFile(join(dir, 'deposit-drafts', 'friction.rul-gap.json'), 'utf8')
    expect(draftText).not.toContain('sk-secret1234567890abcdef')
    expect(draftText).toContain('[REDACTED')

    const m3Pages = await listMemoryPages(gov.memoryDir, ['m3'])
    expect(m3Pages.some(p => p.relPath.startsWith('m3/repo-alpha/') && p.page.layer === 'm3' && p.page.entries.some(e => e.statement.includes('check build first')))).toBe(true)
    const m2 = await readMemoryPage(gov.memoryDir, 'm2/profile.md')
    expect(m2?.layer === 'm2' && m2.entries.some(e => e.statement.includes('prefer terse replies'))).toBe(true)
    const m6 = await readMemoryPage(gov.memoryDir, 'm6/ledger.md')
    expect(m6?.layer === 'm6' && m6.items.some(i => i.question.includes('待确认工作区归属'))).toBe(true)

    const events = await readM0Events({ db: store.db, memoryDir: gov.memoryDir })
    expect(events.filter(e => e.type === 'authoring.draft_created')).toHaveLength(1)
    await gov.shutdown()
  })

  it('lists drafts, adopts to shadow package, exposes HTTP routes & secretary list_drafts', async () => {
    const { dir, store, gov } = await setupGov()
    await gov.rulings.enqueue({ id: 'rul-adopt', kind: 'system_escalation', question: 'adopt?' })
    await gov.rulings.decide({ id: 'rul-adopt', decision: 'reject', actorId: 'boss', captureAsRule: true, note: 'require flag' })
    await gov.flush()

    const listTool = secretaryGovernanceTools(gov).find(t => t.name === 'orchestrator_deposit_author')!
    const toolOut = await listTool.execute({ mode: 'list_drafts' }, new AbortController().signal) as { drafts: { id: string }[] }
    expect(toolOut.drafts.some(d => d.id === 'friction.rul-adopt')).toBe(true)

    const routes = governanceRoutes(
      { store, governance: gov, machine: { stateDir: dir }, engine: {}, requestPass: () => undefined } as unknown as HttpHost,
      msg => { throw new Error(msg) },
      msg => { throw new Error(msg) },
    )
    const httpDrafts = await routes['GET deposits/drafts']({ params: {}, query: {}, body: async () => undefined })
    expect(httpDrafts.some(d => d.id === 'friction.rul-adopt')).toBe(true)

    const adopted = await adoptDepositDraft(gov, {
      draftId: 'friction.rul-adopt',
      cases: sampleCases('rul-adopt'),
      overrides: {
        requires: ['ok'],
        rule: { kind: 'predicates', mode: 'all', clauses: [{ path: 'ok', op: 'eq', value: true, message: 'must be ok' }] },
      },
      installShadow: true,
    })
    expect(adopted.ok && adopted.installed).toBe(true)
    expect(existsSync(join(dir, 'deposit-drafts', 'friction.rul-adopt.json'))).toBe(false)
    expect(gov.registry.list().some(g => g.id === 'friction.rul-adopt' && g.stage === 'shadow')).toBe(true)
    const ledger = await readFile(join(dir, 'deposits', 'LEDGER.md'), 'utf8')
    expect(ledger).toContain('friction.rul-adopt')
    const draftsAfter = await listDepositDrafts(gov, { includeOnlineCandidates: false })
    expect(draftsAfter).toHaveLength(0)
    await gov.shutdown()
  })

  it('runs standing order patrol with cooldown, wires reply-desk/intake gates and shard cache', async () => {
    const { store, gov, setNow } = await setupGov('2026-11-26T10:00:00.000Z')
    store.tickets.save({
      id: 't-stale-1', title: 'Stale Ticket', decisionId: 'd-2', channels: [], inputs: [], undelivered: [],
      assignments: [{ id: 'a-1', state: 'running', createdAt: '2026-11-26T09:00:00.000Z', startedAt: '2026-11-26T09:00:00.000Z' }],
      createdAt: '2026-11-26T09:00:00.000Z', updatedAt: '2026-11-26T09:00:00.000Z',
      origin: { triggerId: 'tr-2', triggerIds: ['tr-2'] },
      mandate: { policyVersion: 'v1', reason: 'test' } as never,
    })

    const first = await gov.tickPatrol(30)
    expect(first).toEqual({ checkedTickets: 1, evaluated: 1, reminded: 1 })
    setNow('2026-11-26T10:01:00.000Z')
    const second = await gov.tickPatrol(30)
    expect(second).toEqual({ checkedTickets: 1, evaluated: 1, reminded: 0 })

    const outRes = await gov.evaluateOutbound({ id: 'm-1', channel: { source: 'github', target: 'o/r#1' } as never, text: 'hi', kind: 'reply' })
    expect(outRes.kind).toBe('allow')
    await changeDepositStage(gov, { id: 'outward.reply-desk', toStage: 'enforce', actor: 'boss' })
    const enforcedOut = await gov.evaluateOutbound({ id: 'm-2', channel: { source: 'github', target: 'o/r#1' } as never, text: 'hi', kind: 'reply' })
    expect(enforcedOut.kind).toBe('unmeasured')

    await gov.evaluateIssueIntake({ issueType: 'bug', body: 'crash', quadruple: {} }, 'tr-gh-1')
    const appRef = gov.appender.append({
      id: 'cache-probe-1', at: '2026-11-26T10:01:00.000Z', stream: 'test:1', type: 'test.probe',
      source: { kind: 'system', ref: 'test' }, evidence: [], taint: 'trusted', payload: { ok: true },
    })
    await gov.flush()
    await gov.shutdown()

    const beforeStats = getProjectionShardCacheStats()
    const env = await gov.readSpineEnvelope(appRef)
    const afterStats = getProjectionShardCacheStats()
    expect(env?.id).toBe('cache-probe-1')
    expect(afterStats.misses + afterStats.hits + afterStats.incrementalHits).toBeGreaterThan(
      beforeStats.misses + beforeStats.hits + beforeStats.incrementalHits,
    )
  })

  it('computes real baseline vs shadow candidate delta in openRsiSealedHoldout', async () => {
    const { gov } = await setupGov()
    await syncDepositsAndLedger(gov)
    gov.registry.register({
      kind: 'gate', id: 'cand.shadow-check', version: 1, point: 'verify.preflight' as never,
      description: 'shadow candidate gate', placement: { timing: 'pre', enforce: false },
      requires: ['hasBug'] as never,
      gate: (ctx: unknown) => (ctx as { hasBug?: boolean }).hasBug ? { kind: 'deny' as const, blockers: ['bug found'] as [string] } : { kind: 'allow' as const },
    }, 'shadow')

    const res = await openRsiSealedHoldout(gov, {
      candidateId: 'cand.shadow-check',
      point: 'verify.preflight',
      cases: ['f1', 'f2', 'f3', 'f4', 'f5'].flatMap((family, i) => [
        { id: `c-${i}-1`, family, input: { hasBug: true }, expectedOutcome: 'defect' as const },
        { id: `c-${i}-2`, family, input: { hasBug: false }, expectedOutcome: 'clean' as const },
      ]),
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.result.trainDelta).toBeGreaterThan(0)
      expect(res.result.holdoutDelta).toBeGreaterThan(0)
    }
    await gov.shutdown()
  })
})
