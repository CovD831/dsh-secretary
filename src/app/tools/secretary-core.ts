/** 中文私人秘书结构化五工具与桌面端主对话总线（飞书作为薄出口）。 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { liveTicket, reasonText, type ChannelRef, type Engine, type Outbox, type Ticket, type Trigger } from '../../core/index.ts'
import { WorktreeNameSchema } from '../assessment.ts'
import { ticketCard } from '../cards.ts'
import type { GovernanceRuntime } from '../governance.ts'
import type { Store } from '../store.ts'
import { KV } from '../../kv.ts'
import { tool, type Tool } from './tool.ts'

export type SecretaryExpression = 'neutral' | 'working' | 'happy' | 'concerned'

export interface SecretaryFeedEntry {
  readonly id: string
  readonly at: string
  readonly role: 'boss' | 'secretary'
  readonly kind: 'boss_message' | 'say' | 'ask' | 'handover' | 'dispatch' | 'memory_receipt'
  readonly text: string
  readonly expression?: SecretaryExpression
  readonly rulingId?: string
  readonly options?: readonly { id: string; label: string; consequence: string; recommended?: boolean }[]
  readonly handover?: { conclusion: string; reason: string; impact: string; evidenceRefs: readonly string[] }
  readonly memoryMeta?: { readonly entryId: string; readonly layer: string; readonly commit?: string; readonly supersededIds?: readonly string[] }
  readonly ticketId?: string
  readonly triggerId?: string
  readonly sourceRef?: { seq: number; id: string }
}

export interface SecretaryCoreHost {
  readonly store: Pick<Store, 'get' | 'set' | 'tickets' | 'triggers' | 'settings' | 'atomic'>
  readonly engine: Pick<Engine, 'receive' | 'decide' | 'note'>
  readonly outbox: Pick<Outbox, 'send'>
  readonly governance: GovernanceRuntime
  requestPass(): void
  quietly<T>(run: () => T): T
}

const EXPRESSION_BADGE: Readonly<Record<SecretaryExpression, string>> = {
  neutral: '🙂',
  working: '🛠️',
  happy: '✨',
  concerned: '⚠️',
}

/** 追加一条桌面端秘书动态并按 id 幂等去重，最多保留最近 200 条。 */
export function appendSecretaryFeed(store: Pick<Store, 'get' | 'set'>, entry: SecretaryFeedEntry): void {
  const prev = store.get(KV.governance.feed) ?? []
  if (prev.some(item => item.id === entry.id)) return
  const current = [...prev, entry]
  store.set(KV.governance.feed, current.length > 200 ? current.slice(current.length - 200) : current)
}

function resolveThinChannel(host: SecretaryCoreHost, triggerId?: string, ticketId?: string): ChannelRef | undefined {
  if (triggerId) {
    const trig = host.store.triggers.get(triggerId)
    if (trig?.channel && trig.channel.source !== 'secretary-bus') return trig.channel
  }
  if (ticketId) {
    const ticket = host.store.tickets.get(ticketId)
    const ch = ticket?.channels.find(c => c.source !== 'secretary-bus')
    if (ch) return ch
  }
  return undefined
}

function forwardToThinAdapter(host: SecretaryCoreHost, id: string, text: string, triggerId?: string, ticketId?: string): boolean {
  const channel = resolveThinChannel(host, triggerId, ticketId)
  if (!channel) return false
  const clipped = text.length > 400 ? `${text.slice(0, 397)}…` : text
  host.outbox.send({ id: `sec-out:${id}`, channel, text: clipped, kind: 'notice', ...(ticketId ? { ticketId } : {}) })
  return true
}

