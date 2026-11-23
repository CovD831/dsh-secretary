/** 作者面 S3 离线回放引擎与参数寻优对比器（只产提议与证据，绝不自动篡改已安装配置）。 */
import type { Verdict } from '../judgement/types.ts'
import { assertCaseSetEquality } from './evaluator.ts'
import type {
  FamilySplit,
  ParamCandidateEvaluation,
  ParamSweepOptions,
  ParamSweepResult,
  ReplayCase,
  ReplayCaseClassification,
  ReplayCaseTrace,
  ReplayGateFn,
  ReplayGateOutcome,
  ReplayOptions,
  ReplayReportCard,
} from './types.ts'

function normalizeGateOutcome(raw: ReplayGateOutcome): {
  verdict: Verdict
  deltaTokens?: number
  deltaMs?: number
} {
  if (raw && typeof raw === 'object' && 'verdict' in raw) {
    return { verdict: normalizeVerdict(raw.verdict), deltaTokens: raw.deltaTokens, deltaMs: raw.deltaMs }
  }
  return { verdict: normalizeVerdict(raw) }
}

function normalizeVerdict(raw: unknown): Verdict {
  if (!raw || typeof raw !== 'object') return { kind: 'unmeasured', cause: 'parse-failed', detail: '判据返回非对象裁决' }
  const v = raw as Record<string, unknown>
  if (v['kind'] === 'allow') return raw as Verdict
  if (v['kind'] === 'deny' && Array.isArray(v['blockers']) && v['blockers'].length > 0) return raw as Verdict
  if (v['kind'] === 'unmeasured' && typeof v['cause'] === 'string' && typeof v['detail'] === 'string') return raw as Verdict
  return { kind: 'unmeasured', cause: 'parse-failed', detail: `判据返回非法裁决形态: ${String(v['kind'])}` }
}

function classifyCase(expected: ReplayCase['expectedOutcome'], verdict: Verdict): ReplayCaseClassification {
  if (verdict.kind === 'unmeasured') return 'unmeasured'
  if (expected === 'unknown') return 'unknown-label'
  if (verdict.kind === 'deny') return expected === 'defect' ? 'catch' : 'false-block'
  return expected === 'defect' ? 'miss' : 'true-allow'
}

function resolveAxisCost(
  explicit: number | undefined,
  perEval: number | undefined,
  perTrigger: number | undefined,
  caseCost: number | undefined,
  isDeny: boolean,
  isFalseBlock: boolean,
  falseBlockMultiplier: number,
): number | undefined {
  if (explicit !== undefined && Number.isFinite(explicit)) return explicit
  let sum = 0
  let measured = false
  if (perEval !== undefined && Number.isFinite(perEval)) {
    sum += perEval
    measured = true
  }
  if (perTrigger !== undefined && Number.isFinite(perTrigger)) {
    if (isDeny) sum += perTrigger
    measured = true
  }
  if (caseCost !== undefined && Number.isFinite(caseCost)) {
    if (isFalseBlock) sum += caseCost * falseBlockMultiplier
    measured = true
  }
  return measured ? sum : undefined
}

