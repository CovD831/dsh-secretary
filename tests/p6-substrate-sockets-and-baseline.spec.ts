import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { GovernanceRuntime } from '../src/app/governance.ts'
import { changeDepositStage, syncDepositsAndLedger } from '../src/app/governance-ops.ts'
import { runStandingOrderPatrol } from '../src/app/governance-patrol.ts'
import { RESOURCES, readResource } from '../src/app/resources.ts'
import { RulingQueue } from '../src/app/ruling-queue.ts'
import { Store } from '../src/app/store.ts'
import { mainTools } from '../src/app/tools/main.ts'
import { secretaryGovernanceTools } from '../src/app/tools/secretary-governance.ts'
import { readTicketTranscript } from '../src/app/transcript-reader.ts'
import type { Ticket } from '../src/core/index.ts'
import { PreExecuteCompletionGuard } from '../src/executor/pre-execute-gates.ts'
import { evaluateChangedPaths } from '../src/judgement/gates/changed-paths.ts'
import {
  RESERVED_BUILTIN_DEPOSIT_IDS, createJudgementRegistry, discoverAndRegisterDeposits, loadDepositPackage,
} from '../src/judgement/index.ts'
import { MemoryFtsIndex, MemoryWriter } from '../src/memory/index.ts'
import { collectOnlineRsiSnapshot, readM0Events } from '../src/rsi/index.ts'
import { GitRepoLock, createSpineAppender, ensureSpineSchema } from '../src/spine/index.ts'
import { redactValue } from '../src/spine/redact.ts'
import type { SpineAppender, SpineDraft, SpineEnvelope } from '../src/spine/types.ts'
import { copyCowDependencies, provisionWorktree } from '../src/workspaces/worktree.ts'

const tempDirs: string[] = []
const stores: Store[] = []

function makeDir(prefix = 'dsh-p6-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStore(): Store {
  const s = new Store(join(makeDir('dsh-p6-db-'), 'state.sqlite'))
  stores.push(s)
  return s
}

async function setupGov(nowIso = '2026-11-26T10:00:00.000Z') {
  const dir = makeDir('dsh-p6-gov-')
  const store = new Store(join(dir, 'state.sqlite'))
  stores.push(store)
  const now = new Date(nowIso)
  const gov = new GovernanceRuntime({ store, stateDir: dir, now: () => now })
  await gov.recover()
  return { dir, store, gov, setNow: (iso: string) => now.setTime(Date.parse(iso)) }
}

function makeMemoryAppender() {
  const events: SpineEnvelope[] = []
  let seq = 0
  return {
    events,
    appender: {
      append(draft: SpineDraft) {
        const env: SpineEnvelope = { v: 1, seq: ++seq, at: draft.at ?? '2026-11-26T10:00:00.000Z', ...draft }
        events.push(env)
        return { seq: env.seq, id: env.id }
      },
    } as unknown as SpineAppender,
  }
}

