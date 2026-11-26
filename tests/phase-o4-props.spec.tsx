// @vitest-environment jsdom
// Phase O4 verification: 4 diegetic governance prop modals (ledger, notebook, corkboard, cabinet) with mocked fetch.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PropsDrawer, type GovernancePropKind } from '../src/office-app/props-drawer.tsx'
import { FROZEN_PALETTE } from '../src/pixel-office/palette.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface RecordedReq { method: string; path: string; body?: unknown }
let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  container?.remove()
  container = undefined
  vi.unstubAllGlobals()
})

function setupFetch(routes: Record<string, (body?: unknown) => unknown>) {
  const requests: RecordedReq[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const path = url.replace('/orchestrator/api/', '').split('?')[0]!
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, path, body })
    const key = `${method} ${path}`
    const handler = routes[key]
    if (!handler) throw new Error(`Unmocked route: ${key}`)
    const data = handler(body)
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return requests
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}

async function mountProp(activeProp: GovernancePropKind, onChanged = vi.fn()) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(<PropsDrawer activeProp={activeProp} onClose={vi.fn()} onChanged={onChanged} />) })
  await flush()
  return onChanged
}

function setField(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

const byLabel = <T extends HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`)!
const byText = (text: string, sel = 'button') => [...document.querySelectorAll<HTMLElement>(sel)].find(el => el.textContent?.includes(text))!

describe('Phase O4: 4 Diegetic Governance Prop Modals', () => {
  it('renders ledger prop, locks counter-rule enforce (D5), and transitions regular deposit stage', async () => {
    const reqs = setupFetch({
      'GET projection/deposits': () => ({
        total: 2, admittedCount: 2, totalTriggers: 10, allowCount: 7, denyCount: 2, unmeasuredCount: 1,
        items: [
          { id: 'gate-safe', dirName: 'gate-safe', source: 'builtin', admitted: true, kind: 'gate', point: 'verify.changed-paths', stage: 'observe', enforce: true, casesCount: 4, stats: { triggers: 8, allow: 6, deny: 2, unmeasured: 0 } },
          { id: 'anti-skip', dirName: 'anti-skip', source: 'state', admitted: true, kind: 'counter-rule', point: 'verify.rerun', stage: 'shadow', enforce: false, casesCount: 2, stats: { triggers: 2, allow: 1, deny: 0, unmeasured: 1 } },
        ],
      }),
      'GET deposits/ledger': () => ({ records: [], markdown: '# LEDGER\n- gate-safe (observe)' }),
      'POST deposits/gate-safe/stage': () => ({ ok: true, id: 'gate-safe', fromStage: 'observe', toStage: 'enforce' }),
    })
    const onChanged = await mountProp('ledger')
    expect(document.body.textContent).toContain('D5 宪法禁升强制')
    const enforceBtns = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent === 'enforce')
    expect(enforceBtns[0]!.disabled).toBe(false)
    expect(enforceBtns[1]!.disabled).toBe(true)

    await act(async () => { enforceBtns[0]!.click() })
    await flush()
    expect(reqs.find(r => r.path === 'deposits/gate-safe/stage' && r.method === 'POST')?.body).toEqual({ toStage: 'enforce' })
    expect(onChanged).toHaveBeenCalledTimes(1)

    await act(async () => { byText('展开 LEDGER.md 原文卷轴').click() })
    expect(document.body.textContent).toContain('# LEDGER')
  })

  it('renders notebook prop, writes m3 direct memory with normalized slug, and approves patch 0', async () => {
    const reqs = setupFetch({
      'GET memory/studio': () => ({
        metrics: { repeatQuestionRate: 0.1, repeatQuestions: 1, totalQuestions: 10, falseRecallCount: 0, weeklyCorrectedMemories: 2, windowDays: 7 },
        entries: [{ relPath: 'm2/pref.md', layer: 'm2', revision: 1, entry: { id: 'e1', statement: '使用中文回复', scope: 'global', sourceRef: { seq: 3, id: 'ev-3' } } }],
        pendingPatches: [{ layer: 'm2', targetRelPath: 'm2/notes.md', statement: '禁止直接改主干', verbatimQuote: '老板原话：别直接改 main', sourceRef: { seq: 8, id: 'ev-8' } }],
      }),
      'GET projection/notebook': () => ({
        exists: true, revision: 1, updatedAt: null,
        counts: { total: 1, pending: 1, asked: 0, resolved: 0, conflicts: 0, rulings: 0, verifications: 0, depositProposals: 0, dueReminders: 1 },
        groups: { pending: [{ id: 'nb-1', kind: 'conflict', status: 'pending', question: '确认合并窗口', due: true, sourceRefs: [], updatedAt: '2026-11-26T00:00:00Z', cooldownExpired: false }], asked: [], resolved: [] },
      }),
      'POST memory/direct': () => ({ writeResult: { kind: 'accepted', revision: 1, detail: 'ok' }, sourceRef: { seq: 11, id: 'ev-11' } }),
      'POST memory/patches/0': () => ({ ok: true }),
    })
    const onChanged = await mountProp('notebook')
    const layerOpts = [...byLabel<HTMLSelectElement>('记忆层级').options].map(o => o.value)
    expect(layerOpts).toEqual(['m2', 'm1', 'm3'])

    await act(async () => {
      setField(byLabel<HTMLSelectElement>('记忆层级'), 'm3')
      setField(byLabel<HTMLInputElement>('工作区键'), 'Repo Alpha!')
      setField(byLabel<HTMLInputElement>('条目标识'), 'Build_Rule 01')
      setField(byLabel<HTMLTextAreaElement>('批注内容'), '测试必须指定临时 DSH_HOME')
    })
    await act(async () => { byText('落笔归档').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    const direct = reqs.find(r => r.path === 'memory/direct' && r.method === 'POST')?.body as Record<string, unknown>
    expect(direct.layer).toBe('m3')
    expect(String(direct.slug)).toMatch(/^[a-z0-9][a-z0-9_-]*$/)
    expect(String(direct.workspaceKey)).toMatch(/^[a-z0-9][a-z0-9_-]*$/)

    await act(async () => { byText('准入归档').click() })
    await flush()
    expect(reqs.find(r => r.path === 'memory/patches/0' && r.method === 'POST')?.body).toEqual({ decision: 'approve' })
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it('renders corkboard prop, runs LOO ablation with sessionDiffs, and opens sealed holdout', async () => {
    const reqs = setupFetch({
      'GET rsi/workbench': () => ({
        snapshot: {
          eventCount: 12,
          labelCounts: { L1_policy_block: 3, L7_unmeasured: 2 },
          attribution: { totalTickets: 5, totalToolExecutions: 20, counts: { missing_rule: 1, wrong_rule: 0, unmeasurable: 2, rule_conflict: 0 }, ratePerTicket: { missing_rule: 0.2 }, ratePerToolExecution: { unmeasurable: 0.1 } },
          candidateDrafts: [{ id: 'cand-1', point: 'verify.changed-paths', intent: '拦截 .env 越界修改', stage: 'shadow' }],
        },
        scaler: { fitted: true, temperature: 1.12, bias: -0.05, sampleCount: 20, lossBefore: 0.52, lossAfter: 0.41 },
        calibratedRecords: [],
        calibration: { state: 'measured', ece: 0.0412, bins: [{ binIndex: 0, lower: 0, upper: 0.5, count: 10, avgConfidence: 0.3, empiricalRate: 0.3 }] },
        openedHoldouts: {},
      }),
      'POST rsi/ablation': () => ({ baseline: { totalCases: 2, catches: 1, netBenefit: 0.8 }, redundantGateIds: [], harmfulGateIds: [], impacts: [] }),
      'POST rsi/holdout': () => ({ ok: true, result: { verdict: 'pass', promoted: true, reason: 'holdout green' } }),
    })
    const onChanged = await mountProp('corkboard')
    await act(async () => { byText('运行全注册表消融 (LOO)').click() })
    await flush()
    const abBody = reqs.find(r => r.path === 'rsi/ablation')?.body as { cases: { input: { sessionDiffs: string[] } }[] }
    expect(abBody.cases[0]!.input.sessionDiffs).toEqual(['.env'])

    await act(async () => { byText('开封密封 Holdout 验证').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(reqs.find(r => r.path === 'rsi/holdout')?.body).toMatchObject({ candidateId: 'candidate-v1', point: 'verify.changed-paths' })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('renders cabinet prop across 3 drawers, saves workspaces/executor, selects & generates avatars with zero file inputs', async () => {
    const reqs = setupFetch({
      'GET settings': () => ({
        policyVersion: 'v1',
        blocks: {
          policy: { value: {}, revision: 1 },
          eval: { value: {}, revision: 1 },
          executor: { value: { model: null, maxWorkers: 3, directory: '', prepare: '', blockedCommands: [], approvalMode: 'smart-auto', maxTurns: 20 }, revision: 4 },
          workspaces: { value: [{ id: 'main', repository: '/srv/repo', baseBranch: 'main', branchPrefix: 'agent/', isolation: 'I2' }], revision: 2 },
        },
        sources: [],
        environment: { root: '/tmp/work', variables: [] },
      }),
      'GET models': () => ({ default: { provider: 'deepseek', model: 'deepseek-chat' }, groups: [{ id: 'deepseek', name: 'DeepSeek', models: [] }] }),
      'GET avatars': () => ({ activeId: 'preset-walnut-01', items: [{ id: 'preset-walnut-01', name: '胡桃木默认', source: 'preset', createdAt: '2026-11-26', portraitUrls: { neutral: '/a.png', working: '/b.png', happy: '/c.png', concerned: '/d.png' }, quantized: true, outOfPaletteCount: 0, statusPixels: 0, semiTransparentCount: 0 }] }),
      'GET projection/state': () => ({ avatar: { posture: 'patrol_idle', zone: 'secretary_counter', shift: 'day', paused: false, workingCount: 0, deviation: null, bark: null, counts: { failed: 0, blocked: 0, personWaiting: 0, working: 0, pendingConflicts: 0, pendingRulings: 0, pendingVerifications: 0 } }, schedule: [], updatedAt: '2026-11-26' }),
      'PUT settings/workspaces': () => ({ revision: 3, restarting: false }),
      'PUT settings/executor': () => ({ revision: 5, restarting: false }),
      'POST executor/pause': () => ({ paused: true }),
      'POST avatars/select': () => ({ ok: true, activeId: 'preset-walnut-01' }),
      'POST avatars/generate': () => ({ ok: true, pack: { id: 'ai-1', name: '夜班秘书', source: 'ai', provider: 'local-remix', createdAt: '2026-11-26', portraitUrls: { neutral: '/n.png', working: '/w.png', happy: '/h.png', concerned: '/c.png' }, quantized: true, outOfPaletteCount: 0, statusPixels: 0, semiTransparentCount: 0 } }),
    })
    const onChanged = await mountProp('cabinet')
    expect(document.querySelector('input[type="file"]')).toBeNull()

    await act(async () => { byText('保存工作区档案').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(reqs.find(r => r.path === 'settings/workspaces' && r.method === 'PUT')?.body).toMatchObject({ revision: 2 })

    await act(async () => { byText('沙箱审批与熔断锁').click() })
    await act(async () => { byText('保存沙箱与熔断配置').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(reqs.find(r => r.path === 'settings/executor' && r.method === 'PUT')?.body).toMatchObject({ revision: 4 })

    await act(async () => { byText('暂停执行器').click() })
    await flush()
    expect(reqs.find(r => r.path === 'executor/pause')?.body).toEqual({ paused: true })

    await act(async () => { byText('秘书形象定制').click() })
    expect(document.querySelector('input[type="file"]')).toBeNull()
    await act(async () => {
      setField(byLabel<HTMLInputElement>('形象名称'), '夜班秘书')
      setField(byLabel<HTMLInputElement>('外观描述词'), '深色马甲戴圆框眼镜')
    })
    await act(async () => { byText('生成并量化入库').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(reqs.find(r => r.path === 'avatars/generate')?.body).toEqual({ name: '夜班秘书', prompt: '深色马甲戴圆框眼镜' })
    expect(document.body.textContent).toContain('已生成并量化入库：夜班秘书')
    expect(document.body.textContent).toContain('预置')
    expect(onChanged).toHaveBeenCalledTimes(4)
  })

  it('enforces 46-color FROZEN_PALETTE compliance across all office-app UI components', () => {
    const allowed = new Set(FROZEN_PALETTE.map(e => e.hex.toUpperCase()))
    const uiFiles = [
      'office-api.tsx', 'ui-skin.tsx', 'game-hud.tsx', 'npc-dialog.tsx',
      'prop-ledger.tsx', 'prop-notebook.tsx', 'prop-corkboard.tsx', 'prop-cabinet.tsx',
      'worker-drawer.tsx', 'handover-sheet.tsx',
    ]
    for (const file of uiFiles) {
      const src = readFileSync(resolve(process.cwd(), 'src/office-app', file), 'utf8')
      const hexes = [...src.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map(m => m[0].toUpperCase())
      const invalid = hexes.filter(h => !allowed.has(h))
      expect(invalid, `${file} contains out-of-palette hex colors`).toEqual([])
    }
  })
})
