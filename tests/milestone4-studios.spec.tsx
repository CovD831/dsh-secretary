// @vitest-environment jsdom
// Milestone 4 verification: incremental shard cache, secretary console, three governance studios, and multi-workspace/approval settings.
import { appendFileSync, mkdtempSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { getProjectionShardCacheStats, readDepositsProjection, readSpineProjection } from '../src/projection/index.ts'
import { all, click, field, find, mount, tab, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('reuses unchanged M0 shards, reads appended lines incrementally by byte offset, and rereads on rewrite/replace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm4-shard-cache-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const m0 = join(dir, 'memory', 'm0')
  mkdirSync(m0, { recursive: true })
  const shard = join(m0, '2026-11-26.jsonl')
  const ev = (seq: number, payload: Record<string, unknown>) => JSON.stringify({
    v: 1, seq, id: `ev-${seq}`, at: '2026-11-26T00:00:00Z', stream: 'ticket:t1',
    type: 'gate.evaluated', source: { kind: 'system', ref: 'test' }, evidence: [], taint: 'trusted', payload,
  })

  writeFileSync(shard, `${ev(1, { ticketId: 't1', point: 'verify.changed-paths', verdict: { kind: 'allow' } })}\n`, 'utf8')
  const s0 = getProjectionShardCacheStats()
  const p1 = await readSpineProjection(undefined, dir)
  const s1 = getProjectionShardCacheStats()
  expect(p1.items.map(i => i.seq)).toEqual([1])
  expect(s1.misses).toBe(s0.misses + 1)

  const dep = await readDepositsProjection(undefined, dir)
  const s2 = getProjectionShardCacheStats()
  expect(dep.totalTriggers).toBeGreaterThanOrEqual(1)
  expect(s2.hits).toBe(s1.hits + 1)
  expect(s2.misses).toBe(s1.misses)

  appendFileSync(shard, `${ev(2, { ticketId: 't1', note: '中文增量尾部' })}\n{"v":1,"seq":999,"id":"torn`, 'utf8')
  const p2 = await readSpineProjection(undefined, dir)
  const s3 = getProjectionShardCacheStats()
  expect(p2.items.map(i => i.seq)).toEqual([1, 2])
  expect(s3.incrementalHits).toBe(s2.incrementalHits + 1)
  expect(s3.misses).toBe(s2.misses)

  // In-place O_TRUNC rewrite with strictly larger size (>515B) and a trailing line: tailSig mismatch must force full reread.
  const largerRewrite = `${ev(20, { ticketId: 't1', padding: 'x'.repeat(420) })}\n${ev(21, { ticketId: 't1' })}\n`
  expect(Buffer.byteLength(largerRewrite, 'utf8')).toBeGreaterThan(statSync(shard).size)
  writeFileSync(shard, largerRewrite, 'utf8')
  const aligned = new Date(1764115200000)
  utimesSync(shard, aligned, aligned)
  const p3 = await readSpineProjection(undefined, dir)
  const s4 = getProjectionShardCacheStats()
  expect(p3.items.map(i => i.seq)).toEqual([20, 21])
  expect(s4.misses).toBe(s3.misses + 1)

  // Atomic rename replacement with identical size AND identical mtime (only new inode differs): ino mismatch must force full reread.
  const beforeStat = statSync(shard)
  const base30 = `${ev(30, { ticketId: 't1', padding: '' })}\n`
  const padLen = beforeStat.size - Buffer.byteLength(base30, 'utf8')
  expect(padLen).toBeGreaterThan(0)
  const content30 = `${ev(30, { ticketId: 't1', padding: 'y'.repeat(padLen) })}\n`
  expect(Buffer.byteLength(content30, 'utf8')).toBe(beforeStat.size)
  const tmpShard = join(m0, 'tmp-replace.jsonl')
  writeFileSync(tmpShard, content30, 'utf8')
  utimesSync(tmpShard, aligned, aligned)
  renameSync(tmpShard, shard)
  const p4 = await readSpineProjection(undefined, dir)
  const s5 = getProjectionShardCacheStats()
  expect(p4.items.map(i => i.seq)).toEqual([30])
  expect(s5.misses).toBe(s4.misses + 1)
})

it('sends desktop secretary messages, decides single-item ruling with optionId & attribution, and opens L3 worker session', async () => {
  const ruling = {
    id: 'rul-1', kind: 'dsh_approval' as const, status: 'pending' as const, createdAt: '2026-11-26T01:00:00Z',
    question: 'worker 请求执行越界写操作，是否放行？', ticketId: 't-disp', toolName: 'write',
    options: [
      { id: 'opt-allow', label: '特批放行一次', consequence: '继续当前工具调用', recommended: false },
      { id: 'opt-deny', label: '拦截并改方案', consequence: '要求改用白名单目录', recommended: true },
    ],
    allowFreeText: true,
  }
  server.rulings = { active: ruling, pendingCount: 1, items: [ruling] }
  server.secretaryFeed = {
    activeRuling: ruling, pendingCount: 1,
    items: [
      { id: 's1', at: '2026-11-26T00:01:00Z', role: 'secretary', kind: 'say', text: '收到任务，正在核对。', expression: 'working' },
      { id: 's2', at: '2026-11-26T00:02:00Z', role: 'secretary', kind: 'handover', text: 'handover',
        handover: { conclusion: '已完成前序排查', reason: '定位到关键约束', impact: '无破坏性副作用', evidenceRefs: ['m0:1#ev-1'] } },
      { id: 's3', at: '2026-11-26T00:03:00Z', role: 'secretary', kind: 'dispatch', text: '已派发工单 t-disp', ticketId: 't-disp' },
    ],
  }
  server.projectionState = {
    avatar: {
      posture: 'raising_hand', zone: 'secretary_counter', shift: 'day', paused: false, workingCount: 1,
      deviation: null, bark: { code: 'BARK_M6_RULING', textZh: '有一件待您拍板', textEn: '1 ruling waiting', sourceRef: { seq: 5, id: 'ev-5' } },
      counts: { failed: 0, blocked: 0, personWaiting: 0, working: 1, pendingConflicts: 0, pendingRulings: 1, pendingVerifications: 0 },
    },
    schedule: [{ id: 'sch-1', kind: 'ruling_queue', window: '09:00', titleZh: '待裁队列', titleEn: 'Rulings', status: 'active', count: 1, sourceRefs: [] }],
    updatedAt: '2026-11-26T01:00:00Z',
  }

  await mount()
  await click(tab(zh['tab.secretary']))
  expect(text()).toContain('已完成前序排查')
  expect(text()).toContain('m0:1#ev-1')
  expect(text()).toContain('有一件待您拍板 (#5)')

  await type(field<HTMLInputElement>(zh['sec.inputTitle']), '请核查构建结果')
  await click(zh['sec.send'])
  expect(server.requests.find(r => r.path === 'secretary/messages' && r.method === 'POST')?.body).toEqual({ text: '请核查构建结果' })

  await click(all('.dt-option').find(btn => btn.textContent?.includes('特批放行一次'))!)
  await type(field<HTMLSelectElement>(zh['sec.attribution']), 'wrong_rule')
  await type(field<HTMLInputElement>(zh['sec.note']), '已确认路径安全')
  await click(zh['sec.approve'])

  const decideReq = server.requests.find(r => r.path === 'rulings/rul-1/decide' && r.method === 'POST')
  expect(decideReq?.body).toMatchObject({ decision: 'approve', optionId: 'opt-allow', attribution: 'wrong_rule', note: '已确认路径安全' })

  await click(zh['sec.openWorker'])
  expect(server.opened).toContain('worker-t-disp')
})

it('transitions deposit stages in Deposits studio and writes direct m2/m3 memory + approves quote patch in Memory studio', async () => {
  server.depositsLedger = {
    markdown: '# Deposits Ledger\n- verify.changed-paths',
    records: [
      { id: 'verify.changed-paths', dirName: 'changed-paths', packageDir: '/p/1', kind: 'gate', point: 'verify.changed-paths', stage: 'shadow', enforce: false, trust: 'owner', casesCount: 4, status: 'registered' },
      { id: 'counter.seen3', dirName: 'seen3', packageDir: '/p/2', kind: 'counter-rule', point: 'verify.preflight', stage: 'shadow', enforce: false, trust: 'owner', casesCount: 2, status: 'registered' },
    ],
  }
  server.memoryStudio = {
    entries: [{
      relPath: 'm3/ws-1/notes.md', layer: 'm3', revision: 1,
      entry: { id: 'mem-m3-row1', statement: 'ws-1 历史测试规则', scope: 'workspace:ws-1', sourceType: 'session', sourceRef: { seq: 5, id: 'ev-5' }, observedAt: '2026-11-26T00:00:00Z', validFrom: '2026-11-26T00:00:00Z', confidence: 'stated', author: 'secretary', taint: 'clean', clearance: 'workspace' },
    }],
    pendingPatches: [{
      layer: 'm3', workspaceKey: 'ws-1', statement: '发布前先跑 pnpm check', scope: 'workspace:ws-1',
      sourceType: 'session', sourceRef: { seq: 8, id: 'ev-8' }, author: 'consolidator',
      verbatimQuote: 'run pnpm check before release', expectedRevision: 1, targetRelPath: 'm3/ws-1.md',
    }],
    metrics: { repeatQuestionRate: 0.1, falseRecallCount: 1, weeklyCorrectedMemories: 2, totalQuestions: 10, repeatQuestions: 1, windowDays: 7 },
  }

  await mount()
  await click(tab(zh['tab.studios']))
  expect(text()).toContain('verify.changed-paths')
  const counterCard = all('.dt-card').find(c => c.textContent?.includes('counter.seen3'))!
  expect((counterCard.querySelectorAll('button').item(2) as HTMLButtonElement).disabled).toBe(true)

  const gateCard = all('.dt-card').find(c => c.textContent?.includes('verify.changed-paths'))!
  await click([...gateCard.querySelectorAll('button')].find(b => b.textContent === 'observe')!)
  expect(server.requests.find(r => r.path === 'deposits/verify.changed-paths/stage' && r.method === 'POST')?.body).toEqual({ toStage: 'observe' })

  await click(tab(zh['studio.memory']))
  expect(text()).toContain('run pnpm check before release')
  expect([...field<HTMLSelectElement>(zh['studio.mem.layer']).options].map(o => o.value)).toEqual(['m2', 'm1', 'm3'])

  await type(field<HTMLSelectElement>(zh['studio.mem.layer']), 'm3')
  await type(field<HTMLInputElement>(zh['studio.mem.workspaceKey']), 'app-ws')
  await type(field<HTMLInputElement>(zh['studio.mem.topicKey']), 'Build Rule')
  await type(field<HTMLInputElement>(zh['studio.mem.statement']), '所有提交必须带测试实证')
  await click(zh['studio.mem.submitDirect'])
  expect(server.requests.find(r => r.path === 'memory/direct' && r.method === 'POST')?.body).toMatchObject({
    layer: 'm3', workspaceKey: 'app-ws', slug: 'build-rule', statement: '所有提交必须带测试实证', topicKey: 'Build Rule',
  })

  await click(zh['studio.mem.approvePatch'])
  expect(server.requests.find(r => r.path === 'memory/patches/0' && r.method === 'POST')?.body).toEqual({ decision: 'approve' })

  await click(zh['studio.mem.tombstoneBtn'])
  expect(server.requests.find(r => r.path === 'memory/entries/mem-m3-row1/tombstone' && r.method === 'POST')).toBeDefined()

  await click(zh['studio.mem.dreamRunNow'])
  expect(server.requests.find(r => r.path === 'memory/dream' && r.method === 'POST')).toBeDefined()
})

it('renders RSI workbench, triggers LOO ablation + F1 pixel proof preview, and saves approvalMode/breakers/workspaces settings', async () => {
  server.ablationResult = {
    baseline: { totalCases: 2, caseIds: ['ab-1', 'ab-2'], triggeredCount: 1, catches: 1, falseBlocks: 0, misses: 0, trueAllows: 1, unmeasuredCount: 0, unknownLabelCount: 0, coverageDiscount: 1, netBenefit: 1, marginalCost: { deltaTokens: undefined, deltaMs: undefined, state: 'unmeasured' }, cases: [] },
    impacts: [{ gateId: 'verify.changed-paths', stage: 'enforce', evaluations: 2, uniqueCatches: 1, ablatedReport: { totalCases: 2, caseIds: [], triggeredCount: 0, catches: 0, falseBlocks: 0, misses: 1, trueAllows: 1, unmeasuredCount: 0, unknownLabelCount: 0, coverageDiscount: 1, netBenefit: 0, marginalCost: { deltaTokens: undefined, deltaMs: undefined, state: 'unmeasured' }, cases: [] }, deltaBenefit: -1, deltaFalseBlocks: 0, savedTokens: 40, savedMs: 2, redundant: false, harmful: false }],
    redundantGateIds: ['gate.redundant'], harmfulGateIds: [], conflicts: [],
  }
  server.pixelProof = { workspaceId: 'secretary-main', seed: 20261126, width: 1440, height: 900, paletteColors: 46, html: '<html><body>F1 Proof</body></html>' }

  await mount()
  await click(tab(zh['tab.studios']))
  await click(tab(zh['studio.rsi']))
  const iframe = document.querySelector<HTMLIFrameElement>('iframe.dt-pixel-frame')!
  expect(iframe.getAttribute('srcdoc')).toContain('F1 Proof')
  await click(zh['studio.rsi.runAblation'])
  const abReq = server.requests.find(r => r.path === 'rsi/ablation' && r.method === 'POST')?.body as { cases: { input: { sessionDiffs?: string[]; gitDirtyPaths?: string[] } }[] }
  expect(abReq.cases[0]?.input.sessionDiffs).toEqual(['.env'])
  expect(abReq.cases[0]?.input.gitDirtyPaths).toEqual(['.env'])
  expect(text()).toContain('gate.redundant')

  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.execution'], '.dt-settings-link'))
  await type(field<HTMLSelectElement>(zh.approvalMode), 'smart-auto')
  await type(field<HTMLInputElement>(zh.breakerTurns), '25')
  await type(field<HTMLInputElement>(zh.breakerStallTurns), '4')
  await type(field<HTMLInputElement>(zh.breakerTokens), '150000')
  await click(zh.save)
  expect(server.settings.executor).toMatchObject({ approvalMode: 'smart-auto', maxTurns: 25, maxStallTurns: 4, maxTokens: 150000 })

  await click(find(zh['settingsGroup.workspaces'], '.dt-settings-link'))
  await click(zh['ws.add'])
  await type(field<HTMLInputElement>(zh['ws.id']), 'web-app')
  await type(field<HTMLInputElement>(zh['ws.repository']), '/srv/repos/web-app')
  await type(field<HTMLSelectElement>(zh['ws.isolation']), 'I3')
  await type(field<HTMLSelectElement>(zh['ws.approvalMode']), 'smart-auto')
  await type(field<HTMLInputElement>(zh['ws.cowPaths']), 'node_modules .next')
  await type(field<HTMLTextAreaElement>(zh['ws.verifyCommands']), 'pnpm typecheck\npnpm test')
  await click(zh.save)
  expect(server.settings.workspaces).toEqual([{
    id: 'web-app', repository: '/srv/repos/web-app', baseBranch: 'main', branchPrefix: 'agent/',
    isolation: 'I3', approvalMode: 'smart-auto', cowPaths: ['node_modules', '.next'], verifyCommands: ['pnpm typecheck', 'pnpm test'],
  }])
})
