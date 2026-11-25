/** 飞书卡片裁决回调闭环：操作人鉴权、M0 原子入脊拿真 SourceRef、防重判与崩溃可重入落盘。 */
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  parseFeishuCardCallback, routeEscalationRuling, telemetryToSpineInput, toMemoryProposal,
  type EscalationRouteResult, type EscalationRuling, type FeishuCardCallbackResponse,
} from '../authoring/index.ts'
import { readMemoryPage, type AttentionItem, type M2Kind, type MemoryWriter, type WriteResult } from '../memory/index.ts'
import { allowedSender } from '../policy.ts'
import { GitRepoLock, redactValue, type SourceRef, type SpineAppender, type SpineEnvelope } from '../spine/index.ts'
import type { Store } from './store.ts'

export interface FeishuCardIngestDeps {
  readonly store: Pick<Store, 'db' | 'atomic' | 'afterCommit' | 'tickets' | 'settings'>
  readonly memoryDir: string
  readonly memoryRepoLock: GitRepoLock
  readonly appender: SpineAppender
  readonly memory: MemoryWriter
  readonly now?: () => Date
}

export interface IngestFeishuCardOptions {
  readonly isAllowedOperator: (openId: string) => boolean
  readonly workspace?: string
  readonly point?: string
  readonly intent?: string
  readonly m2Kind?: M2Kind
  readonly personId?: string
  readonly slug?: string
}

export type FeishuCardIngestResult =
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true
      readonly duplicate: boolean
      readonly alreadyRuled?: boolean
      readonly callbackId: string
      readonly sourceRef: SourceRef
      readonly ruling: EscalationRuling
      readonly routed?: EscalationRouteResult
      readonly memoryWrite?: WriteResult
      readonly draftPath?: string
      readonly attentionUpdated?: boolean
      readonly attentionItem?: AttentionItem
      readonly response: FeishuCardCallbackResponse
    }

const SHARD_NAME_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const SAFE_DRAFT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const rulingQueues = new WeakMap<object, GitRepoLock>()
const getRulingQueue = (store: object): GitRepoLock => {
  let lock = rulingQueues.get(store)
  if (!lock) { lock = new GitRepoLock(); rulingQueues.set(store, lock) }
  return lock
}

/** 按权限策略构造飞书卡片回调操作人鉴权器（仅 `policy.sources.feishu.allowed` 在册成员通过）。 */
export function createFeishuOperatorAuthorizer(store: Pick<Store, 'settings'>): (openId: string) => boolean {
  return (openId: string) => Boolean(allowedSender(store.settings(), { source: 'feishu', id: openId }))
}

interface RulingScan {
  ruledByCallback?: { ref: SourceRef; envelope: SpineEnvelope<Record<string, unknown>> }
  appliedByEscalation?: { ref: SourceRef; envelope: SpineEnvelope<Record<string, unknown>> }
}

async function scanRulingState(
  deps: Pick<FeishuCardIngestDeps, 'store' | 'memoryDir' | 'memoryRepoLock'>,
  callbackEventId: string,
  escalationId: string,
): Promise<RulingScan> {
  const out: RulingScan = {}
  const inspect = (env: SpineEnvelope<Record<string, unknown>>) => {
    if (!Number.isSafeInteger(env.seq) || env.seq <= 0) return
    if (!out.ruledByCallback && env.id === callbackEventId && env.type === 'escalation.ruled') {
      out.ruledByCallback = { ref: { seq: env.seq, id: env.id }, envelope: env }
    }
    if (!out.appliedByEscalation && env.type === 'escalation.applied' && env.payload?.['escalationId'] === escalationId) {
      out.appliedByEscalation = { ref: { seq: env.seq, id: env.id }, envelope: env }
    }
  }
  const scanSqlite = () => {
    const rows = deps.store.db.prepare("SELECT value FROM event_spine WHERE id = ? OR value LIKE '%\"escalation.applied\"%'").all(callbackEventId) as { value: string }[]
    for (const r of rows) {
      try { if (r.value) inspect(JSON.parse(r.value) as SpineEnvelope<Record<string, unknown>>) } catch { continue }
    }
  }
  scanSqlite()
  if (out.ruledByCallback && out.appliedByEscalation) return out
  await deps.memoryRepoLock.run(async () => {
    scanSqlite()
    if (out.ruledByCallback && out.appliedByEscalation) return
    const m0Dir = join(deps.memoryDir, 'm0')
    let shards: string[]
    try { shards = (await readdir(m0Dir)).filter(n => SHARD_NAME_RE.test(n)).sort() } catch { return }
    for (let i = shards.length - 1; i >= 0; i--) {
      const raw = await readFile(join(m0Dir, shards[i]!), 'utf8').catch(() => '')
      const cut = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1)
      const lines = cut.split('\n')
      for (let j = lines.length - 1; j >= 0; j--) {
        const line = lines[j]?.trim()
        if (!line) continue
        try { inspect(JSON.parse(line) as SpineEnvelope<Record<string, unknown>>) } catch { continue }
        if (out.ruledByCallback && out.appliedByEscalation) return
      }
    }
  })
  return out
}

