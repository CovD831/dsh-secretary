/** 记忆治理宿主辅助：防伪证原文核验、老板话中直改四重鉴权升级、可逆回执、单条作废与运行时装配。 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { z } from 'zod'
import { KV } from '../kv.ts'
import {
  EpochMemoryInjector, MemoryDreamer, TranscriptFtsIndex, canPolicyDirectOverride,
  createHostDreamExtractor, createSecretaryMemoryPolicy, memoryTaintOf, readMemoryPage, resolveMemoryRelPath,
  type DreamExtractorFn, type FactLayer, type LedgerPage, type MemoryEntry, type MemoryFtsIndex, type MemoryScope,
} from '../memory/index.ts'
import type { GitRepoLock, SourceRef, SpineAppender, SpineEnvelope } from '../spine/index.ts'
import type { MemoryWriter } from '../memory/writer.ts'
import type { GovernanceRuntime } from './governance.ts'
import type { Store } from './store.ts'
import { appendSecretaryFeed } from './tools/secretary-core.ts'
import { normalizeMemoryScope, type ProposeSchema } from './tools/secretary-governance-schemas.ts'

/** 组装持久化记忆检索/Epoch 注入/做梦闭环子系统（保持 GovernanceRuntime 体积精简）。 */
export function buildGovernanceMemorySubsystem(input: {
  readonly stateDir: string
  readonly memoryDir: string
  readonly masterId: string
  readonly memoryRepoLock: GitRepoLock
  readonly memory: MemoryWriter
  readonly ftsIndex: MemoryFtsIndex
  readonly appender: SpineAppender
  readonly store: Store
  readonly context?: Context
  readonly persistence?: Pick<SessionPersistence, 'flush' | 'open'>
  readonly dreamExtractor?: DreamExtractorFn
  readonly now: () => Date
}) {
  const memoryPolicy = createSecretaryMemoryPolicy(input.masterId)
  const transcriptFts = new TranscriptFtsIndex({ dbPath: join(input.stateDir, 'derived', 'transcript-fts.sqlite'), now: input.now })
  const epochInjector = new EpochMemoryInjector({
    memoryDir: input.memoryDir, memoryRepoLock: input.memoryRepoLock, policy: memoryPolicy,
    ftsIndex: input.ftsIndex, memory: input.memory, appender: input.appender, now: input.now,
  })
  const dreamer = new MemoryDreamer({
    memoryDir: input.memoryDir, ftsIndex: input.ftsIndex, transcriptFts, memory: input.memory,
    appender: input.appender, policy: memoryPolicy, now: input.now,
    ...(input.persistence ? { persistence: input.persistence } : {}),
    extractFn: input.dreamExtractor ?? createHostDreamExtractor(input.context, () => input.store.settings()),
    getCursors: () => input.store.get(KV.governance.dreamCursors) ?? {},
    saveCursors: cursors => input.store.set(KV.governance.dreamCursors, cursors),
    classifyTrigger: text => {
      const feed = input.store.get(KV.governance.feed) ?? []
      const bossHit = feed.find(item => item.role === 'boss' && item.kind === 'boss_message' && item.text === text)
      if (bossHit) return { taint: 'trusted', isBoss: true, ...(bossHit.triggerId ? { triggerId: bossHit.triggerId } : {}) }
      const untrusted = /\[(?:Feishu|GitHub|external|relay)/i.test(text)
      return { taint: untrusted ? 'untrusted' : 'trusted' }
    },
    onUpdated: ids => { for (const id of ids) epochInjector.invalidateEntry(id) },
  })
  return { memoryPolicy, transcriptFts, epochInjector, dreamer }
}

const MAX_OVERRIDE_AGE_MS = 10 * 60_000

function resolveHostEvidenceText(
  gov: GovernanceRuntime,
  triggerIdArg: string | undefined,
  env: SpineEnvelope<Record<string, unknown>>,
): { trigger: ReturnType<GovernanceRuntime['storeRef']['triggers']['get']>; hostText: string } {
  const payloadTrigId = typeof env.payload?.['triggerId'] === 'string' ? env.payload['triggerId'] : undefined
  const triggerId = triggerIdArg ?? payloadTrigId
  const trigger = triggerId ? gov.storeRef.triggers.get(triggerId) : undefined
  const hostText = trigger?.text
    ?? (typeof env.payload?.['text'] === 'string' ? env.payload['text']
      : typeof env.payload?.['statement'] === 'string' ? env.payload['statement'] : '')
  return { trigger, hostText }
}

function canElevateBossLiveOverride(
  gov: GovernanceRuntime,
  trigger: ReturnType<GovernanceRuntime['storeRef']['triggers']['get']>,
  verbatimQuote: string | undefined,
  sourceType: 'session' | 'inference' | undefined,
): boolean {
  if (!trigger || sourceType === 'inference') return false
  const quote = verbatimQuote?.trim() ?? ''
  if (quote.length < 4 || !trigger.text.includes(quote)) return false
  if (!canPolicyDirectOverride(gov.memoryPolicy, trigger.source, trigger.meta?.localAuthenticated === true)) return false
  const atMs = Date.parse(trigger.at)
  const nowMs = gov.nowDate().getTime()
  if (Number.isFinite(atMs) && Math.abs(nowMs - atMs) > MAX_OVERRIDE_AGE_MS) return false
  const feed = gov.storeRef.get(KV.governance.feed) ?? []
  const recentBossTriggerIds = new Set(
    feed.filter(item => item.role === 'boss' && item.kind === 'boss_message' && item.triggerId)
      .slice(-5).map(item => item.triggerId!),
  )
  return recentBossTriggerIds.has(trigger.id)
}

/** 宿主执行 `orchestrator_memory_propose`：强守原文核验（禁止模型传 `evidence_text`），鉴权通过时升级话中直改并吐出可逆回执。 */
export async function executeSecretaryMemoryPropose(
  gov: GovernanceRuntime,
  args: z.infer<typeof ProposeSchema>,
  resolveTriggerEnv: (triggerId: string) => Promise<{ ref: SourceRef; env: SpineEnvelope<Record<string, unknown>> } | undefined>,
  stripUndefined: <T>(v: T) => T,
): Promise<unknown> {
  let sourceRef = args.source_ref
  let env = sourceRef ? await gov.readSpineEnvelope(sourceRef) : undefined
  if (!env && args.trigger_id) {
    const resolved = await resolveTriggerEnv(args.trigger_id)
    if (resolved) { sourceRef = resolved.ref; env = resolved.env }
  }
  if (!env || !sourceRef) {
    return {
      kind: 'rejected',
      reason: 'unknown-source-ref',
      detail: args.trigger_id
        ? `未在 M0 事件脊中找到 trigger_id=${args.trigger_id} 对应的 trigger.received`
        : `source_ref 未在事件脊中确认: seq=${args.source_ref?.seq ?? 'missing'}`,
    }
  }

  if (args.mode === 'tombstone') {
    if (!args.entry_id?.trim() || !args.reason?.trim()) throw new Error('tombstone mode requires entry_id and reason')
    if (args.layer === 'm2') return { kind: 'rejected', reason: 'forbidden', detail: '禁止秘书工具对 M2 条目打墓碑' }
    const rel = resolveMemoryRelPath({ layer: args.layer, ...(args.slug ? { slug: args.slug } : {}), ...(args.workspace_key ? { workspaceKey: args.workspace_key } : {}) })
    const page = await gov.memoryRepoLock.run(() => readMemoryPage(gov.memoryDir, rel))
    const hit = page?.layer !== 'm6' ? page?.entries.find(e => e.id === args.entry_id) : undefined
    if (hit && (hit.sourceType === 'user_ruling' || hit.sourceType === 'user_direct')) {
      return { kind: 'rejected', reason: 'forbidden', detail: '禁止秘书工具对老板直述或裁决条目打墓碑' }
    }
    const tombRes = await gov.memory.tombstone({
      target: { layer: args.layer, ...(args.slug ? { slug: args.slug } : {}), ...(args.workspace_key ? { workspaceKey: args.workspace_key } : {}) },
      entryId: args.entry_id, reason: args.reason, sourceRef, author: 'secretary',
    })
    await gov.ftsIndex.rebuild().catch(() => undefined)
    gov.epochInjector.invalidateEntry(args.entry_id)
    return stripUndefined({ kind: 'tombstoned', ...tombRes })
  }

  if (!args.statement?.trim()) throw new Error('propose mode requires statement')
  if (args.layer === 'm2' && env.taint === 'untrusted') {
    return { kind: 'rejected', reason: 'forbidden', detail: '禁止使用 untrusted 来源事件写入 M2 记忆' }
  }

  const { trigger, hostText } = resolveHostEvidenceText(gov, args.trigger_id, env)
  const quote = args.verbatim_quote?.trim()
  if (quote !== undefined && args.source_type !== 'inference') {
    if (quote.length < 4 || !hostText.includes(quote)) {
      return { kind: 'rejected', reason: 'verbatim-quote-mismatch', detail: '逐字引证长度不足 4 或未在宿主真实消息原文中命中，已拒绝写入' }
    }
  }

  const elevated = canElevateBossLiveOverride(gov, trigger, quote, args.source_type)
  const resolvedScope: MemoryScope = normalizeMemoryScope(args.layer, args.scope, args.workspace_key)
  const propRes = await gov.memory.propose({
    layer: args.layer,
    ...(args.slug ? { slug: args.slug } : {}),
    ...(args.workspace_key ? { workspaceKey: args.workspace_key } : {}),
    statement: args.statement,
    scope: resolvedScope,
    sourceType: elevated ? 'user_direct' : (args.source_type ?? 'session'),
    sourceRef,
    author: elevated ? 'user' : 'secretary',
    taint: memoryTaintOf(env.taint),
    overrideTombstone: false,
    ...(args.topic_key ? { topicKey: args.topic_key } : {}),
    ...(args.clearance ? { clearance: args.clearance } : {}),
    ...(args.m2_kind ? { m2Kind: args.m2_kind } : {}),
    ...(args.resident !== undefined ? { resident: args.resident } : {}),
    ...(args.importance !== undefined ? { importance: args.importance } : {}),
    ...(quote ? { verbatimQuote: quote } : {}),
    ...(hostText ? { evidenceText: hostText } : {}),
    ...(args.trigger_keys ? { triggerKeys: args.trigger_keys } : {}),
  })

  if (propRes.kind === 'accepted') {
    await gov.ftsIndex.rebuild().catch(() => undefined)
    gov.epochInjector.invalidateEntry(propRes.entry.id)
    for (const sid of propRes.supersededIds) gov.epochInjector.invalidateEntry(sid)
    if (elevated) {
      const supText = propRes.supersededIds.length ? `（已替换旧记忆 ${propRes.supersededIds.join(', ')}）` : ''
      appendSecretaryFeed(gov.storeRef, {
        id: `mem-rcpt-${randomUUID().slice(0, 10)}`,
        at: gov.nowDate().toISOString(),
        role: 'secretary',
        kind: 'memory_receipt',
        text: `已更新记忆 [${propRes.entry.id}]：${propRes.entry.statement}${supText}${propRes.commit ? ` (${propRes.commit.slice(0, 7)})` : ''}`,
        sourceRef,
        ...(trigger ? { triggerId: trigger.id } : {}),
        memoryMeta: {
          entryId: propRes.entry.id,
          layer: args.layer,
          ...(propRes.commit ? { commit: propRes.commit } : {}),
          supersededIds: propRes.supersededIds,
        },
      })
    }
  }
  return stripUndefined(propRes)
}

/** UI/管理面老板一键作废单条记忆（先入 M0 `memory.user_direct` 拿真 SourceRef，再墓碑归档并刷新检索与 Epoch 缓存）。 */
export async function tombstoneMemoryEntryByBoss(
  gov: GovernanceRuntime,
  input: { entryId: string; layer: FactLayer; slug?: string; workspaceKey?: string; reason: string; actorRef?: string },
): Promise<{ ok: boolean; entry?: MemoryEntry; pagePath?: string; commit?: string; sourceRef?: SourceRef; reason?: string }> {
  const atIso = gov.nowDate().toISOString()
  const sourceRef = gov.appender.append({
    id: `mem:tombstone:${randomUUID().slice(0, 12)}`,
    at: atIso,
    stream: `memory:${input.layer}`,
    type: 'memory.user_direct',
    source: { kind: 'human', ref: input.actorRef ?? 'boss' },
    evidence: [],
    taint: 'trusted',
    payload: { layer: input.layer, action: 'tombstone', entryId: input.entryId, reason: input.reason.trim() },
  })
  try {
    const target = { layer: input.layer, ...(input.slug ? { slug: input.slug } : {}), ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}) }
    const res = await gov.memory.tombstone({ target, entryId: input.entryId, reason: input.reason.trim(), sourceRef, author: input.actorRef ?? 'user' })
    const ledger = await gov.memoryRepoLock.run(() => readMemoryPage(gov.memoryDir, 'm6/ledger.md'))
    if (ledger?.layer === 'm6') {
      for (const item of (ledger as LedgerPage).items) {
        if ((item.status === 'pending' || item.status === 'asked') && item.kind === 'conflict' && item.conflictingEntryIds?.includes(input.entryId)) {
          await gov.memory.transitionAttention({ id: item.id, action: 'expire' }, input.actorRef ?? 'user').catch(() => undefined)
        }
      }
    }
    await gov.ftsIndex.rebuild().catch(() => undefined)
    gov.epochInjector.invalidateEntry(input.entryId)
    return { ok: true, entry: res.entry, pagePath: res.pagePath, ...(res.commit ? { commit: res.commit } : {}), sourceRef }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
