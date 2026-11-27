import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bootstrapDeltaCI,
  buildTierEscalationGate,
  buildWorkspaceOneHopGraph,
  clusterProblemEvents,
  collectOnlineRsiSnapshot,
  compareParamCandidates,
  DEFAULT_TIER_ROUTER_PARAMS,
  evaluateClusterQuality,
  evaluateSealedHoldout,
  routeProblemCluster,
  splitByFamily,
  UNROUTED_FAST_LANE_GATE,
  type ProblemClusterFeatures,
  type TierRouterParams,
} from '../src/rsi/index.ts'
import type { SpineEnvelope } from '../src/spine/types.ts'

const temps: string[] = []
function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true })
})

function mkEv(
  seq: number,
  at: string,
  type: SpineEnvelope['type'],
  ticketId: string | undefined,
  payload: Record<string, unknown>,
  causationId?: string,
): SpineEnvelope {
  return {
    v: 1,
    seq,
    id: `ev-${seq}`,
    at,
    stream: ticketId ? `ticket:${ticketId}` : `desk:ev-${seq}`,
    type,
    ...(causationId ? { causationId } : {}),
    source: { kind: 'system', ref: 'test' },
    evidence: [],
    taint: 'trusted',
    payload: { ...(ticketId ? { ticketId } : {}), ...payload },
  }
}

