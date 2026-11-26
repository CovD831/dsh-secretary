/** 执行期三档权限门控、DSH 原生轨迹实时入脊、外部副作用记账与防烧钱/打转熔断护栏。 */
import { isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { latestAssignment, liveTicket, runningAssignment, type EngineForExecutor, type Ticket } from '../core/index.ts'
import type { ApprovalMode, Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import type { ApprovalOutcome, RulingQueue } from '../app/ruling-queue.ts'
import { KV, type PersistedRuntimeBudget } from '../kv.ts'
import { calibrateProbability, classifyThresholdBand } from '../rsi/index.ts'
import type { SpineAppender } from '../spine/types.ts'
import { ticketOfSession } from './dsh.ts'

export interface HostApprovalRequest {
  readonly agent: Agent; readonly toolName: string; readonly callId?: unknown; readonly reason?: string; readonly signal?: AbortSignal
}
declare module '@deepseek-ai/cordis' {
  interface Events { 'approval/request'(req: HostApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> }
}

const SAFE_READ_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'todo_write', 'skill', 'list_agents', 'list_subagent_models', 'wait_agent',
  'job_list', 'job_output', 'orchestrator_read', 'orchestrator_report', 'orchestrator_ack', 'orchestrator_thread_follow',
  'orchestrator_thread_unrelated', 'orchestrator_trigger_handback', 'team_task_list', 'team_task_get',
])
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'bash_persistent', 'pwsh_persistent'])
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'fs_write', 'fs_edit', 'fs_delete'])
const HARM_SHELL_PATTERNS: readonly [RegExp, string][] = [
  [/\bgit\s+push\b/i, '外部推送 git push'],
  [/\bgh\s+(?:pr|issue|release|api\s+-X\s*(?:POST|PUT|PATCH|DELETE))\b/i, 'GitHub 远端写操作'],
  [/\blark(?:-cli)?\b.*\b(?:send|reply|create|update|delete)\b/i, '飞书远端发送操作'],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r\b/i, '破坏性删除 rm -rf'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f)/i, '破坏性覆写工作树'],
  [/(?:^|[\s"'=/])\.env(?:\.[a-zA-Z0-9_-]+)?(?=$|[\s"'])/, '触碰敏感凭据文件 .env'],
  [/(?:~|\$HOME)\/\.dsh\b/, '触碰生产 ~/.dsh 目录'],
  [/\bcurl\b.*(?:-d\b|--data|-X\s*(?:POST|PUT|DELETE))/i, '外部网络写请求'],
  [/\bsudo\b/, '提权命令 sudo'],
]
const EXTERNAL_SIDE_EFFECT_RE = /\b(?:git\s+push|gh\s+(?:pr|issue|release)\s+(?:create|merge|comment|close|edit)|lark(?:-cli)?\s+.*(?:send|reply))\b/i
const PROTECTED_PATH_RE = /(?:^|\/)(?:\.git|\.github|\.env(?:\.[^/]+)?|.*(?:secret|credential|private[_-]?key).*|.*\.(?:pem|key))(?=$|\/)/i

interface AssignmentBudgetState {
  turns: number; stallTurns: number; totalTokens: number; turnHadProgress: boolean; turnHadFailure: boolean; tripped: boolean
}

export interface RuntimeGuardDeps {
  readonly context: Context; readonly store: Pick<Store, 'tickets' | 'settings' | 'atomic' | 'get' | 'set'>
  readonly engine: Pick<EngineForExecutor, 'report'>; readonly appender: SpineAppender
  readonly rulings: RulingQueue; readonly relayToMaster: (id: string, text: string) => void
}

const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))

export function resolveRootTicketId(ctx: Context, sessionOrId: Session | string): string | undefined {
  const startId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id
  const direct = ticketOfSession(startId)
  if (direct) return direct
  let parent = typeof sessionOrId === 'string'
    ? ctx.agents.get(sessionOrId as never)?.session?.header?.parentSession
    : sessionOrId.header?.parentSession
  for (let depth = 0; parent !== undefined && depth < 8; depth++) {
    const hit = ticketOfSession(parent)
    if (hit) return hit
    parent = ctx.agents.get(parent as never)?.session?.header?.parentSession
  }
  return undefined
}

