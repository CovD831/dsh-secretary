/** 运行时治理编排中枢：串联 M0 事件脊、判局注册表、工作区安全 GC 与发射前上下文胶囊。 */
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Assignment, DomainEvent, OutboundMessage, Ticket } from '../core/index.ts'
import { prepareLaunchCapsule, type PreparedLaunchCapsule } from '../executor/capsule-hook.ts'
import { adaptiveDispatchGate, verifyChangedPathsGate, verifyRerunGate } from '../judgement/gates/index.ts'
import { createJudgementRegistry, type ExtendedJudgementRegistry, type Verdict } from '../judgement/index.ts'
import { MemoryWriter } from '../memory/index.ts'
import { domainEventToSpineDraft } from '../rsi/trace-bridge.ts'
import {
  GitRepoLock, createGitShardSink, createSpineAppender, createSpineFlusher, ensureSpineSchema,
  type FlushReport, type GitShardSink, type SourceRef, type SpineAppender, type SpineDraft, type SpineFlusher,
} from '../spine/index.ts'
import {
  createWorkspaceRegistry, executeWorkspaceGc, findWorktreeObservation, isBranchMergedIntoBase,
  observeWorktrees, planWorkspaceGc, registerWorkspaceGcGate,
  type GcSubject, type WorkspaceRegistry, type WorktreeObservation,
} from '../workspaces/index.ts'
import { ingestFeishuCardAction, type FeishuCardIngestResult, type IngestFeishuCardOptions } from './governance-ruling.ts'
import type { Store } from './store.ts'

export interface OutboxSendCtx {
  readonly message: OutboundMessage
  readonly ticket?: Ticket
}

declare module '../judgement/types.ts' {
  interface ScopeCatalog { outbox: true }
  interface PointCatalog { 'outbox.send': OutboxSendCtx }
}

export interface GovernanceOptions {
  readonly store: Store
  readonly stateDir: string
  readonly onError?: (error: unknown) => void
  readonly now?: () => Date
}

const SHARD_NAME_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/

function readSyncTailSeq(memoryDir: string): number {
  const m0Dir = join(memoryDir, 'm0')
  let shards: string[]
  try { shards = readdirSync(m0Dir).filter(n => SHARD_NAME_RE.test(n)).sort() } catch { return 0 }
  for (let i = shards.length - 1; i >= 0; i--) {
    const fd = openSync(join(m0Dir, shards[i]!), 'r')
    try {
      const { size } = fstatSync(fd)
      for (let win = Math.min(size, 64 * 1024); size > 0; win = Math.min(size, win * 2)) {
        const offset = size - win, buf = Buffer.allocUnsafe(win)
        let filled = 0
        while (filled < win) { const n = readSync(fd, buf, filled, win - filled, offset + filled); if (n === 0) break; filled += n }
        const endNl = buf.subarray(0, filled).lastIndexOf(0x0a)
        if (endNl >= 0) {
          const lines = buf.subarray(0, endNl + 1).toString('utf8').split('\n')
          for (let j = lines.length - 1; j >= (offset > 0 ? 1 : 0); j--) {
            const line = lines[j]?.trim()
            if (!line) continue
            try { const seq = (JSON.parse(line) as { seq?: unknown }).seq; if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) return seq } catch { continue }
          }
        }
        if (offset === 0) break
      }
    } finally { closeSync(fd) }
  }
  return 0
}

/** 串联 M0 事件脊、判局注册表、外发事前闸、发射切片与工作区自动 GC 的运行时治理中枢。 */
export class GovernanceRuntime {
  readonly stateDir: string
  readonly memoryDir: string
  readonly memoryRepoLock: GitRepoLock
  readonly sink: GitShardSink
  readonly flusher: SpineFlusher
  readonly appender: SpineAppender
  readonly memory: MemoryWriter
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
    this.stateDir = options.stateDir
    this.onError = options.onError ?? (() => {})
    this.now = options.now ?? (() => new Date())
    this.memoryDir = join(options.stateDir, 'memory')
    this.memoryRepoLock = new GitRepoLock()

    ensureSpineSchema(this.store.db, readSyncTailSeq(this.memoryDir))
    this.sink = createGitShardSink({ dir: this.memoryDir, lock: this.memoryRepoLock })
    this.flusher = createSpineFlusher(this.store.db, this.sink, { onError: this.onError, now: this.now })
    this.appender = createSpineAppender(this.store, { kick: () => { if (!this.closed && !this.shuttingDown) this.flusher.kick() } })
    this.memory = new MemoryWriter({ dir: this.memoryDir, lock: this.memoryRepoLock, resolveRef: ref => this.resolveSpineRef(ref, true), now: this.now })
    this.workspaces = createWorkspaceRegistry(this.store)

