/** 飞书卡片裁决回调闭环：操作人鉴权、M0 原子入脊拿真 SourceRef、幂等去重与 M2/M3/M6/草稿落盘。 */
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  parseFeishuCardCallback, routeEscalationRuling, telemetryToSpineInput, toMemoryProposal,
  type EscalationRouteResult, type EscalationRuling, type FeishuCardCallbackResponse,
} from '../authoring/index.ts'
import { readMemoryPage, type M2Kind, type MemoryWriter, type WriteResult } from '../memory/index.ts'
import { allowedSender } from '../policy.ts'
import type { GitRepoLock, SourceRef, SpineAppender, SpineEnvelope } from '../spine/index.ts'
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
      readonly callbackId: string
      readonly sourceRef: SourceRef
      readonly ruling: EscalationRuling
      readonly routed?: EscalationRouteResult
      readonly memoryWrite?: WriteResult
      readonly draftPath?: string
      readonly attentionUpdated?: boolean
      readonly response: FeishuCardCallbackResponse
    }

const SHARD_NAME_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const SAFE_DRAFT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))

/** 按权限策略构造飞书卡片回调操作人鉴权器（仅 `policy.sources.feishu.allowed` 在册成员通过）。 */
export function createFeishuOperatorAuthorizer(store: Pick<Store, 'settings'>): (openId: string) => boolean {
  return (openId: string) => Boolean(allowedSender(store.settings(), { source: 'feishu', id: openId }))
}

function readBufferedEvent(store: Pick<Store, 'db'>, eventId: string): { ref: SourceRef; envelope?: SpineEnvelope<Record<string, unknown>> } | undefined {
  const row = store.db.prepare('SELECT seq, id, value FROM event_spine WHERE id = ?').get(eventId) as { seq: number; id: string; value: string } | undefined
  if (!row) return undefined
  let envelope: SpineEnvelope<Record<string, unknown>> | undefined
  try { envelope = row.value ? JSON.parse(row.value) as SpineEnvelope<Record<string, unknown>> : undefined } catch { envelope = undefined }
  return { ref: { seq: Number(row.seq), id: row.id }, ...(envelope ? { envelope } : {}) }
}

async function findExistingSpineEvent(
  deps: Pick<FeishuCardIngestDeps, 'store' | 'memoryDir' | 'memoryRepoLock'>,
  eventId: string,
): Promise<{ ref: SourceRef; envelope?: SpineEnvelope<Record<string, unknown>> } | undefined> {
  const buffered = readBufferedEvent(deps.store, eventId)
  if (buffered) return buffered
  const m0Dir = join(deps.memoryDir, 'm0')
  return deps.memoryRepoLock.run(async () => {
    const rechecked = readBufferedEvent(deps.store, eventId)
    if (rechecked) return rechecked
    let shards: string[]
    try { shards = (await readdir(m0Dir)).filter(n => SHARD_NAME_RE.test(n)).sort() } catch { return undefined }
    for (let i = shards.length - 1; i >= 0; i--) {
      const raw = await readFile(join(m0Dir, shards[i]!), 'utf8').catch(() => '')
      const cut = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1)
      const lines = cut.split('\n')
      for (let j = lines.length - 1; j >= 0; j--) {
        const line = lines[j]?.trim()
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as SpineEnvelope<Record<string, unknown>>
          if (parsed.id === eventId && Number.isSafeInteger(parsed.seq) && parsed.seq > 0) {
            return { ref: { seq: parsed.seq, id: parsed.id }, envelope: parsed }
          }
        } catch { continue }
      }
    }
    return undefined
  })
}

