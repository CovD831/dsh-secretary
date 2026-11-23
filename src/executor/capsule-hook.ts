/** 执行器发射前机械 1-Hop 切片与自适应派发钩子。 */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { assembleCapsule, sliceWorkspaceContext, type ContextCapsule, type PitfallNote, type SliceResult } from '../context/index.ts'
import type { Assignment, Ticket } from '../core/index.ts'
import { DEFAULT_ADAPTIVE_DISPATCH_PARAMS, type ThinkingTier } from '../judgement/gates/index.ts'
import type { JudgementRegistry, Verdict } from '../judgement/index.ts'
import type { SpineDraft } from '../spine/types.ts'

export interface LaunchDispatchPlan {
  readonly executionMode: 'solo' | 'team'
  readonly thinkingTier: ThinkingTier
  readonly escalateReason?: string
}

export interface PreparedLaunchCapsule {
  readonly dispatch: LaunchDispatchPlan
  readonly capsule: ContextCapsule
  readonly slice: SliceResult
}

export interface LaunchCapsuleInput {
  readonly ticket: Pick<Ticket, 'id' | 'title' | 'assignments' | 'execution'>
  readonly assignment?: Pick<Assignment, 'id'>
  readonly workspaceDir: string
  readonly triggerText?: string
  readonly registry: Pick<JudgementRegistry, 'evaluate'>
  readonly recordSpine?: (event: SpineDraft<Record<string, unknown>>) => void
  readonly retryCount?: number
  readonly maxBytes?: number
  readonly pitfallNotes?: readonly PitfallNote[]
  readonly rgBin?: string
}

const PATH_CANDIDATE_RE =
  /(?<![A-Za-z0-9_./:-])((?:\.\/)?(?:(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,10}))(?::\d+(?:-\d+)?)?(?:#L?\d+(?:-L?\d+)?)?(?![A-Za-z0-9_./-])/g

let hookSeq = 0

/** 从工单标题、任务说明与触发文本中提取相对文件路径候选，过滤 URL 与目录穿越。 */
export function extractCandidatePaths(texts: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const raw of texts) {
    if (!raw) continue
    const scrubbed = raw.replace(/https?:\/\/\S+/g, ' ')
    PATH_CANDIDATE_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PATH_CANDIDATE_RE.exec(scrubbed)) !== null) {
      const cleaned = match[1]!.replace(/\\/g, '/').replace(/^\.\//, '')
      if (!cleaned || cleaned.startsWith('/') || cleaned.split('/').includes('..')) continue
      seen.add(cleaned)
    }
  }
  return [...seen]
}

async function resolveExistingRepoFiles(workspaceDir: string, candidates: readonly string[]): Promise<string[]> {
  if (!workspaceDir.trim() || candidates.length === 0) return []
  let rootReal: string
  try {
    rootReal = await realpath(resolve(workspaceDir))
  } catch {
    return []
  }
  const verified: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    try {
      const abs = resolve(rootReal, candidate)
      const info = await stat(abs)
      if (!info.isFile()) continue
      const real = await realpath(abs)
      const rel = relative(rootReal, real).replace(/\\/g, '/')
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || seen.has(rel)) continue
      seen.add(rel)
      verified.push(rel)
    } catch {
      continue
    }
  }
  return verified
}

function countFailedRetries(assignments: readonly Pick<Assignment, 'state' | 'endedReason' | 'report'>[]): number {
  return assignments.filter(a => a.state === 'ended' && (a.report?.state === 'failed' || a.endedReason === 'retried')).length
}

function extractDispatchPlan(verdict: Verdict): LaunchDispatchPlan {
  if (verdict.kind === 'allow') {
    const raw = (verdict.produced?.['ticket.adaptive-dispatch']
      ?? (verdict.produced ? Object.values(verdict.produced)[0] : undefined)) as Record<string, unknown> | undefined
    const mode = raw?.['executionMode'] === 'team' ? 'team' : 'solo'
    const tier = raw?.['thinkingTier']
    const thinkingTier: ThinkingTier = tier === 'high' || tier === 'medium' || tier === 'low'
      ? tier : DEFAULT_ADAPTIVE_DISPATCH_PARAMS.default_thinking
    const reason = typeof raw?.['escalateReason'] === 'string' && raw['escalateReason'] ? raw['escalateReason'] : undefined
    return { executionMode: mode, thinkingTier, ...(reason ? { escalateReason: reason } : {}) }
  }
  const escalateReason = verdict.kind === 'deny' ? verdict.blockers.join('; ') : verdict.detail
  return { executionMode: 'solo', thinkingTier: DEFAULT_ADAPTIVE_DISPATCH_PARAMS.default_thinking, escalateReason }
}

/** 发射前提取工作区 1-Hop 切片、计算自适应派发档位并记录事件脊；未命中仓内真实文件时返回 undefined。 */
export async function prepareLaunchCapsule(input: LaunchCapsuleInput): Promise<PreparedLaunchCapsule | undefined> {
  const { ticket, assignment, workspaceDir, triggerText, registry, recordSpine } = input
  const candidates = extractCandidatePaths([ticket.title, ticket.execution?.assignment, triggerText])
  const entryFiles = await resolveExistingRepoFiles(workspaceDir, candidates)
  if (entryFiles.length === 0) return undefined

  const slice = await sliceWorkspaceContext({
    workspaceRoot: workspaceDir,
    entryFiles,
    ...(triggerText ? { queryText: triggerText } : {}),
    ...(input.pitfallNotes ? { pitfallNotes: input.pitfallNotes } : {}),
    ...(input.rgBin ? { rgBin: input.rgBin } : {}),
  })
  const retryCount = input.retryCount ?? countFailedRetries(ticket.assignments)
  const evaluation = await registry.evaluate('ticket.adaptive-dispatch', { metrics: slice.metrics, retryCount })
  const dispatch = extractDispatchPlan(evaluation.verdict)
  const capsule = assembleCapsule(slice, input.maxBytes ?? DEFAULT_ADAPTIVE_DISPATCH_PARAMS.max_capsule_bytes)

  if (recordSpine) {
    const sessionPtr = `dsh-session:worker-${ticket.id}`
    recordSpine({
      id: `gate:ticket.adaptive-dispatch:${ticket.id}:${assignment?.id ?? 'launch'}:${++hookSeq}`,
      stream: `ticket:${ticket.id}`,
      type: 'gate.evaluated',
      source: { kind: 'system', ref: 'executor.capsule-hook' },
      evidence: [
        { kind: 'event', ref: `session:worker-${ticket.id}` },
        { kind: 'event', ref: sessionPtr },
      ],
      taint: 'trusted',
      payload: {
        point: 'ticket.adaptive-dispatch',
        ticketId: ticket.id,
        ...(assignment ? { assignmentId: assignment.id } : {}),
        sessionPtr,
        entryFiles: slice.targetFiles,
        metrics: slice.metrics,
        retryCount,
        verdict: evaluation.verdict,
        dispatch,
        capsuleBytes: capsule.usedBytes,
        overflow: capsule.overflow,
        droppedItems: capsule.droppedItems,
      },
    })
  }

  return { dispatch, capsule, slice }
}