export function effectiveApprovalMode(settings: Settings, ticket: Ticket): ApprovalMode {
  const wsId = ticket.execution?.workspace
  const ws = wsId ? (settings.workspaces ?? []).find(w => w.id === wsId) : undefined
  return ws?.approvalMode ?? settings.executor.approvalMode ?? 'smart-auto'
}

function extractStringArg(args: unknown, keys: readonly string[]): string | undefined {
  if (!isRec(args)) return undefined
  for (const k of keys) if (typeof args[k] === 'string' && args[k].trim()) return args[k].trim()
  return undefined
}

export function classifySmartAutoRisk(
  toolName: string,
  args: unknown,
  worktreeDir: string,
): { rawScore: number; needsAsk: boolean; reason?: string; externalSideEffect?: string } {
  if (SAFE_READ_TOOLS.has(toolName)) return { rawScore: 0.05, needsAsk: false }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const rawPath = extractStringArg(args, ['file_path', 'path', 'filePath', 'target'])
    if (!rawPath) return { rawScore: 0.75, needsAsk: true, reason: `工具 ${toolName} 缺少可校验路径参数` }
    const rel = worktreeDir ? relative(resolve(worktreeDir), resolve(worktreeDir, rawPath)).replace(/\\/g, '/') : '..'
    if (!worktreeDir || rel.startsWith('..') || isAbsolute(rel)) {
      return { rawScore: 0.95, needsAsk: true, reason: `写入路径越出当前工单 Worktree: ${rawPath}` }
    }
    if (PROTECTED_PATH_RE.test(rel)) return { rawScore: 0.92, needsAsk: true, reason: `触碰受保护高危路径: ${rel}` }
    return { rawScore: 0.12, needsAsk: false }
  }
  if (SHELL_TOOLS.has(toolName)) {
    const cmd = extractStringArg(args, ['command', 'cmd', 'script']) ?? ''
    const sideEffect = EXTERNAL_SIDE_EFFECT_RE.exec(cmd)?.[0]
    for (const [pattern, label] of HARM_SHELL_PATTERNS) {
      if (pattern.test(cmd)) {
        return { rawScore: 0.9, needsAsk: true, reason: `命令命中高风险规则（${label}）: ${cmd.slice(0, 120)}`, ...(sideEffect ? { externalSideEffect: sideEffect } : {}) }
      }
    }
    return { rawScore: 0.18, needsAsk: false, ...(sideEffect ? { externalSideEffect: sideEffect } : {}) }
  }
  return { rawScore: 0.2, needsAsk: false }
}

/** 挂载在宿主 Cordis 上下文上的执行护栏：三档审批拦截、M0 轨迹采集与单工单熔断器。 */
export class RuntimeGuard {
  private readonly disposers: (() => void)[] = []
  private readonly budgets = new Map<string, AssignmentBudgetState>()
  private seq = 0

  constructor(private readonly deps: RuntimeGuardDeps) {
    const saved = this.deps.store.get?.(KV.governance.runtimeBudgets)
    if (saved) for (const [id, b] of Object.entries(saved).slice(-500)) this.budgets.set(id, { turns: b.turns, stallTurns: b.stallTurns, totalTokens: b.totalTokens, turnHadProgress: false, turnHadFailure: false, tripped: Boolean(b.tripped) })
  }

