import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Sessions } from '../src/app/sessions.ts'
import { Store } from '../src/app/store.ts'
import { ticketDetail, ticketList } from '../src/app/views/tickets.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'

describe('Backend read-only nested subagent projection', () => {
  it('projects multi-depth subagents on ticket views without leaking across tickets and notifies on disposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-subproj-'))
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    try {
      const origin = {
        id: 'trig-1', source: 'feishu', at: '2026-11-27T08:00:00Z',
        actor: { source: 'feishu', id: 'ou_boss' }, human: true, text: '调研多代理方案',
        threads: [feishuChannel('oc_1', 'om_1').thread ? { source: 'feishu', id: 'om_1' } : { source: 'feishu', id: 'om_1' }],
        meta: {},
      }
      store.triggers.save(origin)
      const ticket = {
        id: 't-sub-1', title: '主调研工单', decisionId: 'dec-1',
        origin: { triggerId: origin.id, triggerIds: [origin.id] },
        mandate: { actor: { source: 'feishu', id: 'ou_boss' }, strength: 'explicit' as const, policyVersion: '', basis: { via: 'listed' as const }, scope: '' },
        channels: [feishuChannel('oc_1', 'om_1')], assignments: [{ id: 'a1', state: 'running' as const, createdAt: '2026-11-27T08:00:00Z' }],
        inputs: [], undelivered: [], createdAt: '2026-11-27T08:00:00Z', updatedAt: '2026-11-27T08:00:00Z',
      }
      const other = {
        ...ticket, id: 't-sub-2', title: '无关工单', decisionId: 'dec-2',
        channels: [feishuChannel('oc_1', 'om_2')],
      }
      store.tickets.save(ticket)
      store.tickets.save(other)

      const agents = new Map<string, Record<string, unknown>>()
      const makeAgent = (id: string, status: 'running' | 'idle', parentSession?: string, preset?: string, delegationDepth?: number) => {
        const agentCtx = new Context()
        agentCtx.reflect.provide('tools', { register: () => () => {}, get: () => undefined, restrict: () => () => {}, guard: () => () => {} })
        agentCtx.reflect.provide('skills', { register: () => () => {} })
        agentCtx.reflect.provide('systemPrompt', { section: () => () => {} })
        const ag = {
          id, status, ctx: agentCtx,
          session: { id, header: { ...(parentSession ? { parentSession } : {}), ...(preset ? { agentPreset: preset } : {}), ...(delegationDepth !== undefined ? { delegationDepth } : {}) }, snapshotEvents: () => [] },
        }
        agents.set(id, ag)
        return ag
      }

      const ctx = new Context()
      ctx.reflect.provide('agents', {
        get: (id: string) => agents.get(id),
        list: () => [...agents.values()],
      })
      const changed: string[] = []
      const sessions = new Sessions({
        context: ctx, store,
        prompts: { current: () => ({ revision: 1, config: { sections: {}, skills: {} } }), version: () => ({ revision: 1, config: { sections: {}, skills: {} } }), compose: () => '', skills: () => [] },
        effects: { enqueue: () => {}, handle: () => {}, idle: async () => {}, pending: () => false },
        health: { set: () => {} },
        masterId: 'master-1',
        lifetime: new AbortController().signal,
        closing: () => false,
        environment: () => [],
        tools: () => [{ name: 'orchestrator_report', description: 'report', schema: z.object({}), execute: async () => ({}) }],
        onSubagentChanged: (tid) => changed.push(tid),
      } as never)
      sessions.install()

      makeAgent('master-1', 'idle')
      makeAgent(`worker-${ticket.id}`, 'running')
      makeAgent(`worker-${other.id}`, 'running')
      const sub1 = makeAgent('sub-l1-research', 'running', `worker-${ticket.id}`, 'research', 1)
      const sub2 = makeAgent('sub-l2-leaf', 'idle', 'sub-l1-research', 'standard', 2)
      const otherSub = makeAgent('sub-other', 'running', `worker-${other.id}`, 'standard', 1)

      await ctx.parallel('agent/created', { agent: sub1 } as never)
      await ctx.parallel('agent/created', { agent: sub2 } as never)
      await ctx.parallel('agent/created', { agent: otherSub } as never)

      const sources = new SourceRegistry(() => store.settings(), { claim: () => ({ set: vi.fn() }) } as never)
      sources.register(feishuKind)
      const host = { store, sources, links: () => () => ({ url: '', label: { zh: 'feishu', en: 'feishu' } }), subagentsOf: (id: string) => sessions.subagentsFor(id) }

      const list = ticketList(host, 'open', 0, 20)
      const row1 = list.items.find((i) => i.id === ticket.id) as { subagents?: unknown[] }
      const row2 = list.items.find((i) => i.id === other.id) as { subagents?: unknown[] }
      expect(row1.subagents).toEqual([
        { id: 'sub-l1-research', parentSessionId: `worker-${ticket.id}`, status: 'running', depth: 1, preset: 'research' },
        { id: 'sub-l2-leaf', parentSessionId: 'sub-l1-research', status: 'idle', depth: 2, preset: 'standard' },
      ])
      expect(row2.subagents).toEqual([
        { id: 'sub-other', parentSessionId: `worker-${other.id}`, status: 'running', depth: 1, preset: 'standard' },
      ])
      const detail1 = ticketDetail(host, ticket.id) as { subagents?: unknown[] }
      expect(detail1.subagents).toHaveLength(2)
      expect(changed.filter((x) => x === ticket.id).length).toBeGreaterThanOrEqual(2)

      agents.delete('sub-l2-leaf')
      await ctx.parallel('agent/disposed', { agent: sub2 } as never)
      expect(sessions.subagentsFor(ticket.id)).toHaveLength(1)
      expect(sessions.subagentsFor(ticket.id)[0]!.id).toBe('sub-l1-research')
      expect(changed.at(-1)).toBe(ticket.id)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
