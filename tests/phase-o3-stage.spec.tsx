// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StageApp } from '../src/office-app/stage-app.tsx'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface RecordedCall { method: string; path: string; body?: unknown }

class MockEventSource {
  static instances: MockEventSource[] = []
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
  let root: Root | undefined
  let container: HTMLElement | undefined

  beforeEach(() => {
    calls.length = 0
    MockEventSource.instances = []
    activeRuling = null
    pendingCount = 0
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    vi.stubGlobal('EventSource', MockEventSource)
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      set src(_v: string) { queueMicrotask(() => this.onload?.()) }
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      imageSmoothingEnabled: false, clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
      fillText: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    } as unknown as CanvasRenderingContext2D)

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
              handover: { conclusion: '已完成 PR #42 预检', reason: '单测全绿且无密钥泄漏', impact: '可安全合并主干', evidenceRefs: ['m0:seq:108'] },
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
        return new Response(JSON.stringify({ items: [], totalMatched: 0, headSeq: 0, nextSinceSeq: null, hasMore: false }), { status: 200 })
      }
      if (path === 'secretary/messages') return new Response(JSON.stringify({ triggerId: 'trig-1', received: 'stored' }), { status: 200 })
      if (path === 'rulings/r-1/decide') { activeRuling = null; pendingCount = 0; return new Response(JSON.stringify({ ok: true }), { status: 200 }) }
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

    const input = document.querySelector<HTMLInputElement>('input[aria-label="向秘书发话"]')!
    await act(async () => { setInputValue(input, '请检查 PR #42') })
    await act(async () => { byText('发送')!.click() })
    await vi.waitFor(() => {
      expect(calls.some(c => c.method === 'POST' && c.path === 'secretary/messages' && (c.body as Record<string, unknown>)['text'] === '请检查 PR #42')).toBe(true)
    })

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
    const portrait = document.querySelector<HTMLImageElement>('img[alt="秘书立绘 (concerned)"]')!
    expect(portrait.src).toContain('/assets/f1-proof/portrait_concerned.png')
    expect(byText('待办 2')).toBeTruthy()

    await act(async () => { byText('仅放行本次')!.click() })
    const sel = document.querySelector<HTMLSelectElement>('select[aria-label="四分类归因"]')!
    await act(async () => { setInputValue(sel, 'wrong_rule') })
    await act(async () => { byText('批准')!.click() })

    await vi.waitFor(() => {
      expect(calls.some(c =>
        c.method === 'POST'
        && c.path === 'rulings/r-1/decide'
        && (c.body as Record<string, unknown>)['optionId'] === 'opt-allow'
        && (c.body as Record<string, unknown>)['attribution'] === 'wrong_rule',
      )).toBe(true)
    })
  })

  it('opens handover sheet, switches workspace via doorplate, and inspects live worker transcript', async () => {
    await act(async () => { root!.render(<StageApp />) })
    const handoverBtn = await waitText('展开三段式公文纸')

    await act(async () => { handoverBtn.click() })
    expect(byText('已完成 PR #42 预检')).toBeTruthy()
    expect(byText('m0:seq:108')).toBeTruthy()
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="关闭器物面板"]')!.click() })

    await act(async () => { byText('门牌簿')!.click() })
    const wsBtn = await waitText('repo-alpha')
    await act(async () => { wsBtn.click() })
    await waitText('repo-alpha')

    const canvas = document.querySelector<HTMLCanvasElement>('canvas[aria-label="像素办公室主舞台"]')!
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 1440, height: 900, right: 1440, bottom: 900, x: 0, y: 0, toJSON: () => ({}),
    })
    for (const [cx, cy] of [[944, 340], [976, 356], [912, 324]]) {
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }))
      })
      if (document.querySelector('[aria-label="现场终端卷宗"]')) break
    }
    await waitText('运行 vitest 幂等校验')
    expect(calls.some(c => c.method === 'GET' && c.path === 'tickets/t-101/transcript')).toBe(true)
  })
})
