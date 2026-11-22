// DEPS: 无（面板经 __ModuleLoader__ 注入，仅用宿主 React）
// RESPONSIBILITY: 注入默认主面板：队首待裁表单与只读事件投影
// MODULE: secretary-client
// ---
interface ReactLike {
  createElement(...args: unknown[]): unknown
  useEffect(setup: () => void, deps: unknown[]): void
  useState<T>(initial: T): [T, (value: T) => void]
}

declare const window: {
  __ModuleLoader__: {
    load(module: { id: string; factory(require: (name: string) => ReactLike): unknown }): void
  }
}

interface PendingOption { id: string; label: string; consequence: string; recommended: boolean }
interface PendingItem {
  pendingId: string
  kind: string
  sessionId: string
  workspaceId: string | null
  payload: Record<string, unknown>
  options: PendingOption[]
}
interface QueueView { current: PendingItem | null; remaining: number; total: number; writeFailure: string | null }

window.__ModuleLoader__.load({
  id: 'dsh-secretary',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react')
    const buttonStyle = { padding: '8px 12px', textAlign: 'left', maxWidth: 360, cursor: 'pointer' }

    function questionOf(item: PendingItem): string {
      if (item.kind === 'secretary.ask') return String(item.payload.text ?? '秘书提了一个问题。')
      const tool = String(item.payload.toolName ?? '未知工具')
      const reason = item.payload.reason === null || item.payload.reason === undefined ? '未提供理由' : String(item.payload.reason)
      return `工具「${tool}」请求权限；理由：${reason}`
    }

    function errorText(data: unknown): string {
      if (typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string') {
        return (data as { error: string }).error
      }
      return '裁决提交失败。'
    }

    function Pending() {
      const [queue, setQueue] = useState<QueueView | null>(null)
      const [readError, setReadError] = useState('')
      const [note, setNote] = useState('')
      const [submitting, setSubmitting] = useState(false)
      const [submitError, setSubmitError] = useState('')

      const refresh = async (): Promise<void> => {
        try {
          const response = await fetch('/api/dsh-secretary.pending')
          if (!response.ok) throw new Error('待裁队列读取失败。')
          setQueue(await response.json() as QueueView)
          setReadError('')
        } catch {
          setReadError('待裁队列读取失败。')
        }
      }

      useEffect(() => {
        void refresh()
        const timer = setInterval(() => { void refresh() }, 3000)
        return () => clearInterval(timer)
      }, [])

      const submit = async (optionId: string): Promise<void> => {
        if (queue === null || queue.current === null || submitting) return
        setSubmitting(true)
        setSubmitError('')
        try {
          const response = await fetch('/api/dsh-secretary.decision', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pendingId: queue.current.pendingId, optionId, ...(note.trim() ? { note: note.trim() } : {}) }),
          })
          const data = await response.json() as unknown
          if (!response.ok) throw new Error(errorText(data))
          setNote('')
          await refresh()
        } catch (caught) {
          setSubmitError(caught instanceof Error ? caught.message : '裁决提交失败。')
        } finally {
          setSubmitting(false)
        }
      }

      const current = queue?.current ?? null
      return h('section', { id: 'secretary-pending', style: { border: '1px solid #c9c9c9', borderRadius: 8, padding: 16, marginBottom: 24 } },
        h('h2', { style: { marginTop: 0 } }, '待裁'),
        queue !== null && queue.writeFailure !== null
          ? h('p', { role: 'alert', style: { background: '#ffe8e8', color: '#a00000', padding: 8, borderRadius: 4 } }, queue.writeFailure)
          : null,
        readError === '' ? null : h('p', null, readError),
        queue === null ? h('p', null, '待裁读取中…') : current === null ? h('p', null, '暂无待裁事项') : h('div', null,
          h('p', { id: 'secretary-pending-question', style: { fontWeight: 600 } }, questionOf(current)),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            ...current.options.slice(0, 3).map(option => h('button', {
              key: option.id, type: 'button', disabled: submitting, onClick: () => { void submit(option.id) }, style: buttonStyle,
            },
            `${option.label}${option.recommended ? ' · 推荐' : ''}`,
            h('span', { style: { display: 'block', fontWeight: 400, fontSize: 12, color: '#555' } }, option.consequence)))),
          h('label', { style: { display: 'block', marginTop: 12 } }, '附言',
            h('input', {
              id: 'secretary-pending-note', 'aria-label': '附言', value: note, disabled: submitting,
              onChange: (event: { target: { value: string } }) => setNote(event.target.value),
              style: { display: 'block', width: '100%', marginTop: 4, padding: 6, boxSizing: 'border-box' },
            })),
          submitError === '' ? null : h('p', { role: 'alert', style: { color: '#a00000' } }, submitError),
          h('p', { style: { color: '#555' } }, `还有 ${queue.remaining} 件`)))
    }

    function Panel() {
      const [events, setEvents] = useState<unknown[]>([])
      const [error, setError] = useState('')
      useEffect(() => {
        void fetch('/api/dsh-secretary.events').then(async response => {
          if (!response.ok) throw new Error('事件日志读取失败')
          return await response.json() as { events: unknown[]; writeFailure: string | null }
        }).then(data => {
          setEvents(data.events)
          setError(data.writeFailure ?? '')
        }).catch(() => setError('事件日志读取失败'))
      }, [])
      return h('main', { style: { padding: 32 } },
        h('h1', null, 'dsh-secretary'),
        h(Pending, null),
        h('p', null, '待裁区可提交裁决；事件日志仅作只读投影。'),
        h('p', null, error),
        h('pre', { id: 'secretary-events' }, JSON.stringify(events, null, 2)))
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx: {
        slots: { inject(name: string, setup: () => unknown): void; register(meta: unknown, component: unknown): unknown }
        layout: { selectPanel(id: string | null): void }
      }) {
        ctx.slots.inject('main', () => {
          const dispose = ctx.slots.register({ name: 'main', key: 'dsh-secretary' }, Panel)
          ctx.layout.selectPanel('dsh-secretary')
          return dispose
        })
      },
    }
  },
})