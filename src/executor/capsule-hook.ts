/** 执行器发射前机械 1-Hop 切片、关键词 rg 定位、风险分诊与自适应派发钩子。 */
import { existsSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { assembleCapsule, sliceWorkspaceContext, type ContextCapsule, type PitfallNote, type SliceResult } from '../context/index.ts'
import type { Assignment, Ticket } from '../core/index.ts'
import { DEFAULT_ADAPTIVE_DISPATCH_PARAMS, type PlanReviewOutcome, type ThinkingTier } from '../judgement/gates/index.ts'
import {
  matchDepositPlaybooks, renderPlaybookCapsuleBlock,
  type JudgementRegistry, type PlaybookCandidate, type Verdict,
} from '../judgement/index.ts'
import type { SpineDraft } from '../spine/types.ts'
import { renderPlanReviewNotice, runLaunchPlanReviewPhase, type HostPlanReviewRunner } from './adversarial-review.ts'
import { DSH_BUNDLED_RG, locateFilesByKeywords } from './keyword-locator.ts'
import { classifyWorkflowRisk, renderElevatedWorkflowNotice, type WorkflowRiskResult } from './workflow-risk.ts'

const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'lib', 'coverage', '.next', '.local'])
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'fix', 'add', 'update', 'change', 'check', 'please',
  'bot', 'src', 'test', 'tests', 'file', 'files', 'code', 'issue', 'bug', 'feature', 'work', 'ticket', 'task',
  'not', 'note', 'routing', 'source', 'request', 'scope', 'proactively', 'accepted', 'under', 'verify', 'pnpm', 'npm',
  '普通任务', '无路径', '修复', '修改', '新增', '检查', '看看', '一下', '问题', '功能', '模块', '文件', '代码', '请帮我', '验收标准',
])

export interface LaunchDispatchPlan {
  readonly executionMode: 'solo' | 'team'
  readonly thinkingTier: ThinkingTier
  readonly escalateReason?: string
}

export interface PreparedLaunchCapsule {
  readonly verdict: Verdict
  readonly dispatch?: LaunchDispatchPlan
  readonly workflowRisk?: WorkflowRiskResult
  readonly planReview?: PlanReviewOutcome
  readonly blocked?: readonly [string, ...string[]]
  readonly capsule: ContextCapsule
  readonly slice: SliceResult
  readonly matchedPlaybooks?: readonly string[]
}

export interface LaunchCapsuleInput {
  readonly ticket: Pick<Ticket, 'id' | 'title' | 'assignments' | 'execution'>
  readonly assignment?: Pick<Assignment, 'id'>
  readonly workspaceDir: string
  readonly triggerText?: string
  readonly registry: Pick<JudgementRegistry, 'evaluate'> & {
    list?: () => readonly { kind: string; stage: string; point?: string }[]
  }
  readonly recordSpine?: (event: SpineDraft<Record<string, unknown>>) => void
  readonly retryCount?: number
  readonly allowTeam?: boolean
  readonly maxBytes?: number
  readonly pitfallNotes?: readonly PitfallNote[]
  readonly playbooks?: readonly PlaybookCandidate[]
  readonly generationHash?: string
  readonly rgBin?: string
  readonly runPlanReview?: HostPlanReviewRunner
  readonly planReviewCache?: Map<string, PlanReviewOutcome>
}

