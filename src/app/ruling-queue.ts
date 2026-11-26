/** 统一单件待裁队列：汇聚秘书发问、DSH 原生沙箱审批与系统熔断/副作用待裁，持久化并落盘 M0 与 M6。 */
import { randomUUID } from 'node:crypto'
import { KV } from '../kv.ts'
import { readMemoryPage, type MemoryWriter } from '../memory/index.ts'
import type { SourceRef, SpineAppender } from '../spine/types.ts'
import type { GitRepoLock } from '../spine/git-sink.ts'
import type { Store } from './store.ts'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export type RulingOrigin = 'secretary_ask' | 'dsh_approval' | 'system_escalation'
export type RulingStatus = 'pending' | 'decided' | 'cancelled'
export type RulingDecision = 'approve' | 'reject' | 'revise'
export type FourWayAttribution = 'missing_rule' | 'wrong_rule' | 'unmeasurable' | 'rule_conflict'

export interface RulingOption {
  readonly id: string
  readonly label: string
  readonly consequence: string
  readonly recommended?: boolean
}

export interface RulingItem {
  readonly id: string
  readonly kind: RulingOrigin
  readonly status: RulingStatus
  readonly createdAt: string
  readonly question: string
  readonly options: readonly RulingOption[]
  readonly allowFreeText: boolean
  readonly ticketId?: string
  readonly triggerId?: string
  readonly workspace?: string
  readonly sessionId?: string
  readonly toolName?: string
  readonly callId?: string
  readonly hostApprovalId?: string
  readonly escalationType?: 'unknown_side_effect' | 'runaway_breaker' | 'gate_escalation'
  readonly rawScore?: number
  readonly queuedRef?: SourceRef
  readonly decidedAt?: string
  readonly decision?: RulingDecision
  readonly selectedOptionId?: string
  readonly attribution?: FourWayAttribution
  readonly note?: string
  readonly actorId?: string
  readonly captureAsRule?: boolean
  readonly ruledRef?: SourceRef
}

export interface EnqueueRulingInput {
  readonly id?: string
  readonly kind: RulingOrigin
  readonly question: string
  readonly options?: readonly RulingOption[]
  readonly allowFreeText?: boolean
  readonly ticketId?: string
  readonly triggerId?: string
  readonly workspace?: string
  readonly sessionId?: string
  readonly toolName?: string
  readonly callId?: string
  readonly hostApprovalId?: string
  readonly escalationType?: 'unknown_side_effect' | 'runaway_breaker' | 'gate_escalation'
  readonly rawScore?: number
  readonly signal?: AbortSignal
}

export interface DecideRulingInput {
  readonly id: string
  readonly decision: RulingDecision
  readonly optionId?: string
  readonly attribution?: FourWayAttribution
  readonly note?: string
  readonly actorId: string
  readonly captureAsRule?: boolean
}

export interface RulingQueueDeps {
  readonly store: Pick<Store, 'get' | 'set' | 'atomic' | 'afterCommit'>
  readonly appender: SpineAppender
  readonly memory: MemoryWriter
  readonly memoryDir: string
  readonly memoryRepoLock: GitRepoLock
  readonly now?: () => Date
  readonly onQueued?: (item: RulingItem) => void
  readonly onDecided?: (item: RulingItem) => void
}

const defaultApprovalOptions = (highRisk: boolean): readonly RulingOption[] => [
  { id: 'approve', label: '放行本次操作', consequence: '允许当前工具调用继续执行一次', recommended: !highRisk },
  { id: 'reject', label: '拒绝并要求改方案', consequence: '拦截本次工具调用并将原因退回执行会话', recommended: highRisk },
]

const KIND_PRIORITY: Readonly<Record<RulingOrigin, number>> = {
  dsh_approval: 0,
  system_escalation: 1,
  secretary_ask: 2,
}

/** 管理单件优先呈递的持久化待裁队列，并维护进程内 DSH `approval/request` 挂起 Promise。 */
export class RulingQueue {
  private readonly resolvers = new Map<string, (outcome: ApprovalOutcome) => void>()
  private readonly now: () => Date

  constructor(private readonly deps: RulingQueueDeps) {
    this.now = deps.now ?? (() => new Date())
    this.cancelOrphanedApprovalsOnBoot()
  }

  private cancelOrphanedApprovalsOnBoot(): void {
    const items = this.readAll()
    let dirty = false
    const updated = items.map(item => {
      if (item.status === 'pending' && item.kind === 'dsh_approval') {
        dirty = true
        return { ...item, status: 'cancelled' as const, decidedAt: this.now().toISOString(), note: 'host-restarted' }
      }
      return item
    })
    if (dirty) this.deps.store.set(KV.governance.rulings, updated)
  }

