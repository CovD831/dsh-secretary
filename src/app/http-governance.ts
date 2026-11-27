/** 秘书总线、三工作台（沉淀/记忆/RSI 校准）与 F1 像素样张的管理面 HTTP 路由处理器。 */
import { z } from 'zod'
import type { Engine } from '../core/index.ts'
import type { Stage, TransitionDepositStageResult } from '../judgement/index.ts'
import { KV } from '../kv.ts'
import type { DreamRunReport, MemoryEntry, UserDirectMemoryResult, WriteResult } from '../memory/index.ts'
import type { SourceRef } from '../spine/index.ts'
import { renderF1ProofHtml } from '../pixel-office/index.ts'
import { readDepositsProjection, readNotebookProjection, readSpineProjection, readStateProjection } from '../projection/index.ts'
import type { AblationCase, HoldoutEvaluationResult, LeaveOneOutResult, ReplayCase } from '../rsi/index.ts'
import type { Api, ApiResponse, RouteParams } from './api.ts'
import { adoptDepositDraft, listDepositDrafts, type AdoptDepositDraftResult, type DepositDraftEntry } from './governance-drafts.ts'
import type { PatrolRunReport } from './governance-patrol.ts'
import {
  changeDepositStage, decideMemoryPatch, openRsiSealedHoldout, readMemoryStudioView,
  readRsiStudioView, runRsiAblationCheck, saveDirectMemory, syncDepositsAndLedger,
  type MemoryStudioView, type RsiWorkbenchView,
} from './governance-ops.ts'
import { tombstoneMemoryEntryByBoss } from './memory-governance-helpers.ts'
import type { HttpHost } from './http.ts'
import { listAvatarPacks, selectAvatarPack } from './avatar-pipeline.ts'
import { generateAvatarPackViaProvider } from './avatar-provider.ts'
import { ingestBossDesktopMessage } from './tools/secretary-core.ts'

export type {
  AdoptDepositDraftResult, DepositDraftEntry, DreamRunReport, HoldoutEvaluationResult, LeaveOneOutResult, MemoryEntry,
  MemoryStudioView, PatrolRunReport, RsiWorkbenchView, SourceRef, TransitionDepositStageResult, UserDirectMemoryResult, WriteResult,
}

export interface GovernanceRouteInput<K extends keyof Api> {
  params: RouteParams<K>
  query: Record<string, string>
  body: (maxBytes?: number) => Promise<unknown>
}

export type GovernanceRouteKeys =
  | 'GET projection/state' | 'GET projection/notebook' | 'GET projection/spine' | 'GET projection/deposits'
  | 'GET rulings' | 'POST rulings/:id/decide' | 'GET secretary/feed' | 'POST secretary/messages'
  | 'GET deposits/ledger' | 'GET deposits/drafts' | 'POST deposits/drafts/adopt' | 'POST deposits/:id/stage'
  | 'POST governance/patrol'
  | 'GET memory/studio' | 'POST memory/direct' | 'POST memory/patches/:index' | 'POST memory/entries/:id/tombstone' | 'POST memory/dream'
  | 'GET rsi/workbench' | 'POST rsi/ablation' | 'POST rsi/holdout'
  | 'GET pixel-office/proof'
  | 'GET avatars' | 'POST avatars/select' | 'POST avatars/generate'

const count = z.coerce.number().int().nonnegative()
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(v => Math.min(max, v))
const SpineQuery = z.object({
  sinceSeq: count.optional(),
  limit: limit(50, 200),
  ticketId: z.string().max(128).optional(),
  type: z.string().max(128).optional(),
  tail: z.enum(['0', '1', 'true', 'false']).optional().transform(v => v === '1' || v === 'true'),
})

const DecideRulingBody = z.object({
  decision: z.enum(['approve', 'reject', 'revise']),
  optionId: z.string().trim().min(1).max(40).optional(),
  attribution: z.enum(['missing_rule', 'wrong_rule', 'unmeasurable', 'rule_conflict']).optional(),
  note: z.string().max(1000).optional(),
  captureAsRule: z.boolean().optional(),
  actorId: z.string().trim().min(1).max(80).default('boss'),
}).strict()

const BossMessageBody = z.object({
  text: z.string().trim().min(1).max(4000),
  threadId: z.string().trim().min(1).max(120).optional(),
}).strict()

const DepositStageBody = z.object({
  toStage: z.enum(['shadow', 'observe', 'enforce', 'retired']),
  reason: z.string().max(500).optional(),
}).strict()

