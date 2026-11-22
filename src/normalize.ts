// DEPS: node:crypto | src/constants, src/contracts, src/events
// RESPONSIBILITY: 将三类宿主事件裁剪为 v0 信封
// MODULE: secretary
// ---
import { randomUUID } from 'node:crypto'
import { KINDS } from './constants.js'
import type { Agent, Context, Session, SessionEvent, ToolExecution, ToolExecutionResult } from './host-types.js'
import { createEnvelope, EventEnvelope, LogWriter } from './events.js'

const SESSION_TYPES = new Set(['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result'])

function workspaceOf(session: Session): string | null {
  return session.header.workspaceId ?? null
}

export function normalizeSession(session: Session, event: SessionEvent): EventEnvelope | null {
  if (!SESSION_TYPES.has(event.type)) return null
  const data = event.data as { name?: string; turn?: number }
  const summary = event.type === 'tool/call' ? `工具：${data.name ?? '未知'}`
    : event.type.startsWith('turn/') ? `${event.type}：第 ${String(data.turn ?? '?')} 轮` : null
  const envelope = createEnvelope({
    id: `dsh:${session.id}:${event.seq}`, kind: KINDS.session, sessionId: session.id,
    workspaceId: workspaceOf(session), source: 'dsh', causedBy: null,
    payload: { seq: event.seq, sessionType: event.type, summary, dataRef: { sessionId: session.id, seq: event.seq } },
  })
  envelope.ts = new Date(event.time).toISOString()
  return envelope
}

export function normalizeTool(exec: ToolExecution, result: ToolExecutionResult, causedBy: string | null): EventEnvelope | null {
  if (exec.agent === undefined) return null
  const meta = result.meta as { diffs?: Array<{ path?: unknown }> } | undefined
  return createEnvelope({
    id: `plugin:${randomUUID()}`, kind: KINDS.tool, sessionId: exec.agent.id,
    workspaceId: workspaceOf(exec.agent.session), source: 'dsh', causedBy,
    payload: {
      callId: exec.callId, name: exec.name, isError: result.isError,
      error: result.isError ? { name: result.error?.info?.name ?? 'Error', code: result.error?.info?.code ?? 'UNKNOWN', ...(result.error?.info?.reason === undefined ? {} : { reason: result.error.info.reason }) } : null,
      diffPaths: meta?.diffs?.flatMap(diff => typeof diff.path === 'string' ? [diff.path] : []) ?? [],
      unmeasured: exec.name === 'bash' || exec.name === 'pwsh' || exec.name === 'str_replace_editor',
    },
  })
}

export function normalizeStatus(agent: Agent, status: 'idle' | 'running'): EventEnvelope {
  return createEnvelope({
    id: `plugin:${randomUUID()}`, kind: KINDS.agentStatus, sessionId: agent.id,
    workspaceId: workspaceOf(agent.session), source: 'dsh', causedBy: null,
    payload: { agentId: agent.id, status },
  })
}

export function observeEvents(ctx: Context, writer: LogWriter, workspaceId: string): void {
  const toolCalls = new Map<string, number>()
  const observe = (event: EventEnvelope | null): undefined => {
    if (event === null) return undefined
    if (event.workspaceId === null) event.workspaceId = workspaceId
    void writer.append(event).catch(error => console.error(`事件观察失败：${String(error)}`))
    return undefined
  }
  ctx.on('tools/result', (exec, result) => {
    const key = exec.agent === undefined ? undefined : `${exec.agent.id}:${exec.callId}`
    const seq = key === undefined ? undefined : toolCalls.get(key)
    if (key !== undefined) toolCalls.delete(key)
    observe(normalizeTool(exec, result, exec.agent !== undefined && seq !== undefined ? `dsh:${exec.agent.id}:${seq}` : null))
    return undefined
  })
  ctx.on('session/event', (session, event) => {
    observe(normalizeSession(session, event))
    if (event.type !== 'tool/call') return undefined
    const callId = (event.data as { callId?: string }).callId
    if (callId !== undefined) toolCalls.set(`${session.id}:${callId}`, event.seq)
    return undefined
  })
  ctx.on('agent/status', ({ agent, status }) => observe(normalizeStatus(agent, status)))
}
