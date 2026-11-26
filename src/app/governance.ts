/** 运行时治理编排中枢：串联 M0 事件脊、判局注册表、FTS5 记忆索引、工作区安全 GC 与发射前上下文胶囊。 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Assignment, DomainEvent, OutboundMessage, Ticket } from '../core/index.ts'
import { prepareLaunchCapsule, type PreparedLaunchCapsule } from '../executor/capsule-hook.ts'
import { adaptiveDispatchGate, verifyChangedPathsGate, verifyRerunGate } from '../judgement/gates/index.ts'
import { createJudgementRegistry, type ActionClass, type ExtendedJudgementRegistry, type Verdict } from '../judgement/index.ts'
import { MemoryFtsIndex, MemoryWriter, loadWorkspacePitfallNotes } from '../memory/index.ts'
import { domainEventToSpineDraft } from '../rsi/trace-bridge.ts'
import {
  GitRepoLock, createGitShardSink, createSpineAppender, createSpineFlusher, ensureSpineSchema, joinTaint,
  type FlushReport, type GitShardSink, type SourceRef, type SpineAppender, type SpineDraft, type SpineEnvelope, type SpineFlusher, type Taint,
} from '../spine/index.ts'
import {
  createWorkspaceRegistry, executeWorkspaceGc, findWorktreeObservation, isBranchMergedIntoBase,
  observeWorktrees, planWorkspaceGc, registerDispatchIsolationGate, registerWorkspaceGcGate,
  type GcSubject, type WorkspaceDef, type WorkspaceRegistry, type WorktreeObservation,
} from '../workspaces/index.ts'
import { collectPostTicketPatches, readSyncTailSeq, refreshSecretaryMemoryBlock, syncDepositsAndLedger } from './governance-ops.ts'
import { ingestFeishuCardAction, type FeishuCardIngestResult, type IngestFeishuCardOptions } from './governance-ruling.ts'
import { RulingQueue, type RulingItem } from './ruling-queue.ts'
import type { Store } from './store.ts'

export interface OutboxSendCtx { readonly message: OutboundMessage; readonly ticket?: Ticket }
declare module '../judgement/types.ts' {
  interface ScopeCatalog { outbox: true }
  interface PointCatalog { 'outbox.send': OutboxSendCtx }
}

export interface GovernanceOptions {
  readonly store: Store; readonly stateDir: string; readonly onError?: (error: unknown) => void; readonly now?: () => Date
  readonly onRulingQueued?: (item: RulingItem) => void; readonly onRulingDecided?: (item: RulingItem) => void
  readonly onSpineAppended?: (ref: SourceRef, draft: SpineDraft<Record<string, unknown>>) => void
}

const SHARD_NAME_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/

/** 串联 M0 事件脊、判局注册表、FTS5 派生索引、外发事前闸、发射切片与工作区自动 GC 的运行时治理中枢。 */
export class GovernanceRuntime {
  readonly storeRef: Store; readonly stateDir: string; readonly memoryDir: string; readonly memoryRepoLock: GitRepoLock
  readonly sink: GitShardSink; readonly flusher: SpineFlusher; readonly appender: SpineAppender
  readonly memory: MemoryWriter; readonly ftsIndex: MemoryFtsIndex; readonly registry: ExtendedJudgementRegistry
  readonly workspaces: WorkspaceRegistry; readonly rulings: RulingQueue
  secretaryMemoryCache = ''
  private readonly store: Store; private readonly onError: (error: unknown) => void; private readonly now: () => Date
  private readonly bootId = randomUUID().slice(0, 8); private readonly pendingTasks = new Set<Promise<void>>()
  private readonly repoLocks = new Map<string, GitRepoLock>()
  private eventSeq = 0; private shuttingDown = false; private closed = false

