// DEPS: src/module, src/normalize
// RESPONSIBILITY: 装配原生事件归一化订阅
// MODULE: secretary
// ---
import type { Install } from './module.js'
import { observeEvents } from './normalize.js'

export const install: Install = (ctx, deps) => {
  observeEvents(ctx, deps.writer, deps.workspace?.id ?? null)
}