/** 在冻结样本集上离线运行候选判据，严格双报 catches 与 falseBlocks 及覆盖折扣和边际成本。 */
export async function runHistoricalReplay<I>(
  gateFn: ReplayGateFn<I>,
  cases: readonly ReplayCase<I>[],
  options: ReplayOptions = {},
): Promise<ReplayReportCard> {
  const seenIds = new Set<string>()
  const caseIds: string[] = []
  const traces: ReplayCaseTrace[] = []
  let triggeredCount = 0
  let catches = 0
  let falseBlocks = 0
  let misses = 0
  let trueAllows = 0
  let unknownLabelCount = 0
  let unmeasuredCount = 0
  let sumTokens = 0
  let sumMs = 0
  let measuredTokens = 0
  let measuredMs = 0
  let unmeasuredTokens = 0
  let unmeasuredMs = 0

  const cm = options.costModel
  const fbMult = cm?.falseBlockMultiplier ?? 1

  for (const item of cases) {
    if (seenIds.has(item.id)) throw new Error(`回放作废：存在重复样本 id "${item.id}"`)
    seenIds.add(item.id)
    caseIds.push(item.id)

    let outcome: { verdict: Verdict; deltaTokens?: number; deltaMs?: number }
    try {
      outcome = normalizeGateOutcome(await gateFn(item.input, item))
    } catch (err) {
      outcome = { verdict: { kind: 'unmeasured', cause: 'threw', detail: err instanceof Error ? err.message : String(err) } }
    }

    const cls = classifyCase(item.expectedOutcome, outcome.verdict)
    const isDeny = outcome.verdict.kind === 'deny'
    if (isDeny) triggeredCount += 1
    if (cls === 'catch') catches += 1
    else if (cls === 'false-block') falseBlocks += 1
    else if (cls === 'miss') misses += 1
    else if (cls === 'true-allow') trueAllows += 1
    else if (cls === 'unmeasured') unmeasuredCount += 1
    if (item.expectedOutcome === 'unknown') unknownLabelCount += 1

    const dTokens = resolveAxisCost(outcome.deltaTokens, cm?.perEvalTokens, cm?.perTriggerTokens, item.tokens, isDeny, cls === 'false-block', fbMult)
    const dMs = resolveAxisCost(outcome.deltaMs, cm?.perEvalMs, cm?.perTriggerMs, item.durationMs, isDeny, cls === 'false-block', fbMult)
    if (dTokens !== undefined) { sumTokens += dTokens; measuredTokens += 1 } else unmeasuredTokens += 1
    if (dMs !== undefined) { sumMs += dMs; measuredMs += 1 } else unmeasuredMs += 1

    traces.push({
      caseId: item.id,
      family: item.family,
      expectedOutcome: item.expectedOutcome,
      verdict: outcome.verdict,
      classification: cls,
      ...(dTokens !== undefined ? { deltaTokens: dTokens } : {}),
      ...(dMs !== undefined ? { deltaMs: dMs } : {}),
    })
  }

  const totalCases = cases.length
  const coverageDiscount = totalCases === 0 ? 0 : (totalCases - unmeasuredCount) / totalCases
  const netBenefit = catches - falseBlocks - misses
  const costState = totalCases === 0 || (measuredTokens === 0 && measuredMs === 0)
    ? 'unmeasured'
    : unmeasuredTokens > 0 || unmeasuredMs > 0 ? 'partial' : 'measured'

  return {
    caseIds,
    totalCases,
    triggeredCount,
    catches,
    falseBlocks,
    misses,
    trueAllows,
    unknownLabelCount,
    unmeasuredCount,
    coverageDiscount,
    netBenefit,
    marginalCost: {
      deltaTokens: measuredTokens === 0 ? undefined : sumTokens,
      deltaMs: measuredMs === 0 ? undefined : sumMs,
      state: costState,
    },
    cases: traces,
  }
}

const costLeq = (a: number | undefined, b: number | undefined): boolean =>
  a === undefined ? b === undefined : b === undefined ? true : a <= b

const costLt = (a: number | undefined, b: number | undefined): boolean =>
  a === undefined ? false : b === undefined ? true : a < b

function dominates<P>(a: ParamCandidateEvaluation<P>, b: ParamCandidateEvaluation<P>): boolean {
  const aTok = a.validation.marginalCost.deltaTokens
  const bTok = b.validation.marginalCost.deltaTokens
  const aMs = a.validation.marginalCost.deltaMs
  const bMs = b.validation.marginalCost.deltaMs
  const noWorse = a.effectiveBenefit >= b.effectiveBenefit
    && a.validation.falseBlocks <= b.validation.falseBlocks
    && costLeq(aTok, bTok)
    && costLeq(aMs, bMs)
  if (!noWorse) return false
  return a.effectiveBenefit > b.effectiveBenefit
    || a.validation.falseBlocks < b.validation.falseBlocks
    || costLt(aTok, bTok)
    || costLt(aMs, bMs)
}