function extractActionWorkspace(raw: unknown): string | undefined {
  if (!isRec(raw)) return undefined
  const ev = isRec(raw['event']) ? raw['event'] : raw
  const action = isRec(ev['action']) ? ev['action'] : undefined
  const val = action && isRec(action['value']) ? action['value'] : undefined
  const ws = val?.['workspace']
  return typeof ws === 'string' && ws.trim() ? ws.trim() : undefined
}

function sanitizeDraftId(rawId: string): string {
  const cleaned = rawId.replace(/\.{2,}/g, '-').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  return cleaned || 'friction-captured'
}

async function writeDepositDraftFile(stateDir: string, draftId: string, content: string): Promise<string> {
  if (!SAFE_DRAFT_ID_RE.test(draftId) || draftId.includes('..')) throw new Error(`非法沉淀草稿 id: ${draftId}`)
  const draftsRoot = resolve(stateDir, 'deposit-drafts')
  const checkNotSymlink = async (p: string) => {
    try { if ((await lstat(p)).isSymbolicLink()) throw new Error(`拒绝写入符号链接路径: ${p}`) }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
  }
  await checkNotSymlink(draftsRoot)
  await mkdir(draftsRoot, { recursive: true })
  const rootReal = await realpath(draftsRoot)
  const target = resolve(rootReal, `${draftId}.json`)
  const rel = relative(rootReal, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`沉淀草稿路径越界: ${draftId}`)
  await checkNotSymlink(target)
  await writeFile(target, content, 'utf8')
  return target
}

/** 飞书卡片裁决全闭环：鉴权 -> 串行查重 -> M0 入脊拿真 SourceRef -> 提交后落盘与记录 applied。 */
export function ingestFeishuCardAction(
  deps: FeishuCardIngestDeps,
  raw: unknown,
  options: IngestFeishuCardOptions,
): Promise<FeishuCardIngestResult> {
  return getRulingQueue(deps.store).run(() => runIngest(deps, raw, options))
}

