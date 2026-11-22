// DEPS: node:crypto | src/constants, src/contracts, src/decisions, src/events, src/workspace
// RESPONSIBILITY: 只截获管辖会话审批，异步应答并在卸载时拒绝挂起项
// MODULE: secretary
// ---
import { randomUUID } from 'node:crypto'
import { KINDS, PRESET_NAME } from './constants.js'
import type { Agent, Context, SessionEvent } from './contracts.js'
import type { ApprovalOutcome, PendingView } from './decisions.js'
import { projectPending } from './decisions.js'
import type { StorageDomain } from './dispatch.js'
import { createEnvelope, LogWriter, readRecentEvents } from './events.js'
import { workspaceOf } from './workspace.js'

export interface ApprovalRequest {
  agent: Agent
  toolName: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}
export interface ApprovalContext extends Omit<Context, 'on'> {
  on(event: 'agent/created', listener: (payload: { agent: Agent }) => undefined): unknown
  on(event: 'approval/request', listener: (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>, options?: { prepend: true }): unknown
}
interface HeldApproval {
  event: { id: string; sessionId: string; workspaceId: string | null }
  signal?: AbortSignal
  resolve(outcome: ApprovalOutcome): void
  cancel?(): void
  onAbort(): void
}

export function registerApprovalQueue(ctx: ApprovalContext, writer: LogWriter, storage: StorageDomain): {
  respond(pending: PendingView, outcome: 'allowed-once' | 'rejected'): Promise<void>
  recover(): Promise<void>
  dispose(): Promise<void>
} {
  const secretaries = new Set<string>()
  const held = new Map<string, HeldApproval>()
  let disposed = false
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.agentPreset === PRESET_NAME) secretaries.add(agent.id)
    return undefined
  })

  ctx.on('approval/request', async (request, next) => {
    const approvalId = approvalIdOf(request)
    const secretary = secretaries.has(request.agent.id)
    const workspaceId = secretary ? null : await workspaceOf(request.agent, storage)
    if (disposed || (!secretary && workspaceId === null)) return await next()
    if (request.signal?.aborted) return 'cancelled'
    const event = createEnvelope({
      id: `plugin:${randomUUID()}`, kind: KINDS.approval, sessionId: request.agent.id,
      workspaceId, source: 'plugin', causedBy: null,
      payload: { phase: 'pending', toolName: request.toolName, callId: request.callId ?? null,
        reason: request.reason ?? null, outcome: null, approvalId },
    })
    await writer.append(event, true)
    const deferred = Promise.withResolvers<ApprovalOutcome>()
    const item: HeldApproval = {
      event, signal: request.signal, resolve: deferred.resolve,
      onAbort: () => { void settle(event.id, 'cancelled').catch(error => console.error('审批取消应答失败：', error)) },
    }
    if (disposed) {
      await writeAnswer(writer, event, 'rejected')
      return 'rejected'
    }
    held.set(event.id, item)
    request.signal?.addEventListener('abort', item.onAbort, { once: true })
    return await Promise.race([deferred.promise, new Promise<ApprovalOutcome>(resolve => {
      item.cancel = () => {
        if (held.has(event.id)) {
          held.delete(event.id)
          void writeAnswer(writer, event, 'rejected').catch(error => console.error('卸载时审批拒绝事件写入失败：', error))
        }
        resolve('rejected')
      }
    })])
  }, { prepend: true })

  async function settle(id: string, outcome: ApprovalOutcome): Promise<void> {
    const item = held.get(id)
    if (item === undefined) return
    const effective = disposed ? 'rejected' : outcome
    await writeAnswer(writer, item.event, effective)
    held.delete(id)
    item.resolve(effective)
    item.signal?.removeEventListener('abort', item.onAbort)
  }

  return {
    recover: async () => {
      const events = await readRecentEvents(writer.path, Number.MAX_SAFE_INTEGER)
      for (const pending of projectPending(events)) {
        if (pending.kind === KINDS.approval && !held.has(pending.pendingId)) {
          await writeAnswer(writer, { id: pending.pendingId, sessionId: pending.sessionId, workspaceId: pending.workspaceId },
            'cancelled', '插件重启，原审批已失效')
        }
      }
    },
    respond: async (pending, outcome) => {
      if (!held.has(pending.pendingId)) {
        await writeAnswer(writer, { id: pending.pendingId, sessionId: pending.sessionId, workspaceId: pending.workspaceId }, outcome)
        return
      }
      await settle(pending.pendingId, outcome)
    },
    dispose: async () => {
      disposed = true
      for (const item of [...held.values()]) {
        item.cancel?.()
        item.signal?.removeEventListener('abort', item.onAbort)
      }
      secretaries.clear()
    },
  }
}

function approvalIdOf(request: ApprovalRequest): string | null {
  if (request.callId === undefined) return null
  const events: SessionEvent[] = request.agent.session.snapshotEvents()
  const decided = new Set(events.filter(event => event.type === 'approval/decided')
    .map(event => (event.data as Record<string, unknown>).id))
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'approval/asked' || typeof event.data !== 'object' || event.data === null) continue
    const data = event.data as Record<string, unknown>
    if (data.toolName !== request.toolName || data.callId !== request.callId || decided.has(data.id)) continue
    return typeof data.id === 'string' ? data.id : null
  }
  return null
}

async function writeAnswer(
  writer: LogWriter, pending: { id: string; sessionId: string; workspaceId: string | null }, outcome: ApprovalOutcome,
  reason: string | null = null,
): Promise<void> {
  await writer.append(createEnvelope({
    id: `plugin:${randomUUID()}`, kind: KINDS.approval, sessionId: pending.sessionId,
    workspaceId: pending.workspaceId, source: 'plugin', causedBy: pending.id,
    payload: { phase: 'answered', toolName: null, callId: null, reason, outcome, approvalId: null },
  }), true)
}
