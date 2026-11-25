import type { GateDef, Verdict } from '../types.ts'

export type RepoAiPolicy = 'allow' | 'require_disclosure' | 'forbid_ai_comments'
export type ReplyMessageKind = 'template_ack' | 'template_needs_info' | 'freeform_reply'

export interface ReplyDeskParams {
  readonly max_writes_per_min: number
  readonly max_writes_per_hour: number
}

export const DEFAULT_REPLY_DESK_PARAMS: ReplyDeskParams = Object.freeze({
  max_writes_per_min: 60,
  max_writes_per_hour: 400,
})

export interface ReplyDeskCtx {
  readonly repoAiPolicy?: RepoAiPolicy | string | null
  readonly messageKind?: ReplyMessageKind | string
  readonly body?: string
  readonly hasAiDisclosure?: boolean
  readonly humanApproved?: boolean
  readonly threadClosedOrResolved?: boolean | null
  readonly writesLastMinute?: number | null
  readonly writesLastHour?: number | null
  readonly params?: Partial<ReplyDeskParams>
}

declare module '../types.ts' {
  interface PointCatalog {
    'outward.reply-desk': ReplyDeskCtx
  }
}

const VALID_POLICIES = new Set<string>(['allow', 'require_disclosure', 'forbid_ai_comments'])
const VALID_MESSAGE_KINDS = new Set<string>(['template_ack', 'template_needs_info', 'freeform_reply'])

function validateParams(p: ReplyDeskParams): string | undefined {
  if (!Number.isFinite(p.max_writes_per_min) || p.max_writes_per_min < 1 || p.max_writes_per_min > 80) {
    return `参数 max_writes_per_min=${String(p.max_writes_per_min)} 超出允许范围 [1, 80]`
  }
  if (!Number.isFinite(p.max_writes_per_hour) || p.max_writes_per_hour < 1 || p.max_writes_per_hour > 500) {
    return `参数 max_writes_per_hour=${String(p.max_writes_per_hour)} 超出允许范围 [1, 500]`
  }
  return undefined
}

/** 对外 Reply Desk 合规门：执行目标仓 AI 政策、线程实时状态、限额熔断与自由文本人批约束。 */
export function evaluateReplyDesk(
  ctx: ReplyDeskCtx,
  boundParams?: Partial<ReplyDeskParams>,
): Verdict {
  const p: ReplyDeskParams = { ...DEFAULT_REPLY_DESK_PARAMS, ...ctx.params, ...boundParams }
  const paramErr = validateParams(p)
  if (paramErr) return { kind: 'deny', blockers: [paramErr] }

  const policyMissing = ctx.repoAiPolicy === undefined || ctx.repoAiPolicy === null || (typeof ctx.repoAiPolicy === 'string' && ctx.repoAiPolicy.trim() === '')
  const kindMissing = ctx.messageKind === undefined || ctx.messageKind === null || (typeof ctx.messageKind === 'string' && ctx.messageKind.trim() === '')
  const threadMissing = typeof ctx.threadClosedOrResolved !== 'boolean'
  const minMissing = typeof ctx.writesLastMinute !== 'number' || !Number.isFinite(ctx.writesLastMinute)
  const hourMissing = typeof ctx.writesLastHour !== 'number' || !Number.isFinite(ctx.writesLastHour)
  if (policyMissing || kindMissing || threadMissing || minMissing || hourMissing) {
    return {
      kind: 'unmeasured',
      cause: 'missing-input',
      detail: '缺少 repoAiPolicy、messageKind、threadClosedOrResolved 或写速率限额观测值，严禁盲发对外回复',
    }
  }

  if (typeof ctx.repoAiPolicy !== 'string' || !VALID_POLICIES.has(ctx.repoAiPolicy)) {
    return { kind: 'deny', blockers: [`未知目标仓 AI 政策 "${String(ctx.repoAiPolicy)}"`] }
  }
  if (typeof ctx.messageKind !== 'string' || !VALID_MESSAGE_KINDS.has(ctx.messageKind)) {
    return { kind: 'deny', blockers: [`未知消息类型 "${String(ctx.messageKind)}"`] }
  }
  if (ctx.writesLastMinute! < 0 || ctx.writesLastHour! < 0) {
    return { kind: 'deny', blockers: ['当前写速率计数不得为负数'] }
  }

  const blockers: string[] = []
  if (ctx.repoAiPolicy === 'forbid_ai_comments') {
    blockers.push('目标仓 AI 政策为 forbid_ai_comments（Ghostty 红线）：严禁 AI 生成社区评论')
  }
  if (ctx.repoAiPolicy === 'require_disclosure' && ctx.hasAiDisclosure !== true) {
    blockers.push('目标仓要求强制 AI 披露（require_disclosure），当前回复缺少披露标识')
  }
  if (ctx.threadClosedOrResolved === true) {
    blockers.push('目标线程已关闭或已解决，严禁发送过期回复')
  }
  if (ctx.writesLastMinute! >= p.max_writes_per_min || ctx.writesLastHour! >= p.max_writes_per_hour) {
    blockers.push(`触发 GitHub 内容生成限额熔断（${ctx.writesLastMinute}/${p.max_writes_per_min}/min, ${ctx.writesLastHour}/${p.max_writes_per_hour}/hr）：停批不重试`)
  }
  if (ctx.messageKind === 'freeform_reply' && ctx.humanApproved !== true) {
    blockers.push('自由文本（freeform_reply）严禁自动直发，必须经 Reply Desk 人工审批')
  }

  if (blockers.length > 0) return { kind: 'deny', blockers: blockers as [string, ...string[]] }
  return {
    kind: 'allow',
    produced: {
      deliveryTier: ctx.messageKind === 'freeform_reply' ? 'T1-human-approved' : 'T2-closed-template',
      repoAiPolicy: ctx.repoAiPolicy,
      hasAiDisclosure: ctx.hasAiDisclosure === true,
    },
  }
}

export function createReplyDeskGate(boundParams?: Partial<ReplyDeskParams>): GateDef<'outward.reply-desk'> {
  return {
    kind: 'gate',
    id: 'outward.reply-desk',
    version: 1,
    point: 'outward.reply-desk',
    description: 'Reply Desk 对外合规门：目标仓 AI 政策、线程重查、写限额熔断与自由文本人批校验',
    side: 'hard',
    placement: { timing: 'pre', enforce: true },
    requires: ['repoAiPolicy', 'messageKind', 'threadClosedOrResolved', 'writesLastMinute', 'writesLastHour'],
    gate: ctx => evaluateReplyDesk(ctx, boundParams),
  }
}

export const replyDeskGate: GateDef<'outward.reply-desk'> = createReplyDeskGate()
