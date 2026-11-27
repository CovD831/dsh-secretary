/** 阶段三运行时主干全链路治理串联与红绿验证：Spine M0 + Judgement + Workspaces GC + 1-Hop Capsule。 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { GovernanceRuntime } from '../src/app/governance.ts'
import { Outbox } from '../src/app/outbox.ts'
import { Store } from '../src/app/store.ts'
import { zh, en } from '../src/client/locales.ts'
import { Engine, type OutboundMessage, type Ticket } from '../src/core/index.ts'
import { prepareLaunchCapsule } from '../src/executor/capsule-hook.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { extractSessionPtr } from '../src/rsi/trace-bridge.ts'
import type { SpineEnvelope } from '../src/spine/types.ts'
import { provisionWorktree, type WorkspaceDef } from '../src/workspaces/index.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []
const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout.trim()
function makeTempDir(prefix: string): string { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); tempDirs.push(d); return d }

function readShardEvents(memoryDir: string): SpineEnvelope<Record<string, unknown>>[] {
  const m0 = join(memoryDir, 'm0')
  if (!existsSync(m0)) return []
  return readdirSync(m0).filter(n => n.endsWith('.jsonl')).sort().flatMap(name => {
    const raw = readFileSync(join(m0, name), 'utf8').trim()
    return raw ? raw.split('\n').map(line => JSON.parse(line) as SpineEnvelope<Record<string, unknown>>) : []
  })
}

async function initSampleRepo(root: string): Promise<{ repoDir: string; ws: WorkspaceDef }> {
  const repoDir = join(root, 'repo')
  mkdirSync(join(repoDir, 'src', 'core'), { recursive: true })
  mkdirSync(join(repoDir, 'src', 'app'), { recursive: true })
  mkdirSync(join(repoDir, 'tests'), { recursive: true })
  writeFileSync(join(repoDir, 'src', 'core', 'ledger.ts'), 'export interface LedgerEntry { readonly id: string; readonly amount: number }\nexport function formatEntry(e: LedgerEntry): string { const SECRET_BODY = "hidden"; return `${e.id}:${SECRET_BODY}` }')
  writeFileSync(join(repoDir, 'src', 'core', 'billing.ts'), "import { formatEntry, type LedgerEntry } from './ledger.ts'\nexport function bill(item: LedgerEntry): string { return formatEntry(item) }")
  writeFileSync(join(repoDir, 'src', 'app', 'runner.ts'), "import { bill } from '../core/billing.ts'\nexport const run = () => bill({ id: 'a', amount: 1 })\n")
  writeFileSync(join(repoDir, 'tests', 'billing.spec.ts'), "import { bill } from '../src/core/billing.ts'\nexport const t = () => bill\n")
  await git(repoDir, 'init', '-b', 'main')
  await git(repoDir, 'config', 'user.name', 'Test User'); await git(repoDir, 'config', 'user.email', 'test@example.com')
  await git(repoDir, 'add', '.'); await git(repoDir, 'commit', '-m', 'init')
  return { repoDir, ws: { id: 'app', repository: repoDir, baseBranch: 'main', branchPrefix: 'agent/', isolation: 'I2' } }
}

function createWiredEngine(store: Store, governance: GovernanceRuntime) {
  return new Engine({
    repo: store,
    scope: { scope: () => ({ listened: true, observed: false, row: 'chat' }) },
    policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } }), revalidate: () => true, admitsInferred: () => true }),
    assessor: { request: () => {} }, executor: { start: () => {}, deliver: () => {}, stop: () => {} }, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
    prepareTicket: (ticket, outcome) => ({ ...ticket, execution: { name: outcome.name ?? 't1', directory: join(governance.memoryDir, '..', 'work', ticket.id), assignment: outcome.scope } }),
    emit: event => {
      governance.recordDomainEvent(event)
      if (event.type === 'ticket.ended') {
        const ended = store.tickets.get(event.data.ticketId)
        if (ended) void governance.onTicketEnded(ended)
      }
    },
  })
}

afterEach(() => { while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true }) })

describe('阶段三 Runtime 主干全链路治理接入', () => {
  it('测试1：原子入脊、resolveSpineRef 真伪核验、删库重建 seq 对齐与停机微任务防踩关库', async () => {
    const stateDir = makeTempDir('wiring-spine-')
    const dbPath = join(stateDir, 'orchestrator.sqlite')
    const store = new Store(dbPath)
    const governance = new GovernanceRuntime({ store, stateDir })
    try {
      await governance.recover()
      expect(governance.registry.list().map(g => [g.id, g.stage])).toEqual([
        ['workspace.gc.safety', 'enforce'],
        ['ticket.dispatch.isolation-ceiling', 'enforce'],
        ['ticket.adaptive-dispatch', 'enforce'],
        ['verify.changed-paths', 'enforce'],
        ['verify.rerun', 'enforce'],
        ['replay.ci-evaluator', 'observe'],
        ['verify.secret-path-guard', 'enforce'],
        ['friction.seen-three', 'observe'],
        ['ticket.stale-patrol', 'observe'],
        ['verify.change-test-coverage', 'observe'],
        ['verify.command-contract', 'observe'],
      ])

      const engine = createWiredEngine(store, governance)
      expect(() => store.atomic(() => {
        governance.recordDomainEvent({ type: 'trigger.received', at: new Date().toISOString(), data: { triggerId: 'rollback-tr', threads: ['c:1'] } })
        throw new Error('tx-abort')
      })).toThrow('tx-abort')
      const trigger = feishu('1', '@bot 修复账单问题')
      expect(engine.receive(trigger)).toBe('stored')
      engine.evaluateDue()
      const decision = engine.decide(trigger.id, { kind: 'accept', title: '修复账单', scope: 'fix billing', reason: { code: 'explicitRouted' }, acknowledgement: '收到。', name: 'fix-billing' })
      const ticketId = decision.ticketId!
      engine.assignmentStarted(ticketId, store.tickets.get(ticketId)!.assignments[0]!.id)
      engine.report(ticketId, { state: 'ready', summary: '已完成修复' })

      const bufferedRef = governance.appender.append({ id: 'buf-check-1', stream: 'system:test', type: 'test.buffered', source: { kind: 'system', ref: 'test' }, evidence: [], taint: 'trusted', payload: {} })
      expect(await governance.resolveSpineRef(bufferedRef)).toBe(true)
      expect(await governance.resolveSpineRef({ seq: bufferedRef.seq, id: 'forged-id' })).toBe(false)
      expect(await governance.resolveSpineRef({ seq: 0, id: bufferedRef.id })).toBe(false)

      await governance.flush()
      const events = readShardEvents(governance.memoryDir)
      expect(events.length).toBeGreaterThanOrEqual(8)
      expect(events.map(e => e.seq)).toEqual(events.map((_, idx) => idx + 1))
      expect(events.some(e => e.payload['triggerId'] === 'rollback-tr')).toBe(false)
      const endedEv = events.find(e => e.type === 'ticket.ended')!
      expect(endedEv.payload['sessionPtr']).toBe(`dsh-session:worker-${ticketId}`)
      expect(extractSessionPtr(endedEv)).toEqual({ sessionId: `worker-${ticketId}` })
      expect(await governance.resolveSpineRef(bufferedRef)).toBe(true)
      expect(await governance.resolveSpineRef({ seq: 9999, id: 'missing' })).toBe(false)
    } finally { await governance.shutdown(); store.close() }

    // 删库重建 + 分片末尾半行残骸 + 停机微任务竞态验证
    const shard = readdirSync(join(stateDir, 'memory', 'm0')).find(n => n.endsWith('.jsonl'))!
    appendFileSync(join(stateDir, 'memory', 'm0', shard), '{"v":1,"seq":999,"id":"torn', 'utf8')
    const rebuiltStore = new Store(join(stateDir, 'rebuilt.sqlite'))
    const rebuiltGov = new GovernanceRuntime({ store: rebuiltStore, stateDir })
    const preRecoverRef = rebuiltGov.appender.append({ id: 'after-rebuild-1', stream: 'system:test', type: 'test.rebuilt', source: { kind: 'system', ref: 'test' }, evidence: [], taint: 'trusted', payload: {} })
    expect(preRecoverRef.seq).toBeGreaterThanOrEqual(9)
    await rebuiltGov.recover()
    rebuiltGov.recordDomainEvent({ type: 'policy.changed', at: new Date().toISOString(), data: { from: 'v1', to: 'v2' } })
    await rebuiltGov.shutdown()
    rebuiltStore.close()
    await new Promise<void>(r => setTimeout(r, 20))
    expect(readShardEvents(rebuiltGov.memoryDir).some(e => e.type === 'policy.changed')).toBe(true)
  })

  it('测试2：outbox.send 事前硬闸拦截(gateDenied)并补齐译文，unmeasured 抛错计次告警不永久静默阻塞，合规放行', async () => {
    expect([zh['reason.gateDenied'], en['reason.gateDenied']]).toEqual(['外发前被判据硬闸拦截', 'Blocked by an outbound judgement gate'])
    const h = await startRuntime()
    try {
      const lark = vi.mocked(Commands.prototype.lark); lark.mockClear()
      h.runtime.governance.registry.register({
        kind: 'gate', id: 'outbox.no-secret', version: 1, point: 'outbox.send',
        description: '拦截违禁密钥标记与未知盲区外发', side: 'hard',
        placement: { timing: 'pre', enforce: true }, requires: ['message', 'message.text'],
        gate: ({ message }) => {
          if (message.text.includes('FORBIDDEN_SECRET')) return { kind: 'deny', blockers: ['禁止外发含 FORBIDDEN_SECRET'] }
          if (message.text.includes('UNMEASURED_BLIND')) return { kind: 'unmeasured', cause: 'no-evidence', detail: '外部脱敏不可测', disposition: 'tolerate' }
          return { kind: 'allow' }
        },
      }, 'enforce')

      const ch = feishu('21', 'hi').channel!
      const blocked: OutboundMessage = { id: 'msg-deny', channel: ch, text: '泄漏 FORBIDDEN_SECRET', kind: 'notice' }
      const blind: OutboundMessage = { id: 'msg-blind', channel: ch, text: '触发 UNMEASURED_BLIND', kind: 'notice' }
      const safe: OutboundMessage = { id: 'msg-ok', channel: ch, text: '正常完成通知', kind: 'notice' }
      h.runtime.outbox.send(blocked); h.runtime.outbox.send(blind); h.runtime.outbox.send(safe)
      await h.runtime.sendReplies(); await h.runtime.governance.flush()

      expect(h.runtime.outbox.status('msg-deny')).toBe('dropped')
      expect(h.runtime.store.receipts.get('msg-deny')?.dropped?.reason).toBe('gateDenied')
      expect(h.runtime.outbox.status('msg-blind')).toBe('pending')
      const eff = h.runtime.store.db.prepare("SELECT attempts, error FROM effect WHERE kind = 'reply' AND key = 'msg-blind'").get() as { attempts: number; error: string }
      expect(eff.attempts).toBe(1)
      expect(eff.error).toContain('Outbound gate unmeasured')
      expect(h.runtime.outbox.status('msg-ok')).toBe('sent')
      expect(lark.mock.calls.map(([args]) => args.join(' ')).some(t => t.includes('FORBIDDEN_SECRET') || t.includes('UNMEASURED_BLIND'))).toBe(false)

      // 连续 3 次 unmeasured 失败触发健康告警且不再阻断后续同会话消息
      const store = new Store(join(makeTempDir('outbox-err-'), 's.sqlite')), fxBoard = new HealthBoard(), sendSpy = vi.fn(async () => 'sent' as const)
      let nowMs = 1_000_000
      const fx = new Effects(store, fxBoard, () => nowMs)
      const outbox = new Outbox({
        store, effects: fx, commands: new Commands(() => ({}) as never, {}, new AbortController().signal),
        sources: { instance: () => ({ id: 'feishu', kind: 'feishu', enabled: true, installed: true, config: {} as never }), channelAllowed: () => true, send: sendSpy },
        paused: () => false,
        evaluateOutbound: async m => m.id === 'm1' ? { kind: 'unmeasured', cause: 'timeout', detail: 'down', disposition: 'tolerate' } : { kind: 'allow' },
      })
      fx.start()
      outbox.send({ id: 'm1', channel: ch, text: 'first', kind: 'reply', ticketId: 'tk1' })
      outbox.send({ id: 'm2', channel: ch, text: 'second', kind: 'reply', ticketId: 'tk1' })
      for (let i = 0; i < 3; i++) { await outbox.sent(); nowMs += 60_000 }
      expect(outbox.status('m1')).toBe('pending')
      expect(fxBoard.all['reply']?.state).toBe('error')
      expect(outbox.status('m2')).toBe('sent')
      await fx.drain(); store.close()
    } finally { await h.stop() }
  })

  it('测试3：发射前 rg 1-Hop 切片、allowTeam=false 拦发射与异常降级、及工单结束 GC 与 executed 入脊', async () => {
    const stateDir = makeTempDir('wiring-gc-')
    const { repoDir, ws } = await initSampleRepo(stateDir)
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    store.saveSettings(SettingsSchema.parse({ workspaces: [ws] }))
    const governance = new GovernanceRuntime({ store, stateDir })
    try {
      await governance.recover()
      const ticketA: Ticket = {
        id: 't-solo', title: 'Fix src/core/billing.ts', decisionId: 'd1', channels: [], undelivered: [], createdAt: '2026-11-24T00:00:00Z', updatedAt: '2026-11-24T00:00:00Z',
        mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'u1' }, scope: 'fix' },
        origin: { triggerId: 'tr1', triggerIds: ['tr1'] }, assignments: [{ id: 'a0', state: 'pending', createdAt: '2026-11-24T00:00:00Z' }], inputs: [],
        execution: { name: 'fix-a', directory: repoDir, assignment: 'Update src/core/billing.ts', workspace: ws.id },
      }
      const solo = await governance.prepareLaunchCapsule({ ticket: ticketA, assignment: ticketA.assignments[0]!, workspaceDir: repoDir, triggerText: '检查 src/core/billing.ts' })
      expect(solo?.dispatch).toEqual({ executionMode: 'solo', thinkingTier: 'low' })
      expect(solo!.capsule.text).toContain('export interface LedgerEntry')
      expect(solo!.capsule.text).not.toContain('SECRET_BODY')
      expect(await prepareLaunchCapsule({ ticket: { ...ticketA, title: '普通任务', execution: { name: 'n', directory: repoDir, assignment: '无路径' } }, workspaceDir: repoDir, triggerText: '无 missing/x.ts', registry: governance.registry })).toBeUndefined()

      const retriedTicket: Ticket = {
        ...ticketA, id: 't-team',
        assignments: [
          { id: 'a0', state: 'ended', createdAt: 't0', endedReason: 'retried', report: { state: 'failed', summary: 'e1', at: 't1' } },
          { id: 'a1', state: 'ended', createdAt: 't2', endedReason: 'retried', report: { state: 'failed', summary: 'e2', at: 't3' } },
          { id: 'a2', state: 'pending', createdAt: 't4' },
        ],
      }
      const escalated = await governance.prepareLaunchCapsule({ ticket: retriedTicket, assignment: retriedTicket.assignments[2]!, workspaceDir: repoDir })
      expect(escalated!.dispatch).toMatchObject({ executionMode: 'team', thinkingTier: 'high' })
      const deniedPlan = await prepareLaunchCapsule({ ticket: retriedTicket, assignment: retriedTicket.assignments[2]!, workspaceDir: repoDir, registry: governance.registry, allowTeam: false })
      expect(deniedPlan?.verdict.kind).toBe('deny')
      expect(deniedPlan?.blocked?.[0]).toContain('禁止 team 模式')
      expect(deniedPlan?.dispatch).toBeUndefined()

      const prompted: string[] = []
      store.triggers.save({ id: 'tr1', source: 'feishu', threads: [{ source: 'feishu', id: 'c1:m1' }], actor: { source: 'feishu', id: 'u1' }, human: true, at: '2026-11-24T00:00:00Z', text: '请修改 src/core/billing.ts', meta: {} })
      store.tickets.save(ticketA)
      const makeExec = (prepareCapsule: NonNullable<ConstructorParameters<typeof DshExecutor>[0]['prepareCapsule']>) => new DshExecutor({
        context: { agents: { get: () => undefined }, on: () => () => {} } as never,
        engine: { assignmentStarted: () => {}, inputsDelivered: () => {}, inputsRead: () => {}, turnEnded: () => {}, deliveryFailed: () => {}, report: () => ticketA, assignmentInterrupted: () => {} },
        store, effects: new Effects(store, new HealthBoard()), health: new HealthBoard().claim('worker'), machine: { stateDir }, lifetime: new AbortController().signal,
        sessions: { ensure: async () => ({ inbox: { remove: () => false } }) as never, prompt: async (_s, _r, text) => { prompted.push(text) }, holds: async () => false, relay: () => {}, promptedId: id => id as never },
        closing: () => false, paused: () => false, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined,
        prepareCapsule, onCapsuleError: (t, a, e) => governance.recordCapsuleUnmeasured(t, a, e),
      })
      await (makeExec(input => governance.prepareLaunchCapsule(input)) as unknown as { launch(t: Ticket, a: Ticket['assignments'][0]): Promise<void> }).launch(ticketA, ticketA.assignments[0]!)
      expect(JSON.parse(prompted[0]!)['dispatch_plan']).toEqual({ executionMode: 'solo', thinkingTier: 'low' })
      // 切片异常隔离回退无胶囊正常发射，并向 M0 补记 unmeasured；而 enforce deny 真正拒发
      await (makeExec(async () => { throw new Error('rg crashed') }) as unknown as { launch(t: Ticket, a: Ticket['assignments'][0]): Promise<void> }).launch(ticketA, ticketA.assignments[0]!)
      expect(JSON.parse(prompted[1]!)['context_capsule']).toBeUndefined()
      await expect((makeExec(async () => deniedPlan) as unknown as { launch(t: Ticket, a: Ticket['assignments'][0]): Promise<void> }).launch(ticketA, ticketA.assignments[0]!)).rejects.toThrow('Adaptive dispatch denied')

      const dirtyDir = join(stateDir, 'wts', 'dirty-wt'), cleanDir = join(stateDir, 'wts', 'clean-wt')
      await provisionWorktree({ ticketId: 't-dirty', workspace: ws, executionName: 'dirty-wt', targetDir: dirtyDir, appender: governance.appender })
      writeFileSync(join(dirtyDir, 'untracked.txt'), 'keep me\n')
      await provisionWorktree({ ticketId: 't-clean', workspace: ws, executionName: 'clean-wt', targetDir: cleanDir, appender: governance.appender })
      writeFileSync(join(cleanDir, 'done.txt'), 'shipped\n'); await git(cleanDir, 'add', 'done.txt'); await git(cleanDir, 'commit', '-m', 'done')
      await git(repoDir, 'merge', '--ff-only', 'agent/clean-wt')
      const engine = createWiredEngine(store, governance)
      for (const [id, name, dir] of [['t-dirty', 'dirty-wt', dirtyDir], ['t-clean', 'clean-wt', cleanDir]] as const) {
        store.tickets.save({ ...ticketA, id, execution: { name, directory: dir, assignment: '', workspace: ws.id }, assignments: [{ id: `${id}-a0`, state: 'running', createdAt: '2026-11-24T00:00:00Z' }] })
        engine.report(id, { state: 'ready', summary: 'done' })
      }
      await governance.flush()

      expect([existsSync(dirtyDir), existsSync(cleanDir)]).toEqual([true, false])
      const allEvents = readShardEvents(governance.memoryDir)
      expect(allEvents.some(e => e.type === 'gate.evaluated' && e.payload['ticketId'] === ticketA.id && (e.payload['verdict'] as { kind: string }).kind === 'unmeasured')).toBe(true)
      const gcExec = allEvents.find(e => e.type === 'workspace.gc.executed' && e.payload['ticketId'] === 't-clean')!
      expect(gcExec.payload).toMatchObject({ removed: true, branchRemoved: true, sessionPtr: 'dsh-session:worker-t-clean' })
    } finally { await governance.shutdown(); store.close() }
  })
})
