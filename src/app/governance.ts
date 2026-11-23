/** 运行时治理编排中枢：串联 M0 事件脊、判局注册表、工作区安全 GC 与发射前上下文胶囊。 */
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { Assignment, DomainEvent, OutboundMessage, Ticket } from '../core/index.ts'
import { prepareLaunchCapsule, type PreparedLaunchCapsule } from '../executor/capsule-hook.ts'
import { adaptiveDispatchGate, verifyChangedPathsGate, verifyRerunGate } from '../judgement/gates/index.ts'
import { createJudgementRegistry, type ExtendedJudgementRegistry, type Verdict } from '../judgement/index.ts'
import { domainEventToSpineDraft } from '../rsi/trace-bridge.ts'
import {
  GitRepoLock, createGitShardSink, createSpineAppender, createSpineFlusher, ensureSpineSchema,
  type FlushReport, type GitShardSink, type SpineAppender, type SpineDraft, type SpineFlusher,
} from '../spine/index.ts'
import {
  createWorkspaceRegistry, executeWorkspaceGc, findWorktreeObservation, isBranchMergedIntoBase,
  observeWorktrees, planWorkspaceGc, registerWorkspaceGcGate,
  type GcSubject, type WorkspaceRegistry, type WorktreeObservation,
} from '../workspaces/index.ts'
import type { Store } from './store.ts'

export interface OutboxSendCtx {
  readonly message: OutboundMessage
  readonly ticket?: Ticket
}

declare module '../judgement/types.ts' {
  interface ScopeCatalog {
    outbox: true
  }
  interface PointCatalog {
    'outbox.send': OutboxSendCtx
  }
}

export interface GovernanceOptions {
  readonly store: Store
  readonly stateDir: string
  readonly onError?: (error: unknown) => void
  readonly now?: () => Date
}

/** 串联 M0 事件脊、判局注册表、外发事前闸、发射切片与工作区自动 GC 的运行时治理中枢。 */
export class GovernanceRuntime {
  readonly memoryDir: string
  readonly memoryRepoLock: GitRepoLock
  readonly sink: GitShardSink
  readonly flusher: SpineFlusher
  readonly appender: SpineAppender
  readonly registry: ExtendedJudgementRegistry
  readonly workspaces: WorkspaceRegistry
  private readonly store: Store
  private readonly onError: (error: unknown) => void
  private readonly now: () => Date
  private readonly bootId = randomUUID().slice(0, 8)
  private readonly pendingTasks = new Set<Promise<void>>()
  private readonly repoLocks = new Map<string, GitRepoLock>()
  private eventSeq = 0
  private shuttingDown = false
  private closed = false

  constructor(options: GovernanceOptions) {
    this.store = options.store
    this.onError = options.onError ?? (() => {})
    this.now = options.now ?? (() => new Date())
    this.memoryDir = join(options.stateDir, 'memory')
    this.memoryRepoLock = new GitRepoLock()

    ensureSpineSchema(this.store.db)
    this.sink = createGitShardSink({ dir: this.memoryDir, lock: this.memoryRepoLock })
    this.flusher = createSpineFlusher(this.store.db, this.sink, { onError: this.onError, now: this.now })
    this.appender = createSpineAppender(this.store, { kick: () => { if (!this.closed) this.flusher.kick() } })
    this.workspaces = createWorkspaceRegistry(this.store)

    this.registry = createJudgementRegistry({ scopes: ['outbox'] })
    registerWorkspaceGcGate(this.registry, 'enforce')
    this.registry.register(adaptiveDispatchGate, 'enforce')
    this.registry.register(verifyChangedPathsGate, 'shadow')
    this.registry.register(verifyRerunGate, 'shadow')
  }

  /** 启动恢复撕裂分片并对齐 `sqlite_sequence`。 */
  recover(): Promise<FlushReport> {
    return this.flusher.recover()
  }

  /** 等待全部在途后台治理任务（如 worktree GC）完成后刷盘全部缓冲事件至 Git 分片。 */
  async flush(): Promise<FlushReport> {
    while (this.pendingTasks.size > 0) {
      await Promise.allSettled([...this.pendingTasks])
    }
    return this.flusher.flush()
  }

