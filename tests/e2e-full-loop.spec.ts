import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GovernanceRuntime } from '../src/app/governance.ts'
import { createFeishuOperatorAuthorizer } from '../src/app/governance-ruling.ts'
import { Store } from '../src/app/store.ts'
import { buildEscalationCard } from '../src/authoring/index.ts'
import { evaluateAdaptiveDispatch } from '../src/judgement/gates/adaptive-dispatch.ts'
import { evaluateChangedPaths, type ChangedPathsCtx } from '../src/judgement/gates/changed-paths.ts'
import { SettingsSchema } from '../src/policy.ts'
import { readDepositsProjection, readNotebookProjection, readSpineProjection, readStateProjection } from '../src/projection/index.ts'
import { compareParamCandidates, runHistoricalReplay, splitByFamily, type ReplayCase } from '../src/rsi/index.ts'

describe('后端全链路真机级集成与灾难恢复闭环', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('灾难恢复演练：撕裂 M0 分片 + 彻底删除 SQLite 索引库后重启不撞 seq 且只读投影完整重建', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-e2e-dr-'))
    dirs.push(stateDir)
    const dbPath = join(stateDir, 'orchestrator.sqlite')

    const s1 = new Store(dbPath)
    const g1 = new GovernanceRuntime({ store: s1, stateDir })
    await g1.recover()
    s1.atomic(() => {
      g1.appender.append({
        id: 'dr-1', stream: 'ticket:T-1', type: 'ticket.created',
        source: { kind: 'system', ref: 'e2e' }, evidence: [], taint: 'trusted', payload: { ticketId: 'T-1' },
      })
      g1.appender.append({
        id: 'dr-2', stream: 'ticket:T-1', type: 'gate.evaluated',
        source: { kind: 'system', ref: 'e2e' }, evidence: [], taint: 'trusted',
        payload: { point: 'verify.changed-paths', verdict: { kind: 'allow' }, ran: [{ id: 'verify.changed-paths', outcome: 'allow' }] },
      })
    })
    await g1.shutdown()
    s1.close()

    const shardDir = join(stateDir, 'memory', 'm0')
    const shardName = readdirSync(shardDir).find(f => f.endsWith('.jsonl'))!
    appendFileSync(join(shardDir, shardName), '{"v":1,"seq":999,"id":"torn-crash-tail')
    rmSync(dbPath, { force: true })

    const s2 = new Store(dbPath)
    const g2 = new GovernanceRuntime({ store: s2, stateDir })
    const rec = await g2.recover()
    expect(rec.truncated).toBeGreaterThan(0)

    const nextRef = s2.atomic(() => g2.appender.append({
      id: 'dr-3', stream: 'ticket:T-1', type: 'ticket.ended',
      source: { kind: 'system', ref: 'e2e' }, evidence: [], taint: 'trusted', payload: { ticketId: 'T-1' },
    }))
    expect(nextRef.seq).toBe(3)
    await g2.flush()

    const spine = await readSpineProjection(s2, stateDir, { limit: 10 })
    const deps = await readDepositsProjection(s2, stateDir)
    expect(spine.items.map(i => i.seq)).toEqual([1, 2, 3])
    expect(deps.admittedCount).toBe(9)
    expect(deps.items.find(d => d.id === 'verify.changed-paths')?.stats.allow).toBe(1)

    await g2.shutdown()
    s2.close()
  }, 15_000)

  it('全链路闭环：飞书 Card 2.0 构建 -> 老板拍板入脊 -> M2/M6 落盘 -> 小人状态与 Notebook 只读投影联动', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-e2e-loop-'))
    dirs.push(stateDir)
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    store.saveSettings(SettingsSchema.parse({
      policy: { rules: [], sources: { feishu: { allowed: [{ id: 'ou_boss888', name: 'Boss' }], syncChat: '' } } },
    }))
    const gov = new GovernanceRuntime({ store, stateDir, now: () => new Date('2026-11-26T00:15:00.000Z') })
    await gov.recover()
    const seedRef = store.atomic(() => gov.appender.append({
      id: 'seed-1', stream: 'ticket:T-100', type: 'ticket.created',
      source: { kind: 'system', ref: 'e2e' }, evidence: [], taint: 'trusted', payload: { ticketId: 'T-100' },
    }))

    const built = buildEscalationCard({
      escalationId: 'att-demo-1', ticketId: 'T-100', title: '确认生产隔离策略',
      summary: '执行器请求访问外部配置目录，是否立为永久禁令？', issuedAt: '2026-11-26T00:00:00.000Z',
    })
    expect(JSON.stringify(built.card).length).toBeLessThan(30_000)

    const att = await gov.memory.upsertAttention({
      kind: 'ruling', question: '是否禁止访问生产 ~/.dsh？', sourceRefs: [seedRef],
    }, 'secretary')

    const res = await gov.handleFeishuCardCallback({
      header: { event_id: 'evt-e2e-ruling-1', event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_boss888' },
        action: {
          value: { escalationId: att.item.id, ticketId: 'T-100', decision: 'approve', issuedAt: '2026-11-26T00:00:00.000Z' },
          form_value: { attribution: 'mandate_unclear', note: '严禁触碰生产 ~/.dsh 目录' },
        },
      },
    }, { isAllowedOperator: createFeishuOperatorAuthorizer(store), m2Kind: 'veto' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.duplicate).toBe(false)
      expect(res.memoryWrite?.kind).toBe('accepted')
      expect(res.attentionUpdated).toBe(true)
    }
    await gov.flush()

    const nb = await readNotebookProjection(stateDir)
    expect(nb.counts.resolved).toBe(1)
    const proj = await readStateProjection(store, stateDir, new Date('2026-11-26T08:20:00+08:00'))
    expect(proj.avatar.bark?.sourceRef.seq).toBeGreaterThan(0)

    await gov.shutdown()
    store.close()
  }, 15_000)

  it('RSI 真实语料回放与多参数寻优实验：43 条冻结语料回归 + Pareto 前沿选参且密封 holdout', async () => {
    const rawCorpus = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'gate-corpus.json'), 'utf8')) as {
      tasks: { id: string; kind?: string; inScope?: string[]; outOfScope?: string[] }[]
    }
    const list = rawCorpus.tasks.filter(t => Array.isArray(t.inScope) && t.inScope.length > 0)
    expect(rawCorpus.tasks.length).toBe(43)
    expect(list.length).toBeGreaterThan(25)

    const replayCases: ReplayCase<ChangedPathsCtx>[] = list.map((t, idx) => {
      const injectOut = idx % 2 === 1 && Array.isArray(t.outOfScope) && t.outOfScope.length > 0
      const outPath = injectOut ? (t.outOfScope![0]!.endsWith('/') ? `${t.outOfScope![0]!}rogue.ts` : t.outOfScope![0]!) : undefined
      const cleanPath = t.inScope![0]!.endsWith('/') ? `${t.inScope![0]!}ok.ts` : t.inScope![0]!
      const touched = outPath ? [cleanPath, outPath] : [cleanPath]
      return {
        id: t.id,
        family: `${t.kind ?? 'task'}-${idx % 7}`,
        expectedOutcome: outPath ? 'defect' : 'clean',
        input: { allowedPaths: t.inScope!, sessionDiffs: touched, gitDirtyPaths: touched, untrackedPaths: [] },
      }
    })
    const replay = await runHistoricalReplay(ctx => evaluateChangedPaths(ctx), replayCases)
    expect(replay.falseBlocks).toBe(0)
    expect(replay.misses).toBe(0)

    const dispatchCases: ReplayCase<{ files: number; bytes: number; retries: number }>[] = Array.from({ length: 18 }, (_, i) => {
      const complex = i % 2 === 0
      return {
        id: `disp-${i}`, family: `dfam-${Math.floor(i / 2)}`, expectedOutcome: complex ? 'defect' : 'clean',
        cost: { tokens: complex ? 1200 : 400, durationMs: complex ? 3000 : 800 },
        input: { files: complex ? 8 : 3, bytes: complex ? 10_000 : 5000, retries: complex ? 2 : 0 },
      }
    })
    const split = splitByFamily(dispatchCases)
    const sweep = await compareParamCandidates(
      (p: { solo_max_files: number; escalate_after_fails: number }) => ctx => evaluateAdaptiveDispatch({
        metrics: {
          targetFiles: ctx.files, importedTypesCount: 2, callSiteCount: 4,
          relatedTestsCount: 1, totalBytes: ctx.bytes, durationMs: 5,
        },
        retryCount: ctx.retries, allowTeam: false,
      }, p),
      [
        { solo_max_files: 20, escalate_after_fails: 5 },
        { solo_max_files: 6, escalate_after_fails: 2 },
        { solo_max_files: 1, escalate_after_fails: 1 },
      ],
      split,
      { baseline: { solo_max_files: 20, escalate_after_fails: 5 } },
    )
    expect(sweep.proposalOnly).toBe(true)
    expect(sweep.holdoutOpened).toBe(false)
    expect(sweep.recommended?.params).toEqual({ solo_max_files: 6, escalate_after_fails: 2 })
    expect(sweep.recommended?.validation.falseBlocks).toBe(0)
  })
})