    this.registry = createJudgementRegistry({ scopes: ['outbox'] })
    registerWorkspaceGcGate(this.registry, 'enforce')
    this.registry.register(adaptiveDispatchGate, 'enforce')
    this.registry.register(verifyChangedPathsGate, 'shadow')
    this.registry.register(verifyRerunGate, 'shadow')
  }

  /** 返回当前治理时钟时间。 */
  nowDate(): Date { return this.now() }

  /** 处理飞书卡片裁决回调：先鉴权与 M0 原子入脊拿真 SourceRef，事务提交后再路由 M2/M3/草稿与 M6。 */
  handleFeishuCardCallback(raw: unknown, options: IngestFeishuCardOptions): Promise<FeishuCardIngestResult> {
    return ingestFeishuCardAction({
      store: this.store, memoryDir: this.memoryDir, memoryRepoLock: this.memoryRepoLock,
      appender: this.appender, memory: this.memory, now: this.now,
    }, raw, options)
  }

  /** 启动恢复撕裂分片并对齐 `sqlite_sequence`。 */
  recover(): Promise<FlushReport> { return this.flusher.recover() }

  /** 等待全部在途后台治理任务完成后刷盘全部缓冲事件至 Git 分片。 */
  async flush(): Promise<FlushReport> {
    while (this.pendingTasks.size > 0) await Promise.allSettled([...this.pendingTasks])
    await new Promise<void>(r => queueMicrotask(r))
    return this.flusher.flush()
  }

  /** 在关库前停止新 kick、排空在途 GC 任务与微任务链式刷盘并封口。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    try {
      while (this.pendingTasks.size > 0) await Promise.allSettled([...this.pendingTasks])
      await new Promise<void>(r => queueMicrotask(r))
      await this.flusher.flush()
      await this.flusher.flush()
    } finally { this.closed = true }
  }

  /** 核验 M0 `SourceRef` 是否真实存在于 SQLite 缓冲或已落盘 Git 分片（防回滚撞号与伪造引用）。 */
  async resolveSpineRef(ref: SourceRef, holdsLock = false): Promise<boolean> {
    if (!ref || !Number.isSafeInteger(ref.seq) || ref.seq <= 0 || typeof ref.id !== 'string' || !ref.id.trim()) return false
    const check = async (): Promise<boolean> => {
      if (!this.closed) {
        const row = this.store.db.prepare('SELECT id FROM event_spine WHERE seq = ?').get(ref.seq) as { id?: string } | undefined
        if (row) return row.id === ref.id
      }
      const m0Dir = join(this.memoryDir, 'm0')
      let shards: string[]
      try { shards = (await readdir(m0Dir)).filter(n => SHARD_NAME_RE.test(n)).sort() } catch { return false }
      for (let i = shards.length - 1; i >= 0; i--) {
        const raw = await readFile(join(m0Dir, shards[i]!), 'utf8').catch(() => '')
        const cut = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1)
        const lines = cut.split('\n')
        let maxInShard: number | undefined
        for (let j = lines.length - 1; j >= 0; j--) {
          const line = lines[j]?.trim()
          if (!line) continue
          try {
            const parsed = JSON.parse(line) as { seq?: unknown; id?: unknown }
            if (typeof parsed.seq !== 'number') continue
            if (maxInShard === undefined) maxInShard = parsed.seq
            if (parsed.seq === ref.seq) return parsed.id === ref.id
          } catch { continue }
        }
        if (maxInShard !== undefined && maxInShard < ref.seq) return false
      }
      return false
    }
    return holdsLock ? check() : this.memoryRepoLock.run(check)
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
    this.appendEvent({ ...draft, payload: { ...draft.payload, ...(ticketId ? { ticketId } : {}), ...(sessionPtr ? { sessionPtr } : {}) } })
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
  prepareLaunchCapsule(input: { ticket: Ticket; assignment: Assignment; workspaceDir: string; triggerText?: string }): Promise<PreparedLaunchCapsule | undefined> {
    return prepareLaunchCapsule({
      ...input, registry: this.registry,
      recordSpine: draft => { if (!this.closed) this.appendEvent({ ...draft, id: `${draft.id}:${this.bootId}:${++this.eventSeq}` }) },
    })
  }

  /** 当发射切片钩子抛错降级时，向 M0 事件脊补记 `unmeasured` 审计记录。 */
  recordCapsuleUnmeasured(ticket: Ticket, assignment: Assignment, error: unknown): void {
    this.recordGate('ticket.adaptive-dispatch', `${ticket.id}:${assignment.id}`, 'executor.capsule-hook', ticket.id, {
      assignmentId: assignment.id,
      verdict: { kind: 'unmeasured', cause: 'threw', detail: error instanceof Error ? error.message : String(error) },
    })
  }

  /** 工单结束且绑定了已注册工作区时，于事务提交后异步探测真 Git 状态并安全执行 worktree GC。 */
  onTicketEnded(ticket: Ticket): Promise<void> {
    if (this.closed || this.shuttingDown || !ticket.ended || !this.workspaces.resolve(ticket)) return Promise.resolve()
    let resolveDone!: () => void
    const done = new Promise<void>(r => { resolveDone = r })
    this.store.afterCommit(() => {
      const task = this.runTicketEndedGc(ticket).catch(error => { this.onError(error) }).finally(resolveDone)
      this.trackTask(task)
    })
    return done
  }

  private async runTicketEndedGc(ticket: Ticket): Promise<void> {
    if (this.closed) return
    const current = this.store.tickets.get(ticket.id) ?? ticket
    const ws = current.ended ? this.workspaces.resolve(current) : undefined
    if (!ws || !current.execution?.directory) return
    await this.repoLock(ws.repository).run(async () => {
      let tree: WorktreeObservation | undefined, mergedIntoBase: boolean | undefined
      try {
        tree = findWorktreeObservation(await observeWorktrees(ws.repository), current.execution!.directory)
        if (tree?.branch) mergedIntoBase = await isBranchMergedIntoBase(ws.repository, tree.branch, ws.baseBranch)
      } catch { tree = undefined; mergedIntoBase = undefined }
      const subject: GcSubject = {
        ticket: { id: current.id, ended: current.ended, ...(current.follows ? { follows: current.follows } : {}), ...(current.execution ? { execution: current.execution } : {}) },
        ...(tree ? { tree } : {}), ...(mergedIntoBase !== undefined ? { mergedIntoBase } : {}), now: this.now().toISOString(),
      }
      const plan = await planWorkspaceGc(this.registry, subject)
      this.recordGate('workspace.gc', current.id, 'governance.workspace-gc', current.id, {
        workspace: ws.id, directory: current.execution!.directory, verdict: plan.kind === 'keep' ? plan.because : { kind: 'allow' }, plan,
      })
      // 仅在提交后再次确认工单仍处于结束状态且数据库尚未关闭时回收物理 worktree。
      if (plan.kind !== 'keep' && !this.closed && this.store.tickets.get(current.id)?.ended) {
        const result = await executeWorkspaceGc(ws.repository, plan)
        const sessionId = `worker-${current.id}`
        if (!this.closed) {
          this.appendEvent({
            id: `workspace.gc.executed:${current.id}:${this.bootId}:${++this.eventSeq}`,
            stream: `ticket:${current.id}`, type: 'workspace.gc.executed',
            source: { kind: 'system', ref: 'governance.workspace-gc' },
            evidence: [{ kind: 'event', ref: `session:${sessionId}` }, { kind: 'event', ref: `dsh-session:${sessionId}` }],
            taint: 'trusted',
            payload: {
              ticketId: current.id, sessionPtr: `dsh-session:${sessionId}`, workspace: ws.id, directory: current.execution!.directory,
              removed: result.removed, branchRemoved: result.branchRemoved,
              ...(result.branchPreserved ? { branchPreserved: result.branchPreserved } : {}),
              ...(result.error ? { error: result.error } : {}), plan: result.plan,
            },
          })
        }
        if (result.error) this.onError(new Error(`workspace.gc failed for ${current.id}: ${result.error}`))
      }
    })
  }

  private recordGate(point: string, key: string, sourceRef: string, ticketId: string | undefined, payload: Record<string, unknown>): void {
    if (this.closed) return
    const sessionId = ticketId ? `worker-${ticketId}` : undefined
    this.appendEvent({
      id: `gate:${point}:${key}:${this.bootId}:${++this.eventSeq}`,
      stream: ticketId ? `ticket:${ticketId}` : `outbox:${key}`, type: 'gate.evaluated',
      source: { kind: 'system', ref: sourceRef },
      evidence: sessionId ? [{ kind: 'event', ref: `session:${sessionId}` }, { kind: 'event', ref: `dsh-session:${sessionId}` }] : [],
      taint: 'trusted',
      payload: { point, ...(ticketId ? { ticketId, sessionPtr: `dsh-session:${sessionId}` } : {}), ...payload },
    })
  }

  private appendEvent(draft: SpineDraft<Record<string, unknown>>): void { this.appender.append(draft) }
  private ticketIdOf(event: DomainEvent): string | undefined {
    const data = event.data as Record<string, unknown>
    if (typeof data['ticketId'] === 'string') return data['ticketId']
    return event.type === 'decision.recorded' ? this.store.decisions.get(event.data.decisionId)?.ticketId : undefined
  }
  private repoLock(repoDir: string): GitRepoLock {
    const key = resolve(repoDir)
    let lock = this.repoLocks.get(key)
    if (!lock) { lock = new GitRepoLock(); this.repoLocks.set(key, lock) }
    return lock
  }
  private trackTask(task: Promise<void>): void {
    this.pendingTasks.add(task)
    void task.finally(() => { this.pendingTasks.delete(task) })
  }
}
