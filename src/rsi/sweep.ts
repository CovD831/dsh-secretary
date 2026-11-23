/** 参数寻优对比器：零退化护栏 + 覆盖度感知 Pareto 非支配排序（只产提议，绝不改配置）。 */
import { assertCaseSetEquality } from './evaluator.ts'
import { runHistoricalReplay } from './replay.ts'
import type {
  FamilySplit,
  ParamCandidateEvaluation,
  ParamSweepOptions,
  ParamSweepResult,
  ReplayGateFn,
  ReplayOptions,
} from './types.ts'

const costLeq = (a: number | undefined, b: number | undefined): boolean =>
  a === undefined ? b === undefined : b === undefined ? true : a <= b

const costLt = (a: number | undefined, b: number | undefined): boolean =>
  a === undefined ? false : b === undefined ? true : a < b

function dominates<P>(a: ParamCandidateEvaluation<P>, b: ParamCandidateEvaluation<P>): boolean {
  const aTok = a.validation.marginalCost.deltaTokens, bTok = b.validation.marginalCost.deltaTokens
  const aMs = a.validation.marginalCost.deltaMs, bMs = b.validation.marginalCost.deltaMs
  const noWorse = a.effectiveBenefit >= b.effectiveBenefit
    && a.validation.coverageDiscount >= b.validation.coverageDiscount
    && a.validation.falseBlocks <= b.validation.falseBlocks
    && costLeq(aTok, bTok)
    && costLeq(aMs, bMs)
  if (!noWorse) return false
  return a.effectiveBenefit > b.effectiveBenefit
    || a.validation.coverageDiscount > b.validation.coverageDiscount
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
      const family = c.family.trim()
      const prevFam = seenFamily.get(family)
      if (prevFam && prevFam !== name) throw new Error(`跨切分泄漏：family "${family}" 同时出现在 ${prevFam} 与 ${name}`)
      seenFamily.set(family, name)
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
    lines.push(`  #${c.index} ${JSON.stringify(c.params)} -> val[catch=${v.catches}, fb=${v.falseBlocks}, miss=${v.misses}, unm=${v.unmeasuredCount}, cov=${v.coverageDiscount.toFixed(2)}, dTok=${String(v.marginalCost.deltaTokens)}, dMs=${String(v.marginalCost.deltaMs)}] ${c.guardrailPassed ? (c.paretoOptimal ? '[PARETO]' : '[PASS]') : `[REJECT: ${c.guardrailViolations.join('; ')}]`}`)
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

  const ceilings: number[] = []
  if (options.maxFalseBlocks !== undefined) ceilings.push(options.maxFalseBlocks)
  if (baseline) ceilings.push(baseline.validation.falseBlocks)
  if (options.maxFalseBlockRate !== undefined) ceilings.push(Math.floor(split.validation.length * options.maxFalseBlockRate))
  const maxFalseBlocksAllowed = ceilings.length > 0 ? Math.min(...ceilings) : 0
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

    const unmeasuredDefects = validation.cases.filter(c => c.expectedOutcome === 'defect' && c.verdict.kind === 'unmeasured').length
    const adjustedNet = validation.netBenefit - unmeasuredDefects
    const effectiveBenefit = adjustedNet > 0 ? adjustedNet * validation.coverageDiscount : adjustedNet
    rawEvaluated.push({ index, params, train, validation, effectiveBenefit, guardrailPassed: violations.length === 0, guardrailViolations: violations })
  }

  const passing = rawEvaluated.filter(c => c.guardrailPassed)
  const paretoIds = new Set<number>()
  for (const cand of passing) {
    const asEval = { ...cand, paretoOptimal: false }
    if (!passing.some(other => other.index !== cand.index && dominates({ ...other, paretoOptimal: false }, asEval))) paretoIds.add(cand.index)
  }

  const evaluated: ParamCandidateEvaluation<P>[] = rawEvaluated.map(c => ({ ...c, paretoOptimal: paretoIds.has(c.index) }))
  const paretoFrontier = evaluated.filter(c => c.paretoOptimal)
  const recommended = [...paretoFrontier].sort((a, b) =>
    (b.effectiveBenefit - a.effectiveBenefit)
    || (b.validation.coverageDiscount - a.validation.coverageDiscount)
    || (a.validation.falseBlocks - b.validation.falseBlocks)
    || cmpOptionalAsc(a.validation.marginalCost.deltaTokens, b.validation.marginalCost.deltaTokens)
    || cmpOptionalAsc(a.validation.marginalCost.deltaMs, b.validation.marginalCost.deltaMs)
    || (a.index - b.index),
  )[0]

  return {
    proposalOnly: true, applied: false, holdoutOpened: false, holdoutCaseCount: split.holdout.length,
    maxFalseBlocksAllowed, ...(baseline ? { baseline } : {}),
    candidates: evaluated, paretoFrontier, recommended,
    summary: formatSweepSummary(maxFalseBlocksAllowed, evaluated, paretoFrontier, recommended, split.holdout.length),
  }
}
