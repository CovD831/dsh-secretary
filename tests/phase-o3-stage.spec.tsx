// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StageApp } from '../src/office-app/stage-app.tsx'
import { createInitialActors, isoToScreen } from '../src/office-app/iso-engine.ts'
import { solveOfficeLayout } from '../src/office-app/layout-solver.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface RecordedCall { method: string; path: string; body?: unknown }

class MockEventSource {
  static instances: MockEventSource[] = []
  onerror: (() => void) | null = null
  private readonly listeners = new Map<string, ((ev: MessageEvent) => void)[]>()
  constructor(public readonly url: string) { MockEventSource.instances.push(this) }
  addEventListener(name: string, fn: (ev: MessageEvent) => void) {
    const list = this.listeners.get(name) ?? []
    list.push(fn)
    this.listeners.set(name, list)
  }
  emit(name: string, data: unknown) {
    const ev = { data: JSON.stringify(data) } as MessageEvent
    for (const fn of this.listeners.get(name) ?? []) fn(ev)
  }
  close() {}
}

function setInputValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

function byText(text: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('button, span, strong, p, div, option')].find(el => el.textContent?.trim() === text)
}

async function waitText(text: string): Promise<HTMLElement> {
  let found: HTMLElement | undefined
  await vi.waitFor(() => {
    found = byText(text)
    expect(found).toBeTruthy()
  })
  return found!
}