const DirectMemoryBody = z.object({
  layer: z.enum(['m1', 'm2', 'm3', 'm4']).default('m2'),
  slug: z.string().max(80).optional(),
  workspaceKey: z.string().max(80).optional(),
  statement: z.string().trim().min(1).max(2000),
  scope: z.string().max(120).optional(),
  topicKey: z.string().max(120).optional(),
  m2Kind: z.enum(['preference', 'veto', 'shared_event', 'internal_moniker', 'correction_repair']).optional(),
  clearance: z.enum(['public', 'workspace', 'private']).optional(),
  resident: z.boolean().optional(),
  importance: z.number().min(0).max(1).optional(),
  overrideTombstone: z.boolean().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  invalidationReason: z.string().max(300).optional(),
}).strict()

const PatchDecisionBody = z.object({ decision: z.enum(['approve', 'dismiss']) }).strict()
const TombstoneEntryBody = z.object({
  layer: z.enum(['m1', 'm2', 'm3', 'm4']),
  slug: z.string().max(128).optional(),
  workspaceKey: z.string().max(128).optional(),
  reason: z.string().trim().min(1).max(300),
}).strict()
const DreamRunBody = z.object({ force: z.boolean().optional(), sessionId: z.string().max(128).optional() }).strict()

const AblationBody = z.object({
  cases: z.array(z.object({
    id: z.string(), family: z.string(), input: z.unknown(),
    expectedOutcome: z.enum(['defect', 'clean', 'unknown']),
    point: z.string().optional(),
  }).strict()),
}).strict()

const HoldoutBody = z.object({
  candidateId: z.string().trim().min(1).max(120),
  point: z.string().trim().min(3).max(120),
  cases: z.array(z.object({
    id: z.string(), family: z.string(), input: z.unknown(),
    expectedOutcome: z.enum(['defect', 'clean', 'unknown']),
  }).strict()),
}).strict()

const SelectAvatarBody = z.object({ avatarId: z.string().trim().min(1).max(64) }).strict()
const AdoptDraftBody = z.object({
  draftId: z.string().trim().min(1).max(120).optional(),
  draft: z.record(z.string(), z.unknown()).optional(),
  cases: z.array(z.object({
    name: z.string(), expected: z.enum(['allow', 'deny', 'unmeasured']), ctx: z.unknown(),
    expectedCause: z.string().optional(), note: z.string().optional(),
  }).strict()).optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
  installShadow: z.boolean().optional(),
  actorId: z.string().trim().min(1).max(80).optional(),
}).strict()
const PatrolBody = z.object({ maxIdleMinutes: z.number().finite().positive().max(1440).optional() }).strict()
const GenerateAvatarBody = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(1000),
  seed: z.number().int().nonnegative().optional(),
}).strict()

