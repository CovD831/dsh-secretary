/** 阶段三运行时主干全链路治理串联与红绿验证：Spine M0 + Judgement + Workspaces GC + 1-Hop Capsule。 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { GovernanceRuntime } from '../src/app/governance.ts'
import { Outbox } from '../src/app/outbox.ts'
import { Store } from '../src/app/store.ts'
import { Engine, type OutboundMessage, type Ticket } from '../src/core/index.ts'
import { prepareLaunchCapsule } from '../src/executor/capsule-hook.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { verifyChangedPathsGate } from '../src/judgement/gates/index.ts'
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
  it('测试1：Engine + Store + GovernanceRuntime 原子入脊并落盘递增 seq 与 dsh-session 指针（含默认注册表阶段）', async () => {
    const stateDir = makeTempDir('wiring-spine-')
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    const governance = new GovernanceRuntime({ store, stateDir })
    try {
      await governance.recover()
      expect(governance.registry.list().map(g => [g.id, g.stage])).toEqual([
        ['workspace.gc.safety', 'enforce'], ['ticket.adaptive-dispatch', 'enforce'], ['verify.changed-paths', 'shadow'], ['verify.rerun', 'shadow'],
      ])
      governance.registry.unregister('verify.changed-paths'); governance.registry.register(verifyChangedPathsGate, 'enforce')
      expect(governance.registry.list().find(g => g.id === 'verify.changed-paths')?.stage).toBe('enforce')

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

      const report = await governance.flush()
      expect(report.to).toBeGreaterThanOrEqual(7)
      const events = readShardEvents(governance.memoryDir)
      expect(events.map(e => e.seq)).toEqual(events.map((_, idx) => idx + 1))
      expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['trigger.received', 'eval.started', 'decision.recorded', 'ticket.created', 'assignment.started', 'ticket.ended']))
      expect(events.some(e => e.payload['triggerId'] === 'rollback-tr')).toBe(false)
      const endedEv = events.find(e => e.type === 'ticket.ended')!
      expect(endedEv.payload['sessionPtr']).toBe(`dsh-session:worker-${ticketId}`)
      expect(extractSessionPtr(endedEv)).toEqual({ sessionId: `worker-${ticketId}` })
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM event_spine').get()).toEqual({ n: 0 })
    } finally { await governance.shutdown(); store.close() }
  })

  it('测试2：outbox.send 事前硬闸拦截违禁消息并落盘 deny 记录，对 unmeasured 拒绝放行，合规消息正常发出', async () => {
    const h = await startRuntime()
    try {
      const lark = vi.mocked(Commands.prototype.lark); lark.mockClear()
      h.runtime.governance.registry.register({
        kind: 'gate', id: 'outbox.no-secret', version: 1, point: 'outbox.send',
        description: '拦截违禁密钥标记与未知盲区外发', side: 'hard',
        placement: { timing: 'pre', enforce: true }, requires: ['message', 'message.text'],
        gate: ({ message }) => {
          if (message.text.includes('FORBIDDEN_SECRET')) return { kind: 'deny', blockers: ['禁止外发含 FORBIDDEN_SECRET'] }
          if (message.text.includes('UNMEASURED_BLIND')) return { kind: 'unmeasured', cause: 'timeout', detail: '外部脱敏检测超时' }
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
      expect(h.runtime.outbox.status('msg-ok')).toBe('sent')
      const sentTexts = lark.mock.calls.map(([args]) => args.join(' '))
      expect(sentTexts.some(t => t.includes('FORBIDDEN_SECRET') || t.includes('UNMEASURED_BLIND'))).toBe(false)
      expect(sentTexts.some(t => t.includes('正常完成通知'))).toBe(true)

      const gateEvs = readShardEvents(h.runtime.governance.memoryDir).filter(e => e.type === 'gate.evaluated' && e.payload['point'] === 'outbox.send')
      expect(gateEvs.some(e => e.payload['messageId'] === 'msg-deny' && (e.payload['verdict'] as { kind: string }).kind === 'deny')).toBe(true)
      expect(gateEvs.some(e => e.payload['messageId'] === 'msg-blind' && (e.payload['verdict'] as { kind: string }).kind === 'unmeasured')).toBe(true)

      const store = new Store(join(makeTempDir('outbox-compat-'), 's.sqlite')), effects = new Effects(store, new HealthBoard()), sendSpy = vi.fn(async () => 'sent' as const)
      const compat = new Outbox({ store, effects, commands: new Commands(() => ({}) as never, {}, new AbortController().signal),
        sources: { instance: () => ({ id: 'feishu', kind: 'feishu', enabled: true, installed: true, config: {} as never }), channelAllowed: () => true, send: sendSpy }, paused: () => false })
      effects.start(); compat.send(safe); await compat.sent()
      expect([compat.status('msg-ok'), sendSpy.mock.calls.length]).toEqual(['sent', 1])
      await effects.drain(); store.close()
    } finally { await h.stop() }
  })

  it('测试3：发射前 rg 1-Hop 切片注入与 team 升档、及工单结束 worktree 脏保留/净回收安全 GC', async () => {
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
      expect(solo!.slice.relatedTests).toContain('tests/billing.spec.ts')

      expect(await prepareLaunchCapsule({ ticket: { ...ticketA, title: '普通任务', execution: { name: 'n', directory: repoDir, assignment: '无路径' } }, workspaceDir: repoDir, triggerText: '不存在 missing/x.ts', registry: governance.registry })).toBeUndefined()

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
      expect(escalated!.dispatch.escalateReason).toContain('retryCount(2)')

      const prompted: string[] = []
      store.triggers.save({ id: 'tr1', source: 'feishu', threads: [{ source: 'feishu', id: 'c1:m1' }], actor: { source: 'feishu', id: 'u1' }, human: true, at: '2026-11-24T00:00:00Z', text: '请修改 src/core/billing.ts', meta: {} })
      store.tickets.save(ticketA)
      const executor = new DshExecutor({
        context: { agents: { get: () => undefined }, on: () => () => {} } as never,
        engine: { assignmentStarted: () => {}, inputsDelivered: () => {}, inputsRead: () => {}, turnEnded: () => {}, deliveryFailed: () => {}, report: () => ticketA, assignmentInterrupted: () => {} },
        store, effects: new Effects(store, new HealthBoard()), health: new HealthBoard().claim('worker'), machine: { stateDir }, lifetime: new AbortController().signal,
        sessions: { ensure: async () => ({ inbox: { remove: () => false } }) as never, prompt: async (_s, _r, text) => { prompted.push(text) }, holds: async () => false, relay: () => {}, promptedId: id => id as never },
        closing: () => false, paused: () => false, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined,
        prepareCapsule: input => governance.prepareLaunchCapsule(input),
      })
      await (executor as unknown as { launch(t: Ticket, a: Ticket['assignments'][0]): Promise<void> }).launch(ticketA, ticketA.assignments[0]!)
      const launchJson = JSON.parse(prompted[0]!) as Record<string, unknown>
      expect(launchJson['dispatch_plan']).toEqual({ executionMode: 'solo', thinkingTier: 'low' })
      expect((launchJson['context_capsule'] as { text: string }).text).toContain('formatEntry')

      const dirtyDir = join(stateDir, 'wts', 'dirty-wt'), cleanDir = join(stateDir, 'wts', 'clean-wt')
      await provisionWorktree({ ticketId: 't-dirty', workspace: ws, executionName: 'dirty-wt', targetDir: dirtyDir, appender: governance.appender })
      writeFileSync(join(dirtyDir, 'untracked.txt'), 'keep me\n')
      await provisionWorktree({ ticketId: 't-clean', workspace: ws, executionName: 'clean-wt', targetDir: cleanDir, appender: governance.appender })
      writeFileSync(join(cleanDir, 'done.txt'), 'shipped\n')
      await git(cleanDir, 'add', 'done.txt'); await git(cleanDir, 'commit', '-m', 'done')
      await git(repoDir, 'merge', '--ff-only', 'agent/clean-wt')

      const engine = createWiredEngine(store, governance)
      for (const [id, name, dir] of [['t-dirty', 'dirty-wt', dirtyDir], ['t-clean', 'clean-wt', cleanDir]] as const) {
        store.tickets.save({ ...ticketA, id, execution: { name, directory: dir, assignment: '', workspace: ws.id }, assignments: [{ id: `${id}-a0`, state: 'running', createdAt: '2026-11-24T00:00:00Z' }] })
        engine.report(id, { state: 'ready', summary: 'done' })
      }
      await governance.flush()

      expect([existsSync(dirtyDir), existsSync(cleanDir)]).toEqual([true, false])
      const branches = await git(repoDir, 'branch', '--list')
      expect(branches).toContain('agent/dirty-wt')
      expect(branches).not.toContain('agent/clean-wt')
      const gcEvents = readShardEvents(governance.memoryDir).filter(e => e.type === 'gate.evaluated' && e.payload['point'] === 'workspace.gc')
      expect((gcEvents.find(e => e.payload['ticketId'] === 't-dirty')?.payload['verdict'] as { kind: string }).kind).toBe('deny')
      expect((gcEvents.find(e => e.payload['ticketId'] === 't-clean')?.payload['verdict'] as { kind: string }).kind).toBe('allow')
      expect(readShardEvents(governance.memoryDir).some(e => e.type === 'gate.evaluated' && e.payload['point'] === 'ticket.adaptive-dispatch' && e.payload['sessionPtr'] === `dsh-session:worker-${ticketA.id}`)).toBe(true)
    } finally { await governance.shutdown(); store.close() }
  })
})
