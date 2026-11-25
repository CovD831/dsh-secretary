/** 可信记忆全生命周期：老板直改正门、M3 避坑桥接、逐字引文 Patch 提案、M6 衰减与三项可信指标。 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PitfallNote } from '../context/types.ts'
import { redactValue } from '../spine/redact.ts'
import type { SpineAppender, SpineEnvelope } from '../spine/types.ts'
import { assertSafeSegment, decodeMemoryPage, listMemoryPages, readMemoryPage, resolveMemoryRelPath } from './codec.ts'
import { tokenizeForSearch } from './fts-index.ts'
import { canCallerReadEntry, isEntryActiveAt } from './recall.ts'
import type {
  FactPage, LedgerPage, MemoryBelievabilityMetrics, MemoryEntry, MemoryProposal, MemoryScope,
  PendingPatchProposal, ProposeTicketPatchesResult, RejectedPatchCandidate, TickM6LifecycleResult,
  TicketPatchCandidate, UserDirectMemoryInput, UserDirectMemoryResult, WriteResult,
} from './types.ts'
import type { MemoryWriter } from './writer.ts'

const DEFAULT_M6_EXPIRE_MS = 14 * 24 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function resolveNowMs(now?: Date | string): number {
  const ms = now instanceof Date ? now.getTime() : (now !== undefined ? Date.parse(now) : Date.now())
  if (!Number.isFinite(ms)) throw new Error(`非法时间戳 now: "${String(now)}"`)
  return ms
}

/** 宿主鉴权后的老板直改正门：先入 M0 `memory.user_direct` 拿真 SourceRef，再写入并自动清理同 topicKey 旧 M2。 */
export async function writeUserDirectMemory(
  writer: MemoryWriter,
  appender: SpineAppender,
  input: UserDirectMemoryInput,
): Promise<UserDirectMemoryResult> {
  const layer = input.layer ?? 'm2'
  const scope: MemoryScope = input.scope ?? (layer === 'm3' && input.workspaceKey ? `workspace:${input.workspaceKey}` : 'global')
  const atIso = input.now ? new Date(resolveNowMs(input.now)).toISOString() : new Date().toISOString()
  const sourceRef = appender.append({
    id: input.eventId ?? `mem:user_direct:${randomUUID().slice(0, 12)}`,
    at: atIso, stream: `memory:${layer}`, type: 'memory.user_direct',
    source: { kind: 'human', ref: input.actorRef ?? 'user' }, evidence: [], taint: 'trusted',
    payload: {
      layer, scope, statement: input.statement.trim(),
      ...(input.topicKey ? { topicKey: input.topicKey } : {}), ...(input.m2Kind ? { m2Kind: input.m2Kind } : {}),
      overrideTombstone: Boolean(input.overrideTombstone),
    },
  })
  const proposal: MemoryProposal = {
    layer, ...(input.slug ? { slug: input.slug } : {}), ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
    statement: input.statement, scope, sourceType: 'user_direct', sourceRef, author: 'user', taint: 'clean', confidence: 'stated',
    ...(input.topicKey ? { topicKey: input.topicKey } : {}),
    ...(layer === 'm2' ? { m2Kind: input.m2Kind ?? 'preference' } : input.m2Kind ? { m2Kind: input.m2Kind } : {}),
    ...(input.clearance ? { clearance: input.clearance } : {}), ...(input.resident !== undefined ? { resident: input.resident } : {}),
    ...(input.importance !== undefined ? { importance: input.importance } : {}), ...(input.triggerKeys ? { triggerKeys: input.triggerKeys } : {}),
    ...(input.overrideTombstone !== undefined ? { overrideTombstone: input.overrideTombstone } : {}),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    ...(input.invalidationReason ? { invalidationReason: input.invalidationReason } : {}),
  }
  const writeResult = await writer.propose(proposal)
  const tombstonedIds: string[] = []
  if (writeResult.kind === 'accepted') {
    tombstonedIds.push(...writeResult.supersededIds)
    if (layer === 'm2' && input.topicKey?.trim()) {
      const m2Page = await writer.lock.run(() => readMemoryPage(writer.dir, 'm2/profile.md'))
      const nowMs = resolveNowMs(input.now)
      if (m2Page?.layer === 'm2') {
        for (const old of m2Page.entries) {
          if (old.id !== writeResult.entry.id && old.topicKey?.trim() === input.topicKey.trim() && isEntryActiveAt(old, nowMs)) {
            await writer.tombstone({ target: { layer: 'm2' }, entryId: old.id, sourceRef, author: 'user',
              reason: input.invalidationReason ?? `replaced by user_direct ${writeResult.entry.id}` })
            tombstonedIds.push(old.id)
          }
        }
      }
    }
  }
  return { sourceRef, writeResult, tombstonedIds }
}

