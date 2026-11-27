/** 做梦机制深度整理阶段（零 LLM 确定性）：M3->M4 跨仓自动晋升、精确去重与 >80% 常驻预算降级。 */
import { existsSync } from 'node:fs'
import type { SourceRef } from '../spine/types.ts'
import { listMemoryPages } from './codec.ts'
import type { PersistentBotMemoryPolicy } from './policy.ts'
import { formatEntryLine, isEntryActiveAt } from './recall.ts'
import { tokenizeForSearch } from './text-search.ts'
import type { FactLayer, FactPage, MemoryEntry, MemoryPageTarget, SourceType } from './types.ts'
import type { MemoryWriter } from './writer.ts'

export interface DeepConsolidationReport {
  readonly promotedM4: number
  readonly deduped: number
  readonly demotedResident: number
}

const SOURCE_RANK: Record<SourceType, number> = {
  user_ruling: 5, user_direct: 4, session: 3, external_doc: 2, inference: 1,
}

const normText = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

function targetFromRelPath(relPath: string): Omit<MemoryPageTarget, 'layer'> & { layer: FactLayer } {
  const parts = relPath.replace(/\.md$/, '').split('/')
  if (parts[0] === 'm2') return { layer: 'm2' }
  if (parts[0] === 'm4') return { layer: 'm4' }
  if (parts[0] === 'm3' && parts[1] && parts[2]) return { layer: 'm3', workspaceKey: parts[1], slug: parts[2] }
  return { layer: 'm1', slug: parts[1] || 'notes' }
}

function salienceOf(e: MemoryEntry, nowMs: number): number {
  const ts = Date.parse(e.lastAccessedAt ?? e.observedAt ?? e.validFrom)
  const ageDays = Number.isFinite(ts) ? Math.max(0, (nowMs - ts) / 86_400_000) : 30
  const recency = Math.pow(0.5, ageDays / 14)
  const imp = Math.min(10, Math.max(0, e.importance ?? 4)) / 10
  return 0.5 * recency + 0.5 * imp
}