export function governanceRoutes(
  runtime: HttpHost,
  fail404: (msg: string) => never,
  fail400: (msg: string) => never,
): { [K in GovernanceRouteKeys]: (input: GovernanceRouteInput<K>) => ApiResponse<K> | Promise<ApiResponse<K>> } {
  const { store } = runtime
  const requireGov = () => runtime.governance ?? fail404('Governance runtime not mounted')
  return {
    'GET projection/state': () => readStateProjection(store, runtime.machine.stateDir),
    'GET projection/notebook': () => readNotebookProjection(runtime.machine.stateDir),
    'GET projection/spine': ({ query }) => readSpineProjection(store, runtime.machine.stateDir, SpineQuery.parse(query)),
    'GET projection/deposits': () => readDepositsProjection(store, runtime.machine.stateDir),
    'GET rulings': ({ query }) => {
      const gov = runtime.governance
      if (!gov) return { active: null, pendingCount: 0, items: [] }
      const status = query.status === 'pending' || query.status === 'decided' || query.status === 'cancelled' ? query.status : undefined
      return { ...gov.rulings.active(), items: gov.rulings.list(status) }
    },
    'POST rulings/:id/decide': async ({ params, body }) => {
      const parsed = DecideRulingBody.parse(await body())
      const { actorId, ...rest } = parsed
      return requireGov().rulings.decide({ id: params.id, actorId, ...rest })
    },
    'GET secretary/feed': () => {
      const items = store.get(KV.governance.feed) ?? []
      const active = runtime.governance ? runtime.governance.rulings.active() : { active: null, pendingCount: 0 }
      return { items, activeRuling: active.active, pendingCount: active.pendingCount }
    },
    'POST secretary/messages': async ({ body }) => {
      if (!runtime.governance || !runtime.engine.receive) fail400('Secretary bus is not ready')
      const parsed = BossMessageBody.parse(await body())
      const { trigger, received } = ingestBossDesktopMessage(
        { store, engine: runtime.engine as Pick<Engine, 'receive' | 'decide' | 'note'>, governance: runtime.governance, requestPass: () => runtime.requestPass() },
        parsed.text, parsed.threadId,
      )
      return { triggerId: trigger.id, received }
    },
    'GET deposits/ledger': async () => syncDepositsAndLedger(requireGov()),
    'GET deposits/drafts': ({ query }) => {
      const inc = query.includeOnlineCandidates !== '0' && query.includeOnlineCandidates !== 'false'
      const collectionMode = query.mode === 'e2e' ? 'e2e' : query.mode === 'production' ? 'production' : undefined
      return listDepositDrafts(requireGov(), { includeOnlineCandidates: inc, ...(collectionMode ? { collectionMode } : {}) })
    },
    'POST deposits/drafts/adopt': async ({ body }) => {
      const parsed = AdoptDraftBody.parse(await body())
      return adoptDepositDraft(requireGov(), parsed as never)
    },
    'POST deposits/:id/stage': async ({ params, body }) => {
      const parsed = DepositStageBody.parse(await body())
      return changeDepositStage(requireGov(), { id: params.id, toStage: parsed.toStage as Stage, ...(parsed.reason ? { reason: parsed.reason } : {}) })
    },
    'POST governance/patrol': async ({ body }) => {
      const parsed = PatrolBody.parse((await body()) ?? {})
      return requireGov().tickPatrol(parsed.maxIdleMinutes)
    },
    'GET memory/studio': () => readMemoryStudioView(requireGov()),
    'POST memory/direct': async ({ body }) => {
      const parsed = DirectMemoryBody.parse(await body())
      return saveDirectMemory(requireGov(), parsed as never)
    },
    'POST memory/patches/:index': async ({ params, body }) => {
      const parsed = PatchDecisionBody.parse(await body())
      const idx = Number(params.index)
      if (!Number.isInteger(idx) || idx < 0) fail400('Invalid patch index')
      return decideMemoryPatch(requireGov(), idx, parsed.decision)
    },
    'POST memory/entries/:id/tombstone': async ({ params, body }) => {
      const parsed = TombstoneEntryBody.parse(await body())
      return tombstoneMemoryEntryByBoss(requireGov(), { entryId: params.id, ...parsed })
    },
    'POST memory/dream': async ({ body }) => {
      const gov = requireGov()
      const parsed = DreamRunBody.parse((await body()) ?? {})
      return gov.dreamer.runNow({ sessionId: parsed.sessionId ?? gov.masterId, force: parsed.force ?? true, runDeep: true, trigger: 'manual' })
    },
    'GET rsi/workbench': ({ query }) => {
      const collectionMode = query.mode === 'e2e' ? 'e2e' : query.mode === 'production' ? 'production' : undefined
      return readRsiStudioView(requireGov(), runtime.persistence, collectionMode ? { collectionMode } : undefined)
    },
    'POST rsi/ablation': async ({ body }) => {
      const parsed = AblationBody.parse(await body())
      return runRsiAblationCheck(requireGov(), parsed.cases as AblationCase[])
    },
    'POST rsi/holdout': async ({ body }) => {
      const parsed = HoldoutBody.parse(await body())
      return openRsiSealedHoldout(requireGov(), {
        candidateId: parsed.candidateId, point: parsed.point, cases: parsed.cases as ReplayCase<unknown>[],
      })
    },
    'GET pixel-office/proof': () => ({
      workspaceId: 'secretary-main', seed: 20261126, width: 1440, height: 900, paletteColors: 46,
      html: renderF1ProofHtml(),
    }),
    'GET avatars': () => listAvatarPacks(runtime.machine.stateDir, store),
    'POST avatars/select': async ({ body }) => {
      const { avatarId } = SelectAvatarBody.parse(await body())
      try { return selectAvatarPack(runtime.machine.stateDir, store, avatarId) }
      catch (err) { fail404(err instanceof Error ? err.message : String(err)) }
    },
    'POST avatars/generate': async ({ body }) => {
      const parsed = GenerateAvatarBody.parse(await body())
      try {
        const pack = await generateAvatarPackViaProvider({
          stateDir: runtime.machine.stateDir, id: `ai-${Date.now()}`, name: parsed.name,
          prompt: parsed.prompt, ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}),
        })
        return { ok: true, pack }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
