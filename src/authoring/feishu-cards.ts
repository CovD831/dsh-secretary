/** 飞书 Card JSON 2.0 构建器、30KB/分块保护、3 秒自更新回调与 14 天滚动过期处理。 */
import type { ReplayReportCard } from '../rsi/types.ts'
import type { SourceRef } from '../spine/types.ts'
import type {
  AttributionCategory, BuiltFeishuCard, DepositDraft, EscalationCardRequest,
  EscalationRuling, ExpiredCardMeta, FeishuCallbackParseResult, FeishuCardElement,
  FeishuCardPayload, PendingEscalationRuling, RulingDecision,
} from './types.ts'

export const CARD_TTL_MS = 14 * 24 * 60 * 60 * 1000
const ATTRIBUTION_LABELS: Record<AttributionCategory, string> = {
  env_transient: '环境波动 (env_transient)', exec_mistake: '执行失误 (exec_mistake)',
  gate_gap: '判据缺口 (gate_gap)', mandate_unclear: '委托不清 (mandate_unclear)',
}
const DECISION_LABELS: Record<RulingDecision, string> = { approve: '批准', reject: '驳回', revise: '修改意见' }
const ATTRIBUTION_SET = new Set<string>(Object.keys(ATTRIBUTION_LABELS))
const DECISION_SET = new Set<string>(Object.keys(DECISION_LABELS))

const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const utf8Bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8')
const mdEl = (content: string): FeishuCardElement => ({ tag: 'markdown', content })
const btnEl = (text: string, type: string, value: Record<string, unknown>, extra: Record<string, unknown> = {}): FeishuCardElement => ({
  tag: 'button', text: { tag: 'plain_text', content: text }, type, value, ...extra,
})
const btnRow = (buttons: readonly FeishuCardElement[]): FeishuCardElement => ({
  tag: 'column_set', flex_mode: 'none',
  columns: buttons.map(b => ({ tag: 'column', width: 'auto', elements: [b] })),
})

function isValidSourceRef(ref: unknown): ref is SourceRef {
  return isRec(ref) && typeof ref['seq'] === 'number' && Number.isSafeInteger(ref['seq']) && ref['seq'] > 0
    && typeof ref['id'] === 'string' && ref['id'].trim().length > 0
}

function splitOversizedLine(line: string, maxChars: number): string[] {
  const out: string[] = []
  for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars))
  return out
}

/** 按段落与换行安全切分超长 markdown，防止单元素超过飞书 3000 字符上限。 */
export function splitMarkdownElements(text: string, maxChars = 2800): string[] {
  if (!text) return []
  const limit = Math.max(1, Math.floor(maxChars))
  if (text.length <= limit) return [text]
  const segments = text.split('\n').flatMap(l => (l.length <= limit ? [l] : splitOversizedLine(l, limit)))
  const chunks: string[] = []
  let cur = ''
  for (const seg of segments) {
    const candidate = cur === '' ? seg : `${cur}\n${seg}`
    if (candidate.length <= limit) cur = candidate
    else { if (cur !== '') chunks.push(cur); cur = seg }
  }
  if (cur !== '') chunks.push(cur)
  return chunks
}