describe('Phase O3 Pixel Office Stage', () => {
  const calls: RecordedCall[] = []
  let activeRuling: Record<string, unknown> | null = null
  let pendingCount = 0
  let spineItems: Record<string, unknown>[] = []
  let root: Root | undefined
  let container: HTMLElement | undefined

  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
      removeItem: (k: string) => { store.delete(k) },
      clear: () => { store.clear() },
    })
    localStorage.clear()
    calls.length = 0
    MockEventSource.instances = []
    activeRuling = null
    pendingCount = 0
    spineItems = []
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    vi.stubGlobal('EventSource', MockEventSource)
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      set src(_v: string) { queueMicrotask(() => this.onload?.()) }
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      imageSmoothingEnabled: false, clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
      fillText: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext)

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^\/orchestrator\/api\//, '').split('?')[0]!
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, path, body })

      if (path === 'secretary/feed') {
        return new Response(JSON.stringify({
          items: [
            { id: 'f1', at: '2026-11-26T08:00:00Z', role: 'secretary', kind: 'say', text: '早安，老板。', expression: 'happy' },
            {
              id: 'f2', at: '2026-11-26T08:05:00Z', role: 'secretary', kind: 'handover', text: '已整理交接公文。',
              handover: { conclusion: '已完成 PR #42 预检', reason: '单测全绿且无密钥泄漏', impact: '可安全合并主干', evidenceRefs: ['seq:2', 'dom:ticket.ended:real', 'issue-1', 'seq:99'] },
            },
          ],
          activeRuling, pendingCount,
        }), { status: 200 })
      }
      if (path === 'tickets') {
        return new Response(JSON.stringify({
          items: [{
            id: 't-101', title: '修复支付回调幂等', state: 'open', stage: 'working', action: 'running',
            actions: { retry: false, stop: true }, strength: 'high', assignments: 1, inputs: 1, undelivered: 0,
            sessionId: 'worker-t-101', summary: '正在补齐单测', createdAt: '2026-11-26T08:00:00Z', updatedAt: '2026-11-26T08:02:00Z', threads: [],
          }],
          next_offset: null,
        }), { status: 200 })
      }
      if (path === 'tickets/t-101/transcript') {
        return new Response(JSON.stringify({
          ticketId: 't-101', sessionId: 'worker-t-101', headSeq: 12, truncated: false,
          entries: [
            { id: 'e1', at: '2026-11-26T08:01:00Z', kind: 'tool_call', summary: '运行 vitest 幂等校验' },
            { id: 'e2', at: '2026-11-26T08:01:10Z', kind: 'gate', summary: 'verify.rerun -> allow', status: 'ok' },
          ],
        }), { status: 200 })
      }
      if (path === 'settings') {
        return new Response(JSON.stringify({
          policyVersion: 'v1',
          blocks: {
            policy: { value: {}, revision: 1 }, eval: { value: {}, revision: 1 }, executor: { value: {}, revision: 1 },
            workspaces: { value: [{ id: 'repo-alpha', repository: '/srv/alpha', baseBranch: 'main', branchPrefix: 'bot/', isolation: 'I3' }], revision: 1 },
          },
          sources: [], environment: { root: '/srv/default', variables: [] },
        }), { status: 200 })
      }
      if (path === 'avatars') {
        return new Response(JSON.stringify({
          activeId: 'preset-walnut-01',
          items: [{
            id: 'preset-walnut-01', name: '胡桃木默认秘书', source: 'preset', createdAt: '2026-11-26T00:00:00Z',
            portraitUrls: {
              neutral: '/assets/f1-proof/portrait_neutral.png',
              working: '/assets/f1-proof/portrait_working.png',
              happy: '/assets/f1-proof/portrait_happy.png',
              concerned: '/assets/f1-proof/portrait_concerned.png',
            },
            quantized: true, outOfPaletteCount: 0, statusPixels: 0, semiTransparentCount: 0,
          }],
        }), { status: 200 })
      }
      if (path === 'projection/spine') {
        const items = [
          { seq: 2, id: 'ev-2', type: 'ticket.updated', taint: 'clean', at: '2026-11-26T08:01:00Z' },
          { seq: 3, id: 'dom:ticket.ended:real', type: 'ticket.ended', taint: 'clean', at: '2026-11-26T08:02:00Z' },
          ...spineItems,
        ]
        return new Response(JSON.stringify({ items, totalMatched: items.length, headSeq: 9, nextSinceSeq: null, hasMore: false }), { status: 200 })
      }
      if (path === 'secretary/messages') return new Response(JSON.stringify({ triggerId: 'trig-1', received: 'stored' }), { status: 200 })
      if (path === 'rulings/r-1/decide' || path === 'rulings/r-2/decide') { activeRuling = null; pendingCount = 0; return new Response(JSON.stringify({ ok: true }), { status: 200 }) }
      return new Response('{}', { status: 200 })
    }))
  })

  afterEach(() => {
    act(() => { root?.unmount() })
    container?.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders stage, sends boss message, switches to concerned on ruling.queued, and decides ruling', async () => {
    await act(async () => { root!.render(<StageApp />) })
    await waitText('已整理交接公文。')
    expect(document.querySelector('canvas[aria-label="像素办公室主舞台"]')).toBeTruthy()
    await act(async () => { byText('历史回看 (2)')!.click() })
    const histEl = document.querySelector<HTMLElement>('[aria-label="对话历史"]')!
    expect(histEl.style.maxHeight).toBe('232px')
    await act(async () => { byText('收起')!.click() })

    const input = document.querySelector<HTMLInputElement>('input[aria-label="向秘书发话"]')!
    await act(async () => { setInputValue(input, '请检查 PR #42') })
    await act(async () => { byText('发送')!.click() })
    await vi.waitFor(() => {
      expect(calls.some(c => c.method === 'POST' && c.path === 'secretary/messages' && (c.body as Record<string, unknown>)['text'] === '请检查 PR #42')).toBe(true)
    })
    expect(document.querySelector('[aria-label="秘书思考中"]')?.textContent).toContain('请检查 PR #42')
    expect(document.querySelector<HTMLImageElement>('img[alt="秘书立绘 (working)"]')).toBeTruthy()

    activeRuling = {
      id: 'r-1', kind: 'dsh_approval', status: 'pending', createdAt: '2026-11-26T08:06:00Z',
      question: '工蜂请求执行 git push --force，是否放行？', toolName: 'run_command', allowFreeText: true,
      options: [
        { id: 'opt-deny', label: '拒绝强推', consequence: '保护远端历史', recommended: true },
        { id: 'opt-allow', label: '仅放行本次', consequence: '允许覆盖分支' },
      ],
    }
    pendingCount = 2
    await act(async () => { MockEventSource.instances[0]!.emit('ruling.queued', { id: 'r-1' }) })

    await waitText('工蜂请求执行 git push --force，是否放行？')
    const dockContainer = byText('门牌簿')!.parentElement!
    expect(dockContainer.style.top).toBe('58px')
    expect(dockContainer.style.bottom).toBe('auto')
    const portrait = document.querySelector<HTMLImageElement>('img[alt="秘书立绘 (concerned)"]')!
    expect(portrait.src).toContain('/assets/f1-proof/portrait_concerned.png')
    expect(byText('待办 2')).toBeTruthy()
    expect(byText('确认拦截')).toBeTruthy()
    expect(byText('批准')).toBeUndefined()
    expect(byText('否决')).toBeUndefined()

    await act(async () => { byText('仅放行本次')!.click() })
    expect(byText('批准')).toBeTruthy()
    expect(byText('否决')).toBeTruthy()
    const sel = document.querySelector<HTMLSelectElement>('select[aria-label="四分类归因"]')!
    await act(async () => { setInputValue(sel, 'wrong_rule') })
    await act(async () => { byText('批准')!.click() })

    await vi.waitFor(() => {
      const decideCall = calls.find(c => c.method === 'POST' && c.path === 'rulings/r-1/decide')
      expect(decideCall).toBeTruthy()
      expect(decideCall!.body).not.toHaveProperty('id')
      expect((decideCall!.body as Record<string, unknown>)['optionId']).toBe('opt-allow')
      expect((decideCall!.body as Record<string, unknown>)['attribution']).toBe('wrong_rule')
    })

    activeRuling = {
      id: 'r-2', kind: 'dsh_approval', status: 'pending', createdAt: '2026-11-26T08:07:00Z',
      question: '工蜂请求写入 .env.staging，是否放行？', toolName: 'write', allowFreeText: true,
      options: [
        { id: 'reject', label: '拒绝并要求改方案', consequence: '拦截高危写入', recommended: true },
        { id: 'approve', label: '放行本次操作', consequence: '允许写一次' },
      ],
    }
    await act(async () => { MockEventSource.instances[0]!.emit('ruling.queued', { id: 'r-2' }) })
    await waitText('确认拦截')
    await act(async () => { byText('确认拦截')!.click() })
    await vi.waitFor(() => {
      const denyCall = calls.find(c => c.method === 'POST' && c.path === 'rulings/r-2/decide')
      expect(denyCall).toBeTruthy()
      expect((denyCall!.body as Record<string, unknown>)['decision']).toBe('reject')
      expect((denyCall!.body as Record<string, unknown>)['optionId']).toBe('reject')
    })

    spineItems = [{ seq: 9, at: new Date().toISOString(), id: 'sp-9', stream: 'gate', type: 'gate.evaluated', payload: { verdict: { kind: 'deny' } } }]
    await act(async () => { MockEventSource.instances[0]!.emit('spine', { seq: 9, id: 'sp-9', type: 'gate.evaluated', stream: 'gate' }) })
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLImageElement>('img[alt="秘书立绘 (concerned)"]')).toBeTruthy()
    })
  })

  it('opens handover sheet, switches workspace via doorplate, and inspects live worker transcript', async () => {
    await act(async () => { root!.render(<StageApp />) })
    const handoverBtn = await waitText('展开三段式公文纸')

    await act(async () => { handoverBtn.click() })
    expect(byText('已完成 PR #42 预检')).toBeTruthy()
    await act(async () => { byText('seq:2')!.click() })
    await waitText('M0 原始信封核验：')
    expect(document.body.textContent).toContain('seq=2 / id=ev-2')

    await act(async () => { byText('dom:ticket.ended:real')!.click() })
    await vi.waitFor(() => { expect(document.body.textContent).toContain('id=dom:ticket.ended:real') })

    await act(async () => { byText('issue-1')!.click() })
    await vi.waitFor(() => { expect(document.body.textContent).toContain('unmeasured') })
    expect(document.body.textContent).not.toContain('M0 原始信封核验：')
    expect(document.body.textContent).not.toContain('ev-2')

    await act(async () => { byText('seq:99')!.click() })
    await vi.waitFor(() => { expect(document.body.textContent).toContain('unmeasured') })
    expect(document.body.textContent).not.toContain('M0 原始信封核验：')
    expect(document.body.textContent).not.toContain('ev-2')
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="关闭器物面板"]')!.click() })

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="查看房间卷宗-default"]')!.click()
    })
    await waitText('运行 vitest 幂等校验')
    expect(calls.some(c => c.method === 'GET' && c.path === 'tickets/t-101/transcript')).toBe(true)
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="关闭器物面板"]')!.click() })

    await act(async () => { byText('门牌簿')!.click() })
    await vi.waitFor(() => { expect(document.querySelector('[role="dialog"]')).toBeTruthy() })
    const wsBtn = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(el => el.textContent?.includes('repo-alpha'))!
    await act(async () => { wsBtn.click() })
    await waitText('repo-alpha')
  })

  it('filters tickets and resident workers by workspaceId when switching doorplate rooms (B3)', async () => {
    const multiTickets = [
      {
        id: 't-default', title: '主室工单', state: 'open', stage: 'working', action: 'running',
        actions: { retry: false, stop: true }, strength: 'high', assignments: 1, inputs: 0, undelivered: 0,
        sessionId: 'worker-t-default', summary: '主室任务', createdAt: '2026-11-26T08:00:00Z', updatedAt: '2026-11-26T08:02:00Z', threads: [],
      },
      {
        id: 't-demo', title: 'Demo 仓库工单', state: 'open', stage: 'working', action: 'running', workspace: 'demo-repo',
        actions: { retry: false, stop: true }, strength: 'high', assignments: 1, inputs: 0, undelivered: 0,
        sessionId: 'worker-t-demo', summary: 'Demo 任务', createdAt: '2026-11-26T08:00:00Z', updatedAt: '2026-11-26T08:02:00Z', threads: [],
      },
    ]
    const origFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^\/orchestrator\/api\//, '').split('?')[0]!
      if (path === 'tickets') return new Response(JSON.stringify({ items: multiTickets, next_offset: null }), { status: 200 })
      if (path === 'tickets/t-default/transcript') {
        return new Response(JSON.stringify({
          ticketId: 't-default', sessionId: 'worker-t-default', headSeq: 1, truncated: false,
          entries: [{ id: 'ed0', at: '2026-11-26T08:01:00Z', kind: 'assistant', summary: '主室终端日志' }],
        }), { status: 200 })
      }
      if (path === 'tickets/t-demo/transcript') {
        return new Response(JSON.stringify({
          ticketId: 't-demo', sessionId: 'worker-t-demo', headSeq: 3, truncated: false,
          entries: [{ id: 'ed1', at: '2026-11-26T08:01:00Z', kind: 'assistant', summary: 'Demo 专属终端日志' }],
        }), { status: 200 })
      }
      if (path === 'settings') {
        return new Response(JSON.stringify({
          policyVersion: 'v1',
          blocks: {
            policy: { value: {}, revision: 1 }, eval: { value: {}, revision: 1 }, executor: { value: {}, revision: 1 },
            workspaces: {
              value: [
                { id: 'demo-repo', repository: '/srv/demo', baseBranch: 'main', branchPrefix: 'bot/', isolation: 'I2' },
                { id: 'empty-repo', repository: '/srv/empty', baseBranch: 'main', branchPrefix: 'bot/', isolation: 'I2' },
              ],
              revision: 1,
            },
          },
          sources: [], environment: { root: '/srv/default', variables: [] },
        }), { status: 200 })
      }
      return origFetch(url, init)
    }))

    await act(async () => { root!.render(<StageApp />) })
    await waitText('已整理交接公文。')

    const openWorker = async (wsId: string) => {
      const btn = document.querySelector<HTMLButtonElement>(`button[aria-label="查看房间卷宗-${wsId}"]`)!
      await act(async () => { btn.click() })
    }

    await openWorker('default')
    await waitText('主室工单')
    expect(byText('Demo 仓库工单')).toBeUndefined()
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="关闭器物面板"]')!.click() })

    await act(async () => { byText('门牌簿')!.click() })
    await vi.waitFor(() => { expect(document.querySelector('[role="dialog"]')).toBeTruthy() })
    const demoBtn = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(el => el.textContent?.includes('demo-repo'))!
    await act(async () => { demoBtn.click() })
    await waitText('demo-repo')

    await openWorker('demo-repo')
    await waitText('Demo 仓库工单')
    await waitText('Demo 专属终端日志')
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="关闭器物面板"]')!.click() })

    await act(async () => { byText('门牌簿')!.click() })
    await vi.waitFor(() => { expect(document.querySelector('[role="dialog"]')).toBeTruthy() })
    const emptyBtn = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(el => el.textContent?.includes('empty-repo'))!
    await act(async () => { emptyBtn.click() })
    await waitText('empty-repo')
    await openWorker('empty-repo')
    await waitText('当前工作区暂无工单。')
  })

  it('renders HUD minimap and multi-room roster in patrol mode, toggles 384x480 portrait and integer zoom', async () => {
    await act(async () => { root!.render(<StageApp />) })
    await waitText('已整理交接公文。')

    expect(document.querySelector('[aria-label="园区小地图"]')).toBeTruthy()
    expect(document.querySelector('button[aria-label="查看房间卷宗-default"]')).toBeTruthy()
    expect(document.querySelector('button[aria-label="查看房间卷宗-repo-alpha"]')).toBeTruthy()
    expect(document.querySelector('img[width="384"]')).toBeNull()

    await act(async () => { byText('展开立绘')!.click() })
    expect(document.querySelector('img[width="384"]')).toBeTruthy()
    expect(document.querySelector('[aria-label="园区小地图"]')).toBeNull()

    await act(async () => { byText('收起巡视')!.click() })
    expect(document.querySelector('img[width="384"]')).toBeNull()
    expect(document.querySelector('[aria-label="园区小地图"]')).toBeTruthy()

    const zoom2Btn = document.querySelector<HTMLButtonElement>('button[aria-label="近景视角"]')!
    const zoom1Btn = document.querySelector<HTMLButtonElement>('button[aria-label="全楼视角"]')!
    await act(async () => { zoom2Btn.click() })
    expect(zoom2Btn.style.background).not.toBe(zoom1Btn.style.background)
    await act(async () => { zoom1Btn.click() })
    expect(zoom1Btn.style.background).not.toBe(zoom2Btn.style.background)

    const seedInput = document.querySelector<HTMLInputElement>('input[aria-label="布局种子编号"]')!
    const seedBtn = document.querySelector<HTMLButtonElement>('button[aria-label="切换布局种子"]')!
    expect(seedInput.value).toBe('1')
    expect(seedBtn.textContent).toBe('随机')
    await act(async () => { setInputValue(seedInput, '42') })
    await act(async () => { seedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(seedInput.value).toBe('42')
    expect(localStorage.getItem('dsh_office_world_seed')).toBe('42')
    await act(async () => { seedBtn.click() })
    const rolled = Number.parseInt(seedInput.value, 10)
    expect(rolled).toBeGreaterThanOrEqual(2)
    expect(rolled).toBeLessThanOrEqual(9999)
    expect(rolled).not.toBe(42)
    expect(localStorage.getItem('dsh_office_world_seed')).toBe(String(rolled))
    await act(async () => { setInputValue(seedInput, '1') })
    await act(async () => { seedInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(seedInput.value).toBe('1')
    expect(localStorage.getItem('dsh_office_world_seed')).toBe('1')
  })

  it('renders 4+ workspaces on single ground plane without 1F/2F tabs, plus nested subagent HUD & drawer breakdown', async () => {
    const origFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/settings')) {
        return new Response(JSON.stringify({
          policyVersion: 'v1',
          blocks: {
            policy: { value: {}, revision: 1 }, eval: { value: {}, revision: 1 }, executor: { value: {}, revision: 1 },
            workspaces: {
              value: [
                { id: 'w2', repository: '/srv/2', baseBranch: 'main', branchPrefix: 'b/', isolation: 'I2' },
                { id: 'w3', repository: '/srv/3', baseBranch: 'main', branchPrefix: 'b/', isolation: 'I2' },
                { id: 'w4', repository: '/srv/4', baseBranch: 'main', branchPrefix: 'b/', isolation: 'I2' },
              ],
              revision: 1,
            },
          },
          sources: [], environment: { root: '/srv/default', variables: [] },
        }), { status: 200 })
      }
      if (u.includes('tickets?state=open')) {
        return new Response(JSON.stringify({
          items: [{
            id: 't-101', title: '并行多代理调研', state: 'open', stage: 'working', action: 'running', workspace: 'w4',
            actions: { retry: false, stop: true }, strength: 'high', assignments: 1, inputs: 0, undelivered: 0,
            sessionId: 'worker-t-101', summary: '调研子代理协作中', createdAt: '2026-11-26T08:00:00Z', updatedAt: '2026-11-26T08:02:00Z', threads: [],
            subagents: [
              { id: 'sub-a1', parentSessionId: 'worker-t-101', status: 'running', depth: 1, preset: 'research' },
              { id: 'sub-b2', parentSessionId: 'sub-a1', status: 'idle', depth: 2, preset: 'standard' },
            ],
          }],
          next_offset: null,
        }), { status: 200 })
      }
      return origFetch(url, init)
    }))
    await act(async () => { root!.render(<StageApp />) })
    await waitText('1 工作中 · +2 子代理')
    expect(document.querySelector('button[aria-label="切换至2F"]')).toBeNull()
    expect(document.querySelector('button[aria-label="切换至1F"]')).toBeNull()
    expect(document.querySelector('button[aria-label="小地图-w4"]')).toBeTruthy()
    expect(document.querySelector('button[aria-label="查看房间卷宗-w4"]')).toBeTruthy()

    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="查看房间卷宗-w4"]')!.click() })
    await waitText('活跃嵌套子代理 (2)')
    expect(document.querySelector('[aria-label="活跃嵌套子代理"]')?.textContent).toContain('L1')
    expect(document.querySelector('[aria-label="活跃嵌套子代理"]')?.textContent).toContain('L2')
    expect(document.querySelector('[aria-label="活跃嵌套子代理"]')?.textContent).toContain('sub-b2')
  })

  it('loads recently ended tickets in WorkerDrawer when open room tickets are empty', async () => {
    const origFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('tickets?state=open')) return new Response(JSON.stringify({ items: [], next_offset: null }), { status: 200 })
      if (u.includes('tickets?state=ended')) {
        return new Response(JSON.stringify({
          items: [{
            id: 't-ended-alpha', title: '已完结修复工单', state: 'ended', stage: 'ended', action: 'ready', workspace: 'repo-alpha',
            actions: { retry: false, stop: false }, strength: 'high', assignments: 1, inputs: 0, undelivered: 0,
            sessionId: 'worker-t-ended-alpha', summary: 'npm test 5/5 通过', createdAt: '2026-11-26T08:00:00Z', updatedAt: '2026-11-26T08:02:00Z', threads: [],
          }],
          next_offset: null,
        }), { status: 200 })
      }
      if (u.includes('tickets/t-ended-alpha/transcript')) {
        return new Response(JSON.stringify({
          ticketId: 't-ended-alpha', sessionId: 'worker-t-ended-alpha', headSeq: 5, truncated: false,
          entries: [{ id: 'e-done', at: '2026-11-26T08:01:55Z', kind: 'gate', summary: 'verify.rerun -> allow', status: 'ok' }],
        }), { status: 200 })
      }
      return origFetch(url, init)
    }))
    await act(async () => { root!.render(<StageApp />) })
    await waitText('已整理交接公文。')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="查看房间卷宗-repo-alpha"]')!.click()
    })
    await waitText('已完结修复工单')
    await waitText('verify.rerun -> allow')
  })

  it('supports keyboard shortcuts (/, 1/2, two-step Escape) and alert jump chip to attention room', async () => {
    const origFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('tickets?state=open')) {
        return new Response(JSON.stringify({
          items: [{
            id: 't-alert', title: '越界审批待定', state: 'open', stage: 'person', action: 'answer', workspace: 'repo-alpha',
            actions: { retry: false, stop: false }, strength: 'high', assignments: 1, inputs: 0, undelivered: 0,
            sessionId: 'worker-t-alert', summary: '需要老板拍板', createdAt: '2026-11-26T08:00:00Z', updatedAt: '2026-11-26T08:02:00Z', threads: [],
          }],
          next_offset: null,
        }), { status: 200 })
      }
      return origFetch(url, init)
    }))
    await act(async () => { root!.render(<StageApp />) })
    const alertChip = await waitText('1 待处理')
    await act(async () => { alertChip.click() })
    await waitText('repo-alpha')

    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })) })
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="向秘书发话"]'))
    ;(document.activeElement as HTMLElement)?.blur()

    const zoom2Btn = document.querySelector<HTMLButtonElement>('button[aria-label="近景视角"]')!
    const zoom1Btn = document.querySelector<HTMLButtonElement>('button[aria-label="全楼视角"]')!
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true })) })
    expect(zoom2Btn.style.background).not.toBe(zoom1Btn.style.background)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })) })
    expect(zoom1Btn.style.background).not.toBe(zoom2Btn.style.background)

    await act(async () => { byText('展开立绘')!.click() })
    await act(async () => { byText('历史回看 (2)')!.click() })
    expect(document.querySelector('[aria-label="对话历史"]')).toBeTruthy()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('[aria-label="对话历史"]')).toBeNull()
    expect(document.querySelector('img[width="384"]')).toBeTruthy()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('img[width="384"]')).toBeNull()
    expect(document.querySelector('[aria-label="园区小地图"]')).toBeTruthy()
  })

  it('guards IME Enter, locks modal hotkeys, cycles multi-room alerts, avoids 5-room minimap overlap, and pauses worker log autoscroll when scrolled up', async () => {
    const origFetch = globalThis.fetch
    let seq = 1
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/settings')) {
        return new Response(JSON.stringify({
          policyVersion: 'v1',
          blocks: {
            policy: { value: {}, revision: 1 }, eval: { value: {}, revision: 1 }, executor: { value: {}, revision: 1 },
            workspaces: {
              value: [
                { id: 'repo-alpha', repository: '/srv/alpha', baseBranch: 'main', branchPrefix: 'bot/', isolation: 'I3' },
                { id: 'w3', repository: '/srv/3', baseBranch: 'main', branchPrefix: 'b/', isolation: 'I2' },
                { id: 'w4', repository: '/srv/4', baseBranch: 'main', branchPrefix: 'b/', isolation: 'I2' },
              ],
              revision: 1,
            },
          },
          sources: [], environment: { root: '/srv/default', variables: [] },
        }), { status: 200 })
      }
      if (u.includes('tickets?state=open')) {
        return new Response(JSON.stringify({
          items: [
            { id: 't-def', title: '主室阻塞', state: 'open', stage: 'person', action: 'blocked', actions: { retry: true, stop: false }, strength: 'high', assignments: 1, inputs: 0, undelivered: 0, sessionId: 'worker-t-def', summary: '主室待处理', createdAt: '2026-11-26T08:00:00Z', updatedAt: '2026-11-26T08:01:00Z', threads: [] },
            { id: 't-al', title: 'Alpha审批', state: 'open', stage: 'person', action: 'answer', workspace: 'repo-alpha', actions: { retry: false, stop: false }, strength: 'high', assignments: 1, inputs: 0, undelivered: 0, sessionId: 'worker-t-al', summary: 'Alpha 待拍板', createdAt: '2026-11-26T08:00:00Z', updatedAt: '2026-11-26T08:02:00Z', threads: [] },
          ],
          next_offset: null,
        }), { status: 200 })
      }
      if (u.includes('/transcript')) {
        return new Response(JSON.stringify({
          ticketId: 't-def', sessionId: 'worker-t-def', headSeq: ++seq, truncated: false,
          entries: [{ id: `e-${seq}`, at: '08:01:00', kind: 'assistant', summary: `日志行 ${seq}` }],
        }), { status: 200 })
      }
      return origFetch(url, init)
    }))
    await act(async () => { root!.render(<StageApp />) })
    const alertBtn = await waitText('2 待处理')
    const input = document.querySelector<HTMLInputElement>('input[aria-label="向秘书发话"]')!
    expect(Number.parseInt(input.closest('[style*="bottom: 12px"]')?.getAttribute('style')?.match(/left:\s*(\d+)px/)?.[1] ?? '0', 10)).toBeGreaterThanOrEqual(275)

    await act(async () => { setInputValue(input, 'nihao') })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true })) })
    expect(calls.some(c => c.method === 'POST' && c.path === 'secretary/messages')).toBe(false)

    await act(async () => { alertBtn.click() })
    await waitText('repo-alpha')
    await act(async () => { alertBtn.click() })
    expect(document.querySelector('strong')?.textContent).toBe('default')

    const zoom2Btn = document.querySelector<HTMLButtonElement>('button[aria-label="近景视角"]')!
    const zoom1Btn = document.querySelector<HTMLButtonElement>('button[aria-label="全楼视角"]')!
    const bgBefore = zoom1Btn.style.background
    await act(async () => { byText('门牌簿')!.click() })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true })) })
    expect(zoom1Btn.style.background).toBe(bgBefore)
    expect(zoom2Btn.style.background).not.toBe(bgBefore)
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="关闭器物面板"]')!.click() })

    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="查看房间卷宗-default"]')!.click() })
    await waitText('日志行 2')
    const logEl = document.querySelector<HTMLDivElement>('[aria-label="现场终端卷宗"]')!
    Object.defineProperty(logEl, 'scrollHeight', { value: 600, configurable: true })
    Object.defineProperty(logEl, 'clientHeight', { value: 320, configurable: true })
    logEl.scrollTop = 40
    await act(async () => { logEl.dispatchEvent(new Event('scroll', { bubbles: true })) })
    expect(document.querySelector('button[aria-label="滚回日志底部"]')).toBeTruthy()
    await act(async () => { MockEventSource.instances[0]!.emit('domain', {}) })
    await waitText('日志行 3')
    expect(logEl.scrollTop).toBe(40)
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="滚回日志底部"]')!.click() })
    expect(logEl.scrollTop).toBe(600)
  })

  it('requires two-step confirmation before stopping a worker and flags SSE offline on error', async () => {
    await act(async () => { root!.render(<StageApp />) })
    await waitText('已整理交接公文。')
    expect(document.querySelector('[title="SSE 在线"]')).toBeTruthy()
    await act(async () => { MockEventSource.instances[0]!.onerror?.() })
    expect(document.querySelector('[title="连接中"]')).toBeTruthy()
    await act(async () => { MockEventSource.instances[0]!.emit('ready', {}) })
    expect(document.querySelector('[title="SSE 在线"]')).toBeTruthy()

    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="查看房间卷宗-default"]')!.click() })
    await waitText('运行 vitest 幂等校验')
    await act(async () => { byText('停止')!.click() })
    expect(byText('确认停止？')).toBeTruthy()
    expect(calls.some(c => c.method === 'POST' && c.path === 'tickets/t-101/stop')).toBe(false)
    await act(async () => { byText('确认停止？')!.click() })
    await vi.waitFor(() => { expect(calls.some(c => c.method === 'POST' && c.path === 'tickets/t-101/stop')).toBe(true) })
  })
})