function entryToPitfallNote(entry: MemoryEntry, fallbackWs: string): PitfallNote {
  const tk = entry.triggerKeys
  const fallbackKeys = entry.topicKey?.trim() ? [entry.topicKey.trim(), ...tokenizeForSearch(entry.statement).slice(0, 5)] : tokenizeForSearch(entry.statement).slice(0, 6)
  const triggerKeys = tk?.primary.length ? [...tk.primary] : (fallbackKeys.length ? [...new Set(fallbackKeys)] : [fallbackWs])
  const sec = tk?.secondary ?? [], isNeg = tk?.logic === 'NOT_ANY' || tk?.logic === 'NOT_ALL'
  return {
    id: entry.id, triggerKeys, ...(sec.length > 0 && !isNeg ? { andKeys: [...sec] } : {}), ...(sec.length > 0 && isNeg ? { notKeys: [...sec] } : {}),
    content: `${entry.taint === 'external_untrusted' ? '[UNTRUSTED_EXTERNAL] ' : ''}${entry.statement}`, sourceRef: entry.sourceRef, wordBoundary: true,
  }
}

/** 由宿主派生 workspaceKey 读取 M3 活跃条目，无损转为 Worker 上下文胶囊可用的 PitfallNote[]。 */
export async function loadWorkspacePitfallNotes(memoryDir: string, workspaceKey: string, now?: Date | string): Promise<PitfallNote[]> {
  const safeWs = assertSafeSegment(workspaceKey, 'workspaceKey'), root = resolve(memoryDir)
  if (!existsSync(root)) return []
  const nowMs = resolveNowMs(now), caller = { role: 'worker' as const, workspaceId: safeWs, maxClearance: 'workspace' as const }
  const pages = (await listMemoryPages(root, ['m3'])).filter(p => p.relPath.startsWith(`m3/${safeWs}/`))
  const flatRel = `m3/${safeWs}.md`, flatAbs = join(root, flatRel)
  try {
    if (!(await lstat(join(root, 'm3'))).isSymbolicLink()) {
      const info = await lstat(flatAbs)
      if (!info.isSymbolicLink() && info.isFile()) {
        const page = decodeMemoryPage(await readFile(flatAbs, 'utf8'))
        if (page.layer === 'm3') pages.push({ relPath: flatRel, page })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const notes: PitfallNote[] = [], seen = new Set<string>()
  for (const { relPath, page } of pages) {
    if (page.layer !== 'm3') continue
    for (const entry of page.entries) {
      if (!seen.has(entry.id) && isEntryActiveAt(entry, nowMs) && canCallerReadEntry(caller, 'm3', entry, relPath)) {
        seen.add(entry.id); notes.push(entryToPitfallNote(entry, safeWs))
      }
    }
  }
  return notes
}

/** 工单收尾/会话沉淀 Patch 提案器：强制逐字引证核对 + expectedRevision + 跨工作区>=2产 M4 提案。 */
export async function proposeTicketMemoryPatches(input: {
  readonly memoryDir: string; readonly ticketId?: string; readonly candidates: readonly TicketPatchCandidate[]
  readonly writer?: MemoryWriter; readonly apply?: boolean; readonly author?: string
}): Promise<ProposeTicketPatchesResult> {
  const root = resolve(input.memoryDir), pages = existsSync(root) ? await listMemoryPages(root, ['m1', 'm2', 'm3', 'm4']) : []
  const revByPath = new Map<string, number>(), existingWsByTopic = new Map<string, Set<string>>()
  for (const { relPath, page } of pages) {
    revByPath.set(relPath, page.revision)
    if (page.layer === 'm6') continue
    for (const e of (page as FactPage).entries) {
      if (!e.invalidatedBy && e.scope.startsWith('workspace:') && e.topicKey?.trim()) {
        const set = existingWsByTopic.get(e.topicKey.trim()) ?? new Set<string>()
        set.add(e.scope.slice(10)); existingWsByTopic.set(e.topicKey.trim(), set)
      }
    }
  }
  const proposals: PendingPatchProposal[] = [], m4Proposals: PendingPatchProposal[] = [], rejected: RejectedPatchCandidate[] = []
  const validRows: { c: TicketPatchCandidate; quote: string; wsSet: Set<string>; patternKey: string }[] = []
  for (const c of input.candidates) {
    if (!c.sourceRef || !Number.isSafeInteger(c.sourceRef.seq) || c.sourceRef.seq <= 0 || !c.sourceRef.id.trim()) {
      rejected.push({ candidate: c, reason: 'missing-source-ref', detail: '缺少合法 M0 sourceRef' }); continue
    }
    const quote = (c.verbatimQuote ?? '').trim()
    if (!quote || !(c.evidenceText ?? '').includes(quote)) {
      rejected.push({ candidate: c, reason: 'verbatim-quote-mismatch', detail: 'verbatimQuote 为空或未在 evidenceText 中逐字命中' }); continue
    }
    if (redactValue([c.statement, quote, c.topicKey, c.author]).redacted.length > 0) {
      rejected.push({ candidate: c, reason: 'secret-detected', detail: '提案内容命中秘密形状，已拦截' }); continue
    }
    if (c.layer === 'm2' && (c.taint === 'external_untrusted' || c.sourceType === 'external_doc')) {
      rejected.push({ candidate: c, reason: 'untrusted-m2-forbidden', detail: '禁止不可信外部文本 (external_untrusted/external_doc) 写入 M2' }); continue
    }
    let targetRelPath: string
    try { targetRelPath = resolveMemoryRelPath({ layer: c.layer, slug: c.slug, workspaceKey: c.layer === 'm3' ? (c.workspaceKey ?? (c.scope.startsWith('workspace:') ? c.scope.slice(10) : undefined)) : undefined }) }
    catch (err) { rejected.push({ candidate: c, reason: 'invalid-input', detail: err instanceof Error ? err.message : String(err) }); continue }
    const wsSet = new Set((c.workspacesSeen ?? []).map(w => w.trim()).filter(Boolean))
    if (c.workspaceKey?.trim()) wsSet.add(c.workspaceKey.trim())
    if (c.scope.startsWith('workspace:')) wsSet.add(c.scope.slice(10))
    const topic = c.topicKey?.trim()
    if (topic && existingWsByTopic.has(topic)) for (const w of existingWsByTopic.get(topic)!) wsSet.add(w)
    const patternKey = (c.patternKey ?? topic ?? c.statement.trim().toLowerCase()).trim()
    validRows.push({ c, quote, wsSet, patternKey })
    if (c.layer === 'm4' && wsSet.size < 2) { rejected.push({ candidate: c, reason: 'm4-threshold-not-met', detail: 'M4 跨仓提案至少需要 workspacesSeen >= 2' }); continue }
    const prop: PendingPatchProposal = {
      layer: c.layer, ...(c.slug ? { slug: c.slug } : {}), ...(c.workspaceKey ? { workspaceKey: c.workspaceKey } : {}),
      statement: c.statement.trim(), scope: c.scope, sourceType: c.sourceType ?? 'session', sourceRef: c.sourceRef,
      author: c.author ?? input.author ?? 'consolidator', verbatimQuote: quote,
      ...(c.evidenceText !== undefined ? { evidenceText: c.evidenceText } : {}), ...(topic ? { topicKey: topic } : {}),
      ...(c.triggerKeys ? { triggerKeys: c.triggerKeys } : {}), ...(c.importance !== undefined ? { importance: c.importance } : {}),
      ...(c.clearance ? { clearance: c.clearance } : {}), ...(c.resident !== undefined ? { resident: c.resident } : {}),
      ...(c.layer === 'm4' ? { workspacesSeen: [...wsSet], seenCount: Math.max(c.seenCount ?? 0, wsSet.size) } : {}),
      expectedRevision: revByPath.get(targetRelPath) ?? 0, targetRelPath,
    }
    proposals.push(prop)
    if (c.layer === 'm4') m4Proposals.push(prop)
  }
  const emittedM4 = new Set<string>(m4Proposals.map(p => (p.topicKey ?? p.statement.toLowerCase()).trim()))
  const rowsByPattern = new Map<string, typeof validRows>()
  for (const r of validRows) rowsByPattern.set(r.patternKey, [...(rowsByPattern.get(r.patternKey) ?? []), r])
  const m4Rev = revByPath.get('m4/patterns.md') ?? 0
  for (const [patternKey, group] of rowsByPattern) {
    if (emittedM4.has(patternKey)) continue
    const unionWs = new Set<string>()
    for (const r of group) for (const w of r.wsSet) unionWs.add(w)
    if (unionWs.size < 2) continue
    const lead = group[group.length - 1]!
    if (lead.c.layer === 'm4') continue
    const m4Prop: PendingPatchProposal = {
      layer: 'm4', statement: lead.c.statement.trim(), scope: 'global', sourceType: lead.c.sourceType ?? 'session', sourceRef: lead.c.sourceRef,
      author: lead.c.author ?? input.author ?? 'consolidator', verbatimQuote: lead.quote,
      ...(lead.c.evidenceText !== undefined ? { evidenceText: lead.c.evidenceText } : {}), ...(lead.c.topicKey ? { topicKey: lead.c.topicKey } : {}),
      workspacesSeen: [...unionWs].sort(), seenCount: Math.max(lead.c.seenCount ?? 0, unionWs.size, group.length),
      expectedRevision: m4Rev, targetRelPath: 'm4/patterns.md',
    }
    emittedM4.add(patternKey); m4Proposals.push(m4Prop); proposals.push(m4Prop)
  }
  if (input.writer && input.apply) {
    const writeResults: WriteResult[] = []
    for (const p of proposals) writeResults.push(await input.writer.propose(p))
    return { proposals, m4Proposals, rejected, writeResults }
  }
  return { proposals, m4Proposals, rejected }
}

/** 驱动 M6 注意力账本生命周期：stickyTurns 递减、delaySeen 推进与超时自动 expire。 */
export async function tickM6AttentionLifecycle(
  writer: MemoryWriter, memoryDir: string, now?: Date | string, options: { readonly maxAgeMs?: number; readonly author?: string } = {},
): Promise<TickM6LifecycleResult> {
  const page = await readMemoryPage(resolve(memoryDir), 'm6/ledger.md')
  if (!page || page.layer !== 'm6') return { tickedIds: [], seenIds: [], expiredIds: [], untouchedIds: [] }
  const nowMs = resolveNowMs(now), maxAgeMs = options.maxAgeMs ?? DEFAULT_M6_EXPIRE_MS, author = options.author ?? 'secretary'
  const tickedIds: string[] = [], seenIds: string[] = [], expiredIds: string[] = [], untouchedIds: string[] = []
  for (const item of (page as LedgerPage).items) {
    if (item.status === 'approved' || item.status === 'dismissed' || item.status === 'expired') continue
    const updatedMs = Date.parse(item.updatedAt)
    if (Number.isFinite(updatedMs) && nowMs - updatedMs >= maxAgeMs) { await writer.transitionAttention({ id: item.id, action: 'expire' }, author); expiredIds.push(item.id) }
    else if (item.status === 'asked' && (item.remainingStickyTurns ?? 0) > 0) { await writer.transitionAttention({ id: item.id, action: 'tick' }, author); tickedIds.push(item.id) }
    else if (item.status === 'pending' && item.seenCount < item.delaySeen) { await writer.transitionAttention({ id: item.id, action: 'seen' }, author); seenIds.push(item.id) }
    else untouchedIds.push(item.id)
  }
  return { tickedIds, seenIds, expiredIds, untouchedIds }
}

const normQuestion = (raw: string): string => raw.replace(/^\[[^\]]+\]\s*/, '').toLowerCase().replace(/[\s？?！!。.,，:：]+/g, ' ').trim()

/** 计算记忆系统 3 项可信指标：重复提问率、假回忆事件数、近 7 天被纠正记忆数。 */
export async function computeMemoryBelievabilityMetrics(
  memoryDir: string, spineEvents: readonly SpineEnvelope[], now?: Date | string,
): Promise<MemoryBelievabilityMetrics> {
  const nowMs = resolveNowMs(now), weekStartMs = nowMs - WEEK_MS, root = resolve(memoryDir)
  const pages = existsSync(root) ? await listMemoryPages(root, ['m1', 'm2', 'm3', 'm4', 'm6']) : []
  const entryById = new Map<string, MemoryEntry>(), correctedIds = new Set<string>()
  let ledgerItems: LedgerPage['items'] = []
  for (const { page } of pages) {
    if (page.layer === 'm6') { ledgerItems = page.items; continue }
    for (const e of (page as FactPage).entries) {
      entryById.set(e.id, e)
      const validToMs = e.validTo ? Date.parse(e.validTo) : NaN, obsMs = Date.parse(e.observedAt)
      if ((e.invalidatedBy && Number.isFinite(validToMs) && validToMs >= weekStartMs && validToMs <= nowMs)
        || (e.m2Kind === 'correction_repair' && Number.isFinite(obsMs) && obsMs >= weekStartMs && obsMs <= nowMs)) correctedIds.add(e.id)
    }
  }
  const seenQuestions = new Map<string, string>()
  let totalQuestions = 0, repeatQuestions = 0, falseRecallCount = 0
  const trackQ = (qid: string, text: string, explicitRepeat = false) => {
    const key = normQuestion(text)
    if (!key) return
    totalQuestions += 1
    if (explicitRepeat || (seenQuestions.has(key) && seenQuestions.get(key) !== qid)) repeatQuestions += 1
    else if (!seenQuestions.has(key)) seenQuestions.set(key, qid)
  }
  for (const item of ledgerItems) trackQ(item.id, item.question)
  for (const ev of spineEvents) {
    const p = (ev.payload && typeof ev.payload === 'object' ? ev.payload : {}) as Record<string, unknown>, evMs = Date.parse(ev.at)
    if ((ev.type === 'ruling.queued' || ev.type === 'secretary.ask') && typeof p['question'] === 'string') {
      trackQ(typeof p['rulingId'] === 'string' ? p['rulingId'] : ev.id, p['question'], p['isRepeatQuestion'] === true)
    }
    if (ev.type === 'memory.false_recall' || ev.type === 'memory.recall.false' || p['falseRecall'] === true) falseRecallCount += 1
    const cited: string[] = []
    for (const k of ['citedEntryIds', 'includedIds', 'memoryIds'] as const) if (Array.isArray(p[k])) for (const v of p[k] as unknown[]) if (typeof v === 'string') cited.push(v)
    if (p['receipt'] && typeof p['receipt'] === 'object') {
      for (const b of ['resident', 'triggered', 'retrieved']) {
        const inc = (p['receipt'] as Record<string, { includedIds?: unknown }>)[b]?.includedIds
        if (Array.isArray(inc)) for (const v of inc) if (typeof v === 'string') cited.push(v)
      }
    }
    for (const id of cited) {
      if (!id.startsWith('mem-')) continue
      const hit = entryById.get(id)
      if (!hit) { falseRecallCount += 1; continue }
      const endMs = hit.validTo ? Date.parse(hit.validTo) : NaN
      if (hit.invalidatedBy && (!Number.isFinite(endMs) || !Number.isFinite(evMs) || endMs <= evMs)) falseRecallCount += 1
    }
    if (Number.isFinite(evMs) && evMs >= weekStartMs && evMs <= nowMs) {
      if (ev.type === 'memory.tombstoned' || ev.type === 'memory.corrected') correctedIds.add(typeof p['entryId'] === 'string' ? p['entryId'] : ev.id)
      else if (ev.type === 'memory.accepted') {
        if (Array.isArray(p['supersededIds'])) for (const sid of p['supersededIds'] as unknown[]) if (typeof sid === 'string') correctedIds.add(sid)
        if (p['m2Kind'] === 'correction_repair' && typeof p['entryId'] === 'string') correctedIds.add(p['entryId'])
      }
    }
  }
  return { repeatQuestionRate: totalQuestions > 0 ? repeatQuestions / totalQuestions : 0, falseRecallCount, weeklyCorrectedMemories: correctedIds.size, totalQuestions, repeatQuestions, windowDays: 7 }
}