  install(): void {
    const { context: ctx } = this.deps
    this.disposers.push(ctx.on('tools/pre-execute', (exec, next) => this.onPreExecute(exec, next)))
    this.disposers.push(ctx.on('approval/request', (req, next) => this.onApprovalRequest(req, next), { prepend: true }))
    this.disposers.push(ctx.on('tools/result', (exec, result) => { this.onToolResult(exec, result); return undefined }))
    this.disposers.push(ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event); return undefined }))
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d()
    this.budgets.clear()
  }

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
    if (mode === 'smart-auto' && !SAFE_READ_TOOLS.has(exec.name)) {
      const scaler = this.deps.store.get(KV.governance.temperatureScaler)
      const calibratedProb = scaler?.fitted ? calibrateProbability(risk.rawScore, scaler) : risk.rawScore
      const bandDecision = classifyThresholdBand(calibratedProb, [0.2, 0.8])
      this.deps.appender.append({
        id: `cal:smart-auto:${ticket.id}:${String(exec.callId)}:${++this.seq}`,
        stream: `ticket:${ticket.id}`, type: 'gate.calibrated_pre_screen',
        source: { kind: 'system', ref: 'runtime-guard.smart-auto' },
        evidence: [{ kind: 'event', ref: `session:${exec.agent.id}` }], taint: 'trusted',
        payload: {
          gateId: 'approval.smart-auto', ticketId: ticket.id, sessionId: exec.agent.id, toolName: exec.name, callId: String(exec.callId),
          rawScore: risk.rawScore, calibratedProb, threshold: 0.5, thresholdBand: [0.2, 0.8], bandDecision,
          decision: risk.needsAsk ? 'ask' : 'allow', ...(risk.reason ? { reason: risk.reason } : {}),
        },
      })
    }
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
    const snapMode = effectiveApprovalMode(this.deps.store.settings(), ticket), snapLive = liveTicket(ticket)
    const outcome = await this.deps.rulings.requestDshApproval({
      question, ticketId: ticket.id, sessionId: req.agent.id, toolName: req.toolName,
      ...(ticket.execution?.workspace ? { workspace: ticket.execution.workspace } : {}),
      ...(req.callId !== undefined ? { callId: String(req.callId) } : {}),
      ...(hostApprovalId ? { hostApprovalId } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    })
    if (outcome === 'allowed-once') {
      const fresh = this.deps.store.tickets.get(ticket.id), paused = this.deps.store.settings().paused
      if (!fresh || !liveTicket(fresh) || paused) {
        this.deps.appender.append({
          id: `approval:stale:${ticket.id}:${String(req.callId ?? ++this.seq)}`, stream: `ticket:${ticket.id}`, type: 'approval.stale_cancelled',
          source: { kind: 'system', ref: 'runtime-guard.approval' }, evidence: [{ kind: 'event', ref: `session:${req.agent.id}` }], taint: 'trusted',
          payload: { ticketId: ticket.id, sessionId: req.agent.id, toolName: req.toolName, snapMode, snapLive, paused, ticketState: fresh?.ended ? 'ended' : fresh ? 'inactive' : 'missing' },
        })
        return 'cancelled'
      }
    }
    return outcome
  }

  private onToolResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
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
      id: `trace:tool:${ticket.id}:${String(exec.callId)}:${++this.seq}`,
      stream: `ticket:${ticket.id}`, type: 'worker.tool_finished',
      source: { kind: 'worker', ref: exec.agent.id },
      evidence: [{ kind: 'event', ref: `session:${exec.agent.id}` }],
      taint: SHELL_TOOLS.has(exec.name) || exec.name === 'web_fetch' ? 'derived' : 'trusted',
      payload: {
        ticketId: ticket.id, assignmentId: assignment.id, sessionId: exec.agent.id,
        toolName: exec.name, callId: String(exec.callId), isError: result.isError, hasDiff,
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
      const u = event.data.usage
      st.totalTokens += u.totalTokens ?? (u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0))
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
    const { maxTurns = 40, maxStallTurns = 6, maxTokens = 2_000_000 } = this.deps.store.settings().executor
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
        source: { kind: 'system', ref: 'runtime-guard.breaker' },
        evidence: [{ kind: 'event', ref: `session:worker-${ticket.id}` }], taint: 'trusted',
        payload: { ticketId: ticket.id, assignmentId, reason, turns: st.turns, stallTurns: st.stallTurns, totalTokens: st.totalTokens },
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
