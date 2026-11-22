// DEPS: node:crypto | src/constants, src/events
// RESPONSIBILITY: 单工作区注册、幂等派发与只读事件投影
// MODULE: secretary
// ---
import { randomUUID } from 'node:crypto'
import { DISPATCH_TOOL_NAMES, KINDS, MAX_ACCEPTANCE_LENGTH, MAX_SUMMARY_LENGTH, MAX_TASK_LENGTH } from './constants.js'
import { createEnvelope, EventEnvelope, LogWriter, readRecentEvents } from './events.js'

export interface Workspace { id: string; cwd: string }
interface SessionController {
  create(request: { cwd: string }): Promise<{ sessionId: string }>
  prompt(request: {
    requestId: string; sessionId: string; mode: 'queue'; content: Array<{ type: 'text'; text: string }>
  }, signal: AbortSignal): Promise<{ accepted: true }>
}
interface StorageDomain {
  open(spec: unknown): Promise<{
    table(name: string): { get(key: string): string | undefined; put(key: string, value: string): Promise<void> }
    close(): Promise<void>
  }>
}
export interface DispatchArgs { dispatchKey: string; task: string; acceptance: string }
export interface DispatchResult { accepted: true; dispatchKey: string; targetSessionId: string; duplicate: boolean }
export interface StatusResult { status: 'idle' | 'running' | 'unknown'; events: unknown[] }

const STORAGE_SPEC = {
  name: 'dsh_secretary', version: 0,
  tables: {
    workspaces: {
      valueSchema: {
        parse(value: unknown): string {
          if (typeof value !== 'string' || value.length === 0) throw new Error('工作区存储的 sessionId 无效。')
          return value
        },
      },
    },
  },
}

export function validateWorkspaces(workspaces: Workspace[]): Workspace {
  if (workspaces.length !== 1) throw new Error('第一阶段只能配置一个工作区。')
  const workspace = workspaces[0]!
  if (workspace.id.length === 0 || workspace.cwd.length === 0) throw new Error('工作区必须配置非空 id 与 cwd。')
  return workspace
}

function dispatchEvent(secretaryId: string, workspaceId: string, causedBy: string | null, payload: Record<string, unknown>): EventEnvelope {
  return createEnvelope({
    id: `plugin:${randomUUID()}`, kind: KINDS.dispatch, sessionId: secretaryId,
    workspaceId, source: 'plugin', causedBy, payload,
  })
}

async function acceptedResult(writer: LogWriter, secretaryId: string, workspaceId: string, key: string): Promise<DispatchResult | null> {
  const events = await readRecentEvents(writer.path, Number.MAX_SAFE_INTEGER)
  const accepted = events.find(event => event.kind === KINDS.dispatch && event.sessionId === secretaryId
    && event.workspaceId === workspaceId && event.payload.dispatchKey === key && event.payload.phase === 'accepted')
  if (accepted === undefined) return null
  return { accepted: true, dispatchKey: key, targetSessionId: String(accepted.payload.targetSessionId), duplicate: true }
}

let dispatchQueue: Promise<void> = Promise.resolve()

export async function dispatch(
  writer: LogWriter, controller: SessionController, storageDomain: StorageDomain,
  secretary: { id: string }, workspace: Workspace, args: DispatchArgs,
): Promise<DispatchResult> {
  const result = dispatchQueue.then(() => dispatchOnce(writer, controller, storageDomain, secretary, workspace, args))
  dispatchQueue = result.then(() => undefined, () => undefined)
  return result
}