function cmpOptionalAsc(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return a - b
}

function assertSplitIsolation<I>(split: FamilySplit<I>): void {
  const seenFamily = new Map<string, string>()
  const seenId = new Map<string, string>()
  for (const [name, list] of [['train', split.train], ['validation', split.validation], ['holdout', split.holdout]] as const) {
    for (const c of list) {
      const prevFam = seenFamily.get(c.family)
      if (prevFam && prevFam !== name) throw new Error(`跨切分泄漏：family "${c.family}" 同时出现在 ${prevFam} 与 ${name}`)
      seenFamily.set(c.family, name)
      const prevId = seenId.get(c.id)
      if (prevId) throw new Error(`样本 id "${c.id}" 同时出现在 ${prevId} 与 ${name}`)
      seenId.set(c.id, name)
    }
  }
}

function formatSweepSummary<P>(
  maxFalseBlocksAllowed: number,
  evaluated: readonly ParamCandidateEvaluation<P>[],
  frontier: readonly ParamCandidateEvaluation<P>[],
  recommended: ParamCandidateEvaluation<P> | undefined,
  holdoutCount: number,
): string {
  const lines = [
    `[S3 参数寻优提议] proposalOnly=true | applied=false | holdoutOpened=false (密封 ${holdoutCount} 条)`,
    `护栏上限: validation.falseBlocks <= ${maxFalseBlocksAllowed} | 候选=${evaluated.length} | Pareto前沿=${frontier.map(f => `#${f.index}`).join(',') || '无'}`,
    recommended
      ? `推荐候选: #${recommended.index} params=${JSON.stringify(recommended.params)} (val: catches=${recommended.validation.catches}, falseBlocks=${recommended.validation.falseBlocks}, misses=${recommended.validation.misses}, coverage=${recommended.validation.coverageDiscount.toFixed(2)}, deltaTokens=${String(recommended.validation.marginalCost.deltaTokens)})`
      : '推荐候选: 无（全部候选均未通过零退化护栏或全部样本不可测）',
  ]
  for (const c of evaluated) {
    const v = c.validation
    lines.push(
      `  #${c.index} ${JSON.stringify(c.params)} -> val[catch=${v.catches}, fb=${v.falseBlocks}, miss=${v.misses}, unm=${v.unmeasuredCount}, cov=${v.coverageDiscount.toFixed(2)}, dTok=${String(v.marginalCost.deltaTokens)}, dMs=${String(v.marginalCost.deltaMs)}] ${c.guardrailPassed ? (c.paretoOptimal ? '[PARETO]' : '[PASS]') : `[REJECT: ${c.guardrailViolations.join('; ')}]`}`,
    )
  }
  return lines.join('\n')
}

