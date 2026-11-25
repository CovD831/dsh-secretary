import type { GateDef, Verdict } from '../types.ts'

export type IssueKind = 'bug' | 'enhancement' | 'question' | 'docs' | 'security'
export type IntakeProposedAction = 'triage' | 'needs-info' | 'auto-close-duplicate'
export type BugQuadrupleField = 'version' | 'platform' | 'steps' | 'errorText'

export interface BugQuadruple {
  readonly version?: string | null
  readonly platform?: string | null
  readonly steps?: string | null
  readonly errorText?: string | null
}

export interface DedupCandidate {
  readonly issueNumber: number
  readonly similarity: number
  readonly diffSummary?: string
}

export interface IssueIntakeParams {
  readonly dedup_similarity_threshold: number
  readonly require_error_text: boolean
}

export const DEFAULT_ISSUE_INTAKE_PARAMS: IssueIntakeParams = Object.freeze({
  dedup_similarity_threshold: 0.85,
  require_error_text: true,
})

export interface IssueIntakeCtx {
  readonly issueType?: IssueKind | string | null
  readonly body?: string | null
  readonly quadruple?: BugQuadruple | null
  readonly dedupCandidates?: readonly DedupCandidate[]
  readonly proposedAction?: IntakeProposedAction | string
  readonly params?: Partial<IssueIntakeParams>
}

declare module '../types.ts' {
  interface PointCatalog {
    'intake.bug-quadruple': IssueIntakeCtx
  }
}

const VALID_ISSUE_KINDS = new Set<string>(['bug', 'enhancement', 'question', 'docs', 'security'])
const VALID_ACTIONS = new Set<string>(['triage', 'needs-info', 'auto-close-duplicate'])
const ALL_QUADRUPLE_FIELDS: readonly BugQuadrupleField[] = ['version', 'platform', 'steps', 'errorText']

function validateParams(p: IssueIntakeParams): string | undefined {
  if (!Number.isFinite(p.dedup_similarity_threshold) || p.dedup_similarity_threshold < 0.5 || p.dedup_similarity_threshold > 0.99) {
    return `参数 dedup_similarity_threshold=${String(p.dedup_similarity_threshold)} 超出允许范围 [0.5, 0.99]`
  }
  if (typeof p.require_error_text !== 'boolean') {
    return `参数 require_error_text=${String(p.require_error_text)} 必须为布尔值`
  }
  return undefined
}

/** 评估 Issue 入口四元组完备性与去重 T1 天花板，严禁猜测补全或自动关重复单。 */
export function evaluateIssueIntake(
  ctx: IssueIntakeCtx,
  boundParams?: Partial<IssueIntakeParams>,
): Verdict {
  const p: IssueIntakeParams = { ...DEFAULT_ISSUE_INTAKE_PARAMS, ...ctx.params, ...boundParams }
  const paramErr = validateParams(p)
  if (paramErr) return { kind: 'deny', blockers: [paramErr] }

  if (ctx.issueType === undefined || ctx.issueType === null || (typeof ctx.issueType === 'string' && ctx.issueType.trim() === '') || ctx.body === undefined || ctx.body === null) {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少 Issue 类型 issueType 或正文 body' }
  }
  if (typeof ctx.issueType !== 'string' || !VALID_ISSUE_KINDS.has(ctx.issueType)) {
    return { kind: 'deny', blockers: [`未知 Issue 类型 "${String(ctx.issueType)}"`] }
  }
  if (typeof ctx.body !== 'string') {
    return { kind: 'unmeasured', cause: 'missing-input', detail: 'Issue 正文 body 非有效字符串' }
  }
  if (ctx.proposedAction !== undefined && !VALID_ACTIONS.has(ctx.proposedAction)) {
    return { kind: 'deny', blockers: [`未知分流动作 "${String(ctx.proposedAction)}"`] }
  }
  if (ctx.proposedAction === 'auto-close-duplicate') {
    return { kind: 'deny', blockers: ['去重天花板为 T1 提议对照表：严禁自动关闭重复 Issue，必须由维护者人工确认'] }
  }

  if (ctx.dedupCandidates !== undefined && !Array.isArray(ctx.dedupCandidates)) {
    return { kind: 'deny', blockers: ['dedupCandidates 必须为数组'] }
  }
  for (const c of ctx.dedupCandidates ?? []) {
    if (!c || typeof c !== 'object' || typeof c.similarity !== 'number' || !Number.isFinite(c.similarity)) {
      return { kind: 'unmeasured', cause: 'missing-input', detail: 'dedupCandidates 包含缺失或非有限 similarity（NaN/Infinity）' }
    }
    if (!Number.isInteger(c.issueNumber) || c.issueNumber <= 0 || c.similarity < 0 || c.similarity > 1) {
      return { kind: 'deny', blockers: [`dedupCandidates 条目非法：issueNumber=${String(c.issueNumber)}, similarity=${String(c.similarity)}`] }
    }
  }

  const dedupProposals = (ctx.dedupCandidates ?? [])
    .filter(c => c.similarity >= p.dedup_similarity_threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .map(c => ({
      issueNumber: c.issueNumber,
      similarity: c.similarity,
      diffSummary: c.diffSummary?.trim() || '待补充关键字段差异对照',
    }))

  const quad = ctx.quadruple ?? {}
  const recognizedFields = ALL_QUADRUPLE_FIELDS.filter(f => typeof quad[f] === 'string' && quad[f]!.trim() !== '')
  const requiredFields = p.require_error_text ? ALL_QUADRUPLE_FIELDS : ALL_QUADRUPLE_FIELDS.filter(f => f !== 'errorText')
  const missingFields = ctx.issueType === 'bug' ? requiredFields.filter(f => !recognizedFields.includes(f)) : []

  if (ctx.issueType === 'bug' && missingFields.length > 0) {
    if (ctx.proposedAction === 'triage') {
      return {
        kind: 'deny',
        blockers: [`bug 四元组缺项（${missingFields.join(', ')}），禁止猜测补全后直接推进复现，须先索取信息`],
      }
    }
    return {
      kind: 'allow',
      produced: { nextStep: 'needs-info', recognizedFields, missingFields, dedupProposals },
    }
  }

  return {
    kind: 'allow',
    produced: {
      nextStep: ctx.proposedAction === 'needs-info' ? 'needs-info' : 'triage',
      recognizedFields,
      missingFields,
      dedupProposals,
    },
  }
}

export function createIssueIntakeGate(boundParams?: Partial<IssueIntakeParams>): GateDef<'intake.bug-quadruple'> {
  return {
    kind: 'gate',
    id: 'intake.bug-quadruple',
    version: 1,
    point: 'intake.bug-quadruple',
    description: 'Issue 入口四元组完备性检查、已识别字段回显与去重 T1 天花板硬门',
    side: 'hard',
    placement: { timing: 'pre', enforce: true },
    requires: ['issueType', 'body'],
    gate: ctx => evaluateIssueIntake(ctx, boundParams),
  }
}

export const issueIntakeGate: GateDef<'intake.bug-quadruple'> = createIssueIntakeGate()