/** 按 UTF-8 字节数核验整卡 ≤ 30KB，超限时将冗长详情截断为深链提示而非爆接口错误。 */
export function assertCardByteLimit(
  card: FeishuCardPayload,
  maxBytes = 30_000,
  detailUrl?: string,
): { readonly card: FeishuCardPayload; readonly byteLength: number; readonly truncated: boolean } {
  const initialBytes = utf8Bytes(card)
  if (initialBytes <= maxBytes) return { card, byteLength: initialBytes, truncated: false }
  const hintText = detailUrl ? `详情已截断，请查看完整内容：[查看详情](${detailUrl})` : '详情过长已截断，请前往面板查看完整上下文。'
  const safeHeader = card.header && card.header.title.content.length > 80
    ? { ...card.header, title: { tag: 'plain_text' as const, content: `${card.header.title.content.slice(0, 77)}…` } }
    : card.header
  const baseCard: FeishuCardPayload = { ...card, ...(safeHeader ? { header: safeHeader } : {}) }
  const interactive = baseCard.body.elements.filter(el => el['tag'] === 'form' || el['tag'] === 'column_set' || el['tag'] === 'action')
  const keptMd: FeishuCardElement[] = []
  let next: FeishuCardPayload = { ...baseCard, body: { elements: [mdEl(hintText), ...interactive] } }
  for (const el of baseCard.body.elements) {
    if (el['tag'] !== 'markdown') continue
    const candidate: FeishuCardPayload = { ...baseCard, body: { elements: [...keptMd, el, mdEl(hintText), ...interactive] } }
    if (utf8Bytes(candidate) <= maxBytes) { keptMd.push(el); next = candidate } else break
  }
  if (utf8Bytes(next) > maxBytes) {
    const hintOnly: FeishuCardPayload = { ...baseCard, body: { elements: [mdEl(hintText)] } }
    next = utf8Bytes(hintOnly) <= maxBytes ? hintOnly : { schema: '2.0', config: baseCard.config, body: { elements: [mdEl('详情过长已截断')] } }
  }
  return { card: next, byteLength: utf8Bytes(next), truncated: true }
}

export function computeCardExpiresAt(issuedAt: string): string {
  const ms = Date.parse(issuedAt)
  return Number.isFinite(ms) ? new Date(ms + CARD_TTL_MS).toISOString() : new Date(Date.now() + CARD_TTL_MS).toISOString()
}

export function isCardExpired(issuedAt: string, now: string | number = Date.now()): boolean {
  const issuedMs = Date.parse(issuedAt)
  const nowMs = typeof now === 'number' ? now : Date.parse(now)
  return Number.isFinite(issuedMs) && Number.isFinite(nowMs) ? nowMs >= issuedMs + CARD_TTL_MS : true
}

function finalizeCard(card: FeishuCardPayload, issuedAt: string, detailUrl?: string): BuiltFeishuCard {
  const expiresAt = computeCardExpiresAt(issuedAt)
  const checked = assertCardByteLimit(card, 30_000, detailUrl)
  return { card: checked.card, issuedAt, expiresAt, byteLength: checked.byteLength, truncated: checked.truncated }
}

/** 构建 Card JSON 2.0 四分法归因裁决卡（含 14 天过期时间与原地捕获开关）。 */
export function buildEscalationCard(req: EscalationCardRequest): BuiltFeishuCard {
  const expiresAt = computeCardExpiresAt(req.issuedAt)
  const attrOptions = (Object.entries(ATTRIBUTION_LABELS) as [AttributionCategory, string][]).map(([value, content]) => ({
    text: { tag: 'plain_text', content }, value,
  }))
  const baseVal = { action: 'escalation_ruling', escalationId: req.escalationId, ticketId: req.ticketId, issuedAt: req.issuedAt, ...(req.sourceRef ? { sourceRef: req.sourceRef } : {}) }
  const elements: FeishuCardElement[] = [
    ...splitMarkdownElements(req.summary).map(mdEl),
    ...(req.detailUrl ? [mdEl(`[查看完整上下文](${req.detailUrl})`)] : []),
    {
      tag: 'form', name: 'escalation_ruling_form',
      elements: [
        { tag: 'select_static', name: 'attribution', required: true, placeholder: { tag: 'plain_text', content: '选择四分法归因' }, ...(req.defaultAttribution ? { initial_option: req.defaultAttribution } : {}), options: attrOptions },
        { tag: 'checker', name: 'captureAsRule', checked: false, text: { tag: 'plain_text', content: '把这条立成规矩（原地捕获）' } },
        { tag: 'input', name: 'note', placeholder: { tag: 'plain_text', content: '裁决备注或修改意见（可选）' } },
        btnRow([
          btnEl('批准', 'primary', { ...baseVal, decision: 'approve' }, { action_type: 'form_submit', name: 'btn_approve' }),
          btnEl('驳回', 'danger', { ...baseVal, decision: 'reject' }, { action_type: 'form_submit', name: 'btn_reject' }),
          btnEl('修改意见', 'default', { ...baseVal, decision: 'revise' }, { action_type: 'form_submit', name: 'btn_revise' }),
        ]),
      ],
    },
    mdEl(`工单：\`${req.ticketId}\` · 卡片有效期至 \`${expiresAt}\``),
  ]
  return finalizeCard({
    schema: '2.0', config: { update_multi: true, wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: `需要裁决：${req.title}` } },
    body: { elements },
  }, req.issuedAt, req.detailUrl)
}