  constructor(options: GovernanceOptions) {
    this.store = options.store; this.storeRef = options.store; this.stateDir = options.stateDir
    this.onError = options.onError ?? (() => {}); this.now = options.now ?? (() => new Date())
    this.memoryDir = join(options.stateDir, 'memory'); this.memoryRepoLock = new GitRepoLock()

    ensureSpineSchema(this.store.db, readSyncTailSeq(this.memoryDir))
    this.sink = createGitShardSink({ dir: this.memoryDir, lock: this.memoryRepoLock })
    this.flusher = createSpineFlusher(this.store.db, this.sink, { onError: this.onError, now: this.now })
    const rawAppender = createSpineAppender(this.store, { kick: () => { if (!this.closed && !this.shuttingDown) this.flusher.kick() } })
    const cb = options.onSpineAppended
    this.appender = cb ? { append: <P>(draft: SpineDraft<P>) => { const ref = rawAppender.append(draft); this.store.afterCommit(() => cb(ref, draft as SpineDraft<Record<string, unknown>>)); return ref } } : rawAppender
    this.memory = new MemoryWriter({
      dir: this.memoryDir, lock: this.memoryRepoLock, resolveRef: ref => this.resolveSpineRefUnlocked(ref), now: this.now,
      onAuditEvent: draft => {
        if (!this.closed) {
          this.appendEvent(draft)
          void refreshSecretaryMemoryBlock(this, '', false).then(t => { this.secretaryMemoryCache = t }).catch(() => undefined)
        }
      },
    })
    this.ftsIndex = new MemoryFtsIndex({
      memoryDir: this.memoryDir, dbPath: join(options.stateDir, 'derived', 'memory-fts.sqlite'), now: this.now,
    })
    this.workspaces = createWorkspaceRegistry(this.store)
    this.rulings = new RulingQueue({
      store: this.store, appender: this.appender, memory: this.memory, memoryDir: this.memoryDir, memoryRepoLock: this.memoryRepoLock,
      now: this.now,
      ...(options.onRulingQueued ? { onQueued: options.onRulingQueued } : {}),
      ...(options.onRulingDecided ? { onDecided: options.onRulingDecided } : {}),
    })

    this.registry = createJudgementRegistry({ scopes: ['outbox'] })
    registerWorkspaceGcGate(this.registry, 'enforce')
    registerDispatchIsolationGate(this.registry, 'enforce')
    this.registry.register(adaptiveDispatchGate, 'enforce')
    this.registry.register(verifyChangedPathsGate, 'enforce')
    this.registry.register(verifyRerunGate, 'enforce')
  }

  latestSpineSeq(): number {
    if (!this.closed) {
      const row = this.store.db.prepare('SELECT MAX(seq) AS seq FROM event_spine').get() as { seq?: number | null } | undefined
      if (row && typeof row.seq === 'number' && row.seq > 0) return row.seq
    }
    return readSyncTailSeq(this.memoryDir)
  }

  async evaluateTicketDispatch(mandateCeiling: ActionClass, workspace?: WorkspaceDef, ticketId?: string): Promise<Verdict> {
    const ev = await this.registry.evaluate('ticket.dispatch', { mandateCeiling, ...(workspace ? { workspace } : {}) })
    if (ev.registered > 0 || ev.observed.length > 0) {
      this.recordGate('ticket.dispatch', ticketId ?? (workspace?.id ?? 'default'), 'governance.dispatch-isolation', ticketId, {
        mandateCeiling, ...(workspace ? { workspace: workspace.id, isolation: workspace.isolation } : {}), verdict: ev.verdict,
      })
    }
    return ev.verdict
  }

  nowDate(): Date { return this.now() }

  handleFeishuCardCallback(raw: unknown, options: IngestFeishuCardOptions): Promise<FeishuCardIngestResult> {
    return ingestFeishuCardAction({
      store: this.store, memoryDir: this.memoryDir, memoryRepoLock: this.memoryRepoLock,
      appender: this.appender, memory: this.memory, now: this.now,
    }, raw, options)
  }

  /** 启动恢复撕裂分片、自动发现并准入全部沉淀包、刷新只读 `LEDGER.md` 与 FTS5 派生索引。 */
  async recover(): Promise<FlushReport> {
    const report = await this.flusher.recover()
    await syncDepositsAndLedger(this).catch(err => this.onError(err))
    await this.ftsIndex.open().catch(err => this.onError(err))
    this.secretaryMemoryCache = await refreshSecretaryMemoryBlock(this, '', false).catch(() => '')
    return report
  }

  async flush(): Promise<FlushReport> {
    while (this.pendingTasks.size > 0) await Promise.allSettled([...this.pendingTasks])
    await new Promise<void>(r => queueMicrotask(r))
    return this.flusher.flush()
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    try {
      while (this.pendingTasks.size > 0) await Promise.allSettled([...this.pendingTasks])
      await new Promise<void>(r => queueMicrotask(r))
      await this.flusher.flush()
      await this.flusher.flush()
    } finally {
      this.ftsIndex.close()
      this.closed = true
    }
  }

  resolveSpineRef(ref: SourceRef): Promise<boolean> { return this.readSpineEnvelope(ref).then(Boolean) }

  readSpineEnvelope(ref: SourceRef): Promise<SpineEnvelope<Record<string, unknown>> | undefined> {
    if (!ref || !Number.isSafeInteger(ref.seq) || ref.seq <= 0 || typeof ref.id !== 'string' || !ref.id.trim()) return Promise.resolve(undefined)
    return this.memoryRepoLock.run(() => this.readSpineEnvelopeUnlocked(ref))
  }

  private async resolveSpineRefUnlocked(ref: SourceRef): Promise<boolean> { return (await this.readSpineEnvelopeUnlocked(ref)) !== undefined }

