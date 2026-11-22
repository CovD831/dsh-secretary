// DEPS: 无（panel id 与包名一致）
// RESPONSIBILITY: 注入默认主面板，以只读 GET 投影最近事件
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

window.__ModuleLoader__.load({
  id: 'dsh-secretary',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react')
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
        h('p', null, '秘书插件骨架；以下仅投影事件日志，不提供写入。'),
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