describe('P7：因果链/1-Hop 根因聚类与分档寻优离线闭环', () => {
  it('防误并 + 去噪：分离不同焦点的 bash 报错、过滤 workspace.gc 并计算 BCubed F1 优于基线', () => {
    const events: SpineEnvelope[] = [
      mkEv(1, '2026-11-26T10:00:00Z', 'workspace.provisioned', 't1', { workspace: 'billing-svc' }),
      mkEv(2, '2026-11-26T10:01:00Z', 'worker.tool_finished', 't1', { toolName: 'bash', isError: true, hasDiff: false }),
      mkEv(3, '2026-11-26T10:01:30Z', 'escalation.ruled', 't1', {
        escalationId: 'r-probe', rulingKind: 'dsh_approval', decision: 'reject', optionId: 'reject',
        workspace: 'billing-svc', toolName: 'write', note: '禁止写 .env.staging，请只改 src/money.mjs',
      }),
      mkEv(4, '2026-11-26T10:02:00Z', 'gate.evaluated', 't1', { point: 'verify.changed-paths', verdict: { kind: 'deny', blockers: ['漏报: tests/money.test.mjs'] }, declaredPaths: ['src/money.mjs'] }),
      mkEv(5, '2026-11-26T10:03:00Z', 'worker.tool_finished', 't1', { toolName: 'orchestrator_report', isError: true, hasDiff: false }),
      mkEv(6, '2026-11-26T10:04:00Z', 'ticket.ended', 't1', { outcome: 'completed' }),
      mkEv(7, '2026-11-26T10:05:00Z', 'gate.evaluated', 't1', { point: 'workspace.gc', verdict: { kind: 'deny', blockers: ['dirty'] }, plan: { kind: 'keep' } }),

      mkEv(11, '2026-11-26T10:10:00Z', 'workspace.provisioned', 't2', { workspace: 'auth-gateway' }),
      mkEv(12, '2026-11-26T10:11:00Z', 'worker.tool_finished', 't2', { toolName: 'bash', isError: true, hasDiff: false }),
      mkEv(13, '2026-11-26T10:12:00Z', 'ticket.ended', 't2', { outcome: 'completed' }),
      mkEv(14, '2026-11-26T10:13:00Z', 'gate.evaluated', 't2', { point: 'workspace.gc', verdict: { kind: 'deny', blockers: ['dirty'] }, plan: { kind: 'keep' } }),

      mkEv(21, '2026-11-26T10:20:00Z', 'workspace.provisioned', 't3', { workspace: 'ops-cli' }),
      mkEv(22, '2026-11-26T10:21:00Z', 'worker.tool_finished', 't3', { toolName: 'bash', isError: true, hasDiff: false }),
      mkEv(23, '2026-11-26T10:22:00Z', 'ticket.ended', 't3', { outcome: 'completed' }),
      mkEv(24, '2026-11-26T10:23:00Z', 'gate.evaluated', 't3', { point: 'workspace.gc', verdict: { kind: 'deny', blockers: ['dirty'] }, plan: { kind: 'keep' } }),
    ]

    const clusters = clusterProblemEvents(events, { mode: 'e2e' })
    expect(clusters.some(c => c.point === 'workspace.gc')).toBe(false)
    expect(clusters.some(c => c.toolName === 'orchestrator_report')).toBe(false)

    const undeclared = clusters.find(c => c.key === 'gate-contract:verify.changed-paths:undeclared-path')
    expect(undeclared).toBeDefined()
    expect(undeclared?.explainedSymptoms.map(s => s.seq)).toContain(5)

    const truth: Record<number, string> = {
      3: 'policy-probe-env',
      4: 'undeclared-money-test',
      5: 'undeclared-money-test',
      2: 'noise',
      7: 'noise',
      12: 'noise',
      14: 'noise',
      22: 'noise',
      24: 'noise',
    }
    const q = evaluateClusterQuality(clusters, [2, 3, 4, 5, 7, 12, 14, 22, 24], truth)
    expect(q.purity).toBe(1)
    expect(q.inversePurity).toBe(1)
    expect(q.bcubedF1).toBe(1)
    expect(q.suppressedNoiseCount).toBe(6)
  })

  it('防漏并：billing-svc 授权反相与下游 .env.staging 门禁阻断收束为单一根因簇并直通 T0', () => {
    const events: SpineEnvelope[] = [
      mkEv(1, '2026-11-26T23:01:00Z', 'workspace.provisioned', 'f538', { workspace: 'billing-svc' }),
      mkEv(2, '2026-11-26T23:02:00Z', 'ruling.queued', 'f538', { rulingId: 'r1', kind: 'dsh_approval', workspace: 'billing-svc', toolName: 'write', question: '触碰 .env.staging' }),
      mkEv(3, '2026-11-26T23:02:15Z', 'escalation.ruled', 'f538', {
        escalationId: 'r1', rulingKind: 'dsh_approval', decision: 'approve', optionId: 'reject',
        workspace: 'billing-svc', toolName: 'write', attribution: 'missing_rule',
      }, 'ruling:queued:r1'),
      mkEv(4, '2026-11-26T23:02:20Z', 'gate.evaluated', 'f538', {
        point: 'verify.secret-path-guard',
        verdict: { kind: 'deny', blockers: ['[verify.secret-path-guard] 命中禁止路径 (.env.*): .env.staging'] },
      }),
      mkEv(5, '2026-11-26T23:02:21Z', 'worker.tool_finished', 'f538', { toolName: 'orchestrator_report', isError: true }),
      mkEv(6, '2026-11-26T23:02:34Z', 'escalation.ruled', 'f538', {
        escalationId: 'r2', rulingKind: 'dsh_approval', decision: 'approve', optionId: 'reject',
        workspace: 'billing-svc', toolName: 'bash', attribution: 'missing_rule',
      }),
      mkEv(7, '2026-11-26T23:03:00Z', 'gate.evaluated', 'f538', {
        point: 'verify.changed-paths',
        verdict: { kind: 'unmeasured', cause: 'shell-blind', detail: 'bash' },
        declaredPaths: ['src/money.mjs'],
        shellAudit: { unlocked: false, reason: 'reverted-or-tampered:.env.staging' },
      }),
      mkEv(8, '2026-11-26T23:03:01Z', 'worker.tool_finished', 'f538', { toolName: 'orchestrator_report', isError: true }),
      mkEv(9, '2026-11-26T23:04:00Z', 'ticket.ended', 'f538', { outcome: 'stopped', by: 'human' }),
    ]

    const clusters = clusterProblemEvents(events, { mode: 'e2e' })
    expect(clusters).toHaveLength(1)
    const root = clusters[0]!
    expect(root.rootKind).toBe('contract-anomaly')
    expect(root.key).toBe('contract-inversion:dsh_approval:negative-option-approved')
    expect(root.refs.map(r => r.seq)).toEqual([3, 6])
    expect(root.explainedSymptoms.map(s => s.seq)).toEqual(expect.arrayContaining([4, 5, 7, 8]))
    expect(root.features.safetyDirection).toBe('fail-closed')
    expect(root.features.deterministicOracle).toBe(true)
    expect(root.qualifiesForRung1).toBe(true)

    const tier = routeProblemCluster(root.features)
    expect(tier.tier).toBe('T0_direct_autofix')
    expect(tier.escalateFromFastLane).toBe(false)
  })

  it('1-Hop 共享依赖共因归并：两条独立路由同时引入 src/slug.mjs 时合并为单一根因并升级 T2', async () => {
    const repo = mkTmp('dsh-p7-onehop-')
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src/slug.mjs'), 'export function slugify(s) { return s.trim().toLowerCase() }\n')
    writeFileSync(join(repo, 'src/invoice-route.mjs'), "import { slugify } from './slug.mjs'\nexport const makeInvoiceKey = slugify\n")
    writeFileSync(join(repo, 'src/webhook-route.mjs'), "import { slugify } from './slug.mjs'\nexport const makeWebhookKey = slugify\n")

    const graph = await buildWorkspaceOneHopGraph({ 'sample-app': repo })
    expect(graph['sample-app:src/invoice-route.mjs']).toContain('sample-app:src/slug.mjs')
    expect(graph['sample-app:src/webhook-route.mjs']).toContain('sample-app:src/slug.mjs')

    const events: SpineEnvelope[] = [
      mkEv(1, '2026-11-26T12:00:00Z', 'workspace.provisioned', 't-inv', { workspace: 'sample-app' }),
      mkEv(2, '2026-11-26T12:01:00Z', 'gate.evaluated', 't-inv', {
        point: 'verify.rerun',
        verdict: { kind: 'deny', blockers: ['invoice-route order-v2 failed'] },
        declaredPaths: ['src/invoice-route.mjs'],
      }),
      mkEv(3, '2026-11-26T12:05:00Z', 'workspace.provisioned', 't-whk', { workspace: 'sample-app' }),
      mkEv(4, '2026-11-26T12:06:00Z', 'gate.evaluated', 't-whk', {
        point: 'verify.rerun',
        verdict: { kind: 'deny', blockers: ['webhook-route batch-7 failed'] },
        declaredPaths: ['src/webhook-route.mjs'],
      }),
    ]

    const clusters = clusterProblemEvents(events, { mode: 'e2e', oneHopGraph: graph })
    expect(clusters).toHaveLength(1)
    const merged = clusters[0]!
    expect(merged.rootKind).toBe('code-locus')
    expect(merged.sharedLoci).toContain('sample-app:src/slug.mjs')
    expect(merged.features.entryPointCount).toBe(2)
    expect(merged.features.sharedLocusCount).toBeGreaterThanOrEqual(1)
    expect(merged.qualifiesForRung1).toBe(true)

    const tier = routeProblemCluster(merged.features)
    expect(tier.tier).toBe('T2_heavy_causal')
    expect(tier.escalateFromFastLane).toBe(true)
    const single = clusterProblemEvents(events.slice(0, 2), { mode: 'e2e', oneHopGraph: graph })[0]!
    expect(single.features.oneHopFileCount).toBe(1)
    expect(routeProblemCluster(single.features).tier).toBe('T1_light_single_pass')
    const baseRes = await UNROUTED_FAST_LANE_GATE(merged.features, { id: 'u', family: 'u', input: merged.features, expectedOutcome: 'defect' })
    expect(baseRes).toMatchObject({ verdict: { kind: 'allow' } })
  })

  it('打通 online-collector E2E 单日多工单晋升，同时维持单工单防刷守恒', async () => {
    const events: SpineEnvelope[] = [
      mkEv(1, '2026-11-26T09:00:00Z', 'workspace.provisioned', 't-a', { workspace: 'billing-svc' }),
      mkEv(2, '2026-11-26T09:01:00Z', 'gate.evaluated', 't-a', { point: 'verify.changed-paths', verdict: { kind: 'deny', blockers: ['漏报: tests/a.test.mjs'] }, declaredPaths: ['src/a.mjs'] }),
      mkEv(3, '2026-11-26T09:05:00Z', 'workspace.provisioned', 't-b', { workspace: 'auth-gateway' }),
      mkEv(4, '2026-11-26T09:06:00Z', 'gate.evaluated', 't-b', { point: 'verify.changed-paths', verdict: { kind: 'deny', blockers: ['漏报: tests/b.test.mjs'] }, declaredPaths: ['src/b.mjs'] }),
      mkEv(5, '2026-11-26T09:10:00Z', 'workspace.provisioned', 't-solo', { workspace: 'ops-cli' }),
      mkEv(6, '2026-11-26T09:11:00Z', 'worker.tool_finished', 't-solo', { toolName: 'bash', isError: true, clusterKey: 'solo-only' }),
      mkEv(7, '2026-11-26T09:12:00Z', 'worker.tool_finished', 't-solo', { toolName: 'bash', isError: true, clusterKey: 'solo-only' }),
    ]

    const prodSnap = await collectOnlineRsiSnapshot({ events })
    expect(prodSnap.candidateDrafts).toHaveLength(0)

    const e2eSnap = await collectOnlineRsiSnapshot({ events, collectionMode: 'e2e' })
    const sharedCluster = e2eSnap.problemClusters?.find(c => c.key === 'gate-contract:verify.changed-paths:undeclared-path')
    const soloCluster = e2eSnap.problemClusters?.find(c => c.key === 'solo-only')
    expect(sharedCluster?.qualifiesForRung1).toBe(true)
    expect(soloCluster?.qualifiesForRung1).toBe(false)
    expect(e2eSnap.candidateDrafts.some(d => d.id === sharedCluster?.draft?.id)).toBe(true)
  })

  it('sweep.ts 数据驱动寻优剔除全 T2 与全 T1 极端档，产出非支配 Pareto 前沿与 Holdout 门禁校验', async () => {
    const mkFeat = (partial: Partial<ProblemClusterFeatures>): ProblemClusterFeatures => ({
      entryPointCount: 1,
      oneHopFileCount: 1,
      sharedLocusCount: 0,
      deterministicOracle: true,
      safetyDirection: 'neutral',
      distinctWorkspaces: 1,
      distinctTickets: 1,
      distinctDays: 1,
      maxRetryCount: 1,
      explainedSymptomCount: 0,
      ...partial,
    })

    const cases = [
      // train families
      { id: 'tr-t1-1', family: 'f-tr-simple-a', expectedOutcome: 'clean' as const, input: mkFeat({ oneHopFileCount: 1 }) },
      { id: 'tr-t1-2', family: 'f-tr-simple-b', expectedOutcome: 'clean' as const, input: mkFeat({ oneHopFileCount: 2 }) },
      { id: 'tr-t2-1', family: 'f-tr-multi-a', expectedOutcome: 'defect' as const, input: mkFeat({ entryPointCount: 2, sharedLocusCount: 1, oneHopFileCount: 3 }) },
      { id: 'tr-spec-1', family: 'f-tr-spec-a', expectedOutcome: 'defect' as const, input: mkFeat({ deterministicOracle: false, safetyDirection: 'fail-open' }) },
      // validation families
      { id: 'va-t1-1', family: 'f-va-simple-a', expectedOutcome: 'clean' as const, input: mkFeat({ oneHopFileCount: 1 }) },
      { id: 'va-t1-2', family: 'f-va-simple-b', expectedOutcome: 'clean' as const, input: mkFeat({ oneHopFileCount: 2 }) },
      { id: 'va-t2-1', family: 'f-va-multi-a', expectedOutcome: 'defect' as const, input: mkFeat({ entryPointCount: 2, sharedLocusCount: 1, oneHopFileCount: 3 }) },
      { id: 'va-t2-2', family: 'f-va-retry-a', expectedOutcome: 'defect' as const, input: mkFeat({ oneHopFileCount: 3, maxRetryCount: 2 }) },
      // holdout families (>= 6 samples across distinct families so bootstrap CI is powered)
      { id: 'ho-t1-1', family: 'f-ho-simple-a', expectedOutcome: 'clean' as const, input: mkFeat({ oneHopFileCount: 1 }) },
      { id: 'ho-t1-2', family: 'f-ho-simple-b', expectedOutcome: 'clean' as const, input: mkFeat({ oneHopFileCount: 2 }) },
      { id: 'ho-t1-3', family: 'f-ho-simple-c', expectedOutcome: 'clean' as const, input: mkFeat({ oneHopFileCount: 1, safetyDirection: 'fail-closed' }) },
      { id: 'ho-t2-1', family: 'f-ho-multi-a', expectedOutcome: 'defect' as const, input: mkFeat({ entryPointCount: 2, sharedLocusCount: 1, oneHopFileCount: 3 }) },
      { id: 'ho-t2-2', family: 'f-ho-multi-b', expectedOutcome: 'defect' as const, input: mkFeat({ entryPointCount: 3, sharedLocusCount: 1, oneHopFileCount: 4 }) },
      { id: 'ho-t2-3', family: 'f-ho-retry-a', expectedOutcome: 'defect' as const, input: mkFeat({ oneHopFileCount: 2, maxRetryCount: 2 }) },
    ]
    const split = {
      train: cases.filter(c => c.id.startsWith('tr-')),
      validation: cases.filter(c => c.id.startsWith('va-')),
      holdout: cases.filter(c => c.id.startsWith('ho-')),
      familyAssignments: Object.fromEntries(cases.map(c => [c.family, c.id.startsWith('tr-') ? 'train' : c.id.startsWith('va-') ? 'validation' : 'holdout'] as const)),
    }

    const candidates: TierRouterParams[] = [
      // #0 过严：几乎全部踢给 T2，导致 falseBlocks 爆发
      { maxT0AutoFixFiles: 0, maxT1OneHopFiles: 0, minT2Entrypoints: 1, escalateAfterRetries: 1, requireSharedLocusForT2: false },
      // #1 推荐均衡档：T1 容忍 <=2 文件，>=2 入口且有共因或重试 >=2 升 T2
      DEFAULT_TIER_ROUTER_PARAMS,
      // #2 过宽：几乎全部放行给 T1，导致 misses 漏防过拟合
      { maxT0AutoFixFiles: 4, maxT1OneHopFiles: 5, minT2Entrypoints: 5, escalateAfterRetries: 5, requireSharedLocusForT2: true },
    ]
    const baselineAllFast: TierRouterParams = { maxT0AutoFixFiles: 5, maxT1OneHopFiles: 5, minT2Entrypoints: 5, escalateAfterRetries: 5, requireSharedLocusForT2: true }

    const sweep = await compareParamCandidates(p => buildTierEscalationGate(p), candidates, split, {
      baseline: baselineAllFast,
      maxFalseBlocks: 0,
      maxMisses: 0,
    })
    expect(sweep.proposalOnly).toBe(true)
    expect(sweep.holdoutOpened).toBe(false)
    expect(sweep.candidates[0]!.guardrailPassed).toBe(false)
    expect(sweep.candidates[2]!.guardrailPassed).toBe(false)
    expect(sweep.recommended?.index).toBe(1)
    expect(sweep.paretoFrontier.map(c => c.index)).toEqual([1])

    const holdout = await evaluateSealedHoldout({
      baselineGate: buildTierEscalationGate(baselineAllFast),
      candidateGate: buildTierEscalationGate(sweep.recommended!.params),
      split,
      candidateId: 'tier-router-sweep-v1',
    })
    expect(holdout.promoted).toBe(true)
    expect(holdout.holdoutCI.verdict).toBe('improved')

    expect(bootstrapDeltaCI([1, -1, 0, 1, -1, 0]).verdict).toBe('unmeasured')
    expect(splitByFamily(cases, { train: 0.5, validation: 0.25, holdout: 0.25 }, 7).train.length).toBeGreaterThan(0)
  })

  it('线上工作台 readRsiStudioView 默认以 e2e 模式输出去噪前筛分档，patrol 过滤保现场噪声', async () => {
    const [{ GovernanceRuntime }, { readRsiStudioView }, { runStandingOrderPatrol }, { Store }] = await Promise.all([
      import('../src/app/governance.ts'), import('../src/app/governance-ops.ts'),
      import('../src/app/governance-patrol.ts'), import('../src/app/store.ts'),
    ])
    const dir = mkTmp('dsh-p7-gov-wb-'), repoDir = join(dir, 'repo')
    mkdirSync(join(repoDir, 'src'), { recursive: true })
    writeFileSync(join(repoDir, 'src/slug.mjs'), 'export const s = x => x\n')
    writeFileSync(join(repoDir, 'src/a.mjs'), "import { s } from './slug.mjs'\nexport const a = s\n")
    writeFileSync(join(repoDir, 'src/b.mjs'), "import { s } from './slug.mjs'\nexport const b = s\n")
    const store = new Store(join(dir, 'state.sqlite'))
    store.saveSettings({ ...store.settings(), workspaces: [{ id: 'app', repository: repoDir, baseBranch: 'main', branchPrefix: 't/', isolation: 'I2' }] })
    const gov = new GovernanceRuntime({ store, stateDir: dir, now: () => new Date('2026-11-27T10:00:00Z') })
    await gov.recover()
    for (const [id, p] of [['t1', 'src/a.mjs'], ['t2', 'src/b.mjs']] as const) gov.appender.append({
      id: `vr-${id}`, at: '2026-11-27T10:01:00Z', stream: `ticket:${id}`, type: 'gate.evaluated', source: { kind: 'system', ref: 't' }, evidence: [], taint: 'trusted',
      payload: { ticketId: id, workspace: 'app', point: 'verify.rerun', verdict: { kind: 'deny', blockers: ['fail'] }, declaredPaths: [p] },
    })
    gov.appender.append({
      id: 'gc-noise', at: '2026-11-27T10:02:00Z', stream: 'ticket:t1', type: 'gate.evaluated', source: { kind: 'system', ref: 't' }, evidence: [], taint: 'trusted',
      payload: { ticketId: 't1', workspace: 'app', point: 'workspace.gc', verdict: { kind: 'deny', blockers: ['dirty'] }, plan: { kind: 'keep' } },
    })
    await gov.flush()
    const wbE2E = await readRsiStudioView(gov)
    expect(wbE2E.collectionMode).toBe('e2e')
    expect(wbE2E.routedClusters?.some(r => r.cluster.key === 'code-locus:app:src/slug.mjs' && r.decision.tier === 'T2_heavy_causal')).toBe(true)
    expect(wbE2E.routedClusters?.some(r => r.cluster.point === 'workspace.gc')).toBe(false)
    expect(wbE2E.snapshot.candidateDrafts.some(d => d.id === 'friction.code-locus-app-src-slug.mjs')).toBe(true)
    const wbProd = await readRsiStudioView(gov, undefined, { collectionMode: 'production' })
    expect(wbProd.snapshot.candidateDrafts.some(d => d.id === 'friction.code-locus-app-src-slug.mjs')).toBe(false)
    await runStandingOrderPatrol(gov)
    await gov.shutdown(); store.close()
  })
})