/** 桌面端老板直接向秘书总线发话：走 Engine 正门生成受信任本地 Trigger 并送交主会话。 */
export function ingestBossDesktopMessage(
  host: Pick<SecretaryCoreHost, 'store' | 'engine' | 'governance' | 'requestPass'>,
  text: string,
  threadId?: string,
): { trigger: Trigger; received: string } {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('消息内容不能为空')
  const id = `desk-${randomUUID().slice(0, 12)}`
  const resolvedThreadId = threadId?.trim() ? threadId.trim() : id
  const at = host.governance.nowDate().toISOString()
  const trigger: Trigger = {
    id,
    source: 'secretary-bus',
    threads: [{ source: 'secretary-bus', id: resolvedThreadId }],
    actor: { source: 'secretary-bus', id: 'boss' },
    human: true,
    addressed: 'direct',
    at,
    text: trimmed,
    meta: { localAuthenticated: true },
  }
  const received = host.engine.receive(trigger)
  appendSecretaryFeed(host.store, { id: trigger.id, at, role: 'boss', kind: 'boss_message', text: trimmed, triggerId: trigger.id })
  host.requestPass()
  return { trigger, received }
}

const SaySchema = z.object({
  text: z.string().trim().min(1).max(240).describe('不超过 240 字的简短直接回复，第一句先给结论。'),
  expression: z.enum(['neutral', 'working', 'happy', 'concerned']).default('neutral'),
  trigger_id: z.string().optional(),
  ticket_id: z.string().optional(),
}).strict()

const AskOptionSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
  consequence: z.string().trim().min(1).max(160),
  recommended: z.boolean().default(false),
}).strict()

const AskSchema = z.object({
  question: z.string().trim().min(1).max(300),
  options: z.array(AskOptionSchema).min(1).max(3),
  allow_free_text: z.boolean().default(true),
  ticket_id: z.string().optional(),
  trigger_id: z.string().optional(),
  workspace: z.string().optional(),
}).strict()

const HandoverSchema = z.object({
  conclusion: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
  impact: z.string().trim().min(1).max(1000),
  evidence_refs: z.array(z.string().trim().min(1).max(200)).default([]),
  ticket_id: z.string().optional(),
  trigger_id: z.string().optional(),
}).strict()

const DispatchSchema = z.object({
  title: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(1500),
  acceptance: z.string().trim().min(1).max(1000),
  verify_commands: z.array(z.string().trim().min(1).max(300)).min(1).max(10),
  dispatch_key: z.string().trim().min(1).max(80),
  worktree_name: WorktreeNameSchema,
  workspace: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
  trigger_id: z.string().optional(),
}).strict()

const StatusSchema = z.object({
  ticket_id: z.string().optional(),
  workspace: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(10),
}).strict()