/** 在 train/validation 上批量对比多组参数候选，按零退化护栏与 Pareto 非支配排序输出只读提议。 */
export async function compareParamCandidates<I, P>(
  buildGateWithParams: (params: P) => ReplayGateFn<I>,
  candidates: readonly P[],
  split: FamilySplit<I>,
  options: ParamSweepOptions<P> = {},
): Promise<ParamSweepResult<P>> {
  if (candidates.length === 0) throw new Error('参数寻优至少需要 1 组候选参数')
  if (split.validation.length === 0) throw new Error('参数寻优需要非空 validation 集，禁止无验证集选参')
  assertSplitIsolation(split)

  const replayOpts: ReplayOptions = options.costModel ? { costModel: options.costModel } : {}
  const expectedTrainIds = split.train.map(c => c.id)
  const expectedValIds = split.validation.map(c => c.id)

  let baseline: ParamSweepResult<P>['baseline']
  if (options.baseline !== undefined) {
    const baseGate = buildGateWithParams(options.baseline)
    const train = await runHistoricalReplay(baseGate, split.train, replayOpts)
    const validation = await runHistoricalReplay(baseGate, split.validation, replayOpts)
    assertCaseSetEquality(expectedTrainIds, train.caseIds, 'baseline-train')
    assertCaseSetEquality(expectedValIds, validation.caseIds, 'baseline-validation')
    baseline = { params: options.baseline, train, validation }
  }

  const maxFalseBlocksAllowed = options.maxFalseBlocks
    ?? (baseline ? baseline.validation.falseBlocks : options.maxFalseBlockRate !== undefined ? Math.floor(split.validation.length * options.maxFalseBlockRate) : 0)
  const minCov = options.minCoverageDiscount ?? 0

  const rawEvaluated: Omit<ParamCandidateEvaluation<P>, 'paretoOptimal'>[] = []
  for (let index = 0; index < candidates.length; index++) {
    const params = candidates[index]!
    const gate = buildGateWithParams(params)
    const train = await runHistoricalReplay(gate, split.train, replayOpts)
    const validation = await runHistoricalReplay(gate, split.validation, replayOpts)
    assertCaseSetEquality(expectedTrainIds, train.caseIds, `candidate-${index}-train`)
    assertCaseSetEquality(expectedValIds, validation.caseIds, `candidate-${index}-validation`)

    const violations: string[] = []
    if (validation.falseBlocks > maxFalseBlocksAllowed) violations.push(`falseBlocks ${validation.falseBlocks} > ${maxFalseBlocksAllowed}`)
    if (validation.unmeasuredCount === validation.totalCases) violations.push('验证集全部样本为 unmeasured')
    if (validation.coverageDiscount < minCov) violations.push(`coverageDiscount ${validation.coverageDiscount.toFixed(2)} < ${minCov}`)
    if (options.maxMisses !== undefined && validation.misses > options.maxMisses) violations.push(`misses ${validation.misses} > ${options.maxMisses}`)

    const effectiveBenefit = validation.netBenefit > 0 ? validation.netBenefit * validation.coverageDiscount : validation.netBenefit
    rawEvaluated.push({ index, params, train, validation, effectiveBenefit, guardrailPassed: violations.length === 0, guardrailViolations: violations })
  }

  const passing = rawEvaluated.filter(c => c.guardrailPassed)
  const paretoIds = new Set<number>()
  for (const cand of passing) {
    const asEval = { ...cand, paretoOptimal: false }
    const dominated = passing.some(other => other.index !== cand.index && dominates({ ...other, paretoOptimal: false }, asEval))
    if (!dominated) paretoIds.add(cand.index)
  }

  const evaluated: ParamCandidateEvaluation<P>[] = rawEvaluated.map(c => ({ ...c, paretoOptimal: paretoIds.has(c.index) }))
  const paretoFrontier = evaluated.filter(c => c.paretoOptimal)
  const sortedFrontier = [...paretoFrontier].sort((a, b) =>
    (b.effectiveBenefit - a.effectiveBenefit)
    || (a.validation.falseBlocks - b.validation.falseBlocks)
    || cmpOptionalAsc(a.validation.marginalCost.deltaTokens, b.validation.marginalCost.deltaTokens)
    || cmpOptionalAsc(a.validation.marginalCost.deltaMs, b.validation.marginalCost.deltaMs)
    || (a.index - b.index),
  )
  const recommended = sortedFrontier[0]

  return {
    proposalOnly: true,
    applied: false,
    holdoutOpened: false,
    holdoutCaseCount: split.holdout.length,
    maxFalseBlocksAllowed,
    ...(baseline ? { baseline } : {}),
    candidates: evaluated,
    paretoFrontier,
    recommended,
    summary: formatSweepSummary(maxFalseBlocksAllowed, evaluated, paretoFrontier, recommended, split.holdout.length),
  }
}
