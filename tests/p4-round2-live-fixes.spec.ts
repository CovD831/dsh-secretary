/** 第 2 轮真机双盲实测 3 项后端问题 + Opus 终审加固的红绿双向回归测试。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RulingQueue, type ApprovalOutcome } from '../src/app/ruling-queue.ts'
import { Store } from '../src/app/store.ts'
import { ingestBossDesktopMessage } from '../src/app/tools/secretary-core.ts'
import type { Ticket } from '../src/core/index.ts'
import { RuntimeGuard, classifySmartAutoRisk, effectiveUsageTokens } from '../src/executor/runtime-guard.ts'
import { KV } from '../src/kv.ts'
import type { MemoryWriter } from '../src/memory/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { GitRepoLock } from '../src/spine/git-sink.ts'
import type { SpineAppender, SpineDraft, SpineEnvelope } from '../src/spine/types.ts'
import { startRuntime } from './fixtures/host.ts'

const dirs: string[] = []
const stores: Store[] = []

function makeDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

function makeStore(): Store {
  const s = new Store(join(makeDir('dsh-w4-db-'), 'orch.sqlite'))
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

function makeTicket(id: string, dir: string): Ticket {
  return {
    id,
    title: `Ticket ${id}`,
    body: 'task',
    origin: { source: 'feishu', thread: { source: 'feishu', kind: 'chat', id: 'oc-1' }, trigger: 'tr-1' },
    createdAt: '2026-11-26T00:00:00Z',
    updatedAt: '2026-11-26T00:00:00Z',
    execution: { workspace: 'ws-1', directory: dir, verifyCommands: [] },
    assignments: [{ id: `asg-${id}`, state: 'running', createdAt: '2026-11-26T00:00:00Z' }],
  } as unknown as Ticket
}

const noopMemory = {
  upsertAttention: async () => undefined,
  transitionAttention: async () => undefined,
} as unknown as MemoryWriter

afterEach(() => {
  vi.useRealTimers()
  while (stores.length) stores.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('Wave 4: 第 2 轮真机实测后端修复与护栏重构', () => {
  it('1) secretary-bus 纯聊天 idle 后自动 ignore 结案不二次触发评估，先 say 后 dispatch 仍正常建单', async () => {
    const h = await startRuntime()
    try {
      const host = {
        store: h.runtime.store,
        engine: h.runtime.engine,
        governance: h.runtime.governance,
        requestPass: () => { h.runtime.passes.request() },
      }
      const chatMsg = ingestBossDesktopMessage(host, '记住：以后汇报先给结论再给细节')
      await h.runtime.idle()

      await h.runTool(h.runtime.masterId, 'secretary_say', {
        text: '好的老板，已记下您的汇报偏好。',
        expression: 'happy',
      })
      const masterAgent = h.agents.get(h.runtime.masterId)!
      h.ctx.emit('agent/status', { agent: masterAgent, status: 'idle' } as never)

      const disp1 = h.runtime.store.triggers.disposition(chatMsg.trigger.id)
      expect(disp1?.decisionId).toBeTruthy()
      const dec1 = h.runtime.store.decisions.get(disp1!.decisionId!)
      expect(dec1?.kind).toBe('ignore')

      // 推进时钟超过 evalTimeoutMs，确认 evaluateDue 不会再次触发评估
      vi.setSystemTime(Date.now() + 300_000)
      h.runtime.engine.evaluateDue()
      expect(h.runtime.store.triggers.disposition(chatMsg.trigger.id)?.evalId).toBe(disp1!.evalId)
      expect(h.runtime.store.triggers.disposition(chatMsg.trigger.id)?.decisionId).toBe(disp1!.decisionId)

      // 同轮内先 secretary_say 再 secretary_dispatch，仍正常创建工单不被误 ignore
      const workMsg = ingestBossDesktopMessage(host, '帮我排查支付回调超时')
      await h.runtime.idle()
      await h.runTool(h.runtime.masterId, 'secretary_say', {
        text: '收到，马上派工单排查。',
        expression: 'working',
        trigger_id: workMsg.trigger.id,
      })
      const dispatchRes = await h.runTool(h.runtime.masterId, 'secretary_dispatch', {
        title: '排查支付回调超时',
        objective: '排查支付回调超时原因',
        acceptance: '定位超时根因并修复',
        verify_commands: ['echo ok'],
        dispatch_key: 'pay-timeout',
        worktree_name: 'pay-timeout',
        trigger_id: workMsg.trigger.id,
      }) as { ok: boolean; ticket?: { ticket_id: string } }
      expect(dispatchRes.ok).toBe(true)

      h.ctx.emit('agent/status', { agent: masterAgent, status: 'idle' } as never)
      const disp2 = h.runtime.store.triggers.disposition(workMsg.trigger.id)
      expect(disp2?.decisionId).toBeTruthy()
      expect(h.runtime.store.decisions.get(disp2!.decisionId!)?.kind).toBe('accept')
    } finally {
      await h.stop()
    }
  })

  it('2) classifySmartAutoRisk 放行只读 gh 命令、拦截写 gh 命令，且 rawScore>=0.8 入队默认推荐 reject', async () => {
    for (const cmd of [
      'gh pr list',
      'gh pr view 12',
      'gh pr status',
      'gh pr diff',
      'gh pr checks',
      'gh issue list',
      'gh issue view 5',
      'gh api repos/a/b/pulls',
    ]) {
      const r = classifySmartAutoRisk('bash', { command: cmd }, '/tmp/wt')
      expect(r.needsAsk, cmd).toBe(false)
    }

    for (const cmd of [
      'gh issue create --title bug --body detail',
      'gh pr create --title feat --body desc',
      'gh pr comment 12 --body lgtm',
      'gh api repos/a/b/issues -f title=x',
      'gh api -X POST repos/a/b/issues',
    ]) {
      const r = classifySmartAutoRisk('bash', { command: cmd }, '/tmp/wt')
      expect(r.needsAsk, cmd).toBe(true)
      expect(r.rawScore).toBeGreaterThanOrEqual(0.8)
    }

    // 端到端验证 RuntimeGuard -> RulingQueue 高风险推荐项为 reject
    const store = makeStore()
    const dir = makeDir('dsh-w4-rul-')
    store.saveSettings(SettingsSchema.parse({ executor: { approvalMode: 'smart-auto' } }))
    const { appender } = makeAppender()
    const rulings = new RulingQueue({
      store, appender, memory: noopMemory, memoryDir: dir, memoryRepoLock: new GitRepoLock(),
    })
    const ctx = new Context()
    ctx.reflect.provide('agents', { get: () => undefined })
    const guard = new RuntimeGuard({
      context: ctx, store, engine: { report: () => {} } as never, appender, rulings, relayToMaster: () => {},
    })
    guard.install()
    store.tickets.save(makeTicket('T-GH', dir))

    const agent = { id: 'worker-T-GH', session: { id: 'worker-T-GH', header: {}, snapshotEvents: () => [] } } as never
    const pre = await ctx.waterfall('tools/pre-execute', {
      agent, name: 'bash', callId: 'call-gh-create' as never, rootCallId: 'call-gh-create' as never,
      token: Symbol() as never, arguments: { command: 'gh issue create --title x --body y' }, signal: new AbortController().signal,
    }, async () => ({ kind: 'allow' as const }))
    expect(pre).toMatchObject({ kind: 'ask' })

    const pending = ctx.waterfall('approval/request', {
      agent, toolName: 'bash', callId: 'call-gh-create', reason: (pre as { reason: string }).reason,
    }, async (): Promise<ApprovalOutcome> => 'unavailable')

    const item = rulings.active().active!
    expect(item.rawScore).toBeGreaterThanOrEqual(0.8)
    expect(item.options.find(o => o.id === 'reject')?.recommended).toBe(true)
    expect(item.options.find(o => o.id === 'approve')?.recommended).toBe(false)

    await rulings.decide({ id: item.id, decision: 'reject', actorId: 'boss' })
    expect(await pending).toBe('rejected')
    guard.dispose()
  })

  it('3) effectiveUsageTokens 按 0.1x 折算 cacheReadTokens，80% 触发一次预警，超限才触发熔断', () => {
    expect(effectiveUsageTokens({
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 80_000, totalTokens: 81_500,
    })).toBe(9500)

    const store = makeStore()
    const dir = makeDir('dsh-w4-tok-')
    store.saveSettings(SettingsSchema.parse({ executor: { maxTokens: 10_000 } }))
    const { events, appender } = makeAppender()
    const relays: { id: string; text: string }[] = []
    const rulings = new RulingQueue({
      store, appender, memory: noopMemory, memoryDir: dir, memoryRepoLock: new GitRepoLock(),
    })
    const ctx = new Context()
    ctx.reflect.provide('agents', { get: () => undefined })
    const guard = new RuntimeGuard({
      context: ctx, store, engine: { report: () => {} } as never, appender, rulings,
      relayToMaster: (id, text) => relays.push({ id, text }),
    })
    guard.install()
    store.tickets.save(makeTicket('T-TOK', dir))

    const session = { id: 'worker-T-TOK', header: {} } as never
    // 两步共 8500 有效 tokens（含大量 cacheReadTokens=30000/步），达到 80% 预警但不熔断
    for (let i = 0; i < 2; i++) {
      ctx.emit('session/event', session, {
        type: 'assistant/message',
        data: { usage: { inputTokens: 1000, outputTokens: 250, cacheReadTokens: 30_000, totalTokens: 31_250 } },
      } as never)
    }
    expect(events.filter(e => e.type === 'ticket.budget_warning')).toHaveLength(1)
    expect(relays.filter(r => r.text.includes('"budget_warning"'))).toHaveLength(1)
    expect(events.some(e => e.type === 'ticket.circuit_broken')).toBe(false)

    // 再来一步 2000 有效 tokens -> 10500 > 10000 触发熔断，且不重复写预警
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { usage: { inputTokens: 1500, outputTokens: 500, totalTokens: 2000 } },
    } as never)
    expect(events.filter(e => e.type === 'ticket.budget_warning')).toHaveLength(1)
    expect(events.filter(e => e.type === 'ticket.circuit_broken')).toHaveLength(1)
    expect(store.get(KV.governance.runtimeBudgets)?.['asg-T-TOK']?.totalTokens).toBe(10_500)
    guard.dispose()
  })
})