afterEach(() => {
  for (const s of stores.splice(0)) try { s.close() } catch { /* ignore */ }
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('P6 substrate sockets + baseline hardening', () => {
  it('Socket 1 & 3: preserves playbook/rule on install_shadow, honors commit ceiling, promotes gate without D5 deadlock, and blocks spoofed reserved IDs', async () => {
    const { dir, gov } = await setupGov()
    const author = secretaryGovernanceTools(gov).find(t => t.name === 'orchestrator_deposit_author')!
    const draft = {
      id: 'verify.custom-playbook-gate',
      name: 'Playbook 门',
      kind: 'gate',
      point: 'verify.completion',
      intent: '提交完成前必须跑 pnpm typecheck',
      actionClass: 'block',
      mandate: { strength: 'explicit', scope: 'workspace:*', policyVersion: 'v1', ceiling: 'commit', isolation: 'I2' },
      playbook: { summary: '故障聚类与反实验 SOP', when: { keywords: ['cluster'] }, steps: ['step1', 'step2'] },
      rule: { kind: 'command_check', requiredCommands: ['pnpm typecheck'] },
      cases: [
        { name: 'ok', expected: 'allow', ctx: { commands: [{ command: 'pnpm typecheck', exitCode: 0 }] } },
        { name: 'bad', expected: 'deny', ctx: { commands: [{ command: 'vitest run', exitCode: 0 }] } },
      ],
    }

    const res = await author.execute({ mode: 'install_shadow', draft } as never, {} as never) as { installed: boolean; packageDir: string }
    expect(res.installed).toBe(true)

    const loaded = await loadDepositPackage(res.packageDir)
    expect(loaded.admission.admitted).toBe(true)
    if (loaded.admission.admitted) {
      expect(loaded.admission.manifest.playbook).toEqual(draft.playbook)
      expect(loaded.admission.manifest.rule).toEqual(draft.rule)
    }

    const toObs = await changeDepositStage(gov, { id: draft.id, toStage: 'observe' })
    expect(toObs.ok).toBe(true)
    const toEnf = await changeDepositStage(gov, { id: draft.id, toStage: 'enforce' })
    expect(toEnf.ok).toBe(true)

    const counterRes = await author.execute({
      mode: 'install_shadow',
      draft: {
        id: 'friction.counter-d5',
        kind: 'counter-rule',
        point: 'deposit.friction',
        intent: '仅提案不阻塞',
        actionClass: 'observe',
        action: { name: 'proposal.create' },
        rule: { kind: 'predicates', mode: 'any', clauses: [{ path: 'seenCount', op: 'lt', value: 3, message: 'seen>=3' }] },
        cases: [
          { name: 'allow', expected: 'allow', ctx: { seenCount: 1 } },
          { name: 'deny', expected: 'deny', ctx: { seenCount: 3 } },
        ],
      },
    } as never, {} as never) as { installed: boolean }
    expect(counterRes.installed).toBe(true)
    const badCounterPromote = await changeDepositStage(gov, { id: 'friction.counter-d5', toStage: 'enforce' })
    expect(badCounterPromote).toMatchObject({ ok: false, code: 'constitutional-d5' })

    const spoofRoot = join(dir, 'spoof-deposits')
    const spoofDir = join(spoofRoot, 'spoof-changed')
    mkdirSync(join(spoofDir, 'cases'), { recursive: true })
    writeFileSync(join(spoofDir, 'DEPOSIT.md'), `---\n${JSON.stringify({
      id: 'verify.changed-paths', version: 1, kind: 'gate', point: 'verify.changed-paths',
      trust: 'owner', cases: 'cases/', params: {}, rule: { kind: 'predicates', mode: 'all', clauses: [{ path: 'ok', op: 'eq', value: true, message: 'bad' }] },
    })}\n---\n\n## 意图\nx\n\n## 判据\nx\n\n## 正反例\nx\n\n## 例外\nx\n\n## 修复指引\nx\n`, 'utf8')
    writeFileSync(join(spoofDir, 'cases', 'cases.json'), JSON.stringify([
      { name: 'ok', expected: 'allow', ctx: { ok: true } },
      { name: 'bad', expected: 'deny', ctx: { ok: false } },
    ]), 'utf8')
    expect(RESERVED_BUILTIN_DEPOSIT_IDS.has('verify.changed-paths')).toBe(true)
    const reg = createJudgementRegistry()
    const disc = await discoverAndRegisterDeposits({ registry: reg, dirs: [spoofRoot], registerSeededOssGates: false })
    expect(disc.rejectedIds).toContain('verify.changed-paths')
    await gov.shutdown()
  })

  it('Socket 2: PreExecuteCompletionGuard evaluates custom verify.* points and passes real bugfix taskType', async () => {
    const store = makeStore()
    const dir = makeDir('dsh-p6-sock2-')
    const { events, appender } = makeMemoryAppender()
    const registry = createJudgementRegistry()
    registry.register({
      kind: 'gate', id: 'custom.typecheck-completion', version: 1, point: 'verify.completion' as never,
      description: 'must run pnpm typecheck', placement: { timing: 'pre', enforce: true }, requires: ['commands'],
      gate: (ctx: { commands?: readonly { command: string; exitCode: number | null }[] }) => {
        const ran = (ctx.commands ?? []).some(c => c.command.includes('pnpm typecheck') && c.exitCode === 0)
        return ran ? { kind: 'allow' } : { kind: 'deny', blockers: ['missing pnpm typecheck'] }
      },
    } as never, 'enforce')

    store.tickets.save({
      id: 't-fix-1', title: 'Fix cow env leak bug', decisionId: 'd-1', channels: [], inputs: [], undelivered: [],
      assignments: [{ id: 'a1', state: 'running', createdAt: '2026-11-26T00:00:00Z' }],
      createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z',
      execution: { workspace: 'ws', directory: dir, assignment: 'fix bug', verifyCommands: ['vitest run'] },
    } as unknown as Ticket)

    const ctx = new Context()
    const guard = new PreExecuteCompletionGuard({
      context: ctx, store, registry, appender,
      runVerifyCommand: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    })
    const makeExec = (callId: string) => ({
      callId, rootCallId: callId, name: 'orchestrator_report',
      arguments: { state: 'ready', summary: 'fixed', declared_paths: [] },
      signal: new AbortController().signal, token: Symbol('t') as never,
      agent: { id: 'worker-t-fix-1', session: { id: 'worker-t-fix-1', header: { cwd: dir } } as never } as never,
    })

    const denied = await ctx.waterfall('tools/pre-execute' as never, makeExec('c1') as never, (async () => 'allow') as never)
    expect(denied).toMatchObject({ kind: 'deny' })
    expect((denied as { reason: string }).reason).toContain('[verify.completion]')

    store.tickets.save({
      id: 't-fix-1', title: 'Fix cow env leak bug', decisionId: 'd-1', channels: [], inputs: [], undelivered: [],
      assignments: [{ id: 'a1', state: 'running', createdAt: '2026-11-26T00:00:00Z' }],
      createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z',
      execution: { workspace: 'ws', directory: dir, assignment: 'fix bug', verifyCommands: ['vitest run', 'pnpm typecheck'] },
    } as unknown as Ticket)
    const allowed = await ctx.waterfall('tools/pre-execute' as never, makeExec('c2') as never, (async () => 'allow') as never)
    expect(allowed).toBe('allow')
    const customEv = events.find(e => e.type === 'gate.evaluated' && (e.payload as { point?: string }).point === 'verify.completion')
    expect((customEv?.payload as { taskType?: string } | undefined)?.taskType).toBe('bugfix')
    guard.dispose()
  })

  it('Socket 4: runStandingOrderPatrol evaluates deposit.friction, friction.repeated and verify.failed', async () => {
    const { store, gov } = await setupGov()
    await syncDepositsAndLedger(gov)
    const author = secretaryGovernanceTools(gov).find(t => t.name === 'orchestrator_deposit_author')!
    await author.execute({
      mode: 'install_shadow',
      draft: {
        id: 'order.friction-repeated-patrol', kind: 'standing-order', point: 'deposit.friction',
        intent: '摩擦重复建提案', actionClass: 'observe',
        trigger: { signal: 'friction.repeated', mode: 'on-event' },
        action: { name: 'proposal.create', params: { title: 'auto friction' } },
        cases: [
          { name: 'ok', expected: 'allow', ctx: { signal: 'friction.repeated', seenCount: 3 } },
          { name: 'bad', expected: 'deny', ctx: { signal: 'verify.failed', seenCount: 3 } },
        ],
      },
    } as never, {} as never)
    await author.execute({
      mode: 'install_shadow',
      draft: {
        id: 'order.verify-failed-patrol', kind: 'standing-order', point: 'verify.preflight',
        intent: '验证失败记缺陷', actionClass: 'observe',
        trigger: { signal: 'verify.failed', mode: 'on-event' },
        action: { name: 'defect.record', params: { summary: 'verify failed' } },
        cases: [
          { name: 'ok', expected: 'allow', ctx: { signal: 'verify.failed', blockerCount: 1 } },
          { name: 'bad', expected: 'deny', ctx: { signal: 'friction.repeated', blockerCount: 1 } },
        ],
      },
    } as never, {} as never)

    for (const [idx, ws] of [['1', 'ws-a'], ['2', 'ws-b'], ['3', 'ws-a']] as const) {
      gov.appender.append({
        id: `tool-err-${idx}`, at: `2026-11-26T10:0${idx}:00.000Z`, stream: `ticket:t-${idx}`,
        type: 'worker.tool_finished', source: { kind: 'system', ref: 'test' }, evidence: [], taint: 'trusted',
        payload: { ticketId: `t-${idx}`, workspace: ws, toolName: 'bash', isError: true, clusterKey: 'shared-err' },
      })
    }
    gov.appender.append({
      id: 'verify-deny-1', at: '2026-11-26T10:05:00.000Z', stream: 'ticket:t-1',
      type: 'gate.evaluated', source: { kind: 'system', ref: 'test' }, evidence: [], taint: 'trusted',
      payload: { ticketId: 't-1', point: 'verify.rerun', verdict: { kind: 'deny', blockers: ['failed'] } },
    })
    await gov.flush()

    await runStandingOrderPatrol(gov)
    const m0 = await readM0Events({ db: store.db, memoryDir: gov.memoryDir })
    expect(m0.some(e => e.type === 'gate.evaluated' && (e.payload as { point?: string }).point === 'deposit.friction')).toBe(true)
    expect(m0.some(e => e.type === 'standing_order.evaluated' && (e.payload as { signal?: string }).signal === 'friction.repeated')).toBe(true)
    expect(m0.some(e => e.type === 'standing_order.evaluated' && (e.payload as { signal?: string }).signal === 'verify.failed')).toBe(true)
    await gov.shutdown()
  })

  it('B1: copyCowDependencies strips .env*, .envrc and escaping symlinks even on Darwin CoW copy', async () => {
    const repoDir = makeDir('dsh-p6-cow-repo-')
    const wtDir = makeDir('dsh-p6-cow-wt-')
    const subDir = join(repoDir, 'cache-data', 'nested')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(repoDir, 'cache-data', 'ok.json'), '{"ok":true}\n', 'utf8')
    writeFileSync(join(subDir, '.env.local'), 'SECRET=123\n', 'utf8')
    writeFileSync(join(repoDir, 'cache-data', '.envrc'), 'export API_KEY=xyz\n', 'utf8')
    symlinkSync('/etc/hosts', join(repoDir, 'cache-data', 'bad-link'))

    await copyCowDependencies(repoDir, wtDir, ['cache-data'])
    expect(existsSync(join(wtDir, 'cache-data', 'ok.json'))).toBe(true)
    expect(existsSync(join(wtDir, 'cache-data', 'nested', '.env.local'))).toBe(false)
    expect(existsSync(join(wtDir, 'cache-data', '.envrc'))).toBe(false)
    expect(existsSync(join(wtDir, 'cache-data', 'bad-link'))).toBe(false)
  })

  it('B2: redacts BEFORE clipping in transcript-reader, covers plural secrets key, and redacts readResource output', async () => {
    expect(redactValue({ secrets: 'plain-secret-val' }).value.secrets).toBe('[REDACTED]')

    const store = makeStore()
    const stateDir = makeDir('dsh-p6-red-')
    const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV123456'
    const padding = `${'x'.repeat(148)} `
    store.tickets.save({
      id: 't-red-1', title: 'Redaction ticket', decisionId: 'd-1', channels: [], inputs: [], undelivered: [],
      assignments: [{ id: 'a1', state: 'ended', createdAt: '2026-11-26T00:00:00Z', report: { at: '2026-11-26T00:01:00Z', summary: 'token ghp_1234567890abcdefghijklmnop done' } }],
      createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z',
    } as unknown as Ticket)

    const view = await readTicketTranscript({
      ticketId: 't-red-1', store, stateDir,
      persistence: {
        flush: async () => {},
        open: async () => {
          let readOnce = false
          return {
            read: async () => ({
              eventState: 'detached',
              events: readOnce ? [] : (readOnce = true, [{
                type: 'user/message', seq: 1, time: 1700000000000,
                data: { content: `${padding}${secret} tail` },
              }]),
            }),
            close: async () => {},
            [Symbol.asyncDispose]: async () => {},
          } as never
        },
      },
    })
    const summary = view?.entries[0]?.summary ?? ''
    expect(summary).toContain('[REDACTED]')
    expect(summary).not.toContain('sk-proj-ABCDEF')

    const resOut = await readResource({
      store, masterId: 'master-1',
      sourceLink: async () => '',
      readTranscript: async () => [],
    } as never, 'ticket/t-red-1/result', 0, undefined) as { text: string }
    expect(resOut.text).not.toContain('ghp_1234567890')
    expect(resOut.text).toContain('[REDACTED]')
  })

  it('B3: blocks M0 fallback from leaking tombstoned or private memories to worker callers', async () => {
    const dir = makeDir('dsh-p6-m0guard-')
    const memDir = join(dir, 'memory')
    const { appender } = makeMemoryAppender()
    const lock = new GitRepoLock()
    const { createGitShardSink, createSpineAppender, createSpineFlusher, ensureSpineSchema } = await import('../src/spine/index.ts')
    const memStore = makeStore()
    ensureSpineSchema(memStore.db)
    const flusher = createSpineFlusher(memStore.db, createGitShardSink({ dir: memDir, lock }))
    const realAppender = createSpineAppender(memStore, flusher)
    const writer = new MemoryWriter({ dir: memDir, lock })
    await writer.init()

    const r1 = realAppender.append({ id: 'src-1', stream: 'ticket:t1', type: 'ticket.created', source: { kind: 'system', ref: 'test' }, evidence: [], taint: 'trusted', payload: {} })
    const prop = await writer.propose({
      layer: 'm1', slug: 'facts', scope: 'global', sourceType: 'user_direct', sourceRef: r1,
      statement: 'uniquefallbacktoken_alpha must never leak', author: 'user',
    })
    expect(prop.kind).toBe('accepted')
    if (prop.kind !== 'accepted') throw new Error('expected accepted')
    realAppender.append({
      id: 'm1-prop', stream: 'memory:m1', type: 'memory.proposed', source: { kind: 'human', ref: 'user' }, evidence: [], taint: 'trusted',
      payload: { layer: 'm1', entryId: prop.entry.id, statement: prop.entry.statement },
    })
    await writer.tombstone({ target: { layer: 'm1', slug: 'facts' }, entryId: prop.entry.id, reason: 'obsolete', sourceRef: r1, author: 'user' })
    realAppender.append({
      id: 'm1-tomb', stream: 'memory:m1', type: 'memory.tombstoned', source: { kind: 'human', ref: 'user' }, evidence: [], taint: 'trusted',
      payload: { layer: 'm1', entryId: prop.entry.id },
    })
    realAppender.append({
      id: 'm2-direct', stream: 'memory:m1', type: 'memory.user_direct', source: { kind: 'human', ref: 'user' }, evidence: [], taint: 'trusted',
      payload: { layer: 'm1', statement: 'uniquebosssecret_beta' },
    })
    await flusher.flush()

    const fts = new MemoryFtsIndex({ memoryDir: memDir, dbPath: join(dir, 'fts.sqlite') })
    const workerCaller = { role: 'worker' as const, workspaceId: 'ws-a', maxClearance: 'workspace' as const }
    const tombSearch = await fts.search('uniquefallbacktoken_alpha', workerCaller, { fallbackToM0: true })
    expect(tombSearch.hits).toHaveLength(0)
    expect(tombSearch.m0FallbackHits).toHaveLength(0)

    const privSearch = await fts.search('uniquebosssecret_beta', workerCaller, { fallbackToM0: true })
    expect(privSearch.m0FallbackHits).toHaveLength(0)
    fts.close()
    void appender
  })

  it('B4: changed-paths checks allowedPaths even when declaredPaths is null or non-null', () => {
    const nullWithForbidden = evaluateChangedPaths({
      declaredPaths: null, allowedPaths: ['src/allowed.ts'],
      sessionDiffPaths: ['src/forbidden.ts'], gitDirtyPaths: ['src/forbidden.ts'],
    })
    expect(nullWithForbidden.kind).toBe('deny')

    const arrayWithForbidden = evaluateChangedPaths({
      declaredPaths: ['src/forbidden.ts'], allowedPaths: ['src/allowed.ts'],
      sessionDiffPaths: ['src/forbidden.ts'], gitDirtyPaths: ['src/forbidden.ts'],
    })
    expect(arrayWithForbidden.kind).toBe('deny')
  })

  it('B5: store.atomic preserves depth on SAVEPOINT throw, MemoryWriter enforces global resident budget, and RulingQueue never drops pending items', async () => {
    const store = makeStore()
    const origExec = store.db.exec.bind(store.db)
    let failSavepoint = true
    store.db.exec = ((sql: string) => {
      if (failSavepoint && sql.startsWith('SAVEPOINT')) throw new Error('disk io error')
      return origExec(sql)
    }) as typeof store.db.exec
    expect(() => store.atomic(() => 1)).toThrow('disk io error')
    failSavepoint = false
    let ranCallback = false
    store.atomic(() => { store.afterCommit(() => { ranCallback = true }) })
    expect(ranCallback).toBe(true)

    const memDir = makeDir('dsh-p6-res-')
    const writer = new MemoryWriter({ dir: memDir, lock: new GitRepoLock(), residentMaxChars: 80 })
    await writer.init()
    const ref = { seq: 1, id: 'r1' }
    const m1 = await writer.propose({ layer: 'm1', slug: 'a', scope: 'global', sourceType: 'user_direct', sourceRef: ref, statement: 'A'.repeat(50), resident: true, author: 'user' })
    expect(m1.kind).toBe('accepted')
    const m2 = await writer.propose({ layer: 'm2', scope: 'global', sourceType: 'user_direct', sourceRef: ref, statement: 'B'.repeat(50), resident: true, author: 'user' })
    expect(m2).toMatchObject({ kind: 'rejected', reason: 'resident-budget-exceeded' })

    const qStore = makeStore()
    const { appender } = makeMemoryAppender()
    const queue = new RulingQueue({ store: qStore, appender, memory: writer, memoryDir: memDir, memoryRepoLock: new GitRepoLock() })
    await queue.enqueue({ id: 'keep-pending-1', kind: 'secretary_ask', question: 'p1?' })
    await queue.enqueue({ id: 'keep-pending-2', kind: 'system_escalation', question: 'p2?' })
    const { KV } = await import('../src/kv.ts')
    const cur = qStore.get(KV.governance.rulings) ?? []
    const bulkDecided = Array.from({ length: 299 }, (_, i) => ({
      id: `bulk-${i}`, kind: 'secretary_ask' as const, status: 'decided' as const,
      question: `q-${i}`, options: [], allowFreeText: true, createdAt: '2026-11-26T09:00:00Z', decidedAt: '2026-11-26T09:01:00Z',
    }))
    qStore.set(KV.governance.rulings, [...cur, ...bulkDecided] as never)
    for (let i = 0; i < 4; i++) {
      const id = `done-${i}`
      await queue.enqueue({ id, kind: 'secretary_ask', question: `q-${i}` })
      await queue.decide({ id, decision: 'approve', actorId: 'boss' })
    }
    const pendingIds = queue.list('pending').map(i => i.id)
    expect(pendingIds).toContain('keep-pending-1')
    expect(pendingIds).toContain('keep-pending-2')
  })

  it('B6: online-collector computes 0 reworkRate for clean single-attempt tickets and prevents single-ticket Rung 1 inflation', async () => {
    const events: SpineEnvelope[] = [
      { v: 1, seq: 1, id: 'e1', at: '2026-11-24T10:00:00Z', stream: 'ticket:t-clean', type: 'assignment.started', source: { kind: 'system', ref: 't' }, evidence: [], taint: 'trusted', payload: { ticketId: 't-clean' } },
      { v: 1, seq: 2, id: 'e2', at: '2026-11-24T10:01:00Z', stream: 'ticket:t-clean', type: 'assignment.ended', source: { kind: 'system', ref: 't' }, evidence: [], taint: 'trusted', payload: { ticketId: 't-clean', reason: 'ready' } },
      { v: 1, seq: 3, id: 'e3', at: '2026-11-24T10:02:00Z', stream: 'ticket:t-clean', type: 'ticket.ended', source: { kind: 'system', ref: 't' }, evidence: [], taint: 'trusted', payload: { ticketId: 't-clean', outcome: 'completed' } },
      { v: 1, seq: 4, id: 'e4', at: '2026-11-24T11:00:00Z', stream: 'ticket:t-stuck', type: 'worker.tool_finished', source: { kind: 'system', ref: 't' }, evidence: [], taint: 'trusted', payload: { ticketId: 't-stuck', toolName: 'bash', isError: true, clusterKey: 'same-ticket-3d' } },
      { v: 1, seq: 5, id: 'e5', at: '2026-11-25T11:00:00Z', stream: 'ticket:t-stuck', type: 'worker.tool_finished', source: { kind: 'system', ref: 't' }, evidence: [], taint: 'trusted', payload: { ticketId: 't-stuck', toolName: 'bash', isError: true, clusterKey: 'same-ticket-3d' } },
      { v: 1, seq: 6, id: 'e6', at: '2026-11-26T11:00:00Z', stream: 'ticket:t-stuck', type: 'worker.tool_finished', source: { kind: 'system', ref: 't' }, evidence: [], taint: 'trusted', payload: { ticketId: 't-stuck', toolName: 'bash', isError: true, clusterKey: 'same-ticket-3d' } },
    ]
    const snap = await collectOnlineRsiSnapshot({ events })
    expect(snap.behavioralMetrics.reworkRate).toMatchObject({ state: 'measurable', value: 0 })
    expect(snap.behavioralMetrics.firstTryPassRate).toMatchObject({ state: 'measurable', value: 1 })
    expect(snap.clusters.find(c => c.key === 'same-ticket-3d')?.qualifiesForRung1).toBe(false)
  })

  it('L1: serializes concurrent provisionWorktree calls on the same repo without .git/config lock races', async () => {
    const repo = makeDir('dsh-p6-wt-repo-')
    const workRoot = makeDir('dsh-p6-wt-out-')
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' })
    git(['init', '-b', 'main'])
    git(['config', 'user.name', 'Tester'])
    git(['config', 'user.email', 'tester@example.com'])
    writeFileSync(join(repo, 'README.md'), 'init\n')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
    const baseSha = git(['rev-parse', 'HEAD']).trim()
    const ws = { id: 'ws-race', repository: repo, baseBranch: 'main', branchPrefix: 'ticket/', isolation: 'I2' as const }

    const res = await Promise.all([1, 2, 3, 4].map(i => provisionWorktree({
      ticketId: `tk-${i}`, workspace: ws, executionName: `race-${i}`, targetDir: join(workRoot, `wt-${i}`),
    })))
    expect(res).toHaveLength(4)
    for (const r of res) {
      expect(r.base).toBe(baseSha)
      expect(git(['config', '--get', `branch.${r.branch}.base`]).trim()).toBe(baseSha)
    }
  })

  it('L2: excludes panel-only workspaces from orchestrator_settings_save schema while documenting it in settings resource', () => {
    const dummyHost = {
      context: new Context(), engine: {}, store: {}, prompts: {}, sessions: {}, settings: {}, assessor: {},
      resources: { store: {}, pages: new Map(), prompts: {}, commands: {}, masterId: 'm', context: new Context(),
        promptVersion: () => ({}), mayRead: () => false, feishuPageSize: () => 20, sourceLink: async () => ({}) },
    }
    const saveTool = mainTools(dummyHost as never, { id: 'm' } as never).find(t => t.name === 'orchestrator_settings_save')!
    expect(saveTool.schema.safeParse({ block: 'workspaces', value: [], revision: 0 }).success).toBe(false)
    expect(saveTool.schema.safeParse({ block: 'eval', value: {}, revision: 0 }).success).toBe(true)
    expect(RESOURCES.find(r => r.name === 'settings/<block>')?.holds).toContain('workspaces (panel-only)')
  })

  it('L3: unlocks bash test runs on provisioned worktree via M0 base + --ignored + digest audit while blocking all tamper/secret vectors', async () => {
    const repo = makeDir('dsh-p6-l3-repo-'), stateDir = makeDir('dsh-p6-l3-state-')
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' })
    git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', 'Tester']); git(repo, ['config', 'user.email', 't@example.com'])
    writeFileSync(join(repo, '.gitignore'), '.env*\nnode_modules/\ncoverage/\n*.tsbuildinfo\n')
    mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(join(repo, 'tests'), { recursive: true }); mkdirSync(join(repo, 'node_modules/pkg'), { recursive: true })
    writeFileSync(join(repo, 'src/app.ts'), 'export const val = 1\n'); writeFileSync(join(repo, 'tests/app.test.ts'), 'expect(1).toBe(1)\n')
    writeFileSync(join(repo, 'node_modules/pkg/ok.js'), '1\n')
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'init'])

    const store = new Store(join(stateDir, 'orch.db')); stores.push(store); ensureSpineSchema(store.db, 0)
    const appender = createSpineAppender(store, { kick: () => {} })
    const ws = { id: 'ws-l3', repository: repo, baseBranch: 'main', branchPrefix: 'ticket/', isolation: 'I2' as const, cowPaths: ['node_modules'] }
    store.saveSettings({ ...store.settings(), workspaces: [ws] })
    const registry = createJudgementRegistry()
    await discoverAndRegisterDeposits({ registry, dirs: [join(process.cwd(), 'deposits')], registerSeededOssGates: false })

    const makeWt = async (id: string, name: string) => {
      const wtDir = join(stateDir, 'work', `${name}-${id}`)
      await provisionWorktree({ ticketId: id, workspace: ws, executionName: name, targetDir: wtDir, appender })
      store.tickets.save({ id, title: `fix ${name}`, state: 'working', origin: { triggerId: id, triggerIds: [id], thread: 'desk:1' },
        channels: [], mandate: { strength: 'explicit', basis: {}, actor: { source: 'secretary-bus', id: 'boss' } },
        execution: { directory: wtDir, name: `${name}-${id}`, assignment: 'fix', workspace: 'ws-l3', verifyCommands: ['npm test'] }, assignments: [] } as never)
      return wtDir
    }
    let nextCmd = { exitCode: 1, stdout: '', stderr: 'failed' }
    const ctx = new Context(), memDir = join(stateDir, 'memory')
    const guard = new PreExecuteCompletionGuard({
      context: ctx, store, registry, appender, memoryDir: memDir,
      runVerifyCommand: async (_cmd, cwd) => {
        const src = existsSync(join(cwd, 'src/app.ts')) ? readFileSync(join(cwd, 'src/app.ts'), 'utf8') : ''
        return src.includes('val = 1') ? { exitCode: 1, stdout: '', stderr: 'base defect red' } : nextCmd
      },
    })
    const pre = (id: string, wt: string, args: unknown) => ctx.waterfall('tools/pre-execute' as never,
      { callId: `c-${Math.random()}`, name: 'orchestrator_report', arguments: args, signal: new AbortController().signal,
        agent: { id: `worker-${id}`, session: { id: `worker-${id}`, header: { cwd: wt } } } } as never, (async () => 'allow') as never)
    const emitEdit = (id: string, wt: string, rel: string, content: string) => {
      writeFileSync(join(wt, rel), content)
      ctx.emit('tools/result', { name: 'edit', agent: { id: `worker-${id}`, session: { id: `worker-${id}`, header: { cwd: wt } } } } as never,
        { isError: false, content: [], meta: { diffs: [{ path: rel }] } })
    }
    const emitBash = (id: string, wt: string, command: string) => {
      ctx.emit('tools/result', { name: 'bash', arguments: { command }, agent: { id: `worker-${id}`, session: { id: `worker-${id}`, header: { cwd: wt } } } } as never,
        { isError: false, content: [] })
    }

    // 1. Structured edits + bash npm test (creating build artifacts) -> verify.changed-paths / verify.rerun run, commit clean -> allow!
    const wt1 = await makeWt('t-ok', 'ok-wt')
    emitEdit('t-ok', wt1, 'src/app.ts', 'export const val = 2\n')
    emitEdit('t-ok', wt1, 'tests/app.test.ts', 'expect(2).toBe(2)\n')
    mkdirSync(join(wt1, 'coverage'), { recursive: true }); writeFileSync(join(wt1, 'coverage/lcov.info'), 'SF:src/app.ts\n')
    writeFileSync(join(wt1, 'tsconfig.tsbuildinfo'), '{}')
    emitBash('t-ok', wt1, 'npm test')
    expect(await pre('t-ok', wt1, { state: 'ready', summary: 'hide test', declared_paths: ['src/app.ts'] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('漏报') })
    expect(await pre('t-ok', wt1, { state: 'ready', summary: 'fail test', declared_paths: ['src/app.ts', 'tests/app.test.ts'] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('verify.rerun') })
    nextCmd = { exitCode: 0, stdout: 'ok', stderr: '' }
    git(wt1, ['config', 'user.name', 'W']); git(wt1, ['config', 'user.email', 'w@example.com'])
    git(wt1, ['add', 'src/app.ts', 'tests/app.test.ts']); git(wt1, ['commit', '-m', 'fix'])
    expect(await pre('t-ok', wt1, { state: 'ready', summary: 'done', declared_paths: ['src/app.ts', 'tests/app.test.ts'] })).toBe('allow')

    // 2. Negative tamper / secret vectors must stay shell-blind!
    const wt2 = await makeWt('t-sneak', 'sneak-wt'); emitEdit('t-sneak', wt2, 'src/app.ts', 'export const val = 3\n')
    writeFileSync(join(wt2, 'src/sneak.ts'), 'x\n'); emitBash('t-sneak', wt2, 'echo x > src/sneak.ts')
    expect(await pre('t-sneak', wt2, { state: 'ready', summary: 'done', declared_paths: ['src/app.ts', 'src/sneak.ts'] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('shell-blind') })

    const wt3 = await makeWt('t-tamper', 'tamper-wt'); emitEdit('t-tamper', wt3, 'src/app.ts', 'export const val = 4\n')
    writeFileSync(join(wt3, 'src/app.ts'), 'export const val = 999\n'); emitBash('t-tamper', wt3, 'echo 999 >> src/app.ts')
    expect(await pre('t-tamper', wt3, { state: 'ready', summary: 'done', declared_paths: ['src/app.ts'] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('shell-blind') })

    const wt4 = await makeWt('t-sec', 'sec-wt'); emitEdit('t-sec', wt4, 'src/app.ts', 'export const val = 5\n')
    writeFileSync(join(wt4, '.env.local'), 'SECRET=1\n'); emitBash('t-sec', wt4, 'npm test')
    expect(await pre('t-sec', wt4, { state: 'ready', summary: 'done', declared_paths: ['src/app.ts'] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('shell-blind') })

    const wt5 = await makeWt('t-det', 'det-wt'); emitEdit('t-det', wt5, 'src/app.ts', 'export const val = 6\n')
    git(wt5, ['checkout', '--detach', 'HEAD']); emitBash('t-det', wt5, 'npm test')
    expect(await pre('t-det', wt5, { state: 'ready', summary: 'done', declared_paths: ['src/app.ts'] })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('shell-blind') })
    guard.dispose()
  })
})