  /** 在关库前排空在途 GC 任务与事件脊刷盘并封口，防止关库后触碰已关闭的 SQLite。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    try {
      await this.flush()
    } finally {
      this.closed = true
    }
  }

  /** 在调用方的 `store.atomic()` 事务内原子写入领域事件并预约提交后异步刷盘。 */
  recordDomainEvent(event: DomainEvent): void {
    if (this.closed) return
    const ticketId = this.ticketIdOf(event)
    const sessionId = ticketId ? `worker-${ticketId}` : undefined
    const sessionPtr = sessionId ? `dsh-session:${sessionId}` : undefined
    const draft = domainEventToSpineDraft(event, {
      id: `dom:${event.type}:${this.bootId}:${++this.eventSeq}`,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionPtr ? { evidence: [{ kind: 'event', ref: sessionPtr }] } : {}),
    })
    const payload: Record<string, unknown> = {
      ...draft.payload,
      ...(ticketId ? { ticketId } : {}),
      ...(sessionPtr ? { sessionPtr } : {}),
    }
    this.appendEvent({ ...draft, payload })
  }

  /** 对外发声事前硬闸口：在 `Outbox` 发送前执行 `outbox.send` 判据并将已参评结果记录入脊。 */
  async evaluateOutbound(message: OutboundMessage): Promise<Verdict> {
    const ticket = message.ticketId ? this.store.tickets.get(message.ticketId) : undefined
    const ev = await this.registry.evaluate('outbox.send', { message, ...(ticket ? { ticket } : {}) })
    if (ev.registered > 0 || ev.observed.length > 0) {
      this.recordGate('outbox.send', message.id, 'governance.outbox', ticket?.id, {
        messageId: message.id, kind: message.kind, verdict: ev.verdict, ran: ev.ran, observed: ev.observed,
      })
    }
    return ev.verdict
  }

  /** 执行器首次发射前提取 1-Hop 上下文胶囊与自适应派发方案，并将判定入脊。 */
  prepareLaunchCapsule(input: {
    ticket: Ticket
    assignment: Assignment
    workspaceDir: string
    triggerText?: string
  }): Promise<PreparedLaunchCapsule | undefined> {
    return prepareLaunchCapsule({
      ...input,
      registry: this.registry,
      recordSpine: draft => {
        if (!this.closed) this.appendEvent({ ...draft, id: `${draft.id}:${this.bootId}:${++this.eventSeq}` })
      },
    })
  }

  /** 工单结束且绑定了已注册工作区时，于事务提交后异步探测真 Git 状态并安全执行 worktree GC。 */
  onTicketEnded(ticket: Ticket): Promise<void> {
    if (this.closed || this.shuttingDown || !ticket.ended || !this.workspaces.resolve(ticket)) {
      return Promise.resolve()
    }
    let resolveDone!: () => void
    const done = new Promise<void>(resolvePromise => { resolveDone = resolvePromise })
    this.store.afterCommit(() => {
      const task = this.runTicketEndedGc(ticket)
        .catch(error => { this.onError(error) })
        .finally(resolveDone)
      this.trackTask(task)
    })
    return done
  }

  private async runTicketEndedGc(ticket: Ticket): Promise<void> {
    if (this.closed) return
    const current = this.store.tickets.get(ticket.id) ?? ticket
    if (!current.ended) return
    const ws = this.workspaces.resolve(current)
    if (!ws || !current.execution?.directory) return

    await this.repoLock(ws.repository).run(async () => {
      let tree: WorktreeObservation | undefined
      let mergedIntoBase: boolean | undefined
      try {
        const observations = await observeWorktrees(ws.repository)
        tree = findWorktreeObservation(observations, current.execution!.directory)
        if (tree?.branch) {
          mergedIntoBase = await isBranchMergedIntoBase(ws.repository, tree.branch, ws.baseBranch)
        }
      } catch {
        tree = undefined
        mergedIntoBase = undefined
      }

      const subject: GcSubject = {
        ticket: {
          id: current.id,
          ended: current.ended,
          ...(current.follows ? { follows: current.follows } : {}),
          ...(current.execution ? { execution: current.execution } : {}),
        },
        ...(tree ? { tree } : {}),
        ...(mergedIntoBase !== undefined ? { mergedIntoBase } : {}),
        now: this.now().toISOString(),
      }
      const plan = await planWorkspaceGc(this.registry, subject)
      this.recordGate('workspace.gc', current.id, 'governance.workspace-gc', current.id, {
        workspace: ws.id, directory: current.execution!.directory,
        verdict: plan.kind === 'keep' ? plan.because : { kind: 'allow' }, plan,
      })

      // 仅在提交后再次确认工单仍处于结束状态且数据库尚未关闭时回收物理 worktree。
      if (plan.kind !== 'keep' && !this.closed && this.store.tickets.get(current.id)?.ended) {
        const result = await executeWorkspaceGc(ws.repository, plan)
        if (result.error) this.onError(new Error(`workspace.gc failed for ${current.id}: ${result.error}`))
      }
    })
  }

  private recordGate(point: string, key: string, sourceRef: string, ticketId: string | undefined, payload: Record<string, unknown>): void {
    if (this.closed) return
    const sessionId = ticketId ? `worker-${ticketId}` : undefined
    this.appendEvent({
      id: `gate:${point}:${key}:${this.bootId}:${++this.eventSeq}`,
      stream: ticketId ? `ticket:${ticketId}` : `outbox:${key}`,
      type: 'gate.evaluated',
      source: { kind: 'system', ref: sourceRef },
      evidence: sessionId ? [{ kind: 'event', ref: `session:${sessionId}` }, { kind: 'event', ref: `dsh-session:${sessionId}` }] : [],
      taint: 'trusted',
      payload: { point, ...(ticketId ? { ticketId, sessionPtr: `dsh-session:${sessionId}` } : {}), ...payload },
    })
  }

  private appendEvent(draft: SpineDraft<Record<string, unknown>>): void {
    this.appender.append(draft)
  }

  private ticketIdOf(event: DomainEvent): string | undefined {
    const data = event.data as Record<string, unknown>
    if (typeof data['ticketId'] === 'string') return data['ticketId']
    if (event.type === 'decision.recorded') return this.store.decisions.get(event.data.decisionId)?.ticketId
    return undefined
  }

  private repoLock(repoDir: string): GitRepoLock {
    const key = resolve(repoDir)
    let lock = this.repoLocks.get(key)
    if (!lock) {
      lock = new GitRepoLock()
      this.repoLocks.set(key, lock)
    }
    return lock
  }

  private trackTask(task: Promise<void>): void {
    this.pendingTasks.add(task)
    void task.finally(() => { this.pendingTasks.delete(task) })
  }
}