const PATH_CANDIDATE_RE =
  /(?<![A-Za-z0-9_./:-])((?:\.\/)?(?:(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,10}))(?::\d+(?:-\d+)?)?(?:#L?\d+(?:-L?\d+)?)?(?![A-Za-z0-9_./-])/g

let hookSeq = 0

const CN_FILLER_RE =
  /帮咱们|去项目里|项目里|查一下|跟我说声|能不能|为什么|多少条|咱们|帮我|叫人|顺便|在它|对应的|测试里|加一条|简单的|跑通|搞完了|最多|多少|一下|现在|什么|怎么|可以/g

/** 从工单标题、任务说明与触发文本中提取相对文件路径候选，过滤 URL、代码块、忽略目录与目录穿越。 */
export function extractCandidatePaths(texts: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const raw of texts) {
    if (!raw) continue
    const scrubbed = raw.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ')
    PATH_CANDIDATE_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PATH_CANDIDATE_RE.exec(scrubbed)) !== null) {
      const cleaned = match[1]!.replace(/\\/g, '/').replace(/^\.\//, '')
      if (!cleaned || cleaned.startsWith('/') || cleaned.split('/').some(seg => seg === '..' || IGNORE_DIRS.has(seg))) continue
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
    if (candidate.split('/').some(seg => IGNORE_DIRS.has(seg))) continue
    try {
      const abs = resolve(rootReal, candidate)
      const info = await stat(abs)
      if (!info.isFile()) continue
      const real = await realpath(abs)
      const rel = relative(rootReal, real).replace(/\\/g, '/')
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || seen.has(rel)) continue
      if (rel.split('/').some(seg => IGNORE_DIRS.has(seg))) continue
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

function extractDispatchPlan(verdict: Verdict): LaunchDispatchPlan | undefined {
  if (verdict.kind !== 'allow') return undefined
  const raw = (verdict.produced?.['ticket.adaptive-dispatch']
    ?? (verdict.produced ? Object.values(verdict.produced)[0] : undefined)) as Record<string, unknown> | undefined
  const mode = raw?.['executionMode'] === 'team' ? 'team' : 'solo'
  const tier = raw?.['thinkingTier']
  const thinkingTier: ThinkingTier = tier === 'high' || tier === 'medium' || tier === 'low'
    ? tier : DEFAULT_ADAPTIVE_DISPATCH_PARAMS.default_thinking
  const reason = typeof raw?.['escalateReason'] === 'string' && raw['escalateReason'] ? raw['escalateReason'] : undefined
  return { executionMode: mode, thinkingTier, ...(reason ? { escalateReason: reason } : {}) }
}

/** 从自然语言标题与描述中提取标识符与领域关键词（优先标识符，过滤模板噪声与停用词），用于无显式路径时的 rg 定位。 */
export function extractSearchKeywords(texts: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const cleanedTexts = texts.filter((t): t is string => Boolean(t)).map(raw =>
    raw
      .replace(/Routing note \(not the source request\):/gi, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(PATH_CANDIDATE_RE, ' '),
  )
  // 第一轮优先提取驼峰/下划线代码标识符，防止被模板短词挤占配额
  for (const scrubbed of cleanedTexts) {
    for (const m of scrubbed.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,39}/g)) {
      const tok = m[0]!
      if ((/[A-Z_]/.test(tok.slice(1)) || tok.length >= 6) && !STOP_WORDS.has(tok.toLowerCase())) seen.add(tok)
      if (seen.size >= 14) return [...seen]
    }
  }
  for (const scrubbed of cleanedTexts) {
    for (const m of scrubbed.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,39}/g)) {
      const tok = m[0]!
      if (!STOP_WORDS.has(tok.toLowerCase())) seen.add(tok)
      if (seen.size >= 14) return [...seen]
    }
    const cnScrubbed = scrubbed.replace(CN_FILLER_RE, ' ')
    for (const m of cnScrubbed.matchAll(/[\u4e00-\u9fa5]{2,12}/g)) {
      const tok = m[0]!
      if (tok.length <= 6 && !STOP_WORDS.has(tok)) seen.add(tok)
      if (seen.size >= 14) return [...seen]
      if (tok.length > 3) {
        for (let i = 0; i <= tok.length - 2; i++) {
          const bi = tok.slice(i, i + 2)
          if (!STOP_WORDS.has(bi)) seen.add(bi)
          if (seen.size >= 14) return [...seen]
        }
      }
    }
  }
  return [...seen]
}

