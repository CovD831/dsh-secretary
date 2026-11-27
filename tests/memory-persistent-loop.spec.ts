/** 持久化会话记忆闭环与自动化做梦全链路红绿验收（覆盖 A1–D3 全部原子需求与 35 条老板黄金集）。 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { ingestBossDesktopMessage } from '../src/app/tools/secretary-core.ts'
import {
  EpochMemoryInjector, MemoryDreamer, MemoryFtsIndex, MemoryWriter, TranscriptFtsIndex,
  assembleMemoryPrompt, callerFromPolicy, canPolicyDirectOverride, createGroupBotMemoryPolicy,
  createHostDreamExtractor, createSecretaryMemoryPolicy, evaluateMemoryGoldSet, readMemoryPage,
  readUnextractedSessionWindow, resolveMemoryRelPath,
  type GoldEvalCase,
} from '../src/memory/index.ts'
import { GitRepoLock, createSpineAppender, createSpineFlusher, createGitShardSink, ensureSpineSchema } from '../src/spine/index.ts'
import goldDataset from './fixtures/memory-gold-v0.json' with { type: 'json' }
import { startRuntime } from './fixtures/host.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })
const mkTemp = (prefix = 'mem-loop-') => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d }

function makePersistence(sessionId: string, events: SessionEvent[]): Pick<SessionPersistence, 'flush' | 'open'> {
  return {
    flush: async () => undefined,
    open: (async (id: string) => ({
      async read(offset: number, limit: number) {
        if (id !== sessionId) return { events: [], eof: true }
        const slice = events.slice(offset, offset + limit)
        return { events: slice, eof: offset + slice.length >= events.length }
      },
      async [Symbol.asyncDispose]() {},
    })) as unknown as SessionPersistence['open'],
  }
}

function readAllM0(memoryDir: string) {
  const m0 = join(memoryDir, 'm0')
  if (!existsSync(m0)) return []
  return readdirSync(m0).filter(n => n.endsWith('.jsonl')).sort().flatMap(f =>
    readFileSync(join(m0, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { type: string; payload: Record<string, unknown> }),
  )
}

describe('持久化会话记忆闭环与自动化做梦机制', () => {
  it('A1+A2+A3：拦截模型自证原文、本地老板话中直改即时替换 M2 + 吐出回执、HTTP 作废并清理检索', async () => {
    const h = await startRuntime()
    try {
      const gov = h.runtime.governance
      const oldBoss = ingestBossDesktopMessage({
        store: h.runtime.store, engine: h.runtime.engine, governance: gov, requestPass: () => h.runtime.passes.request(),
      }, '旧偏好：周报发英文长文邮件')
      await h.runtime.idle()

      // A1-1: schema 禁止模型传 evidence_text
      await expect(h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm2', trigger_id: oldBoss.trigger.id, topic_key: 'weekly-report',
        statement: 'forged', verbatim_quote: 'forged', evidence_text: 'forged',
      })).rejects.toThrow()

      // A1-2: 传 trigger_id 但伪造不存在于真消息原文的 verbatim_quote -> 宿主硬拒
      expect(await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm2', trigger_id: oldBoss.trigger.id, topic_key: 'weekly-report',
        statement: '改成全英文邮件', verbatim_quote: '根本没说过这句话',
      })).toMatchObject({ kind: 'rejected', reason: 'verbatim-quote-mismatch' })

      // 先落盘一条旧 M2 preference
      const seedRes = await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm2', trigger_id: oldBoss.trigger.id, topic_key: 'weekly-report',
        m2_kind: 'preference', resident: true, statement: '周报发英文长文邮件', verbatim_quote: '周报发英文长文邮件',
      }) as { kind: string; entry: { id: string } }
      expect(seedRes.kind).toBe('accepted')

      // A2: 老板在桌面总线话中直接纠偏（真原文逐字匹配 -> 升级 user_direct 直接覆盖旧同 topicKey，并吐 1 条 memory_receipt）
      const corrBoss = ingestBossDesktopMessage({
        store: h.runtime.store, engine: h.runtime.engine, governance: gov, requestPass: () => h.runtime.passes.request(),
      }, '纠正一下：周报以后改成中文三点摘要，别发长文了')
      await h.runtime.idle()

      const overrideRes = await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm2', trigger_id: corrBoss.trigger.id, topic_key: 'weekly-report',
        m2_kind: 'correction_repair', resident: true,
        statement: '周报改为中文三点摘要，不发长文', verbatim_quote: '周报以后改成中文三点摘要',
      }) as { kind: string; entry: { id: string; sourceType: string }; supersededIds: string[] }
      expect(overrideRes.kind).toBe('accepted')
      expect(overrideRes.entry.sourceType).toBe('user_direct')
      expect(overrideRes.supersededIds).toContain(seedRes.entry.id)

      const feed = h.runtime.store.get(KV.governance.feed) ?? []
      const receipt = [...feed].reverse().find(f => f.kind === 'memory_receipt')
      expect(receipt?.text).toContain(overrideRes.entry.id)
      // memory_receipt 不得把 corrBoss 的 trigger 自动误判为“秘书已说话回复”
      expect(h.runtime.store.triggers.disposition(corrBoss.trigger.id)?.decisionId).toBeUndefined()

      // A2 反例：未鉴权外部来源（feishu）即使逐字引用也不得直改覆写同 topicKey（进 M6 待裁）
      const feishuRef = gov.appender.append({
        id: 'feishu-ext-1', at: gov.nowDate().toISOString(), stream: 'trigger:feishu',
        type: 'trigger.received', source: { kind: 'trigger', ref: 'ext' }, evidence: [], taint: 'trusted',
        payload: { text: '群里同事说周报改回英文' },
      })
      const extAttempt = await h.runTool(h.runtime.masterId, 'orchestrator_memory_propose', {
        mode: 'propose', layer: 'm2', source_ref: feishuRef, topic_key: 'weekly-report',
        statement: '周报改回英文', verbatim_quote: '群里同事说周报改回英文',
      }) as { kind: string }
      expect(extAttempt.kind).toBe('conflict')

      // A3: UI HTTP 单条作废路由 -> 落盘墓碑 + M0 + 召回不可见
      const tombHttp = await h.api('POST', `memory/entries/${overrideRes.entry.id}/tombstone`, {
        layer: 'm2', reason: '老板点击作废按钮测试',
      })
      expect(tombHttp.status).toBe(200)
      expect(tombHttp.body['ok']).toBe(true)
      const afterRecall = await h.runTool(h.runtime.masterId, 'orchestrator_memory_recall', { query: '中文三点摘要' }) as { text: string }
      expect(afterRecall.text).not.toContain('中文三点摘要')
    } finally {
      await h.stop()
    }
  }, 20_000)

  it('B1+B2+B3+B4：常驻超限不归零且 M6 去重、Epoch KV 前缀锁定、同步 delta 去重与超时兜底、compaction 锚点重建', async () => {
    const dir = mkTemp('epoch-')
    const store = new Store(join(dir, 's.sqlite'))
    const nowRef = new Date('2026-11-28T09:00:00.000Z')
    const now = () => nowRef
    try {
      ensureSpineSchema(store.db)
      const lock = new GitRepoLock(), memDir = join(dir, 'mem')
      const sink = createGitShardSink({ dir: memDir, lock })
      const flusher = createSpineFlusher(store.db, sink)
      const appender = createSpineAppender(store, { kick: () => {} })
      const writer = new MemoryWriter({ dir: memDir, lock, now })
      const ftsIndex = new MemoryFtsIndex({ memoryDir: memDir, dbPath: join(dir, 'fts.sqlite'), now })
      await writer.init()

      const r1 = appender.append({ id: 'e1', at: nowRef.toISOString(), stream: 'memory:m2', type: 'trigger.received', source: { kind: 'human', ref: 'boss' }, evidence: [], taint: 'trusted', payload: {} })
      await writer.propose({ layer: 'm2', scope: 'global', sourceType: 'user_ruling', m2Kind: 'preference', resident: true, clearance: 'private', sourceRef: r1, author: 'user', statement: '高优先级规则：先给结论再附证据' })
      await writer.propose({ layer: 'm1', slug: 'long-a', scope: 'global', sourceType: 'session', resident: true, clearance: 'public', sourceRef: r1, author: 'secretary', statement: '低优先级补充材料一二三四五六七八九十零一二三四五六七八九十甲乙丙丁' })
      await writer.propose({ layer: 'm1', slug: 'long-b', scope: 'global', sourceType: 'session', resident: true, clearance: 'public', sourceRef: r1, author: 'secretary', statement: '另一条超预算低优先级常驻条目用于触发常驻降级预算边界测试' })
      await ftsIndex.rebuild()

      const basePolicy = createSecretaryMemoryPolicy('master-1')
      const tightPolicy = { ...basePolicy, residentMaxChars: 95, deltaMaxChars: 400, recallTimeoutMs: 500 }
      const injector = new EpochMemoryInjector({ memoryDir: memDir, memoryRepoLock: lock, policy: tightPolicy, ftsIndex, memory: writer, appender, now })

      // B1: 超限不归零，保留最高权威规则，落盘 memory.resident.overflow 且去重仅建 1 条 M6
      const res1 = await injector.refreshResidentCache()
      expect(res1.text).toContain('先给结论再附证据')
      expect(res1.overflowIds.length).toBeGreaterThanOrEqual(1)
      await injector.refreshResidentCache()
      const ledger = await readMemoryPage(memDir, resolveMemoryRelPath({ layer: 'm6' }))
      expect(ledger?.layer === 'm6' ? ledger.items.filter(i => i.question.includes('[resident-overflow]')).length : 0).toBe(1)

      // B2: mid-Epoch 新增条目不改动 residentSection()（KV 前缀严格稳定）
      const prefixBefore = injector.residentSection()
      const propNew = await writer.propose({ layer: 'm1', slug: 'mid-epoch', scope: 'global', sourceType: 'session', clearance: 'public', resident: true, sourceRef: r1, author: 'secretary', statement: 'SQLite WAL 派生索引可随时删除重建' })
      if (propNew.kind !== 'accepted') throw new Error('expected accepted')
      injector.invalidateEntry(propNew.entry.id)
      await ftsIndex.rebuild()
      expect(injector.residentSection()).toBe(prefixBefore)

      // B3: 同步召回当轮命中新条目；同 Epoch 第 2 轮查同一话题不重复注入；修改后失效可再次注入
      const delta1 = await injector.prepareTurnDelta('SQLite WAL 重建')
      expect(delta1.text).toContain('SQLite WAL 派生索引可随时删除重建')
      expect(delta1.includedIds).toContain(propNew.entry.id)
      const delta2 = await injector.prepareTurnDelta('SQLite WAL 重建')
      expect(delta2.includedIds).not.toContain(propNew.entry.id)

      // B3: 超时兜底不卡主流程且 M0 记录 timedOut=true
      const slowFts = {
        ...ftsIndex,
        search: () => new Promise(resolve => setTimeout(() => resolve({ hits: [], m0FallbackHits: [], usedFallback: false, rebuilt: false }), 300)),
      } as unknown as MemoryFtsIndex
      const slowInjector = new EpochMemoryInjector({ memoryDir: memDir, memoryRepoLock: lock, policy: { ...tightPolicy, recallTimeoutMs: 60 }, ftsIndex: slowFts, memory: writer, appender, now })
      const slowRes = await slowInjector.prepareTurnDelta('慢查询触发超时')
      expect(slowRes.timedOut).toBe(true)
      expect(slowRes.text).toBe('')

      // B4: compaction/end 刷新静态常驻、清空去重、产出确定性实时状态锚点
      const comp = await injector.onCompactionEnded({
        openTickets: [{ id: 'TK-9', title: '修复支付回调签名', stage: 'working', workspace: 'pay' }],
        pendingRulings: [{ id: 'RL-2', question: '是否允许修改生产限流阈值？', kind: 'secretary_ask' }],
        workspaces: [{ id: 'pay', baseBranch: 'main' }],
      })
      expect(comp.epoch).toBe(1)
      expect(comp.anchorText).toContain('TK-9')
      expect(comp.anchorText).toContain('RL-2')
      expect(comp.anchorText.length).toBeLessThanOrEqual(1200)
      await flusher.flush()
      const m0 = readAllM0(memDir)
      expect(m0.some(e => e.type === 'memory.resident.overflow')).toBe(true)
      expect(m0.some(e => e.type === 'memory.recall.trace' && e.payload['timedOut'] === true)).toBe(true)
      ftsIndex.close()
    } finally {
      store.close()
    }
  })

  it('B2/B3 运行时集成：Sessions.prompt 同步 await 注入 delta、agent/pre-step 兜底、compaction/end 刷新 Epoch 锚点', async () => {
    const h = await startRuntime()
    try {
      const gov = h.runtime.governance
      const ref = gov.appender.append({ id: 's-1', at: gov.nowDate().toISOString(), stream: 'memory:m1', type: 'trigger.received', source: { kind: 'human', ref: 'boss' }, evidence: [], taint: 'trusted', payload: {} })
      await gov.memory.propose({ layer: 'm1', slug: 'tsdown-rule', scope: 'global', sourceType: 'session', clearance: 'public', sourceRef: ref, author: 'secretary', statement: '前端构建必须检查 tsdown 产物目录', triggerKeys: { primary: ['tsdown'] } })
      await gov.ftsIndex.rebuild()

      // Sessions.prompt 同步等待 delta 注入，且本次 step 1 不会因 agent/pre-step 重复二次注入
      const agent = h.agents.get(h.runtime.masterId) as unknown as {
        ctx: import('@deepseek-ai/cordis').Context
        session: never
        inject: ReturnType<typeof vi.fn>
      }
      await h.runtime.sessions.prompt(h.runtime.masterId, 'req-sync-1', '这次 tsdown 构建需要注意什么', 'queue')
      expect(agent.inject).toHaveBeenCalled()
      const injectedMsg = agent.inject.mock.calls.at(-1)![0]
      expect((injectedMsg.source as { form?: string }).form).toBe('recall')
      expect(injectedMsg.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('前端构建必须检查 tsdown') })

      const firstStepMsg = freezeMessage({ id: MessageId('u-step1'), role: 'user', content: [{ type: 'text', text: '这次 tsdown 构建需要注意什么' }], source: { kind: 'user' } })
      const dedupedPreStep = await agentEvents(agent.ctx, agent as never).waterfall(
        'agent/pre-step',
        { turn: 1, step: 1, messages: [firstStepMsg], signal: new AbortController().signal, modelSelection: { provider: 'mock', model: 'm' } },
        async () => ({ kind: 'enter', messages: [firstStepMsg] }),
      )
      expect(dedupedPreStep.kind === 'enter' && dedupedPreStep.messages).toHaveLength(1)

      // 绕过 Sessions.prompt 的直接 WebUI 输入回合 -> agent/pre-step 在 step=1 同步补入增量记忆
      h.ctx.emit('session/event', agent.session, { type: 'turn/end' } as never)
      await gov.memory.propose({ layer: 'm1', slug: 'redis-rule', scope: 'global', sourceType: 'session', clearance: 'public', sourceRef: ref, author: 'secretary', statement: 'Redis 锁配置不得禁用 maxRetriesPerRequest', triggerKeys: { primary: ['redis'] } })
      await gov.ftsIndex.rebuild()
      const directMsg = freezeMessage({ id: MessageId('u-direct'), role: 'user', content: [{ type: 'text', text: '排查一下 redis 锁超时' }], source: { kind: 'user' } })
      const preStepRes = await agentEvents(agent.ctx, agent as never).waterfall(
        'agent/pre-step',
        { turn: 2, step: 1, messages: [directMsg], signal: new AbortController().signal, modelSelection: { provider: 'mock', model: 'm' } },
        async () => ({ kind: 'enter', messages: [directMsg] }),
      )
      expect(preStepRes.kind).toBe('enter')
      if (preStepRes.kind === 'enter') {
        expect(preStepRes.messages.some(m => (m.source as { form?: string }).form === 'recall')).toBe(true)
        expect(JSON.stringify(preStepRes.messages)).toContain('Redis 锁配置')
      }

      // HTTP POST memory/dream 手动触发做梦路由 + GET memory/studio 返回 dreamStatus
      const dreamHttp = await h.api('POST', 'memory/dream', { force: true })
      expect(dreamHttp.status).toBe(200)
      const studioHttp = await h.api('GET', 'memory/studio')
      expect(studioHttp.status).toBe(200)
      expect(studioHttp.body['dreamStatus']).toBeDefined()

      // compaction/end 事件触发 Epoch 刷新并注入 snapshot 状态锚点
      h.ctx.emit('session/event', agent.session, { type: 'compaction/end' } as never)
      await new Promise(r => setTimeout(r, 40))
      const snapCall = agent.inject.mock.calls.find(([m]) => (m.source as { form?: string }).form === 'snapshot')
      expect(snapCall).toBeDefined()
    } finally {
      await h.stop()
    }
  })

  it('C1+C2 自动化做梦全闭环：越过 compaction 读原文、剥自注入与脱敏、三门准入、两步熔断、M3->M4 晋升与 >80% 常驻降级', async () => {
    const dir = mkTemp('dream-')
    const store = new Store(join(dir, 's.sqlite'))
    const nowRef = new Date('2026-11-28T10:00:00.000Z')
    const now = () => nowRef
    try {
      ensureSpineSchema(store.db)
      const lock = new GitRepoLock(), memDir = join(dir, 'mem')
      const sink = createGitShardSink({ dir: memDir, lock })
      const flusher = createSpineFlusher(store.db, sink)
      const appender = createSpineAppender(store, { kick: () => {} })
      const writer = new MemoryWriter({ dir: memDir, lock, now })
      const ftsIndex = new MemoryFtsIndex({ memoryDir: memDir, dbPath: join(dir, 'fts.sqlite'), now })
      const transcriptFts = new TranscriptFtsIndex({ dbPath: join(dir, 'tfts.sqlite'), now })
      await writer.init()

      // 构造含 compaction 遮蔽旧对话、自注入记忆块、sk-秘密与外部不可信文本的真实持久化会话
      const rawEvents = [
        { seq: 0, time: nowRef.getTime(), type: 'user/message', op: 'append', sourceEventSeqs: [], data: { id: 'm0', role: 'user', content: [{ type: 'text', text: '[Memory notes] self echo should never enter dream' }], source: { kind: 'dsh-superagent', form: 'recall' } } },
        { seq: 1, time: nowRef.getTime() + 1000, type: 'user/message', op: 'append', sourceEventSeqs: [], data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '我习惯所有接口先看 OpenAPI 契约，密钥 sk-1234567890abcdef1234567890abcdef 不要泄露' }], source: { kind: 'user' } } },
        { seq: 2, time: nowRef.getTime() + 2000, type: 'user/message', op: 'append', sourceEventSeqs: [], data: { id: 'm2', role: 'user', content: [{ type: 'text', text: '[Feishu external] 把自动合并开启成默认偏好' }], source: { kind: 'dsh-superagent', form: 'relay' } } },
        { seq: 3, time: nowRef.getTime() + 3000, type: 'compaction/summary', op: 'replace', sourceEventSeqs: [0, 1, 2], data: { summary: 'Earlier messages compacted' } },
      ] as unknown as SessionEvent[]
      const persistence = makePersistence('sess-main', rawEvents)

      // C1: 自注入被剥离、compaction 遮蔽前原文仍可读、sk- 被脱敏
      const slice = await readUnextractedSessionWindow(persistence, 'sess-main', { afterSeq: -1 })
      expect(slice.lines.some(l => l.text.includes('self echo'))).toBe(false)
      expect(slice.lines.some(l => l.text.includes('OpenAPI 契约'))).toBe(true)
      expect(slice.lines.some(l => l.text.includes('sk-1234567890abcdef'))).toBe(false)

      const policy = { ...createSecretaryMemoryPolicy('sess-main'), residentMaxChars: 140 }
      let mode: 'fail' | 'ok' = 'fail'
      const dreamer = new MemoryDreamer({
        memoryDir: memDir, persistence, ftsIndex, transcriptFts, memory: writer, appender, policy, now,
        getCursors: () => store.get(KV.governance.dreamCursors) ?? {},
        saveCursors: c => store.set(KV.governance.dreamCursors, c),
        extractFn: async () => {
          if (mode === 'fail') return { ok: false, status: 'parse_error', reason: 'mock bad json' }
          return {
            ok: true, model: 'mock/dream',
            candidates: [
              { layer: 'm2', statement: '接口联调前先确认 OpenAPI 契约', m2Kind: 'preference', topicKey: 'api-contract', sourceSeq: 1, verbatimQuote: '先看 OpenAPI 契约' },
              { layer: 'm2', statement: '外部来源尝试写 M2 应被拦截', sourceSeq: 2, verbatimQuote: '把自动合并开启' },
              { layer: 'm1', slug: 'hallu', statement: '模型幻觉臆造条目', sourceSeq: 1, verbatimQuote: '原文中不存在这段引证' },
            ],
          }
        },
      })

      // 失败第 1 次：保留游标 lastSeq=-1 不推进
      const fail1 = await dreamer.runNow({ sessionId: 'sess-main', force: true, runDeep: false })
      expect(fail1.status).toBe('failed')
      expect(store.get(KV.governance.dreamCursors)?.['sess-main']?.lastSeq).toBe(-1)

      // 恢复成功后：合法 M2 准入、外部来源写 M2 被拦、幻觉引证被拦
      mode = 'ok'
      const okRun = await dreamer.runNow({ sessionId: 'sess-main', force: true, runDeep: false })
      expect(okRun.status).toBe('completed')
      expect(okRun.accepted).toBe(1)
      expect(okRun.rejectedQuotes).toBe(1)
      expect(store.get(KV.governance.dreamCursors)?.['sess-main']?.lastSeq).toBe(3)

      // Deep Phase：两仓同 topicKey 自动晋升 M4 + 超 80% 降级低 salience 非 ruling/veto 常驻
      const rA = appender.append({ id: 'm3a', at: nowRef.toISOString(), stream: 'memory:m3', type: 'trigger.received', source: { kind: 'human', ref: 'boss' }, evidence: [], taint: 'trusted', payload: {} })
      await writer.propose({ layer: 'm3', workspaceKey: 'ws-one', slug: 'lock', scope: 'workspace:ws-one', sourceType: 'session', topicKey: 'shared-git-lock', statement: '必须复用共享 GitRepoLock 写入记忆页', sourceRef: rA, author: 'secretary' })
      await writer.propose({ layer: 'm3', workspaceKey: 'ws-two', slug: 'lock', scope: 'workspace:ws-two', sourceType: 'session', topicKey: 'shared-git-lock', statement: '必须复用共享 GitRepoLock 写入记忆页', sourceRef: rA, author: 'secretary' })
      const vetoSeed = await writer.propose({ layer: 'm2', scope: 'global', sourceType: 'user_ruling', m2Kind: 'veto', resident: true, sourceRef: rA, author: 'user', statement: '绝不可降级的老板核心红线规则条目一二三' })
      expect(vetoSeed.kind).toBe('accepted')
      const coldSeed = await writer.propose({ layer: 'm1', slug: 'cold-res', scope: 'global', sourceType: 'session', resident: true, importance: 1, observedAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z', sourceRef: rA, author: 'secretary', statement: '这是一条很久以前写入且长期未再检索的冷常驻记忆条目，用来把总常驻字符数量稳定推过百分之八十阈值，测试自动降级为按需召回而不是直接删除' })
      expect(coldSeed.kind).toBe('accepted')

      const deepRun = await dreamer.runNow({ sessionId: 'sess-main', force: true, runDeep: true })
      expect(deepRun.promotedM4).toBe(1)
      expect(deepRun.demotedResident).toBeGreaterThanOrEqual(1)
      const m4Page = await readMemoryPage(memDir, 'm4/patterns.md')
      expect(m4Page?.layer === 'm4' && m4Page.entries.some(e => e.topicKey === 'shared-git-lock')).toBe(true)
      const m2Page = await readMemoryPage(memDir, 'm2/profile.md')
      expect(m2Page?.layer === 'm2' && m2Page.entries.find(e => e.m2Kind === 'veto')?.resident).toBe(true)

      // 连续 2 次失败同一新范围 -> 触发熔断跳过并写 memory.dream.unmeasured
      const badEvents: SessionEvent[] = [...rawEvents, { seq: 4, time: nowRef.getTime() + 4000, type: 'user/message', op: 'append', sourceEventSeqs: [], data: { id: 'm4', role: 'user', content: [{ type: 'text', text: '测试坏跨度熔断保护的一段正常长度消息' }], source: { kind: 'user' } } } as unknown as SessionEvent]
      const breakerDreamer = new MemoryDreamer({
        memoryDir: memDir, persistence: makePersistence('sess-main', badEvents), ftsIndex, memory: writer, appender, policy, now,
        getCursors: () => store.get(KV.governance.dreamCursors) ?? {},
        saveCursors: c => store.set(KV.governance.dreamCursors, c),
        extractFn: async () => ({ ok: false, status: 'timeout', reason: 'timeout' }),
      })
      expect((await breakerDreamer.runNow({ sessionId: 'sess-main', force: true, runDeep: false })).status).toBe('failed')
      const unm = await breakerDreamer.runNow({ sessionId: 'sess-main', force: true, runDeep: false })
      expect(unm.status).toBe('unmeasured')
      expect(store.get(KV.governance.dreamCursors)?.['sess-main']?.lastSeq).toBe(4)

      await flusher.flush()
      expect(readAllM0(memDir).some(e => e.type === 'memory.dream.unmeasured')).toBe(true)
      ftsIndex.close(); transcriptFts.close()
    } finally {
      store.close()
    }
  })

  it('C1b：createHostDreamExtractor 容忍可选字段 null/空串并在全候选非法时诚实报 parse_error', async () => {
    const makeExtractor = (payload: string) => {
      const llm = {
        listProviders: () => [{ id: 'mock' }],
        async *stream() {
          yield { type: 'text-delta', text: payload }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
      return createHostDreamExtractor({ get: (k: string) => k === 'llm' ? llm : undefined } as never, () => ({ eval: { model: { provider: 'mock', model: 'm' } } } as never))
    }
    const slice = { sessionId: 's-null', fromSeq: 0, throughSeq: 0, totalChars: 12, hasMore: false, lines: [{ seq: 0, at: '2026-11-28T00:00:00.000Z', role: 'boss' as const, text: '周报以后改成表格形式发飞书', taint: 'trusted' as const }] }

    const okNull = await makeExtractor(JSON.stringify({
      candidates: [{ layer: 'm2', statement: '周报改飞书表格', topicKey: 'weekly-report-format', m2Kind: 'preference', workspaceKey: null, slug: '', sourceSeq: 0, verbatimQuote: '周报以后改成表格', importance: 8, triggerKeys: ['周报'] }],
    }))({ sessionId: 's-null', slice })
    expect(okNull.ok).toBe(true)
    if (okNull.ok) {
      expect(okNull.candidates).toHaveLength(1)
      expect(okNull.candidates[0]?.workspaceKey).toBeUndefined()
      expect(okNull.candidates[0]?.slug).toBeUndefined()
    }

    const allBad = await makeExtractor(JSON.stringify({
      candidates: [{ layer: 'm2', statement: '', sourceSeq: 0, verbatimQuote: 'x' }],
    }))({ sessionId: 's-null', slice })
    expect(allBad).toMatchObject({ ok: false, status: 'parse_error' })

    const explicitEmpty = await makeExtractor('{"candidates":[]}')({ sessionId: 's-null', slice })
    expect(explicitEmpty).toMatchObject({ ok: true, candidates: [] })
  })

  it('C3+D2+D3：CJK 防常见字 OR 噪音、压缩对话 FTS 权限检索、群 Bot 策略隔离、35 条黄金集全绿过线', async () => {
    const dir = mkTemp('c3-d2-')
    const store = new Store(join(dir, 's.sqlite'))
    const now = new Date('2026-11-28T11:00:00.000Z')
    try {
      ensureSpineSchema(store.db)
      const lock = new GitRepoLock(), memDir = join(dir, 'mem')
      const appender = createSpineAppender(store, { kick: () => {} })
      const writer = new MemoryWriter({ dir: memDir, lock, now: () => now })
      const fts = new MemoryFtsIndex({ memoryDir: memDir, dbPath: join(dir, 'fts.sqlite'), now: () => now })
      const tFts = new TranscriptFtsIndex({ dbPath: join(dir, 'tfts.sqlite'), now: () => now })
      await writer.init()
      const ref = appender.append({ id: 'r-c3', at: now.toISOString(), stream: 'memory:m1', type: 'trigger.received', source: { kind: 'human', ref: 'boss' }, evidence: [], taint: 'trusted', payload: {} })
      await writer.propose({ layer: 'm3', workspaceKey: 'ws-a', slug: 'db', scope: 'workspace:ws-a', sourceType: 'session', clearance: 'workspace', sourceRef: ref, author: 'secretary', statement: '使用 PostgreSQL 存储账单数据' })
      await writer.propose({ layer: 'm2', scope: 'global', sourceType: 'user_direct', clearance: 'private', sourceRef: ref, author: 'user', statement: '老板私密偏好：每周五复盘项目路线' })
      await fts.rebuild()

      // C3: CJK 高频废话句零误召回，实词精准命中
      const noiseRes = await fts.search('我的项目是不是应该处理一下', { role: 'secretary', maxClearance: 'private' }, { now })
      expect(noiseRes.hits).toHaveLength(0)
      const hitRes = await fts.search('PostgreSQL 账单数据', { role: 'secretary', maxClearance: 'private' }, { now })
      expect(hitRes.hits).toHaveLength(1)

      // C3-2: 压缩对话增量索引 -> 秘书可读、worker 隔离 private、跳过 recall 自注入
      const p = makePersistence('sess-sec', [
        { seq: 0, time: now.getTime(), type: 'user/message', op: 'append', sourceEventSeqs: [], data: { id: 'u0', role: 'user', content: [{ type: 'text', text: '[Memory notes] 不该进转录索引' }], source: { kind: 'dsh-superagent', form: 'recall' } } },
        { seq: 1, time: now.getTime() + 1000, type: 'assistant/message', op: 'append', sourceEventSeqs: [], data: { id: 'a1', role: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '码头吊机供应商联系人是王工' }] } } },
      ] as unknown as SessionEvent[])
      const sync1 = await tFts.syncSession(p, 'sess-sec', 'private')
      expect(sync1.indexed).toBe(1)
      expect((await tFts.search('王工 供应商', { role: 'secretary', maxClearance: 'private' }))[0]?.snippet).toContain('王工')
      expect(await tFts.search('王工 供应商', { role: 'worker', workspaceId: 'ws-a', maxClearance: 'workspace' })).toHaveLength(0)

      // D2: 群 Bot 策略隔离 private/M2 且禁直改覆盖
      const botPolicy = createGroupBotMemoryPolicy('bot-g1', 'ws-a')
      expect(canPolicyDirectOverride(botPolicy, 'secretary-bus', true)).toBe(false)
      const botView = await assembleMemoryPrompt({ dir: memDir, caller: callerFromPolicy(botPolicy), query: '账单数据 路线', ftsIndex: fts, now })
      expect(botView.text).toContain('PostgreSQL 存储账单数据')
      expect(botView.text).not.toContain('每周五复盘项目路线')
      fts.close(); tFts.close()
    } finally {
      store.close()
    }

    // D3: 35 条老板黄金评测集
    const report = await evaluateMemoryGoldSet(goldDataset.cases as readonly GoldEvalCase[])
    expect(report.totalCases).toBe(35)
    expect(report.failures).toEqual([])
    expect(report.recallAt5).toBeGreaterThanOrEqual(0.9)
    expect(report.overrideAccuracy).toBe(1)
    expect(report.vetoBlockRate).toBe(1)
    expect(report.transcriptRecallRate).toBeGreaterThanOrEqual(0.9)
    expect(report.falseRecallCount).toBe(0)
    expect(report.passed).toBe(true)
  }, 30_000)
})