async function runIngest(
  deps: FeishuCardIngestDeps,
  raw: unknown,
  options: IngestFeishuCardOptions,
): Promise<FeishuCardIngestResult> {
  const nowIso = (deps.now ?? (() => new Date()))().toISOString()
  const parsed = parseFeishuCardCallback(raw, { now: nowIso, isAllowedOperator: options.isAllowedOperator })
  if (!parsed.ok) return { ok: false, reason: parsed.reason }

  const pending = parsed.pendingRuling!
  const eventId = `feishu:card:${parsed.callbackId}`
  const dupResponse: FeishuCardCallbackResponse = {
    toast: { type: 'info', content: '重复回调已幂等忽略' },
    ...(parsed.response.card ? { card: parsed.response.card } : {}),
  }

  const scan = await scanRulingState(deps, eventId, pending.escalationId)
  if (scan.appliedByEscalation) {
    const appliedRef = (scan.appliedByEscalation.envelope.payload?.['ruledRef'] as SourceRef | undefined) ?? scan.appliedByEscalation.ref
    if (!scan.ruledByCallback) {
      deps.appender.append({
        id: `feishu:revised:${parsed.callbackId}`, at: nowIso, stream: `ticket:${pending.ticketId}`, type: 'escalation.revised',
        source: { kind: 'human', ref: parsed.operatorOpenId, actor: { source: 'feishu', id: parsed.operatorOpenId } },
        evidence: [{ kind: 'event', ref: eventId }], taint: pending.note ? 'derived' : 'trusted',
        payload: { callbackId: parsed.callbackId, escalationId: pending.escalationId, decision: pending.decision, attribution: pending.attribution },
      })
    }
    return {
      ok: true, duplicate: true, alreadyRuled: true, callbackId: parsed.callbackId,
      sourceRef: appliedRef, ruling: { ...pending, sourceRef: appliedRef }, response: dupResponse,
    }
  }

  // 若已有 escalation.ruled 但无 escalation.applied，说明上次下游落盘前崩溃，沿用原 SourceRef 重跑下游。
  let sourceRef: SourceRef
  if (scan.ruledByCallback) {
    sourceRef = scan.ruledByCallback.ref
  } else {
    sourceRef = deps.store.atomic(() => deps.appender.append({
      id: eventId, at: pending.decidedAt, stream: `ticket:${pending.ticketId}`, type: 'escalation.ruled',
      source: { kind: 'human', ref: parsed.operatorOpenId, actor: { source: 'feishu', id: parsed.operatorOpenId } },
      evidence: [{ kind: 'event', ref: eventId }], taint: pending.note ? 'derived' : 'trusted',
      payload: {
        callbackId: parsed.callbackId, escalationId: pending.escalationId, ticketId: pending.ticketId,
        operatorOpenId: parsed.operatorOpenId, decision: pending.decision, attribution: pending.attribution,
        ...(pending.note ? { note: pending.note } : {}), captureAsRule: Boolean(pending.captureAsRule),
        decidedAt: pending.decidedAt,
      },
    }))
    await new Promise<void>(r => deps.store.afterCommit(r))
  }

  const ruling: EscalationRuling = { ...pending, sourceRef }
  const stateDir = resolve(deps.memoryDir, '..')
  const ticket = deps.store.tickets.get(ruling.ticketId)
  const workspace = options.workspace ?? ticket?.execution?.workspace ?? extractActionWorkspace(raw)

  let routed: EscalationRouteResult | undefined
  let memoryWrite: WriteResult | undefined
  let draftPath: string | undefined
  let attentionItem: AttentionItem | undefined
  if (!ruling.captureAsRule && ruling.attribution === 'exec_mistake' && !workspace) {
    const q = `待确认工作区归属（工单 ${ruling.ticketId} 执行失误裁决 ${ruling.escalationId}）：${ruling.note?.trim() || '请指定目标 M3 工作区'}`
    attentionItem = (await deps.memory.upsertAttention({ kind: 'verification', question: q, sourceRefs: [sourceRef], delaySeen: 1, seenCount: 1 }, ruling.operatorOpenId)).item
  } else {
    routed = routeEscalationRuling(ruling, {
      ...(workspace ? { workspace } : {}), ...(options.point ? { point: options.point } : {}), ...(options.intent ? { intent: options.intent } : {}),
    })
    if (routed.route === 'workspace-memory-proposal' || routed.route === 'user-ruling-memory-proposal') {
      const proposal = toMemoryProposal(routed, {
        ...(workspace ? { workspaceId: workspace } : {}), ...(options.personId ? { personId: options.personId } : {}),
        ...(options.slug ? { slug: options.slug } : {}), ...(options.m2Kind ? { m2Kind: options.m2Kind } : {}),
      })
      memoryWrite = await deps.memory.propose(proposal)
    } else if (routed.route === 'deposit-draft') {
      const safeId = sanitizeDraftId(routed.draft.id)
      const { value: cleanDraft } = redactValue({ ...routed.draft, id: safeId })
      draftPath = await writeDepositDraftFile(stateDir, safeId, `${JSON.stringify(cleanDraft, null, 2)}\n`)
      deps.appender.append(telemetryToSpineInput({
        id: `authoring:draft_created:${safeId}:${parsed.callbackId}`,
        kind: 'draft_created', draftId: safeId, depositKind: cleanDraft.kind,
        scope: cleanDraft.scope, at: nowIso, actorId: ruling.operatorOpenId,
      }))
    }
  }

  let attentionUpdated: boolean | undefined
  if (ruling.decision === 'approve' || ruling.decision === 'reject') {
    const ledger = await deps.memoryRepoLock.run(() => readMemoryPage(deps.memoryDir, 'm6/ledger.md'))
    const item = ledger?.layer === 'm6' ? ledger.items.find(i => i.id === ruling.escalationId) : undefined
    if (item && item.status !== 'approved' && item.status !== 'dismissed' && item.status !== 'expired') {
      await deps.memory.transitionAttention({ id: item.id, action: ruling.decision === 'approve' ? 'approve' : 'dismiss' }, ruling.operatorOpenId)
      attentionUpdated = true
    }
  }

  deps.appender.append({
    id: `feishu:applied:${ruling.escalationId}`, at: nowIso, stream: `ticket:${ruling.ticketId}`, type: 'escalation.applied',
    causationId: eventId, source: { kind: 'system', ref: 'governance.ruling' },
    evidence: [{ kind: 'event', ref: eventId }], taint: 'trusted',
    payload: { escalationId: ruling.escalationId, callbackId: parsed.callbackId, ruledRef: sourceRef, route: routed?.route ?? 'verification-missing-workspace' },
  })

  return {
    ok: true, duplicate: false, callbackId: parsed.callbackId, sourceRef, ruling,
    ...(routed ? { routed } : {}), ...(memoryWrite ? { memoryWrite } : {}),
    ...(draftPath ? { draftPath } : {}), ...(attentionUpdated ? { attentionUpdated } : {}),
    ...(attentionItem ? { attentionItem } : {}), response: parsed.response,
  }
}