async function dispatchOnce(
  writer: LogWriter, controller: SessionController, storageDomain: StorageDomain,
  secretary: { id: string }, workspace: Workspace, args: DispatchArgs,
): Promise<DispatchResult> {
  if (typeof args.dispatchKey !== 'string' || args.dispatchKey.length === 0) throw new Error('派发键 dispatchKey 不能为空。')
  if (typeof args.task !== 'string' || args.task.length < 1 || args.task.length > MAX_TASK_LENGTH) {
    throw new Error(`任务须为 1 至 ${MAX_TASK_LENGTH} 字。`)
  }
  if (typeof args.acceptance !== 'string' || args.acceptance.length < 1 || args.acceptance.length > MAX_ACCEPTANCE_LENGTH) {
    throw new Error(`验收标准须为 1 至 ${MAX_ACCEPTANCE_LENGTH} 字，缺失时请补充 acceptance。`)
  }
  const previous = await acceptedResult(writer, secretary.id, workspace.id, args.dispatchKey)
  if (previous !== null) return previous
  const domain = await storageDomain.open(STORAGE_SPEC)
  let targetSessionId: string
  try {
    targetSessionId = domain.table('workspaces').get(workspace.id) ?? ''
    if (targetSessionId === '') {
      targetSessionId = (await controller.create({ cwd: workspace.cwd })).sessionId
      await domain.table('workspaces').put(workspace.id, targetSessionId)
    }
  } finally {
    await domain.close()
  }
  const prepared = dispatchEvent(secretary.id, workspace.id, null, {
    dispatchKey: args.dispatchKey, phase: 'prepared', targetSessionId, requestId: null, summary: args.task.slice(0, MAX_SUMMARY_LENGTH),
  })
  await writer.append(prepared, true)
  const requestId = randomUUID()
  try {
    await controller.prompt({
      requestId, sessionId: targetSessionId, mode: 'queue',
      content: [{ type: 'text', text: `任务：${args.task}\n验收标准：${args.acceptance}` }],
    }, new AbortController().signal)
  } catch (error) {
    await writer.append(dispatchEvent(secretary.id, workspace.id, prepared.id, {
      dispatchKey: args.dispatchKey, phase: 'failed', targetSessionId, requestId: null, summary: args.task.slice(0, MAX_SUMMARY_LENGTH),
      reason: error instanceof Error ? error.message : String(error),
    }), true)
    throw new Error('任务投递失败，已记录失败事件。', { cause: error })
  }
  await writer.append(dispatchEvent(secretary.id, workspace.id, prepared.id, {
    dispatchKey: args.dispatchKey, phase: 'accepted', targetSessionId, requestId, summary: args.task.slice(0, MAX_SUMMARY_LENGTH),
  }), true)
  return { accepted: true, dispatchKey: args.dispatchKey, targetSessionId, duplicate: false }
}

function projectStatus(events: EventEnvelope[], targetSessionId: string, limit: number): StatusResult {
  const own = events.filter(event => event.sessionId === targetSessionId).slice(-limit).reverse()
  const latest = own.find(event => event.kind === KINDS.agentStatus)
  return {
    status: latest?.payload.status === 'idle' || latest?.payload.status === 'running' ? latest.payload.status : 'unknown',
    events: own.map(event => ({ id: event.id, kind: event.kind, ts: event.ts, causedBy: event.causedBy, payload: event.payload })),
  }
}

export async function status(writer: LogWriter, workspaceId: string, limit: number): Promise<StatusResult> {
  const events = await readRecentEvents(writer.path, Number.MAX_SAFE_INTEGER)
  const registered = events.find(event => event.kind === KINDS.dispatch && event.workspaceId === workspaceId)
  if (registered === undefined) return { status: 'unknown', events: [] }
  return projectStatus(events, String(registered.payload.targetSessionId), limit)
}

export function createDispatchTool(writer: LogWriter, controller: SessionController, storageDomain: StorageDomain, workspace: Workspace): unknown {
  return {
    name: DISPATCH_TOOL_NAMES.dispatch,
    description: '把带验收标准的任务派给唯一工作区；accepted 仅表示入队，不等待执行完成。',
    parameters: {
      type: 'object', properties: {
        dispatchKey: { type: 'string', minLength: 1 },
        task: { type: 'string', minLength: 1, maxLength: MAX_TASK_LENGTH },
        acceptance: { type: 'string', minLength: 1, maxLength: MAX_ACCEPTANCE_LENGTH },
      }, required: ['dispatchKey', 'task', 'acceptance'], additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object', properties: {
          accepted: { type: 'boolean', enum: [true] }, dispatchKey: { type: 'string' },
          targetSessionId: { type: 'string' }, duplicate: { type: 'boolean' },
        }, required: ['accepted', 'dispatchKey', 'targetSessionId', 'duplicate'],
      },
      render: (_args: DispatchArgs, value: DispatchResult) => [{ type: 'text', text: value.duplicate ? '该派发已入队，本次未重复投递。' : '任务已入队，可用 secretary_status 查状态。' }],
    },
    execute: (args: DispatchArgs, exec: { agent?: { id: string } }) => {
      if (exec.agent === undefined) throw new Error('派发工具必须在秘书会话中调用。')
      return dispatch(writer, controller, storageDomain, exec.agent, workspace, args)
    },
  }
}

export function createStatusTool(writer: LogWriter, workspace: Workspace): unknown {
  return {
    name: DISPATCH_TOOL_NAMES.status,
    description: '从事件日志读取工作区 idle/running 状态与最近事件摘要，不等待工作区。',
    parameters: {
      type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object', properties: {
          status: { type: 'string', enum: ['idle', 'running', 'unknown'] },
          events: { type: 'array', items: { type: 'object' } },
        }, required: ['status', 'events'],
      },
      render: (_args: unknown, value: StatusResult) => [{ type: 'text', text: `工作区状态：${value.status}；最近事件 ${value.events.length} 条。` }],
    },
    execute: (args: { limit?: number }) => status(writer, workspace.id, args.limit ?? 10),
  }
}
