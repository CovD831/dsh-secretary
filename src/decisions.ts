// DEPS: node:crypto | src/approval-options, src/constants, src/events
// RESPONSIBILITY: 从日志投影待裁队首，串行记录裁决并恢复原流程
// MODULE: secretary
// ---
import { randomUUID } from 'node:crypto'
import { KINDS } from './constants.js'
import { APPROVAL_OPTIONS } from './approval-options.js'
import { createEnvelope, EventEnvelope, LogWriter, readRecentEvents } from './events.js'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export interface DecisionInput { pendingId: string; optionId: string; note?: string }
export interface PendingView {
  pendingId: string
  kind: 'secretary.ask' | 'dsh.approval'
  sessionId: string
  workspaceId: string | null
  payload: Record<string, unknown>
  options: Array<{ id: string; label: string; consequence: string; recommended: boolean }>
}
export interface QueueView { current: PendingView | null; remaining: number; total: number; deliveryFailure: string | null }
export interface DecisionResult { accepted: true; pendingId: string; decisionId: string }
export interface DecisionActions {
  answerApproval(pending: PendingView, outcome: 'allowed-once' | 'rejected'): Promise<void>
  promptSecretary(pending: PendingView, text: string): Promise<void>
  closeApprovals(): Promise<void>
}

function closePending(pending: PendingView[], id: string): void {
  const index = pending.findIndex(item => item.pendingId === id)
  if (index >= 0) pending.splice(index, 1)
}

export function projectPending(events: EventEnvelope[]): PendingView[] {
  const pending: PendingView[] = []
  for (const event of events) {
    if (event.kind === KINDS.bossDecision) {
      closePending(pending, event.causedBy ?? '')
    } else if (event.kind === KINDS.secretaryAsk) {
      pending.push({ pendingId: event.id, kind: event.kind, sessionId: event.sessionId,
        workspaceId: event.workspaceId, payload: event.payload, options: event.payload.options as PendingView['options'] })
    } else if (event.kind === KINDS.approval) {
      if (event.payload.phase === 'pending') {
        pending.push({ pendingId: event.id, kind: event.kind, sessionId: event.sessionId,
          workspaceId: event.workspaceId, payload: event.payload, options: [...APPROVAL_OPTIONS] })
      } else if (event.payload.phase === 'answered') {
        closePending(pending, event.causedBy ?? '')
      }
    }
  }
  return pending
}

export async function readQueue(writer: LogWriter): Promise<QueueView> {
  const events = await readRecentEvents(writer.path, Number.MAX_SAFE_INTEGER)
  const pending = projectPending(events)
  const deliveryFailure = events.findLast(event => event.kind === KINDS.dispatch
    && event.payload.phase === 'failed' && event.payload.purpose === 'boss-decision')
  return { current: pending[0] ?? null, remaining: Math.max(0, pending.length - 1), total: pending.length,
    deliveryFailure: deliveryFailure === undefined ? null : '老板裁决已记录，但回投秘书失败；未自动重试，请检查秘书会话。' }
}

export class Decider {
  private operation: Promise<void> = Promise.resolve()
  private closing = false

  constructor(private readonly writer: LogWriter, private readonly actions: DecisionActions) {}

  async decide(input: DecisionInput): Promise<DecisionResult> {
    const run = this.operation.then(() => this.commit(input), () => this.commit(input))
    this.operation = run.then(() => undefined, () => undefined)
    return await run
  }

  private async commit(input: DecisionInput): Promise<DecisionResult> {
    if (this.closing) throw new Error('待裁队列正在释放，不能接受新裁决。')
    if (typeof input.pendingId !== 'string' || input.pendingId.length === 0
      || typeof input.optionId !== 'string' || input.optionId.length === 0
      || (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 1000))) {
      throw new Error('裁决参数须包含 pendingId、optionId，附言不得超过 1000 字。')
    }
    const queue = await readQueue(this.writer)
    if (queue.current?.pendingId !== input.pendingId) throw new Error('待裁件不存在、已裁决或不是当前队首。')
    const pending = queue.current
    const outcome = pending.kind === KINDS.approval
      ? input.optionId === 'allow' ? 'allowed-once' as const
        : input.optionId === 'reject' ? 'rejected' as const : null
      : null
    if (pending.kind === KINDS.approval && outcome === null) throw new Error('审批选项只能是 allow 或 reject。')
    if (pending.kind === KINDS.secretaryAsk && !pending.options.some(option => option.id === input.optionId)) {
      throw new Error('选项不属于当前秘书提问。')
    }
    const decision = createEnvelope({
      id: `plugin:${randomUUID()}`, kind: KINDS.bossDecision, sessionId: pending.kind === KINDS.secretaryAsk
        ? pending.sessionId : 'secretary', workspaceId: pending.workspaceId, source: 'plugin', causedBy: pending.pendingId,
      payload: { targetKind: pending.kind, choiceId: input.optionId, note: input.note?.trim() || null, approvalOutcome: outcome },
    })
    await this.writer.append(decision, true)
    try {
      if (pending.kind === KINDS.approval && outcome !== null) {
        await this.actions.answerApproval(pending, outcome)
      }
      if (pending.kind === KINDS.secretaryAsk) {
        const option = pending.options.find(item => item.id === input.optionId)
        const note = input.note?.trim() ? `，附言：${input.note.trim()}` : ''
        await this.actions.promptSecretary(pending, `老板选了「${option?.label ?? input.optionId}」（${input.optionId}）${note}`)
      }
    } catch (error) {
      if (pending.kind === KINDS.secretaryAsk) {
        await this.writer.append(createEnvelope({
          id: `plugin:${randomUUID()}`, kind: KINDS.dispatch, sessionId: pending.sessionId,
          workspaceId: pending.workspaceId, source: 'plugin', causedBy: decision.id,
          payload: { phase: 'failed', purpose: 'boss-decision', targetSessionId: pending.sessionId,
            requestId: null, summary: '老板裁决回投失败', reason: error instanceof Error ? error.message : String(error) },
        }), true)
      }
      throw new Error('裁决已落日志，但恢复原流程失败；请检查原会话与事件日志。', { cause: error })
    }
    return { accepted: true, pendingId: pending.pendingId, decisionId: decision.id }
  }

  async dispose(): Promise<void> {
    this.closing = true
    await this.actions.closeApprovals()
    await this.operation
    await this.actions.closeApprovals()
  }
}
