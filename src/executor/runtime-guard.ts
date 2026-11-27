/** 执行期三档权限门控、DSH 原生轨迹实时入脊、外部副作用记账与防烧钱/打转熔断护栏。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { latestAssignment, liveTicket, runningAssignment, type EngineForExecutor, type Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import type { ApprovalOutcome, RulingQueue } from '../app/ruling-queue.ts'
import { KV, type PersistedRuntimeBudget } from '../kv.ts'
import { calibrateProbability, classifyThresholdBand } from '../rsi/index.ts'
import type { SpineAppender } from '../spine/types.ts'
import {
  FILE_WRITE_TOOLS, SAFE_READ_TOOLS, SHELL_TOOLS, classifySmartAutoRisk,
  effectiveApprovalMode, effectiveUsageTokens, isHardRedlineRisk, resolveRootTicketId,
} from './runtime-guard-rules.ts'

export { classifySmartAutoRisk, effectiveApprovalMode, effectiveUsageTokens, resolveRootTicketId } from './runtime-guard-rules.ts'

export interface HostApprovalRequest {
  readonly agent: Agent; readonly toolName: string; readonly callId?: unknown; readonly reason?: string; readonly signal?: AbortSignal
}
declare module '@deepseek-ai/cordis' {
  interface Events { 'approval/request'(req: HostApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> }
}

interface AssignmentBudgetState {
  turns: number; stallTurns: number; totalTokens: number; turnHadProgress: boolean; turnHadFailure: boolean; tripped: boolean; warned80?: boolean
}

export interface RuntimeGuardDeps {
  readonly context: Context; readonly store: Pick<Store, 'tickets' | 'settings' | 'atomic' | 'get' | 'set'>
  readonly engine: Pick<EngineForExecutor, 'report'>; readonly appender: SpineAppender
  readonly rulings: RulingQueue; readonly relayToMaster: (id: string, text: string) => void
}

const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))

/** 挂载在宿主 Cordis 上下文上的执行护栏：三档审批拦截、M0 轨迹采集与单工单熔断器。 */
export class RuntimeGuard {
  private readonly disposers: (() => void)[] = []
  private readonly budgets = new Map<string, AssignmentBudgetState>()
  private readonly callScores = new Map<string, number>()
  private seq = 0

  constructor(private readonly deps: RuntimeGuardDeps) {
    const saved = this.deps.store.get?.(KV.governance.runtimeBudgets)
    if (saved) for (const [id, b] of Object.entries(saved).slice(-500)) this.budgets.set(id, { turns: b.turns, stallTurns: b.stallTurns, totalTokens: b.totalTokens, turnHadProgress: false, turnHadFailure: false, tripped: Boolean(b.tripped) })
  }