/** 将过期旧卡刷成「已过期，请在新卡操作」并生成滚动新卡。 */
export function buildExpiredCardReplacement(oldCardMeta: ExpiredCardMeta): { readonly expiredOldCard: BuiltFeishuCard; readonly replacementCard: BuiltFeishuCard } {
  const nowIso = oldCardMeta.now ?? new Date().toISOString()
  const replacementCard = buildEscalationCard({ ...oldCardMeta.request, issuedAt: nowIso })
  const expiredOldCard = finalizeCard({
    schema: '2.0', config: { update_multi: true },
    header: { template: 'grey', title: { tag: 'plain_text', content: `已过期：${oldCardMeta.request.title}` } },
    body: {
      elements: [
        mdEl(`**此卡已过期，请在新卡操作**（原卡发送于 \`${oldCardMeta.request.issuedAt}\`，已超 14 天 CardKit 寿命上限）。`),
        ...(oldCardMeta.request.detailUrl ? [mdEl(`[查看工单上下文](${oldCardMeta.request.detailUrl})`)] : []),
      ],
    },
  }, oldCardMeta.request.issuedAt, oldCardMeta.request.detailUrl)
  return { expiredOldCard, replacementCard }
}

/** 构建 S1 沉淀包草稿卡，对未答槽位显式标黄提示保守默认值。 */
export function buildDepositDraftCard(draft: DepositDraft, options: { readonly issuedAt?: string; readonly detailUrl?: string } = {}): BuiltFeishuCard {
  const issuedAt = options.issuedAt ?? new Date().toISOString()
  const unanswered = draft.unansweredSlots ?? []
  const paramLines = Object.entries(draft.params).map(([k, spec]) => `- \`${k}\`: ${spec.type}${spec.default !== undefined ? ` = ${JSON.stringify(spec.default)}` : ''}`)
  const summary = [
    `**意图**：${draft.intent}`,
    `**触发**：\`${draft.point}\` · \`${draft.trigger.on}\` (${draft.trigger.mode}) · 范围 \`${draft.scope}\``,
    `**输入面 (requires)**：${draft.requires.length > 0 ? draft.requires.map(r => `\`${r}\``).join(', ') : '无'}`,
    `**参数槽位 (params)**：\n${paramLines.length > 0 ? paramLines.join('\n') : '（无参数，仅限私有）'}`,
    `**例外**：${draft.exceptions.length > 0 ? draft.exceptions.join('；') : '暂无显式例外'}`,
    `**判据正文**：\n${draft.rubricBody}`,
  ].join('\n\n')
  const warningEl: FeishuCardElement[] = unanswered.length > 0
    ? [mdEl(`🟡 **未答槽位已采用保守默认值**（请重点核对）：${unanswered.map(s => `\`${s}\``).join('、')}`)]
    : []
  return finalizeCard({
    schema: '2.0', config: { update_multi: true, wide_screen_mode: true },
    header: { template: unanswered.length > 0 ? 'yellow' : 'blue', title: { tag: 'plain_text', content: `沉淀草稿：${draft.name} (${draft.id})` } },
    body: {
      elements: [
        ...warningEl, ...splitMarkdownElements(summary).map(mdEl),
        btnRow([btnEl('确认去定界', 'primary', { action: 'draft_confirm', draftId: draft.id }), btnEl('改', 'default', { action: 'draft_edit', draftId: draft.id }), btnEl('算了', 'danger', { action: 'draft_abandon', draftId: draft.id })]),
      ],
    },
  }, issuedAt, options.detailUrl)
}

/** 构建 S3 离线回放报告卡：强制双向展示误伤/漏检与分母、覆盖折扣及边际成本，明确影子为试穿期。 */
export function buildReplayReportCard(
  draft: DepositDraft,
  replayReport: ReplayReportCard,
  options: { readonly issuedAt?: string; readonly detailUrl?: string } = {},
): BuiltFeishuCard {
  const issuedAt = options.issuedAt ?? new Date().toISOString()
  const tokStr = replayReport.marginalCost.deltaTokens !== undefined ? `${replayReport.marginalCost.deltaTokens} tok` : '未测'
  const msStr = replayReport.marginalCost.deltaMs !== undefined ? `${replayReport.marginalCost.deltaMs} ms` : '未测'
  const body = [
    `**总样本**：${replayReport.totalCases} 例（触发 ${replayReport.triggeredCount}/${replayReport.totalCases}，净收益 ${replayReport.netBenefit}）`,
    `- **正确拦截（catches）**：${replayReport.catches}/${replayReport.totalCases}`,
    `- **误伤（falseBlocks）**：${replayReport.falseBlocks}/${replayReport.totalCases}`,
    `- **漏检（misses）**：${replayReport.misses}/${replayReport.totalCases}`,
    `- **未测（unmeasured）**：${replayReport.unmeasuredCount}/${replayReport.totalCases}`,
    `**覆盖折扣 (coverageDiscount)**：${(replayReport.coverageDiscount * 100).toFixed(1)}% (${replayReport.coverageDiscount.toFixed(3)})`,
    `**边际成本**：deltaTokens=${tokStr} · deltaMs=${msStr}（状态：${replayReport.marginalCost.state}）`,
  ].join('\n')
  return finalizeCard({
    schema: '2.0', config: { update_multi: true, wide_screen_mode: true },
    header: { template: replayReport.falseBlocks > 0 || replayReport.misses > 0 ? 'orange' : 'green', title: { tag: 'plain_text', content: `回放试穿报告：${draft.name}` } },
    body: {
      elements: [
        ...splitMarkdownElements(body).map(mdEl),
        btnRow([
          btnEl('装入影子试穿期（只记账不拦截）', 'primary', { action: 'install_shadow', draftId: draft.id }),
          btnEl('回 S1 修改', 'default', { action: 'back_to_draft', draftId: draft.id }),
          btnEl('放弃', 'danger', { action: 'draft_abandon', draftId: draft.id }),
        ]),
      ],
    },
  }, issuedAt, options.detailUrl)
}

/** 校验 card.action.trigger 负载（操作人鉴权、14 天过期、真实 SourceRef、幂等去重）并生成 <3s 锁态卡。 */
export function parseFeishuCardCallback(
  raw: unknown,
  options: {
    readonly seenCallbackIds?: Set<string>
    readonly now?: string
    readonly isAllowedOperator?: (openId: string) => boolean
    readonly verifiedSourceRef?: SourceRef
    readonly issuedAt?: string
  } = {},
): FeishuCallbackParseResult {
  if (!isRec(raw)) return { ok: false, reason: '回调负载必须为对象' }
  const header = isRec(raw['header']) ? raw['header'] : undefined
  const ev = isRec(raw['event']) ? raw['event'] : raw
  const operator = isRec(ev['operator']) ? ev['operator'] : undefined
  const operatorOpenId = typeof operator?.['open_id'] === 'string' ? operator['open_id'].trim() : ''
  if (!operatorOpenId) return { ok: false, reason: 'operator.open_id 不能为空' }
  if (options.isAllowedOperator && !options.isAllowedOperator(operatorOpenId)) return { ok: false, reason: 'unauthorized-operator' }
  const action = isRec(ev['action']) ? ev['action'] : undefined
  if (!action) return { ok: false, reason: '缺少 action 字段' }
  const val = isRec(action['value']) ? action['value'] : {}
  const form = isRec(action['form_value']) ? action['form_value'] : {}
  const ctx = isRec(ev['context']) ? ev['context'] : {}
  const decidedAt = options.now ?? new Date().toISOString()
  const issuedAt = options.issuedAt ?? (typeof val['issuedAt'] === 'string' ? val['issuedAt'] : undefined)
  if (issuedAt !== undefined && isCardExpired(issuedAt, decidedAt)) return { ok: false, reason: 'card-expired' }
  const ticketId = typeof val['ticketId'] === 'string' ? val['ticketId'].trim() : typeof form['ticketId'] === 'string' ? form['ticketId'].trim() : ''
  if (!ticketId) return { ok: false, reason: 'missing-ticket-id' }
  const decisionRaw = val['decision'] ?? form['decision']
  const attrRaw = form['attribution'] ?? val['attribution']
  if (typeof decisionRaw !== 'string' || !DECISION_SET.has(decisionRaw)) return { ok: false, reason: '缺少或非法的 decision（approve|reject|revise）' }
  if (typeof attrRaw !== 'string' || !ATTRIBUTION_SET.has(attrRaw)) return { ok: false, reason: '缺少或非法的四分法归因 attribution' }
  let sourceRef: SourceRef | undefined
  if (options.verifiedSourceRef !== undefined) {
    if (!isValidSourceRef(options.verifiedSourceRef)) return { ok: false, reason: 'invalid-source-ref' }
    sourceRef = options.verifiedSourceRef
  } else if (val['sourceRef'] !== undefined) {
    if (!isValidSourceRef(val['sourceRef'])) return { ok: false, reason: 'invalid-source-ref' }
    sourceRef = val['sourceRef']
  }
  const callbackId = [header?.['event_id'], raw['callback_id'], ev['token'], val['callbackId'], ctx['open_message_id']]
    .find(v => typeof v === 'string' && v.trim() !== '') as string | undefined ?? `${operatorOpenId}:${String(val['escalationId'] ?? '')}:${decisionRaw}`
  if (options.seenCallbackIds?.has(callbackId)) {
    return { ok: true, duplicate: true, callbackId, operatorOpenId, response: { toast: { type: 'info', content: '重复回调已幂等忽略' } } }
  }
  const escalationId = typeof val['escalationId'] === 'string' && val['escalationId'].trim() !== '' ? val['escalationId'].trim() : callbackId
  const noteRaw = form['note'] ?? val['note']
  const note = typeof noteRaw === 'string' && noteRaw.trim() !== '' ? noteRaw.trim() : undefined
  const capRaw = form['captureAsRule'] ?? val['captureAsRule']
  const captureAsRule = capRaw === true || capRaw === 'true' || capRaw === 1
  options.seenCallbackIds?.add(callbackId)
  const decision = decisionRaw as RulingDecision
  const attribution = attrRaw as AttributionCategory
  const pendingRuling: PendingEscalationRuling = { escalationId, ticketId, operatorOpenId, decision, attribution, ...(note ? { note } : {}), captureAsRule, decidedAt }
  const ruling: EscalationRuling | undefined = sourceRef ? { ...pendingRuling, sourceRef } : undefined
  const summaryLine = `已裁决：${DECISION_LABELS[decision]}（${ATTRIBUTION_LABELS[attribution]}） · 操作人 ${operatorOpenId} · ${decidedAt}`
  const lockedCard = assertCardByteLimit({
    schema: '2.0', config: { update_multi: true },
    header: { template: decision === 'approve' ? 'green' : decision === 'reject' ? 'red' : 'blue', title: { tag: 'plain_text', content: `已裁决：${DECISION_LABELS[decision]}` } },
    body: { elements: [mdEl(summaryLine), ...(note ? [mdEl(`**备注**：${note}`)] : []), ...(captureAsRule ? [mdEl('📌 已勾选「把这条立成规矩」，将自动进入 S1 草稿流程。')] : [])] },
  }, 30_000).card
  return { ok: true, duplicate: false, callbackId, operatorOpenId, pendingRuling, ...(ruling ? { ruling } : {}), response: { toast: { type: 'success', content: `${DECISION_LABELS[decision]}已记录` }, card: lockedCard } }
}