/** 扫描 M1–M4 真源页并执行确定性晋升、去重与常驻防膨胀压缩（全程走 MemoryWriter 单写者锁与 Git 提交）。 */
export async function runDeepConsolidation(input: {
  readonly memoryDir: string
  readonly writer: MemoryWriter
  readonly policy: PersistentBotMemoryPolicy
  readonly batchRef: SourceRef
  readonly now: () => Date
}): Promise<DeepConsolidationReport> {
  if (!existsSync(input.memoryDir)) return { promotedM4: 0, deduped: 0, demotedResident: 0 }
  const nowMs = input.now().getTime()
  const pages = await input.writer.lock.run(() => listMemoryPages(input.memoryDir, ['m1', 'm2', 'm3', 'm4']))
  let promotedM4 = 0, deduped = 0, demotedResident = 0

  // 1) M3 -> M4 自动跨工作区晋升（同一 topicKey 出现在 >=2 个工作区且尚未入 M4）
  const activeM4Topics = new Set<string>()
  const activeM4Stmts = new Set<string>()
  const m3ByTopic = new Map<string, { ws: string; entry: MemoryEntry }[]>()
  for (const { page } of pages) {
    if (page.layer === 'm4') {
      for (const e of (page as FactPage).entries) {
        if (!isEntryActiveAt(e, nowMs)) continue
        if (e.topicKey?.trim()) activeM4Topics.add(e.topicKey.trim().toLowerCase())
        activeM4Stmts.add(normText(e.statement))
      }
    } else if (page.layer === 'm3') {
      for (const e of (page as FactPage).entries) {
        if (!isEntryActiveAt(e, nowMs) || e.taint === 'external_untrusted') continue
        const tk = e.topicKey?.trim().toLowerCase()
        if (!tk || !e.scope.startsWith('workspace:')) continue
        const ws = e.scope.slice(10).trim()
        if (!ws) continue
        m3ByTopic.set(tk, [...(m3ByTopic.get(tk) ?? []), { ws, entry: e }])
      }
    }
  }
  for (const [topicLower, list] of m3ByTopic) {
    if (activeM4Topics.has(topicLower)) continue
    const workspaces = [...new Set(list.map(x => x.ws))].sort()
    if (workspaces.length < 2) continue
    const lead = list.at(-1)!.entry
    if (activeM4Stmts.has(normText(lead.statement))) continue
    const quote = lead.statement.trim().slice(0, 60)
    if (quote.length < 4) continue
    const res = await input.writer.propose({
      layer: 'm4', statement: lead.statement, scope: 'global', sourceType: 'inference',
      sourceRef: input.batchRef, author: 'consolidator', taint: 'clean', clearance: 'public',
      ...(lead.topicKey ? { topicKey: lead.topicKey } : {}),
      verbatimQuote: quote, evidenceText: lead.statement,
      workspacesSeen: workspaces, seenCount: Math.max(workspaces.length, list.length),
    })
    if (res.kind === 'accepted') promotedM4 += 1
  }

  // 2) 同范围完全重复陈述去重（先确认高权威保留条目活跃，再对重复低权威副本打墓碑）
  for (const { relPath, page } of pages) {
    if (page.layer === 'm6') continue
    const groups = new Map<string, MemoryEntry[]>()
    for (const e of (page as FactPage).entries) {
      if (!isEntryActiveAt(e, nowMs)) continue
      const key = `${e.scope}::${normText(e.statement)}`
      groups.set(key, [...(groups.get(key) ?? []), e])
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const sorted = [...group].sort((a, b) =>
        SOURCE_RANK[b.sourceType] - SOURCE_RANK[a.sourceType]
        || b.observedAt.localeCompare(a.observedAt)
        || a.id.localeCompare(b.id))
      const keeper = sorted[0]
      if (!keeper || !isEntryActiveAt(keeper, nowMs)) continue
      for (const dup of sorted.slice(1)) {
        if (dup.sourceType === 'user_ruling' || dup.m2Kind === 'veto') continue
        await input.writer.tombstone({
          target: targetFromRelPath(relPath), entryId: dup.id,
          reason: `dream dedup merged into ${keeper.id}`, sourceRef: input.batchRef, author: 'consolidator',
        }).then(() => { deduped += 1 }).catch(() => undefined)
      }
    }
  }

  // 3) 常驻预算自整理（超 80% 上限时按最低显著度逐条降级非 user_ruling/非 veto 为按需触发记忆）
  const freshPages = await input.writer.lock.run(() => listMemoryPages(input.memoryDir, ['m1', 'm2', 'm3', 'm4']))
  const residentRows: { relPath: string; entry: MemoryEntry; chars: number; salience: number }[] = []
  for (const { relPath, page } of freshPages) {
    if (page.layer === 'm6') continue
    for (const e of (page as FactPage).entries) {
      if (e.resident !== true || !isEntryActiveAt(e, nowMs)) continue
      residentRows.push({ relPath, entry: e, chars: formatEntryLine(e).length, salience: salienceOf(e, nowMs) })
    }
  }
  const threshold = Math.floor(input.policy.residentMaxChars * 0.8)
  let totalChars = residentRows.length ? residentRows.reduce((s, r) => s + r.chars, 0) + (residentRows.length - 1) : 0
  if (totalChars > threshold) {
    const demotable = residentRows
      .filter(r => r.entry.sourceType !== 'user_ruling' && r.entry.m2Kind !== 'veto')
      .sort((a, b) => a.salience - b.salience || SOURCE_RANK[a.entry.sourceType] - SOURCE_RANK[b.entry.sourceType] || a.entry.id.localeCompare(b.entry.id))
    for (const cand of demotable) {
      if (totalChars <= threshold) break
      const keys = cand.entry.triggerKeys?.primary.length
        ? undefined
        : { primary: [...new Set([cand.entry.topicKey ?? '', ...tokenizeForSearch(cand.entry.statement).slice(0, 4)].filter(Boolean))] }
      const ok = await input.writer.demoteResident({
        target: targetFromRelPath(cand.relPath), entryId: cand.entry.id,
        reason: 'dream resident budget hygiene (>80%)', sourceRef: input.batchRef, author: 'consolidator',
        ...(keys?.primary.length ? { triggerKeys: keys } : {}),
      }).then(() => true, () => false)
      if (ok) {
        demotedResident += 1
        totalChars = Math.max(0, totalChars - cand.chars - 1)
      }
    }
  }

  return { promotedM4, deduped, demotedResident }
}