  install(): void {
    const { context: ctx } = this.deps
    this.disposers.push(
      ctx.on('tools/pre-execute', (exec, next) => this.onPreExecute(exec, next)),
      ctx.on('approval/request', (req, next) => this.onApprovalRequest(req, next), { prepend: true }),
      ctx.on('tools/result', (exec, result) => { this.onToolResult(exec, result); return undefined }),
      ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event); return undefined }),
    )
  }
  dispose(): void { for (const d of this.disposers.splice(0)) d(); this.budgets.clear(); this.callScores.clear() }

  private stateOf(assignmentId: string): AssignmentBudgetState {
    let st = this.budgets.get(assignmentId)
    if (!st) {
      if (this.budgets.size >= 500) { const oldest = this.budgets.keys().next().value; if (oldest !== undefined) this.budgets.delete(oldest) }
      st = { turns: 0, stallTurns: 0, totalTokens: 0, turnHadProgress: false, turnHadFailure: false, tripped: false }
      this.budgets.set(assignmentId, st)
    }
    return st
  }
  private persistBudgets(): void {
    const out: Record<string, PersistedRuntimeBudget> = {}
    for (const [id, b] of this.budgets) out[id] = { turns: b.turns, stallTurns: b.stallTurns, totalTokens: b.totalTokens, tripped: b.tripped }
    this.deps.store.set(KV.governance.runtimeBudgets, out)
  }

  private async onPreExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    if (!exec.agent) return next()
    const ticketId = resolveRootTicketId(this.deps.context, exec.agent.id)
    const ticket = ticketId ? this.deps.store.tickets.get(ticketId) : undefined
    if (!ticket || !liveTicket(ticket)) return next()

    const mode = effectiveApprovalMode(this.deps.store.settings(), ticket)
    const risk = classifySmartAutoRisk(exec.name, exec.arguments, ticket.execution?.directory ?? '')
    if (exec.callId !== undefined) {
      if (this.callScores.size >= 500) { const oldest = this.callScores.keys().next().value; if (oldest !== undefined) this.callScores.delete(oldest) }
      this.callScores.set(String(exec.callId), risk.rawScore)
    }
    if (mode === 'smart-auto' && !SAFE_READ_TOOLS.has(exec.name)) {
      const scaler = this.deps.store.get(KV.governance.temperatureScaler)
      const calibratedProb = scaler?.fitted ? calibrateProbability(risk.rawScore, scaler) : risk.rawScore
      const bandDecision = classifyThresholdBand(calibratedProb, [0.2, 0.8])
      this.deps.appender.append({
        id: `cal:smart-auto:${ticket.id}:${String(exec.callId)}:${++this.seq}`, stream: `ticket:${ticket.id}`,
        type: 'gate.calibrated_pre_screen', source: { kind: 'system', ref: 'runtime-guard.smart-auto' },
        evidence: [{ kind: 'event', ref: `session:${exec.agent.id}` }], taint: 'trusted',
        payload: {
          gateId: 'approval.smart-auto', ticketId: ticket.id, sessionId: exec.agent.id, toolName: exec.name, callId: String(exec.callId),
          rawScore: risk.rawScore, calibratedProb, threshold: 0.5, thresholdBand: [0.2, 0.8], bandDecision,
          decision: risk.needsAsk ? 'ask' : 'allow', ...(risk.reason ? { reason: risk.reason } : {}),
        },
      })
    }
    const hardRedline = isHardRedlineRisk(exec.name, exec.arguments, ticket.execution?.directory ?? '')
    if (hardRedline) return { kind: 'ask', reason: hardRedline }
    if (mode === 'full-trust') return next()
    if (mode === 'always-ask' && !SAFE_READ_TOOLS.has(exec.name)) return { kind: 'ask', reason: `always-ask 档位要求审批工具 ${exec.name}` }
    if (mode === 'smart-auto' && risk.needsAsk) return { kind: 'ask', reason: risk.reason ?? `smart-auto 拦截高风险工具 ${exec.name}` }
    return next()
  }

  private async onApprovalRequest(req: HostApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const ticketId = resolveRootTicketId(this.deps.context, req.agent.id)
    const ticket = ticketId ? this.deps.store.tickets.get(ticketId) : undefined
    if (!ticket) return next()

    const events = req.agent.session?.snapshotEvents?.() ?? []
    let hostApprovalId: string | undefined
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!
      const data = ev.data as unknown
      if (ev.type === 'approval/asked' && isRec(data) && data['toolName'] === req.toolName && (data['callId'] ?? null) === (req.callId ?? null) && typeof data['id'] === 'string') {
        hostApprovalId = data['id']; break
      }
    }
    const question = `工单「${ticket.title}」请求执行 ${req.toolName}${req.reason ? `：${req.reason}` : ''}`
    this.deps.relayToMaster(`approval:${ticket.id}:${String(req.callId ?? ++this.seq)}`, JSON.stringify({
      kind: 'approval_pending', ticket_id: ticket.id, tool_name: req.toolName, reason: req.reason ?? '',
    }))
    const snapMode = effectiveApprovalMode(this.deps.store.settings(), ticket), snapAsg = runningAssignment(ticket)?.id
    const callKey = req.callId !== undefined ? String(req.callId) : undefined
    let rawScore = callKey !== undefined ? this.callScores.get(callKey) : undefined
    if (callKey !== undefined) this.callScores.delete(callKey)
    if (rawScore === undefined && req.reason && /命令命中高风险规则|越出当前工单|受保护高危路径/.test(req.reason)) rawScore = 0.9
    const outcome = await this.deps.rulings.requestDshApproval({
      question, ticketId: ticket.id, sessionId: req.agent.id, toolName: req.toolName,
      ...(ticket.execution?.workspace ? { workspace: ticket.execution.workspace } : {}),
      ...(callKey !== undefined ? { callId: callKey } : {}),
      ...(hostApprovalId ? { hostApprovalId } : {}),
      ...(rawScore !== undefined ? { rawScore } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    })
    if (outcome === 'allowed-once') {
      const fresh = this.deps.store.tickets.get(ticket.id), paused = this.deps.store.settings().paused
      const freshAsg = fresh ? runningAssignment(fresh)?.id : undefined
      const freshMode = fresh ? effectiveApprovalMode(this.deps.store.settings(), fresh) : undefined
      const asgChanged = Boolean(snapAsg && freshAsg !== snapAsg) || !freshAsg
      if (!fresh || !liveTicket(fresh) || paused || asgChanged || freshMode !== snapMode) {
        this.deps.appender.append({
          id: `approval:stale:${ticket.id}:${String(req.callId ?? ++this.seq)}`, stream: `ticket:${ticket.id}`, type: 'approval.stale_cancelled',
          source: { kind: 'system', ref: 'runtime-guard.approval' }, evidence: [{ kind: 'event', ref: `session:${req.agent.id}` }], taint: 'trusted',
          payload: { ticketId: ticket.id, sessionId: req.agent.id, toolName: req.toolName, snapMode, freshMode, asgChanged, paused, ticketState: fresh?.ended ? 'ended' : fresh ? 'inactive' : 'missing' },
        })
        return 'cancelled'
      }
    }
    return outcome
  }

  private onToolResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    if (exec.callId !== undefined) this.callScores.delete(String(exec.callId))
    if (!exec.agent) return
    const ticketId = resolveRootTicketId(this.deps.context, exec.agent.id)
    const ticket = ticketId ? this.deps.store.tickets.get(ticketId) : undefined
    const assignment = ticket ? runningAssignment(ticket) : undefined
    if (!ticket || !assignment) return

    const st = this.stateOf(assignment.id)
    const hasDiff = isRec(result.meta) && Array.isArray(result.meta['diffs']) && result.meta['diffs'].length > 0
    if (hasDiff || (!result.isError && FILE_WRITE_TOOLS.has(exec.name))) st.turnHadProgress = true
    if (result.isError) st.turnHadFailure = true

    const risk = classifySmartAutoRisk(exec.name, exec.arguments, ticket.execution?.directory ?? '')
    if (!result.isError && risk.externalSideEffect) {
      this.deps.store.atomic(() => {
        const fresh = this.deps.store.tickets.get(ticket.id)
        const entry = `${exec.name}:${risk.externalSideEffect}`
        if (fresh?.execution && !(fresh.execution.externalSideEffects ?? []).includes(entry)) {
          fresh.execution = { ...fresh.execution, externalSideEffects: [...(fresh.execution.externalSideEffects ?? []), entry] }
          this.deps.store.tickets.save(fresh)
        }
      })
    }
    this.deps.appender.append({
      id: `trace:tool:${ticket.id}:${String(exec.callId)}:${++this.seq}`, stream: `ticket:${ticket.id}`, type: 'worker.tool_finished',
      source: { kind: 'worker', ref: exec.agent.id }, evidence: [{ kind: 'event', ref: `session:${exec.agent.id}` }],
      taint: SHELL_TOOLS.has(exec.name) || exec.name === 'web_fetch' ? 'derived' : 'trusted',
      payload: {
        ticketId: ticket.id, assignmentId: assignment.id, sessionId: exec.agent.id, toolName: exec.name,
        callId: String(exec.callId), isError: result.isError, hasDiff,
        ...(risk.externalSideEffect ? { externalSideEffect: risk.externalSideEffect } : {}),
      },
    })
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const ticketId = resolveRootTicketId(this.deps.context, session)
    const ticket = ticketId ? this.deps.store.tickets.get(ticketId) : undefined
    const assignment = ticket ? (runningAssignment(ticket) ?? latestAssignment(ticket)) : undefined
    if (!ticket || !assignment || !liveTicket(ticket)) return

    const st = this.stateOf(assignment.id)
    if (event.type === 'assistant/message' && event.data.usage) {
      st.totalTokens += effectiveUsageTokens(event.data.usage)
      this.checkCircuitBreaker(ticket, assignment.id, st); this.persistBudgets(); return
    }
    const rawEv = event as { type: string; seq?: unknown }
    if (rawEv.type === 'team/task' || rawEv.type === 'subagent/start' || rawEv.type === 'subagent/end') {
      this.deps.appender.append({
        id: `trace:${rawEv.type.replace('/', '.')}:${ticket.id}:${++this.seq}`, stream: `ticket:${ticket.id}`,
        type: `worker.${rawEv.type.replace('/', '_')}` as `${string}.${string}`, source: { kind: 'worker', ref: session.id },
        evidence: [{ kind: 'event', ref: `session:${session.id}#${String(rawEv.seq ?? '')}` }], taint: 'trusted',
        payload: { ticketId: ticket.id, assignmentId: assignment.id, sessionId: session.id, eventType: rawEv.type },
      }); return
    }
    if (event.type === 'turn/end' && session.id === `worker-${ticket.id}`) {
      st.turns += 1
      if (st.turnHadProgress) st.stallTurns = 0
      else if (st.turnHadFailure) st.stallTurns += 1
      st.turnHadProgress = false; st.turnHadFailure = false
      this.checkCircuitBreaker(ticket, assignment.id, st); this.persistBudgets()
    }
  }

  private checkCircuitBreaker(ticket: Ticket, assignmentId: string, st: AssignmentBudgetState): void {
    if (st.tripped) return
    const { maxTurns = 40, maxStallTurns = 6, maxTokens = 5_000_000 } = this.deps.store.settings().executor
    if (!st.warned80 && maxTokens >= 2000 && st.totalTokens >= Math.floor(maxTokens * 0.8) && st.totalTokens <= maxTokens) {
      st.warned80 = true
      this.deps.appender.append({
        id: `budget-warn:${ticket.id}:${assignmentId}`, stream: `ticket:${ticket.id}`, type: 'ticket.budget_warning',
        source: { kind: 'system', ref: 'runtime-guard.breaker' }, evidence: [{ kind: 'event', ref: `session:worker-${ticket.id}` }],
        taint: 'trusted', payload: { ticketId: ticket.id, assignmentId, usedTokens: st.totalTokens, maxTokens },
      })
      this.deps.relayToMaster(`budget-warn:${ticket.id}:${assignmentId}`, JSON.stringify({ kind: 'budget_warning', ticket_id: ticket.id, used_tokens: st.totalTokens, max_tokens: maxTokens }))
    }
    const reason = st.turns > maxTurns ? `单工单轮次超限 (${st.turns} > ${maxTurns})`
      : st.stallTurns >= maxStallTurns ? `连续无进展失败打转超限 (${st.stallTurns} >= ${maxStallTurns})`
        : st.totalTokens > maxTokens ? `单工单 Token 消耗超限 (${st.totalTokens} > ${maxTokens})` : undefined
    if (!reason) return
    st.tripped = true
    ;(this.deps.context.agents.get(`worker-${ticket.id}` as never) as Agent | undefined)?.cancel({ kind: 'hook' } as never, { keepInbox: false })
    this.deps.store.atomic(() => {
      const fresh = this.deps.store.tickets.get(ticket.id)
      if (!fresh || !liveTicket(fresh) || runningAssignment(fresh)?.id !== assignmentId) return
      this.deps.engine.report(ticket.id, { state: 'blocked', summary: `触发执行熔断护栏：${reason}` })
      this.deps.appender.append({
        id: `breaker:${ticket.id}:${assignmentId}`, stream: `ticket:${ticket.id}`, type: 'ticket.circuit_broken',
        source: { kind: 'system', ref: 'runtime-guard.breaker' }, evidence: [{ kind: 'event', ref: `session:worker-${ticket.id}` }],
        taint: 'trusted', payload: { ticketId: ticket.id, assignmentId, reason, turns: st.turns, stallTurns: st.stallTurns, totalTokens: st.totalTokens },
      })
    })
    void this.deps.rulings.enqueue({
      kind: 'system_escalation', escalationType: 'runaway_breaker', ticketId: ticket.id,
      ...(ticket.execution?.workspace ? { workspace: ticket.execution.workspace } : {}),
      question: `工单「${ticket.title}」因 ${reason} 已熔断暂停，是否继续？`,
      options: [{ id: 'retry', label: '调高预算并重试', consequence: '开启新一轮 Assignment 继续当前 Worktree', recommended: false }, { id: 'stop', label: '停止该工单', consequence: '结束工单并保留现场供人工检查', recommended: true }],
    })
    this.deps.relayToMaster(`breaker:${ticket.id}:${assignmentId}`, JSON.stringify({ kind: 'circuit_broken', ticket_id: ticket.id, reason }))
  }
}
