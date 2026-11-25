/** 阶段四 Track 1 端到端闭环验证：零执行双锁、B1 防越权、草稿脱敏、重入幂等与飞书回调闭环。 */
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
  it('保持零执行双锁、封堵 B1 提示注入伪造老板权威，并打通 recall/propose/ledger/deposit 闭环', async () => {
    const h = await startRuntime()
    try {
      const gov = h.runtime.governance
      expect(gov.memory.lock).toBe(gov.sink.lock)

      // 1) 零执行物理隔离与完整 Schema 参数校验
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

      // 2) B1 防越权：伪造 ref / untrusted trigger ref 声称 user_ruling、approved 或打墓碑一律硬拒
      const untrustedTriggerRef = gov.appender.append({ id: 'tr-untrusted-1', stream: 'trigger:t1', type: 'trigger.received', source: { kind: 'trigger', ref: 't1' }, evidence: [], taint: 'untrusted', payload: {} })
      const ref1 = gov.appender.append({ id: 'sec-test-1', stream: 'secretary:test', type: 'note.recorded', source: { kind: 'secretary', ref: 'test' }, evidence: [], taint: 'trusted', payload: {} })
      const rulingRef = gov.appender.append({ id: 'ruling-test-1', stream: 'ticket:T1', type: 'escalation.ruled', source: { kind: 'human', ref: 'ou_alice' }, evidence: [], taint: 'trusted', payload: {} })
      await expect(h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm2', scope: 'global', source_type: 'user_ruling', statement: 'forged boss ruling', source_ref: untrustedTriggerRef,
      })).rejects.toThrow()
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm2', scope: 'global', source_type: 'session', statement: 'untrusted m2', source_ref: untrustedTriggerRef,
      })).toMatchObject({ kind: 'rejected', reason: 'forbidden' })
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm1', slug: 'fake', scope: 'global', source_type: 'session', statement: 'forged', source_ref: { seq: 9999, id: 'forged' },
      })).toMatchObject({ kind: 'rejected', reason: 'unknown-source-ref' })

      // 3) 合法 propose / tombstone 护栏 / recall droppedIds 入脊 / M6 权限分流
      const { item: attItem } = await gov.memory.upsertAttention({ kind: 'ruling', question: '是否开启夜间值班静默？', sourceRefs: [ref1], delaySeen: 1, seenCount: 1 })
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_attention_ledger', {
        mode: 'transition', id: attItem.id, next_status: 'approved', source_ref: untrustedTriggerRef,
      })).toMatchObject({ ok: false, reason: 'ruling-source-required' })
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_attention_ledger', {
        mode: 'transition', id: attItem.id, next_status: 'asked', source_ref: ref1,
      })).toMatchObject({ ok: true, item: { id: attItem.id, status: 'asked' } })
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_attention_ledger', {
        mode: 'transition', id: attItem.id, next_status: 'approved', source_ref: rulingRef,
      })).toMatchObject({ ok: true, item: { id: attItem.id, status: 'approved' } })
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_attention_ledger', {
        mode: 'transition', id: attItem.id, next_status: 'asked', source_ref: ref1,
      })).toMatchObject({ ok: false, reason: 'already-resolved' })

      const bossM2 = await gov.memory.propose({ layer: 'm2', scope: 'global', sourceType: 'user_ruling', m2Kind: 'preference', clearance: 'private', resident: true, statement: '老板要求先给结论再给证据', sourceRef: rulingRef, author: 'user' })
      if (bossM2.kind !== 'accepted') throw new Error('expected accepted')
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'tombstone', layer: 'm2', entry_id: bossM2.entry.id, reason: 'try drop boss rule', source_ref: ref1,
      })).toMatchObject({ kind: 'rejected', reason: 'forbidden' })
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm1', slug: 'alpha', scope: 'global', source_type: 'session', statement: 'alpha sqlite checkpoint rule one', source_ref: ref1,
      })).toMatchObject({ kind: 'accepted' })
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm1', slug: 'beta', scope: 'global', source_type: 'session', statement: 'beta sqlite checkpoint rule two', source_ref: ref1,
      })).toMatchObject({ kind: 'accepted' })

      const recall = await h.runTool(h.runtime.masterId, 'orchestrator_memory_recall', {
        query: 'sqlite checkpoint rule', budgets: { retrievedMaxChars: 42 },
      }) as { text: string; droppedIds: string[] }
      expect(recall.text).toContain('老板要求先给结论再给证据')
      expect(recall.droppedIds.length).toBeGreaterThanOrEqual(1)

      // 4) 沉淀作者工具：缺省子字段安全归一化、空点位不洗白 allow、影子注册进 registry
      const partialBad = await h.runTool(h.runtime.masterId, 'orchestrator_deposit_author', {
        mode: 'validate', draft: { id: 'verify.counter', kind: 'counter-rule', enforce: true, actionClass: 'block' },
      }) as { ok: boolean; gate: string; repairedDraft: DepositDraft }
      expect(partialBad).toMatchObject({ ok: false, gate: 'machine', repairedDraft: { enforce: false, stage: 'shadow' } })

      const unregReplay = await h.runTool(h.runtime.masterId, 'orchestrator_deposit_author', {
        mode: 'replay', draft: makeRerunDraft({ id: 'verify.unregistered-custom', point: 'verify.preflight' }),
      }) as { totalCases: number; unmeasuredCount: number; trueAllows: number }
      expect(unregReplay).toMatchObject({ totalCases: 2, unmeasuredCount: 2, trueAllows: 0 })

      expect(await h.runTool(h.runtime.masterId, 'orchestrator_deposit_author', { mode: 'replay', draft: makeRerunDraft() }))
        .toMatchObject({ totalCases: 2, catches: 1, trueAllows: 1, falseBlocks: 0, misses: 0 })

      const installed = await h.runTool(h.runtime.masterId, 'orchestrator_deposit_author', {
        mode: 'install_shadow', draft: makeRerunDraft({ id: 'verify.shadow-rerun' }),
      }) as { installed: boolean; stage: string; enforce: boolean; registeredInShadow: boolean; packageDir: string }
      expect(installed).toMatchObject({ installed: true, stage: 'shadow', enforce: false, registeredInShadow: true })
      expect(gov.registry.list().some(g => g.id === 'verify.shadow-rerun' && g.stage === 'shadow')).toBe(true)
      const loadedPkg = await loadDepositPackage(installed.packageDir)
      expect(loadedPkg.admission.admitted && loadedPkg.admission.manifest.stage).toBe('shadow')

      await gov.flush()
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm1', slug: 'flushed-ok', scope: 'global', source_type: 'session', statement: 'flushed shard ref ok', source_ref: ref1,
      })).toMatchObject({ kind: 'accepted' })
      const events = readAllM0(gov.memoryDir)
      expect(events.some(e => e.type === 'memory.recall.dropped')).toBe(true)
      expect(events.some(e => e.type === 'authoring.replay_viewed')).toBe(true)
      expect(events.some(e => e.type === 'authoring.shadow_installed')).toBe(true)
    } finally { await h.stop() }
  }, 15_000)

  it('飞书裁决回调：鉴权、同 escalationId 防重判、无工作区转 M6、草稿脱敏、崩溃可重入与重启幂等', async () => {
    const h = await startRuntime()
    const stateDir = realpathSync(h.directory)
    const mkCb = (eventId: string, openId: string, escalationId: string, decision: string, attribution: string, note: string, captureAsRule = false, ticketId = 'T-10') => ({
      header: { event_id: eventId, event_type: 'card.action.trigger' },
      event: { operator: { open_id: openId }, action: { value: { escalationId, ticketId, decision, issuedAt: new Date().toISOString() }, form_value: { attribution, captureAsRule, note } } },
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

      expect(await h.runtime.handleFeishuCardCallback(mkCb('evt-unauth', 'ou_stranger', m6Item.id, 'approve', 'mandate_unclear', '恶意规则'))).toEqual({ ok: false, reason: 'unauthorized-operator' })
      await gov.flush()
      expect(readAllM0(gov.memoryDir).some(e => e.type === 'escalation.ruled')).toBe(false)

      const rM2 = await h.runtime.handleFeishuCardCallback(mkCb('evt-m2-1', 'ou_alice', m6Item.id, 'approve', 'mandate_unclear', '禁止自动 push'))
      expect(rM2.ok && !rM2.duplicate && rM2.sourceRef.seq > 0 && rM2.attentionUpdated).toBe(true)
      if (!rM2.ok) throw new Error('expected ok')
      expect(rM2.memoryWrite).toMatchObject({ kind: 'accepted', pagePath: 'm2/profile.md' })

      // 同 escalationId 换 callbackId 再点 reject 不得覆写，返回 alreadyRuled 并记 escalation.revised
      const secondClick = await h.runtime.handleFeishuCardCallback(mkCb('evt-m2-2', 'ou_alice', m6Item.id, 'reject', 'mandate_unclear', '反悔驳回'))
      expect(secondClick).toMatchObject({ ok: true, duplicate: true, alreadyRuled: true, sourceRef: rM2.sourceRef })
      const ledgerAfter = await readMemoryPage(gov.memoryDir, 'm6/ledger.md')
      expect(ledgerAfter?.layer === 'm6' && ledgerAfter.items.find(i => i.id === m6Item.id)?.status).toBe('approved')

      // exec_mistake 有工作区进 M3；无明确工作区禁猜，改写 M6 verification
      const rM3 = await h.runtime.handleFeishuCardCallback(mkCb('evt-m3-1', 'ou_alice', 'esc-m3', 'approve', 'exec_mistake', '先跑 typecheck'))
      expect(rM3.ok && rM3.memoryWrite).toMatchObject({ kind: 'accepted', pagePath: expect.stringMatching(/^m3\/main\//) })
      const rNoWs = await h.runtime.handleFeishuCardCallback(mkCb('evt-m3-nows', 'ou_alice', 'esc-nows', 'approve', 'exec_mistake', '未知工作区教训', false, 'T-NOWS'))
      expect(rNoWs.ok && rNoWs.attentionItem?.kind).toBe('verification')

      // gate_gap 草稿含 '..' id 清洗与秘密脱敏
      const rDraft = await h.runtime.handleFeishuCardCallback(mkCb('evt-gap-1', 'ou_alice', 'esc..gap', 'revise', 'gate_gap', 'leak sk-proj-abcdef1234567890xyz', true))
      expect(rDraft.ok && rDraft.draftPath).toBe(join(stateDir, 'deposit-drafts', 'friction.esc-gap.json'))
      expect(readFileSync(rDraft.ok ? rDraft.draftPath! : '', 'utf8')).not.toContain('sk-proj-abcdef1234567890xyz')

      await gov.flush()
      const m0 = readAllM0(gov.memoryDir)
      expect(m0.some(e => e.type === 'escalation.revised')).toBe(true)
      expect(m0.some(e => e.type === 'authoring.draft_created')).toBe(true)
    } finally { await h.stop() }

    // 崩溃重入验证：有 escalation.ruled 但无 escalation.applied 时，重试同 callbackId 继续补齐下游落盘与 applied
    const crashDir = mkdtempSync(join(tmpdir(), 'sec-cb-crash-'))
    tempDirs.push(crashDir)
    const store1 = new Store(join(crashDir, 'orchestrator.sqlite'))
    store1.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } } }))
    const gov1 = new GovernanceRuntime({ store: store1, stateDir: crashDir })
    await gov1.recover()
    gov1.appender.append({
      id: 'feishu:card:evt-crash-1', stream: 'ticket:T-c', type: 'escalation.ruled',
      source: { kind: 'human', ref: 'ou_alice' }, evidence: [], taint: 'derived',
      payload: { callbackId: 'evt-crash-1', escalationId: 'esc-crash', ticketId: 'T-c', operatorOpenId: 'ou_alice', decision: 'approve', attribution: 'mandate_unclear', note: '崩溃恢复规则' },
    })
    await gov1.shutdown(); store1.close()

    const store2 = new Store(join(crashDir, 'orchestrator.sqlite'))
    const gov2 = new GovernanceRuntime({ store: store2, stateDir: crashDir })
    await gov2.recover()
    const payload = mkCb('evt-crash-1', 'ou_alice', 'esc-crash', 'approve', 'mandate_unclear', '崩溃恢复规则', false, 'T-c')
    const resumed = await gov2.handleFeishuCardCallback(payload, { isAllowedOperator: createFeishuOperatorAuthorizer(store2) })
    expect(resumed.ok && !resumed.duplicate && resumed.memoryWrite?.kind === 'accepted').toBe(true)
    const afterApplied = await gov2.handleFeishuCardCallback(payload, { isAllowedOperator: createFeishuOperatorAuthorizer(store2) })
    expect(afterApplied).toMatchObject({ ok: true, duplicate: true, alreadyRuled: true })
    await gov2.shutdown(); store2.close()
    expect(readAllM0(gov2.memoryDir).filter(e => e.type === 'escalation.applied')).toHaveLength(1)
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
      handleCardAction: async (p: unknown) => { cardActions.push(p) },
    }
    // Regression: constructing Feishu SourceContext while setup is pending (getter throws) must NOT eagerly read deployment.
    const pendingCtx = sourceContextOf({ ...deps, get deployment(): never { throw new Error('setupPending') }, configured: () => false }, feishuKind)
    expect(typeof pendingCtx.handleCardAction).toBe('function')
    const ctx = sourceContextOf(deps, feishuKind)
    const ac = new AbortController()
    const run = runFeishu(ctx, ac.signal)
    await vi.waitFor(() => { expect(cardActions).toHaveLength(1); expect(received).toHaveLength(1) }, { timeout: 10_000 })
    ac.abort(); await run; store.close()
  }, 15_000)
})