/** 发射前提取工作区 1-Hop 切片（显式路径优先，缺失时走关键词 rg 定位）、风险分诊与自适应派发并记入 M0。 */
export async function prepareLaunchCapsule(input: LaunchCapsuleInput): Promise<PreparedLaunchCapsule | undefined> {
  const { ticket, assignment, workspaceDir, triggerText, registry, recordSpine } = input
  const texts = [triggerText, ticket.title, ticket.execution?.assignment]
  const candidates = extractCandidatePaths(texts)
  let entryFiles = await resolveExistingRepoFiles(workspaceDir, candidates)
  if (entryFiles.length === 0) {
    const keywords = extractSearchKeywords(texts)
    entryFiles = await locateFilesByKeywords(workspaceDir, keywords, input.rgBin)
  }
  const retryCount = input.retryCount ?? countFailedRetries(ticket.assignments)
  const verifyCmds = ticket.execution?.verifyCommands
  const initialRisk = classifyWorkflowRisk({
    paths: entryFiles.length > 0 ? entryFiles : candidates, title: ticket.title,
    assignment: ticket.execution?.assignment, triggerText, retryCount,
  })
  const matchedPlaybooks = input.playbooks?.length
    ? matchDepositPlaybooks({
        deposits: input.playbooks, workspace: ticket.execution?.workspace, entryFiles,
        title: ticket.title, ...(triggerText ? { triggerText } : {}), riskTier: initialRisk.tier,
      })
    : []
  if (entryFiles.length === 0 && retryCount === 0 && (!verifyCmds || verifyCmds.length === 0) && matchedPlaybooks.length === 0 && initialRisk.tier === 'fast') {
    return undefined
  }

  const resolvedRg = input.rgBin ?? (existsSync(DSH_BUNDLED_RG) ? DSH_BUNDLED_RG : undefined)
  const slice: SliceResult = entryFiles.length > 0
    ? await sliceWorkspaceContext({
        workspaceRoot: workspaceDir,
        entryFiles,
        ...(triggerText ? { queryText: triggerText } : {}),
        ...(input.pitfallNotes ? { pitfallNotes: input.pitfallNotes } : {}),
        ...(resolvedRg ? { rgBin: resolvedRg } : {}),
      })
    : {
        workspaceRoot: workspaceDir, targetFiles: [], targetContents: [], importedSignatures: [],
        callSites: [], relatedTests: [], matchedPitfalls: [], usedFallback: false,
        metrics: { targetFiles: 0, importedTypesCount: 0, callSiteCount: 0, relatedTestsCount: 0, totalBytes: 0, durationMs: 0 },
      }
  const evaluation = await registry.evaluate('ticket.adaptive-dispatch', {
    metrics: slice.metrics,
    retryCount,
    ...(input.allowTeam !== undefined ? { allowTeam: input.allowTeam } : {}),
  })
  const dispatch = extractDispatchPlan(evaluation.verdict)
  const riskPaths = slice.targetFiles.length > 0 ? slice.targetFiles : candidates
  const workflowRisk = classifyWorkflowRisk({
    paths: riskPaths, title: ticket.title, assignment: ticket.execution?.assignment, triggerText, retryCount,
    ...(dispatch ? { executionMode: dispatch.executionMode } : {}),
  })
  const finalPlaybooks = input.playbooks?.length && (workflowRisk.tier !== initialRisk.tier || slice.targetFiles.length > entryFiles.length)
    ? matchDepositPlaybooks({
        deposits: input.playbooks, workspace: ticket.execution?.workspace, entryFiles: riskPaths,
        title: ticket.title, ...(triggerText ? { triggerText } : {}), riskTier: workflowRisk.tier,
      })
    : matchedPlaybooks
  const planPhase = await runLaunchPlanReviewPhase({
    ticketId: ticket.id, ...(assignment ? { assignmentId: assignment.id } : {}), title: ticket.title,
    ...(ticket.execution?.assignment ? { assignmentText: ticket.execution.assignment } : {}),
    ...(triggerText ? { triggerText } : {}), riskPaths, workflowRisk,
    ...(input.generationHash ? { generationHash: input.generationHash } : {}), registry,
    ...(input.runPlanReview ? { runPlanReview: input.runPlanReview } : {}),
    ...(input.planReviewCache ? { planReviewCache: input.planReviewCache } : {}),
  })
  const blockers: string[] = [...(evaluation.verdict.kind === 'deny' ? evaluation.verdict.blockers : []), ...planPhase.blockers]
  const blocked = blockers.length > 0 ? blockers as [string, ...string[]] : undefined
  const budgetBytes = input.maxBytes ?? DEFAULT_ADAPTIVE_DISPATCH_PARAMS.max_capsule_bytes
  const playbookBlock = renderPlaybookCapsuleBlock(finalPlaybooks, Math.min(4096, budgetBytes))
  const verifyHeader = verifyCmds?.length ? `## 标准验证命令\n\`\`\`verify\n${verifyCmds.join('\n')}\n\`\`\`\n\n` : ''
  const riskNotice = renderElevatedWorkflowNotice(workflowRisk)
  const planNotice = planPhase.planReview ? renderPlanReviewNotice(planPhase.planReview) : ''
  const prefix = verifyHeader + (riskNotice ? `${riskNotice}\n\n` : '') + (planNotice ? `${planNotice}\n\n` : '') + (playbookBlock.text ? `${playbookBlock.text}\n\n` : '')
  const prefixBytes = Buffer.byteLength(prefix, 'utf8')
  const baseCapsule = assembleCapsule(slice, Math.max(0, budgetBytes - (prefixBytes <= budgetBytes ? prefixBytes : 0)))
  const fullText = prefix && prefixBytes <= budgetBytes ? prefix + baseCapsule.text : baseCapsule.text
  const capsule: ContextCapsule = prefix && prefixBytes <= budgetBytes
    ? { ...baseCapsule, budgetBytes, text: fullText, usedBytes: Buffer.byteLength(fullText, 'utf8') }
    : baseCapsule

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
        ...(dispatch ? { dispatch } : {}),
        workflowRisk,
        ...(blocked ? { blocked } : {}),
        capsuleBytes: capsule.usedBytes,
        overflow: capsule.overflow,
        droppedItems: capsule.droppedItems,
        matchedPlaybooks: playbookBlock.matchedIds,
        ...(input.generationHash ? { generationHash: input.generationHash } : {}),
      },
    })
    if (planPhase.spineDraft) recordSpine({ ...planPhase.spineDraft, id: `${planPhase.spineDraft.id}:${++hookSeq}` })
  }

  return {
    verdict: evaluation.verdict,
    ...(dispatch ? { dispatch } : {}),
    workflowRisk,
    ...(planPhase.planReview ? { planReview: planPhase.planReview } : {}),
    ...(blocked ? { blocked } : {}),
    capsule,
    slice,
    ...(playbookBlock.matchedIds.length ? { matchedPlaybooks: playbookBlock.matchedIds } : {}),
  }
}
