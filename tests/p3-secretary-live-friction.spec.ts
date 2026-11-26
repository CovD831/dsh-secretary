/** 真机双盲实测四大秘书总线与治理工具摩擦的回归测试。 */
import { describe, expect, it } from 'vitest'
import { ingestBossDesktopMessage } from '../src/app/tools/secretary-core.ts'
import { KV } from '../src/kv.ts'
import { readMemoryPage, resolveMemoryRelPath } from '../src/memory/index.ts'
import { startRuntime } from './fixtures/host.ts'

describe('Wave 3: 秘书总线与治理工具真机摩擦彻底修复', () => {
  it('1) 连续两条 ingestBossDesktopMessage 各自独立线程，第 1 条派单建工单后第 2 条不被旧工单劫持', async () => {
    const h = await startRuntime()
    try {
      const host = {
        store: h.runtime.store,
        engine: h.runtime.engine,
        governance: h.runtime.governance,
        requestPass: () => { h.runtime.passes.request() },
      }
      const first = ingestBossDesktopMessage(host, '帮我检查支付回调幂等逻辑')
      await h.runtime.idle()
      expect(first.trigger.threads[0]?.id).toBe(first.trigger.id)

      const dispatchRes = await h.runTool(h.runtime.masterId, 'secretary_dispatch', {
        title: '检查支付回调幂等',
        objective: '检查支付回调幂等逻辑',
        acceptance: '输出幂等漏洞清单',
        verify_commands: ['echo ok'],
        dispatch_key: 'pay-idempotent',
        worktree_name: 'pay-idempotent',
        trigger_id: first.trigger.id,
      }) as { ok: boolean; ticket?: { ticket_id: string } }
      expect(dispatchRes.ok).toBe(true)
      const ticketId = dispatchRes.ticket!.ticket_id

      const second = ingestBossDesktopMessage(host, '记住：以后汇报先给结论再给细节')
      await h.runtime.idle()
      expect(second.trigger.threads[0]?.id).toBe(second.trigger.id)
      expect(second.trigger.threads[0]?.id).not.toBe(first.trigger.threads[0]?.id)

      const ticket = h.runtime.store.tickets.get(ticketId)
      expect(ticket?.inputs.some(i => 'triggerId' in i && i.triggerId === second.trigger.id)).toBe(false)

      // 显式传 threadId 时保留原语义
      const explicit = ingestBossDesktopMessage(host, '同线程追问', 'custom-thread-1')
      expect(explicit.trigger.threads[0]?.id).toBe('custom-thread-1')

      // secretary_say 放宽到 240 字
      const longSay = await h.runTool(h.runtime.masterId, 'secretary_say', {
        text: '结论：'.padEnd(80, '稳'),
        expression: 'happy',
      }) as { ok: boolean }
      expect(longSay.ok).toBe(true)
    } finally {
      await h.stop()
    }
  })

  it('2) orchestrator_route 多缺失字段一次报全、accept 自动写 feed、orchestrator_reply 不抛 noChannel、master 纯文本回合自动兜底写 feed', async () => {
    const h = await startRuntime()
    try {
      const host = {
        store: h.runtime.store,
        engine: h.runtime.engine,
        governance: h.runtime.governance,
        requestPass: () => { h.runtime.passes.request() },
      }
      const msg1 = ingestBossDesktopMessage(host, '请修一下结算页报错')
      await h.runtime.idle()

      // 多缺失字段一次报全
      const badRoute = await h.runTool(h.runtime.masterId, 'orchestrator_route', {
        decisions: [{ kind: 'accept', trigger_id: msg1.trigger.id }],
      }) as { results: { refused?: string }[] }
      const refused = badRoute.results[0]?.refused ?? ''
      expect(refused).toContain('accept needs title')
      expect(refused).toContain('accept needs worktree_name')
      expect(refused).toContain('accept needs acknowledgement')

      // secretary-bus accept 自动写入 dispatch feed
      const goodRoute = await h.runTool(h.runtime.masterId, 'orchestrator_route', {
        decisions: [{
          kind: 'accept',
          trigger_id: msg1.trigger.id,
          title: '修复结算页报错',
          worktree_name: 'fix-checkout-err',
          acknowledgement: '已派工单排查结算页报错',
        }],
      }) as { results: { decision?: string; ticket?: { ticket_id: string } }[] }
      expect(goodRoute.results[0]?.decision).toBe('accept')
      const ticketId = goodRoute.results[0]!.ticket!.ticket_id
      const feedAfterRoute = h.runtime.store.get(KV.governance.feed) ?? []
      expect(feedAfterRoute.some(f => f.id === `feed-disp-${ticketId}` && f.kind === 'dispatch' && f.text.includes('已派工单排查结算页报错'))).toBe(true)

      // orchestrator_reply 对无 channel 的 secretary-bus 不抛 noChannel 且写 feed
      const msg2 = ingestBossDesktopMessage(host, '帮我查下刚才那个单子')
      await h.runtime.idle()
      const replyRes = await h.runTool(h.runtime.masterId, 'orchestrator_reply', {
        purpose: 'answer',
        trigger_id: msg2.trigger.id,
        text: '结论：工单已启动，正在排查结算页报错。',
      })
      expect(replyRes).toEqual({ status: 'sent' })
      const feedAfterReply = h.runtime.store.get(KV.governance.feed) ?? []
      expect(feedAfterReply.at(-1)).toMatchObject({
        role: 'secretary', kind: 'say', triggerId: msg2.trigger.id,
        text: '结论：工单已启动，正在排查结算页报错。',
      })

      // master 纯文本回合结束（未调说话工具）自动兜底写 feed
      const msg3 = ingestBossDesktopMessage(host, '在吗？')
      await h.runtime.idle()
      const masterAgent = h.agents.get(h.runtime.masterId)!
      const masterSession = (masterAgent as unknown as { session: unknown }).session
      h.ctx.emit('session/event', masterSession as never, {
        type: 'turn/start', data: { turn: 1 },
      } as never)
      h.ctx.emit('session/event', masterSession as never, {
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { id: 'm-fb-1', role: 'assistant', content: [{ type: 'text', text: '在的，请吩咐。' }] } },
      } as never)
      h.ctx.emit('agent/status', { agent: masterAgent, status: 'idle' } as never)

      const feedAfterFallback = h.runtime.store.get(KV.governance.feed) ?? []
      expect(feedAfterFallback.at(-1)).toMatchObject({
        role: 'secretary', kind: 'say', triggerId: msg3.trigger.id, text: '在的，请吩咐。',
      })
    } finally {
      await h.stop()
    }
  })

  it('3) orchestrator_memory_propose 仅传 trigger_id 与口语化 scope 一次成功落盘 M2 并绑定真实 M0 seq', async () => {
    const h = await startRuntime()
    try {
      const host = {
        store: h.runtime.store,
        engine: h.runtime.engine,
        governance: h.runtime.governance,
        requestPass: () => { h.runtime.passes.request() },
      }
      const msg = ingestBossDesktopMessage(host, '记住：向我汇报一律先给结论再给证据')
      await h.runtime.idle()

      const res = await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose',
        layer: 'm2',
        trigger_id: msg.trigger.id,
        scope: 'boss-reporting',
        m2_kind: 'preference',
        resident: true,
        statement: '向老板汇报必须结论先行，再附关键证据。',
      }) as { kind: string; entry?: { sourceRef?: { seq: number; id: string }; scope?: string } }

      expect(res.kind).toBe('accepted')
      expect(res.entry?.scope).toBe('global')
      expect(res.entry?.sourceRef?.seq).toBeGreaterThan(0)
      const env = await h.runtime.governance.readSpineEnvelope(res.entry!.sourceRef!)
      expect(env?.type).toBe('trigger.received')
      expect(env?.payload['triggerId']).toBe(msg.trigger.id)

      const m2Page = await readMemoryPage(h.runtime.governance.memoryDir, resolveMemoryRelPath({ layer: 'm2' }))
      expect(m2Page?.layer).toBe('m2')
      expect(m2Page?.layer === 'm2' && m2Page.entries.some(e => e.statement.includes('结论先行'))).toBe(true)
    } finally {
      await h.stop()
    }
  })

  it('4) orchestrator_deposit_author 拦截无 rule 自定义 gate 并给出 repairHint；自动清洗 Allow/Deny 的 expectedCause 噪音并准入落盘 shadow', async () => {
    const h = await startRuntime()
    try {
      const missingRule = await h.runTool(h.runtime.masterId, 'orchestrator_deposit_author', {
        mode: 'validate',
        draft: {
          id: 'verify.empty-shell',
          kind: 'gate',
          point: 'verify.completion',
          intent: '完成前必须跑 tsc',
          cases: [
            { name: 'ok', expected: 'allow', ctx: { commands: [{ command: 'tsc --noEmit', exitCode: 0 }] } },
            { name: 'bad', expected: 'deny', ctx: { commands: [] } },
          ],
        },
      }) as { ok: boolean; gate: string; violations: { ruleId: string; repairHint: string }[] }
      expect(missingRule.ok).toBe(false)
      expect(missingRule.gate).toBe('machine')
      expect(missingRule.violations[0]?.ruleId).toBe('missing-declarative-rule')
      expect(missingRule.violations[0]?.repairHint).toContain('command_check')

      const installed = await h.runTool(h.runtime.masterId, 'orchestrator_deposit_author', {
        mode: 'install_shadow',
        draft: {
          id: 'verify.tsc-clean',
          name: 'TSC 类型检查门',
          kind: 'gate',
          point: 'verify.completion',
          intent: '提交完成声明前必须通过 tsc --noEmit',
          actionClass: 'block',
          rule: { kind: 'command_check', requiredCommands: ['tsc --noEmit'] },
          cases: [
            { name: 'green', expected: 'allow', expectedCause: 'ran tsc cleanly', ctx: { commands: [{ command: 'tsc --noEmit', exitCode: 0 }] } },
            { name: 'red', expected: 'deny', expectedCause: 'missing tsc', ctx: { commands: [{ command: 'vitest run', exitCode: 0 }] } },
          ],
        },
      }) as { installed: boolean; stage: string; registeredInShadow: boolean }
      expect(installed).toMatchObject({ installed: true, stage: 'shadow', registeredInShadow: true })
    } finally {
      await h.stop()
    }
  })
})