  private readAll(): RulingItem[] {
    return [...(this.deps.store.get(KV.governance.rulings) ?? [])]
  }

  private saveAll(items: readonly RulingItem[]): void {
    const capped = items.length > 300 ? items.slice(items.length - 300) : [...items]
    this.deps.store.set(KV.governance.rulings, capped)
  }

  list(status?: RulingStatus): RulingItem[] {
    const all = this.readAll()
    return status ? all.filter(item => item.status === status) : all
  }

  get(id: string): RulingItem | undefined {
    return this.readAll().find(item => item.id === id)
  }

  /** 返回当前唯一呈递给老板的最高优最老待裁项及队列剩余数量。 */
  active(): { active: RulingItem | null; pendingCount: number } {
    const pending = this.readAll().filter(item => item.status === 'pending')
    pending.sort((a, b) => {
      const p = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]
      return p !== 0 ? p : a.createdAt.localeCompare(b.createdAt)
    })
    return { active: pending[0] ?? null, pendingCount: pending.length }
  }

  async enqueue(input: EnqueueRulingInput): Promise<RulingItem> {
    const id = input.id ?? `rul-${randomUUID().slice(0, 12)}`
    const createdAt = this.now().toISOString()
    const options = input.options?.length ? input.options : defaultApprovalOptions((input.rawScore ?? 0) >= 0.8)
    const allowFreeText = input.allowFreeText ?? true
    const item = this.deps.store.atomic(() => {
      const existing = this.get(id)
      if (existing) return existing
      const queuedRef = this.deps.appender.append({
        id: `ruling:queued:${id}`,
        at: createdAt,
        stream: input.ticketId ? `ticket:${input.ticketId}` : `ruling:${id}`,
        type: 'ruling.queued',
        source: { kind: input.kind === 'secretary_ask' ? 'secretary' : 'system', ref: `ruling-queue.${input.kind}` },
        evidence: input.sessionId ? [{ kind: 'event', ref: `session:${input.sessionId}` }] : [],
        taint: 'trusted',
        payload: {
          rulingId: id, kind: input.kind, question: input.question, options, allowFreeText,
          ...(input.ticketId ? { ticketId: input.ticketId } : {}),
          ...(input.workspace ? { workspace: input.workspace } : {}),
          ...(input.toolName ? { toolName: input.toolName } : {}),
          ...(input.callId ? { callId: input.callId } : {}),
          ...(input.hostApprovalId ? { hostApprovalId: input.hostApprovalId } : {}),
          ...(input.escalationType ? { escalationType: input.escalationType } : {}),
          ...(input.rawScore !== undefined ? { rawScore: input.rawScore } : {}),
        },
      })
      const created: RulingItem = {
        id, kind: input.kind, status: 'pending', createdAt, question: input.question, options, allowFreeText, queuedRef,
        ...(input.ticketId ? { ticketId: input.ticketId } : {}),
        ...(input.triggerId ? { triggerId: input.triggerId } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.toolName ? { toolName: input.toolName } : {}),
        ...(input.callId ? { callId: input.callId } : {}),
        ...(input.hostApprovalId ? { hostApprovalId: input.hostApprovalId } : {}),
        ...(input.escalationType ? { escalationType: input.escalationType } : {}),
        ...(input.rawScore !== undefined ? { rawScore: input.rawScore } : {}),
      }
      const all = this.readAll()
      all.push(created)
      this.saveAll(all)
      return created
    })

    if (item.queuedRef) {
      await this.deps.memory.upsertAttention({
        kind: item.kind === 'secretary_ask' ? 'verification' : 'ruling',
        question: `[${item.id}] ${item.question}`,
        sourceRefs: [item.queuedRef],
        ...(item.kind !== 'secretary_ask' ? { stickyTurns: 3 } : {}),
        delaySeen: 0,
        seenCount: 1,
      }, 'system').catch(() => undefined)
    }
    this.deps.onQueued?.(item)
    return item
  }

  /** 入队一条 DSH 原生 `approval/request` 并挂起等待老板拍板或信号取消（先挂 resolver 防并发抢跑死锁）。 */
  async requestDshApproval(input: Omit<EnqueueRulingInput, 'kind'>): Promise<ApprovalOutcome> {
    if (input.signal?.aborted) return 'cancelled'
    const id = input.id ?? `rul-${randomUUID().slice(0, 12)}`
    const { promise, resolve } = Promise.withResolvers<ApprovalOutcome>()
    this.resolvers.set(id, resolve)
    const onAbort = () => {
      if (!this.resolvers.has(id)) return
      this.resolvers.delete(id)
      this.cancel(id, 'signal-aborted')
      resolve('cancelled')
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.enqueue({ ...input, id, kind: 'dsh_approval' })
      const cur = this.get(id)
      if (cur?.status === 'decided' && this.resolvers.has(id)) {
        this.resolvers.delete(id)
        resolve(cur.decision === 'approve' ? 'allowed-once' : 'rejected')
      } else if (cur?.status === 'cancelled' && this.resolvers.has(id)) {
        this.resolvers.delete(id)
        resolve('cancelled')
      }
      return await promise
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      this.resolvers.delete(id)
    }
  }

  cancel(id: string, reason = 'cancelled'): RulingItem | undefined {
    return this.deps.store.atomic(() => {
      const all = this.readAll()
      const idx = all.findIndex(i => i.id === id)
      if (idx < 0 || all[idx]!.status !== 'pending') return all[idx]
      const updated: RulingItem = { ...all[idx]!, status: 'cancelled', decidedAt: this.now().toISOString(), note: reason }
      all[idx] = updated
      this.saveAll(all)
      const resolver = this.resolvers.get(id)
      if (resolver) { this.resolvers.delete(id); resolver('cancelled') }
      return updated
    })
  }

  /** 对待裁项作出裁决：写 M0 `escalation.ruled`（含四分归因与天然回填标签）、更新 M6 并唤醒挂起会话。 */
  async decide(input: DecideRulingInput): Promise<{ ok: true; item: RulingItem; duplicate: boolean } | { ok: false; reason: string }> {
    const existing = this.get(input.id)
    if (!existing) return { ok: false, reason: 'ruling-not-found' }
    if (existing.status === 'decided') return { ok: true, item: existing, duplicate: true }
    if (existing.status === 'cancelled') return { ok: false, reason: 'ruling-cancelled' }

    const decidedAt = this.now().toISOString()
    const updated = this.deps.store.atomic(() => {
      const all = this.readAll()
      const idx = all.findIndex(i => i.id === input.id)
      const cur = all[idx]!
      if (cur.status === 'decided') return cur
      const ruledRef = this.deps.appender.append({
        id: `ruling:decided:${cur.id}`,
        at: decidedAt,
        stream: cur.ticketId ? `ticket:${cur.ticketId}` : `ruling:${cur.id}`,
        type: 'escalation.ruled',
        ...(cur.queuedRef ? { causationId: cur.queuedRef.id } : {}),
        source: { kind: 'human', ref: input.actorId, actor: { source: 'secretary-bus', id: input.actorId } },
        evidence: cur.queuedRef ? [{ kind: 'event', ref: cur.queuedRef.id }] : [],
        taint: input.note ? 'derived' : 'trusted',
        payload: {
          escalationId: cur.id, rulingKind: cur.kind, decision: input.decision,
          ...(cur.ticketId ? { ticketId: cur.ticketId } : {}),
          ...(cur.workspace ? { workspace: cur.workspace } : {}),
          ...(cur.toolName ? { toolName: cur.toolName } : {}),
          ...(cur.rawScore !== undefined ? { rawScore: cur.rawScore, groundTruth: input.decision === 'approve' ? 'clean' : 'defect' } : {}),
          ...(input.optionId ? { optionId: input.optionId } : {}),
          ...(input.attribution ? { attribution: input.attribution } : {}),
          ...(input.note ? { note: input.note } : {}),
          captureAsRule: Boolean(input.captureAsRule),
          naturalLabel: 'L7:ruling_decided',
          decidedAt,
        },
      })
      const next: RulingItem = {
        ...cur, status: 'decided', decidedAt, decision: input.decision, actorId: input.actorId, ruledRef,
        ...(input.optionId ? { selectedOptionId: input.optionId } : {}),
        ...(input.attribution ? { attribution: input.attribution } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.captureAsRule !== undefined ? { captureAsRule: input.captureAsRule } : {}),
      }
      all[idx] = next
      this.saveAll(all)
      return next
    })

    const resolver = this.resolvers.get(updated.id)
    if (resolver) {
      this.resolvers.delete(updated.id)
      resolver(input.decision === 'approve' ? 'allowed-once' : 'rejected')
    }

    const ledger = await this.deps.memoryRepoLock.run(() => readMemoryPage(this.deps.memoryDir, 'm6/ledger.md')).catch(() => undefined)
    const m6Hit = ledger?.layer === 'm6'
      ? ledger.items.find(i => i.id === updated.id || i.question.startsWith(`[${updated.id}]`))
      : undefined
    if (m6Hit && m6Hit.status !== 'approved' && m6Hit.status !== 'dismissed' && m6Hit.status !== 'expired') {
      await this.deps.memory.transitionAttention(
        { id: m6Hit.id, action: input.decision === 'approve' ? 'approve' : 'dismiss' },
        input.actorId,
      ).catch(() => undefined)
    }
    this.deps.onDecided?.(updated)
    return { ok: true, item: updated, duplicate: false }
  }
}
