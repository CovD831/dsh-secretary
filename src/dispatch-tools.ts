// DEPS: src/dispatch, src/module
// RESPONSIBILITY: 把派发与状态工具交给秘书装配模块
// MODULE: secretary
// ---
import { createDispatchTool, createStatusTool } from './dispatch.js'
import type { Install } from './module.js'

export const install: Install = (ctx, deps) => {
  deps.dispatchTools = [
    createDispatchTool(deps.writer, ctx.sessionController, ctx.storageDomain, deps.workspace),
    createStatusTool(deps.writer, deps.workspace),
  ]
}
