/** 阶段四 Track 1 端到端闭环验证：零执行双锁、秘书治理工具与飞书裁决回调入脊/记忆/草稿闭环。 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GovernanceRuntime } from '../src/app/governance.ts'
import { createFeishuOperatorAuthorizer } from '../src/app/governance-ruling.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { mainTools } from '../src/app/tools/main.ts'
import type { DepositDraft } from '../src/authoring/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { loadDepositPackage } from '../src/judgement/deposit.ts'
import { readMemoryPage } from '../src/memory/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { runFeishu } from '../src/sources/feishu-loops.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SpineEnvelope } from '../src/spine/types.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { startRuntime } from './fixtures/host.ts'

const tempDirs: string[] = []
afterEach(() => { while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true }) })

function readAllM0(memoryDir: string): SpineEnvelope<Record<string, unknown>>[] {
  const m0 = join(memoryDir, 'm0')
  if (!existsSync(m0)) return []
  return readdirSync(m0).filter(n => n.endsWith('.jsonl')).sort().flatMap(f =>
    readFileSync(join(m0, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as SpineEnvelope<Record<string, unknown>>),
  )
}

const makeRerunDraft = (overrides: Partial<DepositDraft> = {}): DepositDraft => ({
  id: 'verify.rerun', name: '反自报重跑校验', version: 1, author: 'ou_alice', scope: 'workspace:main',
  kind: 'gate', level: 'object', point: 'verify.rerun', trigger: { on: 'completion.claimed', mode: 'on-event' },
  requires: ['claimedDone'], params: { require_red_green: { type: 'boolean', default: true }, require_independent_verifier: { type: 'boolean', default: true } },
  exceptions: ['claimedDone=false 时放行'], repairHint: '请独立验证方重跑并附红绿证据',
  intent: '防止自报完成而无独立验证或缺陷红绿对比。', rubricBody: 'fix 任务必须附红绿对照与独立验证。',
  enforce: true, actionClass: 'block', origin: { kind: 'user-authored' },
  cases: [
    { name: 'green-feature', expected: 'allow', ctx: { taskType: 'feature', builderRole: 'builder', claimedDone: true, rerun: { command: 'pnpm test', exitCode: 0, verifierRole: 'verifier' } } },
    { name: 'red-self-verify', expected: 'deny', ctx: { taskType: 'feature', builderRole: 'builder', claimedDone: true, rerun: { command: 'pnpm test', exitCode: 0, verifierRole: 'builder' } } },
  ],
  ...overrides,
})

describe('阶段四 Track 1：零执行秘书治理闭环与飞书裁决回调闭环', () => {
  it('保持秘书零执行双锁完好，共用单锁，并打通记忆提议/防伪溯源/召回丢弃入脊/M6账本/沉淀试穿', async () => {
    const h = await startRuntime()
    try {
      const gov = h.runtime.governance
      expect(gov.memory.lock).toBe(gov.sink.lock)

      // 1) 零执行物理隔离：秘书工具仅含 orchestrator_*，且 restrict({ allow: [] }) 锁死继承全局工具
      const masterTools = h.tools.get(h.runtime.masterId)!
      expect([...masterTools.keys()]).toEqual(expect.arrayContaining([
        'orchestrator_memory_recall', 'orchestrator_memory_propose', 'orchestrator_attention_ledger', 'orchestrator_deposit_author',
      ]))
      for (const forbidden of ['bash', 'bash_persistent', 'pwsh', 'read', 'write', 'edit', 'fs_read', 'fs_write', 'subagent', 'schedule_create']) {
        expect(masterTools.has(forbidden)).toBe(false)
      }
      const restrictMock = (h.agents.get(h.runtime.masterId) as unknown as { ctx: { tools: { restrict: ReturnType<typeof vi.fn> } } }).ctx.tools.restrict
      expect(restrictMock).toHaveBeenCalledWith({ allow: [] })
      const unmounted = mainTools({ context: h.ctx, engine: h.runtime.engine, store: h.runtime.store, prompts: h.runtime.prompts,
        sessions: h.runtime.sessions, settings: h.runtime.settings, assessor: h.runtime.assessor,
        resources: {} as never, requestPass: () => {}, sendReplies: async () => {}, quietly: fn => fn() }, h.agents.get(h.runtime.masterId) as never)
      expect(unmounted.some(t => t.name === 'orchestrator_memory_recall')).toBe(false)

      // 2) 伪造 SourceRef 被记忆提议与 M6 状态流转同时拒写
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm1', slug: 'fake', scope: 'global', source_type: 'user_direct',
        statement: 'forged memory', source_ref: { seq: 9999, id: 'forged-ref' },
      })).toMatchObject({ kind: 'rejected', reason: 'unknown-source-ref' })
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_attention_ledger', {
        mode: 'transition', id: 'att-none', next_status: 'approved', source_ref: { seq: 9999, id: 'forged-ref' },
      })).toMatchObject({ ok: false, reason: 'unknown-source-ref' })

      // 3) 真实 M0 sourceRef 写入 M1/M2，召回含 private M2 + droppedIds 入脊
      const ref1 = gov.appender.append({ id: 'sec-test-1', stream: 'secretary:test', type: 'note.recorded', source: { kind: 'secretary', ref: 'test' }, evidence: [], taint: 'trusted', payload: {} })
      const ref2 = gov.appender.append({ id: 'sec-test-2', stream: 'secretary:test', type: 'note.recorded', source: { kind: 'secretary', ref: 'test' }, evidence: [], taint: 'trusted', payload: {} })
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm2', scope: 'global', source_type: 'user_ruling', m2_kind: 'preference',
        clearance: 'private', resident: true, statement: '老板要求所有汇报先给结论再给证据', source_ref: ref1,
      })).toMatchObject({ kind: 'accepted', pagePath: 'm2/profile.md' })
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm1', slug: 'alpha', scope: 'global', source_type: 'user_direct', statement: 'alpha sqlite checkpoint rule one', source_ref: ref1,
      })).toMatchObject({ kind: 'accepted' })
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm1', slug: 'beta', scope: 'global', source_type: 'user_direct', statement: 'beta sqlite checkpoint rule two', source_ref: ref2,
      })).toMatchObject({ kind: 'accepted' })

      const { item: attItem } = await gov.memory.upsertAttention({ kind: 'ruling', question: '是否开启夜间值班静默？', sourceRefs: [ref1], delaySeen: 1, seenCount: 1 })
      const recall = await h.runTool(h.runtime.masterId, 'orchestrator_memory_recall', {
        query: 'sqlite checkpoint rule', budgets: { retrievedMaxChars: 42 },
      }) as { text: string; droppedIds: string[]; attention: { id: string }[] }
      expect(recall.text).toContain('老板要求所有汇报先给结论再给证据')
      expect(recall.attention.map(i => i.id)).toContain(attItem.id)
      expect(recall.droppedIds.length).toBeGreaterThanOrEqual(1)

      // 4) M6 账本读取与凭真实 sourceRef 流转
      const listed = await h.runTool(h.runtime.masterId, 'orchestrator_attention_ledger', { mode: 'list', status: 'pending' }) as { items: { id: string }[] }
      expect(listed.items.some(i => i.id === attItem.id)).toBe(true)
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_attention_ledger', {
        mode: 'transition', id: attItem.id, next_status: 'asked', source_ref: ref2,
      })).toMatchObject({ ok: true, item: { id: attItem.id, status: 'asked' } })

      // 5) 沉淀作者工具：机器门纠偏、离线回放与影子试穿安装
      const badValidate = await h.runTool(h.runtime.masterId, 'orchestrator_deposit_author', {
        mode: 'validate', draft: makeRerunDraft({ id: 'verify.counter', kind: 'counter-rule', enforce: true, actionClass: 'block' }),
      }) as { ok: boolean; gate: string; repairedDraft: DepositDraft }
      expect(badValidate).toMatchObject({ ok: false, gate: 'machine', repairedDraft: { enforce: false, stage: 'shadow' } })

      expect(await h.runTool(h.runtime.masterId, 'orchestrator_deposit_author', {
        mode: 'replay', draft: makeRerunDraft(),
      })).toMatchObject({ totalCases: 2, catches: 1, trueAllows: 1, falseBlocks: 0, misses: 0 })

      const installed = await h.runTool(h.runtime.masterId, 'orchestrator_deposit_author', {
        mode: 'install_shadow', draft: makeRerunDraft({ id: 'verify.shadow-rerun' }),
      }) as { installed: boolean; stage: string; enforce: boolean; packageDir: string }
      expect(installed).toMatchObject({ installed: true, stage: 'shadow', enforce: false })
      const loadedPkg = await loadDepositPackage(installed.packageDir)
      expect(loadedPkg.admission.admitted && loadedPkg.admission.manifest.stage).toBe('shadow')

      await gov.flush()
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm1', slug: 'flushed-ok', scope: 'global', source_type: 'user_direct',
        statement: 'flushed shard ref resolves without lock deadlock', source_ref: ref1,
      })).toMatchObject({ kind: 'accepted' })
      const events = readAllM0(gov.memoryDir)
      expect(events.some(e => e.type === 'memory.recall.dropped')).toBe(true)
      expect(events.some(e => e.type === 'authoring.replay_viewed')).toBe(true)
      expect(events.some(e => e.type === 'authoring.shadow_installed')).toBe(true)
    } finally { await h.stop() }
  }, 15_000)

  it('飞书裁决回调：未授权拒写、先入 M0 拿真实 seq 后自动落盘 M2/M3/草稿与 M6 状态，且跨刷盘/重启严格幂等', async () => {
    const h = await startRuntime()
    const stateDir = realpathSync(h.directory)
    const mkCb = (eventId: string, openId: string, escalationId: string, decision: string, attribution: string, note: string, captureAsRule = false) => ({
      header: { event_id: eventId, event_type: 'card.action.trigger' },
      event: { operator: { open_id: openId }, action: { value: { escalationId, ticketId: 'T-10', decision, issuedAt: new Date().toISOString() }, form_value: { attribution, captureAsRule, note } } },
    })
    try {
      const gov = h.runtime.governance
      const seedRef = gov.appender.append({ id: 'seed-att-1', stream: 'ticket:T-10', type: 'escalation.created', source: { kind: 'system', ref: 'test' }, evidence: [], taint: 'trusted', payload: {} })
      const { item: m6Item } = await gov.memory.upsertAttention({ kind: 'ruling', question: '确认边界规则？', sourceRefs: [seedRef], delaySeen: 1, seenCount: 1 })
      h.runtime.store.tickets.save({
        id: 'T-10', title: 'Fix billing', decisionId: 'd-10', channels: [], undelivered: [],
        createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-25T00:00:00Z',
        mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: 'fix' },
        origin: { triggerId: 'tr-10', triggerIds: ['tr-10'] }, assignments: [], inputs: [],
        execution: { name: 'fix-10', directory: stateDir, assignment: 'fix', workspace: 'main' },
      })

      // 1) 群内未授权成员点卡立即被拒，零 M0/M2/草稿副作用
      expect(await h.runtime.handleFeishuCardCallback(mkCb('evt-unauth', 'ou_stranger', m6Item.id, 'approve', 'mandate_unclear', '恶意规则'))).toEqual({ ok: false, reason: 'unauthorized-operator' })
      await gov.flush()
      expect(readAllM0(gov.memoryDir).some(e => e.type === 'escalation.ruled')).toBe(false)
      expect(await readMemoryPage(gov.memoryDir, 'm2/profile.md')).toBeUndefined()

      // 2) 授权老板点 mandate_unclear -> 先 M0 拿真实 seq>0 -> 自动写 m2/profile.md + 更新 M6 item 为 approved
      const rM2 = await h.runtime.handleFeishuCardCallback(mkCb('evt-m2-1', 'ou_alice', m6Item.id, 'approve', 'mandate_unclear', '禁止自动 push 到远端'))
      expect(rM2.ok && !rM2.duplicate && rM2.sourceRef.seq > 0 && rM2.attentionUpdated).toBe(true)
      if (!rM2.ok) throw new Error('expected ok')
      expect(rM2.memoryWrite).toMatchObject({ kind: 'accepted', pagePath: 'm2/profile.md' })
      const m2Page = await readMemoryPage(gov.memoryDir, 'm2/profile.md')
      expect(m2Page?.layer === 'm2' && m2Page.entries.some(e => e.sourceRef.seq === rM2.sourceRef.seq && e.statement.includes('禁止自动 push'))).toBe(true)
      const ledgerAfter = await readMemoryPage(gov.memoryDir, 'm6/ledger.md')
      expect(ledgerAfter?.layer === 'm6' && ledgerAfter.items.find(i => i.id === m6Item.id)?.status).toBe('approved')

      // 3) 缓冲期重推同 callbackId 严格幂等 + 锁态卡面
      const dupBuffered = await h.runtime.handleFeishuCardCallback(mkCb('evt-m2-1', 'ou_alice', m6Item.id, 'approve', 'mandate_unclear', '禁止自动 push 到远端'))
      expect(dupBuffered).toMatchObject({ ok: true, duplicate: true, sourceRef: rM2.sourceRef })
      expect(JSON.stringify(dupBuffered.ok && dupBuffered.response.card)).toContain('已裁决')

      // 4) exec_mistake -> m3/main/... 及 gate_gap -> deposit-drafts/<id>.json + draft_created 入脊
      const rM3 = await h.runtime.handleFeishuCardCallback(mkCb('evt-m3-1', 'ou_alice', 'esc-m3', 'approve', 'exec_mistake', '改完先跑 typecheck 再交差'))
      expect(rM3.ok && rM3.memoryWrite).toMatchObject({ kind: 'accepted', pagePath: expect.stringMatching(/^m3\/main\//) })
      const rDraft = await h.runtime.handleFeishuCardCallback(mkCb('evt-gap-1', 'ou_alice', 'esc-gap-9', 'revise', 'gate_gap', '补充缺失断言门', true))
      expect(rDraft.ok && rDraft.draftPath).toBe(join(stateDir, 'deposit-drafts', 'friction.esc-gap-9.json'))
      expect(existsSync(rDraft.ok ? rDraft.draftPath! : '')).toBe(true)
      await gov.flush()
      const eventsAfterFlush = readAllM0(gov.memoryDir)
      expect(eventsAfterFlush.filter(e => e.type === 'escalation.ruled')).toHaveLength(3)
      expect(eventsAfterFlush.some(e => e.type === 'authoring.draft_created')).toBe(true)
    } finally { await h.stop() }

    // 5) 进程重启后重推已落盘分片的 callbackId 依然幂等不重放
    const restartDir = mkdtempSync(join(tmpdir(), 'sec-cb-restart-'))
    tempDirs.push(restartDir)
    const payload = mkCb('evt-restart-1', 'ou_alice', 'esc-r', 'approve', 'mandate_unclear', '记住重启幂等')
    const store1 = new Store(join(restartDir, 'orchestrator.sqlite'))
    store1.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } } }))
    const gov1 = new GovernanceRuntime({ store: store1, stateDir: restartDir })
    await gov1.recover()
    const first = await gov1.handleFeishuCardCallback(payload, { isAllowedOperator: createFeishuOperatorAuthorizer(store1) })
    await gov1.shutdown(); store1.close()

    const store2 = new Store(join(restartDir, 'orchestrator.sqlite'))
    const gov2 = new GovernanceRuntime({ store: store2, stateDir: restartDir })
    await gov2.recover()
    const second = await gov2.handleFeishuCardCallback(payload, { isAllowedOperator: createFeishuOperatorAuthorizer(store2) })
    expect(second).toMatchObject({ ok: true, duplicate: true, sourceRef: first.ok ? first.sourceRef : undefined })
    await gov2.shutdown(); store2.close()
    expect(readAllM0(gov2.memoryDir).filter(e => e.type === 'escalation.ruled')).toHaveLength(1)
  }, 15_000)

  it('feishu event consumer 识别 card.action.trigger 转发给宿主回调入口且不破坏普通消息触发', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'feishu-card-stream-'))
    tempDirs.push(dir)
    const cli = join(dir, 'lark-bot')
    writeFileSync(cli, `#!/bin/sh\necho '[event] ready' >&2\ncat '${dir}/events'\nexec sleep 60\n`, { mode: 0o755 })
    writeFileSync(join(dir, 'events'), [
      JSON.stringify({ header: { event_id: 'evt-stream-1', event_type: 'card.action.trigger' }, event: { operator: { open_id: 'ou_alice' }, action: { value: { ticketId: 'T-1', decision: 'approve' }, form_value: { attribution: 'mandate_unclear' } } } }),
      JSON.stringify({ message_id: 'om_stream_1', chat_id: 'oc_team', chat_type: 'group', sender_id: 'ou_alice', sender_type: 'user', content: 'hello', create_time: String(Date.now()), mentions: [{ id: 'ou_bot' }] }),
    ].join('\n') + '\n')
    const store = new Store(join(dir, 's.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { chats: [] } } } }))
    const sources = new SourceRegistry(() => store.settings(), new HealthBoard())
    sources.register(feishuKind)
    const received: string[] = []
    const cardActions: unknown[] = []
    const deps: SourceContextDeps = {
      store, engine: { bindThread: (() => ({})) as never, threadClosed: () => {} }, outbox: { send: () => {} },
      commands: new Commands(() => testDeployment(), {}, new AbortController().signal),
      sources, deployment: testDeployment({ feishu: { ...testDeployment().feishu!, cli } }),
      ready: Promise.resolve(), configured: () => true, receive: t => { received.push(t.id); return 'stored' },
    }
    const ctx = { ...sourceContextOf(deps, feishuKind), handleCardAction: async (p: unknown) => { cardActions.push(p) } }
    const ac = new AbortController()
    const run = runFeishu(ctx, ac.signal)
    await vi.waitFor(() => { expect(cardActions).toHaveLength(1); expect(received).toHaveLength(1) }, { timeout: 10_000 })
    ac.abort(); await run; store.close()
  }, 15_000)
})