function extractActionWorkspace(raw: unknown): string | undefined {
  if (!isRec(raw)) return undefined
  const ev = isRec(raw['event']) ? raw['event'] : raw
  const action = isRec(ev['action']) ? ev['action'] : undefined
  const val = action && isRec(action['value']) ? action['value'] : undefined
  const ws = val?.['workspace']
  return typeof ws === 'string' && ws.trim() ? ws.trim() : undefined
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

/** 飞书卡片裁决全闭环：鉴权 -> M0 幂等查重/原子入脊 -> 提交后路由至 M2/M3/草稿与 M6 状态推进。 */
export async function ingestFeishuCardAction(
  deps: FeishuCardIngestDeps,
  raw: unknown,
  options: IngestFeishuCardOptions,
): Promise<FeishuCardIngestResult> {
  const nowIso = (deps.now ?? (() => new Date()))().toISOString()
  const parsed = parseFeishuCardCallback(raw, { now: nowIso, isAllowedOperator: options.isAllowedOperator })
  if (!parsed.ok) return { ok: false, reason: parsed.reason }

  const pending = parsed.pendingRuling!
  const eventId = `feishu:card:${parsed.callbackId}`
  const duplicateResponse: FeishuCardCallbackResponse = {
    toast: { type: 'info', content: '重复回调已幂等忽略' },
    ...(parsed.response.card ? { card: parsed.response.card } : {}),
  }

  const existing = await findExistingSpineEvent(deps, eventId)
  if (existing) {
    return {
      ok: true, duplicate: true, callbackId: parsed.callbackId, sourceRef: existing.ref,
      ruling: { ...pending, sourceRef: existing.ref }, response: duplicateResponse,
    }
  }

  const txResult = deps.store.atomic(() => {
    const inside = readBufferedEvent(deps.store, eventId)
    if (inside) return { ref: inside.ref, duplicate: true as const }
    const ref = deps.appender.append({
      id: eventId, at: pending.decidedAt, stream: `ticket:${pending.ticketId}`, type: 'escalation.ruled',
      source: { kind: 'human', ref: parsed.operatorOpenId, actor: { source: 'feishu', id: parsed.operatorOpenId } },
      evidence: [{ kind: 'event', ref: eventId }], taint: 'trusted',
      payload: {
        callbackId: parsed.callbackId, escalationId: pending.escalationId, ticketId: pending.ticketId,
        operatorOpenId: parsed.operatorOpenId, decision: pending.decision, attribution: pending.attribution,
        ...(pending.note ? { note: pending.note } : {}), captureAsRule: Boolean(pending.captureAsRule),
        decidedAt: pending.decidedAt,
      },
    })
    return { ref, duplicate: false as const }
  })
  // 严格等外层事务提交后，再把真实的 M0 SourceRef 交给记忆仓或草稿落盘，防止回滚撞号。
  await new Promise<void>(r => deps.store.afterCommit(r))

  const ruling: EscalationRuling = { ...pending, sourceRef: txResult.ref }
  if (txResult.duplicate) {
    return { ok: true, duplicate: true, callbackId: parsed.callbackId, sourceRef: txResult.ref, ruling, response: duplicateResponse }
  }

  const stateDir = resolve(deps.memoryDir, '..')
  const ticket = deps.store.tickets.get(ruling.ticketId)
  const workspace = options.workspace
    ?? ticket?.execution?.workspace
    ?? extractActionWorkspace(raw)
    ?? deps.store.settings().workspaces?.[0]?.id
    ?? (ruling.attribution === 'exec_mistake' && !ruling.captureAsRule ? 'default' : undefined)

  const routed = routeEscalationRuling(ruling, {
    ...(workspace ? { workspace } : {}),
    ...(options.point ? { point: options.point } : {}),
    ...(options.intent ? { intent: options.intent } : {}),
  })

  let memoryWrite: WriteResult | undefined
  let draftPath: string | undefined
  if (routed.route === 'workspace-memory-proposal' || routed.route === 'user-ruling-memory-proposal') {
    const proposal = toMemoryProposal(routed, {
      ...(workspace ? { workspaceId: workspace } : {}),
      ...(options.personId ? { personId: options.personId } : {}),
      ...(options.slug ? { slug: options.slug } : {}),
      ...(options.m2Kind ? { m2Kind: options.m2Kind } : {}),
    })
    memoryWrite = await deps.memory.propose(proposal)
  } else if (routed.route === 'deposit-draft') {
    draftPath = await writeDepositDraftFile(stateDir, routed.draft.id, `${JSON.stringify(routed.draft, null, 2)}\n`)
    deps.appender.append(telemetryToSpineInput({
      id: `authoring:draft_created:${routed.draft.id}:${parsed.callbackId}`,
      kind: 'draft_created', draftId: routed.draft.id, depositKind: routed.draft.kind,
      scope: routed.draft.scope, at: nowIso, actorId: ruling.operatorOpenId,
    }))
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

  return {
    ok: true, duplicate: false, callbackId: parsed.callbackId, sourceRef: txResult.ref, ruling, routed,
    ...(memoryWrite ? { memoryWrite } : {}), ...(draftPath ? { draftPath } : {}),
    ...(attentionUpdated ? { attentionUpdated } : {}), response: parsed.response,
  }
}