/** 构造挂入主会话的中文私人秘书五工具（say / ask / handover / dispatch / status）。 */
export function secretaryCoreTools(host: SecretaryCoreHost): Tool[] {
  const { governance: gov } = host
  return [
    tool({
      name: 'secretary_say',
      description: '对老板说话（不超过 240 字，带表情），日常确认与简短直接回复专用。',
      schema: SaySchema,
      execute: async args => {
        const id = `say-${randomUUID().slice(0, 10)}`
        const at = gov.nowDate().toISOString()
        const sourceRef = host.store.atomic(() => {
          const ref = gov.appender.append({
            id: `secretary:say:${id}`, at, stream: 'secretary:dialog', type: 'secretary.say',
            source: { kind: 'secretary', ref: 'secretary_say' }, evidence: [], taint: 'trusted',
            payload: { text: args.text, expression: args.expression, ...(args.ticket_id ? { ticketId: args.ticket_id } : {}) },
          })
          appendSecretaryFeed(host.store, {
            id, at, role: 'secretary', kind: 'say', text: args.text, expression: args.expression, sourceRef: ref,
            ...(args.ticket_id ? { ticketId: args.ticket_id } : {}), ...(args.trigger_id ? { triggerId: args.trigger_id } : {}),
          })
          return ref
        })
        const forwarded = forwardToThinAdapter(host, id, `${EXPRESSION_BADGE[args.expression]} ${args.text}`, args.trigger_id, args.ticket_id)
        return { ok: true, id, source_ref: sourceRef, forwarded }
      },
    }),
    tool({
      name: 'secretary_ask',
      description: '向老板提出单件事待裁问题（最多 3 个选项，写明后果与推荐项），自动进入统一单件待裁队列。',
      schema: AskSchema,
      execute: async args => {
        const item = await gov.rulings.enqueue({
          kind: 'secretary_ask', question: args.question, options: args.options, allowFreeText: args.allow_free_text,
          ...(args.ticket_id ? { ticketId: args.ticket_id } : {}),
          ...(args.trigger_id ? { triggerId: args.trigger_id } : {}),
          ...(args.workspace ? { workspace: args.workspace } : {}),
        })
        host.store.atomic(() => {
          appendSecretaryFeed(host.store, {
            id: item.id, at: item.createdAt, role: 'secretary', kind: 'ask', text: args.question,
            rulingId: item.id, options: args.options, ...(item.queuedRef ? { sourceRef: item.queuedRef } : {}),
            ...(args.ticket_id ? { ticketId: args.ticket_id } : {}), ...(args.trigger_id ? { triggerId: args.trigger_id } : {}),
          })
        })
        const optLines = args.options.map((o, i) => `${i + 1}. ${o.label}${o.recommended ? '（推荐）' : ''} — ${o.consequence}`).join('\n')
        const forwarded = forwardToThinAdapter(host, item.id, `需要您拍板：${args.question}\n${optLines}`, args.trigger_id, args.ticket_id)
        return { ok: true, ruling_id: item.id, source_ref: item.queuedRef, forwarded }
      },
    }),
    tool({
      name: 'secretary_handover',
      description: '三段式长汇报（结论、理由、影响）及证据引用，适用于自我介绍、验收总结与复杂说明。',
      schema: HandoverSchema,
      execute: async args => {
        const id = `handover-${randomUUID().slice(0, 10)}`
        const at = gov.nowDate().toISOString()
        const text = `【结论】${args.conclusion}\n【理由】${args.reason}\n【影响】${args.impact}`
        const sourceRef = host.store.atomic(() => {
          const ref = gov.appender.append({
            id: `secretary:handover:${id}`, at, stream: args.ticket_id ? `ticket:${args.ticket_id}` : 'secretary:dialog',
            type: 'secretary.handover', source: { kind: 'secretary', ref: 'secretary_handover' },
            evidence: args.evidence_refs.map(r => ({ kind: 'event' as const, ref: r })), taint: 'trusted',
            payload: { conclusion: args.conclusion, reason: args.reason, impact: args.impact, evidenceRefs: args.evidence_refs,
              ...(args.ticket_id ? { ticketId: args.ticket_id } : {}) },
          })
          appendSecretaryFeed(host.store, {
            id, at, role: 'secretary', kind: 'handover', text, sourceRef: ref,
            handover: { conclusion: args.conclusion, reason: args.reason, impact: args.impact, evidenceRefs: args.evidence_refs },
            ...(args.ticket_id ? { ticketId: args.ticket_id } : {}), ...(args.trigger_id ? { triggerId: args.trigger_id } : {}),
          })
          return ref
        })
        const forwarded = forwardToThinAdapter(host, id, text, args.trigger_id, args.ticket_id)
        return { ok: true, id, source_ref: sourceRef, forwarded }
      },
    }),
    tool({
      name: 'secretary_dispatch',
      description: '派活给独立工作区会话，必须附带可独立复查的验收标准、验证命令与稳定 dispatch_key。',
      schema: DispatchSchema,
      execute: async args => {
        const wsList = gov.workspaces.list()
        const targetWs = args.workspace ? wsList.find(w => w.id === args.workspace) : wsList[0]
        if (args.workspace && !targetWs) {
          return { ok: false, refused: `未知工作区 "${args.workspace}"，已配置工作区: ${wsList.map(w => w.id).join(', ') || '无'}` }
        }
        const isoEval = await gov.evaluateTicketDispatch('local-write', targetWs)
        if (isoEval.kind === 'deny') return { ok: false, refused: isoEval.blockers.join('; ') }

        const existing = host.store.tickets.open().find(t => t.execution?.dispatchKey === args.dispatch_key)
        if (existing && liveTicket(existing)) {
          host.quietly(() => host.engine.note(existing.id, `补充要求 (${args.dispatch_key}): ${args.objective} | 验收: ${args.acceptance}`))
          host.requestPass()
          return { ok: true, reused: true, dispatch_key: args.dispatch_key, ticket: ticketCard(existing) }
        }

        const originTrigger = args.trigger_id ? host.store.triggers.get(args.trigger_id) : undefined
        if (!args.trigger_id || !originTrigger) {
          return { ok: false, refused: '必须提供真实已记录的 trigger_id 以溯源授权与污点等级，禁止合成老板授权派单' }
        }
        const triggerId = originTrigger.id
        const effectiveVerifyCmds = targetWs?.verifyCommands?.length ? [...targetWs.verifyCommands] : args.verify_commands
        const verifyBlock = `\`\`\`verify\n${effectiveVerifyCmds.join('\n')}\n\`\`\``
        const scope = `${args.objective}\n\n验收标准：${args.acceptance}\n${verifyBlock}`
        const decision = host.quietly(() => host.engine.decide(triggerId, {
          kind: 'accept', title: args.title, scope, reason: { code: 'explicitRouted' },
          name: args.worktree_name, note: `验收标准: ${args.acceptance.slice(0, 80)}`,
          ...(targetWs ? { workspace: targetWs.id } : {}),
          dispatchKey: args.dispatch_key,
          verifyCommands: effectiveVerifyCmds,
        }))
        if (decision.kind !== 'accept' || !decision.ticketId) {
          return { ok: false, refused: `派单未创建成功: ${reasonText(decision.reason)}` }
        }
        const created = host.store.tickets.get(decision.ticketId)!
        appendSecretaryFeed(host.store, {
          id: `feed-disp-${created.id}`, at: gov.nowDate().toISOString(), role: 'secretary', kind: 'dispatch',
          text: `已派发工单「${created.title}」(${created.id})`, ticketId: created.id, triggerId,
        })
        host.requestPass()
        return { ok: true, reused: false, accepted: true, dispatch_key: args.dispatch_key, ticket: ticketCard(created) }
      },
    }),
    tool({
      name: 'secretary_status',
      description: '查询工单状态、统一待裁队列与最近事件脊记录；未查到时如实返回 found=false（没查到）。',
      schema: StatusSchema,
      execute: async args => {
        if (args.ticket_id) {
          const found = host.store.tickets.get(args.ticket_id)
          if (!found) return { found: false, message: '没查到对应工单记录', rulings: gov.rulings.active() }
          return {
            found: true,
            ticket: {
              ...ticketCard(found),
              workspace: found.execution?.workspace ?? null,
              dispatch_key: found.execution?.dispatchKey ?? null,
              execution_mode: found.execution?.executionMode ?? null,
              thinking_tier: found.execution?.thinkingTier ?? null,
              external_side_effects: found.execution?.externalSideEffects ?? [],
            },
            rulings: gov.rulings.active(),
          }
        }
        const allTickets = host.store.tickets.list()
          .filter(t => !args.workspace || t.execution?.workspace === args.workspace)
          .slice(0, args.limit)
          .map(t => ({ ...ticketCard(t), workspace: t.execution?.workspace ?? null, dispatch_key: t.execution?.dispatchKey ?? null }))
        return {
          found: allTickets.length > 0,
          ...(allTickets.length === 0 ? { message: '没查到工单记录' } : {}),
          tickets: allTickets,
          rulings: gov.rulings.active(),
          workspaces: gov.workspaces.list().map(w => ({ id: w.id, isolation: w.isolation, baseBranch: w.baseBranch })),
          latest_spine_seq: gov.latestSpineSeq(),
        }
      },
    }),
  ]
}