  private async readSpineEnvelopeUnlocked(ref: SourceRef): Promise<SpineEnvelope<Record<string, unknown>> | undefined> {
    if (!ref || !Number.isSafeInteger(ref.seq) || ref.seq <= 0 || typeof ref.id !== 'string' || !ref.id.trim()) return undefined
    if (!this.closed) {
      const row = this.store.db.prepare('SELECT id, value FROM event_spine WHERE seq = ?').get(ref.seq) as { id?: string; value?: string } | undefined
      if (row) return row.id === ref.id && row.value ? JSON.parse(row.value) as SpineEnvelope<Record<string, unknown>> : undefined
    }
    const m0Dir = join(this.memoryDir, 'm0')
    let shards: string[]
    try { shards = (await readdir(m0Dir)).filter(n => SHARD_NAME_RE.test(n)).sort() } catch { return undefined }
    for (let i = shards.length - 1; i >= 0; i--) {
      const raw = await readFile(join(m0Dir, shards[i]!), 'utf8').catch(() => '')
      const lines = (raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1)).split('\n')
      let maxInShard: number | undefined
      for (let j = lines.length - 1; j >= 0; j--) {
        const line = lines[j]?.trim()
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as SpineEnvelope<Record<string, unknown>>
          if (typeof parsed.seq !== 'number') continue
          maxInShard ??= parsed.seq
          if (parsed.seq === ref.seq) return parsed.id === ref.id ? parsed : undefined
        } catch { continue }
      }
      if (maxInShard !== undefined && maxInShard < ref.seq) return undefined
    }
    return undefined
  }

  recordDomainEvent(event: DomainEvent): void {
    if (this.closed) return
    const ticketId = this.ticketIdOf(event)
    const sessionId = ticketId ? `worker-${ticketId}` : undefined
    const sessionPtr = sessionId ? `dsh-session:${sessionId}` : undefined
    let taint: Taint | undefined
    if (event.type === 'trigger.received') {
      const trig = this.store.triggers.get(event.data.triggerId)
      const isLocalTrusted = trig?.source === 'secretary-bus' && trig.meta.localAuthenticated === true
      taint = isLocalTrusted ? 'trusted' : joinTaint('trusted', 'untrusted')
    }
    const draft = domainEventToSpineDraft(event, {
      id: `dom:${event.type}:${this.bootId}:${++this.eventSeq}`,
      ...(taint ? { taint } : {}), ...(sessionId ? { sessionId } : {}),
      ...(sessionPtr ? { evidence: [{ kind: 'event', ref: sessionPtr }] } : {}),
    })
    this.appendEvent({ ...draft, payload: { ...draft.payload, ...(ticketId ? { ticketId } : {}), ...(sessionPtr ? { sessionPtr } : {}) } })
  }

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

  /** 执行器首次发射前加载宿主派生的 M3 避坑经验、提取 1-Hop 切片与自适应派发方案并记入事件脊。 */
  async prepareLaunchCapsule(input: { ticket: Ticket; assignment: Assignment; workspaceDir: string; triggerText?: string }): Promise<PreparedLaunchCapsule | undefined> {
    const wsKey = input.ticket.execution?.workspace
    const pitfallNotes = wsKey
      ? await this.memoryRepoLock.run(() => loadWorkspacePitfallNotes(this.memoryDir, wsKey, this.now())).catch(() => [])
      : undefined
    return prepareLaunchCapsule({
      ...input, registry: this.registry,
      ...(pitfallNotes?.length ? { pitfallNotes } : {}),
      recordSpine: draft => { if (!this.closed) this.appendEvent({ ...draft, id: `${draft.id}:${this.bootId}:${++this.eventSeq}` }) },
    })
  }

  recordCapsuleUnmeasured(ticket: Ticket, assignment: Assignment, error: unknown): void {
    this.recordGate('ticket.adaptive-dispatch', `${ticket.id}:${assignment.id}`, 'executor.capsule-hook', ticket.id, {
      assignmentId: assignment.id,
      verdict: { kind: 'unmeasured', cause: 'threw', detail: error instanceof Error ? error.message : String(error) },
    })
  }

  onTicketEnded(ticket: Ticket): Promise<void> {
    if (this.closed || this.shuttingDown || !ticket.ended) return Promise.resolve()
    let resolveDone!: () => void
    const done = new Promise<void>(r => { resolveDone = r })
    this.store.afterCommit(() => {
      const task = this.runTicketEndedHooks(ticket).catch(error => { this.onError(error) }).finally(resolveDone)
      this.trackTask(task)
    })
    return done
  }

  private async runTicketEndedHooks(ticket: Ticket): Promise<void> {
    if (this.closed) return
    const current = this.store.tickets.get(ticket.id) ?? ticket
    await collectPostTicketPatches(this, current).catch(err => this.onError(err))
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
