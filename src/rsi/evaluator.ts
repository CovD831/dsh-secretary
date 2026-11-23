/** 零耦合评估器核：Beta 后验置信度、前后窗口对比、行为指标、按族切分与样本集一致性守卫。 */
import type { EvaluationReading } from '../judgement/types.ts'
import type {
  BehavioralMetricsReading,
  FamilySplit,
  GenericMetricReading,
  ReplayCase,
  SplitBucket,
  SplitRatios,
  TaskBehaviorRecord,
  WindowCompareOptions,
  WindowComparison,
  WindowSample,
} from './types.ts'

/** Beta 后验均值 (Add-k 平滑)；total === 0 或非法计数返回 undefined，严禁返回 0.5。 */
export function confidenceOf(successes: number, total: number, k = 2): number | undefined {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || !Number.isFinite(k) || k <= 0) return undefined
  if (total <= 0 || successes < 0 || successes > total) return undefined
  return (successes + k / 2) / (total + k)
}

/** 将成功/总次数转换为三态 EvaluationReading；不可判时落 unmeasured 且不带 probability。 */
export function toEvaluationReading(
  successes: number,
  total: number,
  options: { readonly minEffectiveRate?: number; readonly reasons?: readonly string[]; readonly k?: number } = {},
): EvaluationReading {
  const probability = confidenceOf(successes, total, options.k ?? 2)
  const baseReasons = options.reasons ? [...options.reasons] : []
  if (probability === undefined) {
    return {
      verdict: 'unmeasured',
      reasons: baseReasons.length > 0 ? baseReasons : [`unmeasured: invalid or zero total (${successes}/${total})`],
    }
  }
  const threshold = options.minEffectiveRate ?? 0.5
  const verdict = probability >= threshold ? 'effective' : 'ineffective'
  return {
    verdict,
    probability,
    reasons: baseReasons.length > 0 ? baseReasons : [`${verdict}: ${successes}/${total} -> p=${probability.toFixed(4)}`],
  }
}

/** 前后窗口结构对比：无基线（before.opportunities === 0）或观察不足必返 unmeasured。 */
export function compareWindows(
  before: WindowSample,
  after: WindowSample,
  options: WindowCompareOptions = {},
): WindowComparison {
  const valid = (w: WindowSample) =>
    Number.isFinite(w.failures) && Number.isFinite(w.opportunities)
    && w.failures >= 0 && w.opportunities >= 0 && w.failures <= w.opportunities
  if (!valid(before) || !valid(after)) {
    return { verdict: 'unmeasured', beforeRate: undefined, afterRate: undefined, deltaRate: undefined, deltaFailures: undefined, reasons: ['invalid-window: negative or inconsistent counts'] }
  }
  if (before.opportunities === 0) {
    return { verdict: 'unmeasured', beforeRate: undefined, afterRate: undefined, deltaRate: undefined, deltaFailures: undefined, reasons: ['no-baseline: before.opportunities === 0'] }
  }
  const beforeRate = before.failures / before.opportunities
  if (after.opportunities === 0) {
    return { verdict: 'unmeasured', beforeRate, afterRate: undefined, deltaRate: undefined, deltaFailures: undefined, reasons: ['no-after-opportunities: after.opportunities === 0'] }
  }
  if (options.minObservationMs !== undefined) {
    if (!Number.isFinite(options.minObservationMs) || options.minObservationMs < 0
      || after.durationMs === undefined || !Number.isFinite(after.durationMs) || after.durationMs < options.minObservationMs) {
      return { verdict: 'unmeasured', beforeRate, afterRate: undefined, deltaRate: undefined, deltaFailures: undefined, reasons: [`observation-window-too-short: ${String(after.durationMs)} < ${options.minObservationMs}ms`] }
    }
  }
  const afterRate = after.failures / after.opportunities
  const deltaRate = beforeRate - afterRate
  const deltaFailures = before.failures - after.failures
  const verdict = afterRate < beforeRate ? 'improved' : afterRate === beforeRate ? 'unchanged' : 'regressed'
  return {
    verdict,
    beforeRate,
    afterRate,
    deltaRate,
    deltaFailures,
    reasons: [`structural: ${(beforeRate * 100).toFixed(2)}% -> ${(afterRate * 100).toFixed(2)}% (${verdict})`],
  }
}

function measuredReading(value: number, sample: number, why: string): GenericMetricReading {
  return { state: 'measurable', value, sample, why }
}

function unmeasuredReading(why: string): GenericMetricReading {
  return { state: 'unmeasured', why }
}

/** 通用行为指标：仅统计真实任务尝试与带分母上报密度，绝不读取判据 allow 计数。 */
export function computeBehavioralMetrics(records: readonly TaskBehaviorRecord[]): BehavioralMetricsReading {
  const executed = records.filter(r => r.attempts.length > 0)
  if (executed.length === 0) {
    return {
      firstTryPassRate: unmeasuredReading('无已执行任务记录（attempts 全空）'),
      reworkRate: unmeasuredReading('无已执行任务记录（attempts 全空）'),
      escalationDensity: unmeasuredReading('无已执行任务记录，上报密度缺分母'),
      executedTasks: 0,
    }
  }
  let firstTryPassed = 0
  let reworked = 0
  for (const task of executed) {
    const allDated = task.attempts.every(a => typeof a.at === 'number' && Number.isFinite(a.at))
    const ordered = allDated
      ? task.attempts.map((a, idx) => ({ a, idx })).sort((x, y) => x.a.at! - y.a.at! || x.idx - y.idx)
      : task.attempts.map((a, idx) => ({ a, idx }))
    if (ordered[0]!.a.outcome === 'completed') firstTryPassed += 1
    if (ordered.length > 1) reworked += 1
  }
  const withEsc = executed.filter(t => typeof t.escalations === 'number' && Number.isFinite(t.escalations) && t.escalations >= 0)
  const escalationSum = withEsc.reduce((acc, t) => acc + t.escalations!, 0)
  return {
    firstTryPassRate: measuredReading(firstTryPassed / executed.length, executed.length, `${firstTryPassed}/${executed.length} 个任务首次终态即 completed`),
    reworkRate: measuredReading(reworked / executed.length, executed.length, `${reworked}/${executed.length} 个任务发生返工（尝试 >1 次）`),
    escalationDensity: withEsc.length === 0
      ? unmeasuredReading('缺少上报次数记录（不可补 0 冒充零上报）')
      : measuredReading(escalationSum / withEsc.length, withEsc.length, `${escalationSum} 次上报 / ${withEsc.length} 个任务`),
    executedTasks: executed.length,
  }
}

function fnv1a32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 按失效族 family 严格不相交划分 train / validation / holdout，禁止同一 family 跨集泄漏。 */
export function splitByFamily<I>(
  cases: readonly ReplayCase<I>[],
  ratios: SplitRatios = { train: 0.6, validation: 0.2, holdout: 0.2 },
  seed: string | number = 0,
): FamilySplit<I> {
  const bucketDefs: readonly SplitBucket[] = ['train', 'validation', 'holdout']
  for (const b of bucketDefs) {
    if (!Number.isFinite(ratios[b]) || ratios[b] < 0) throw new Error(`切分比例 ${b} 非法：${String(ratios[b])}`)
  }
  const ratioSum = ratios.train + ratios.validation + ratios.holdout
  if (ratioSum <= 0) throw new Error('切分比例之和必须大于 0')

  const seenIds = new Set<string>()
  const groups = new Map<string, ReplayCase<I>[]>()
  for (const item of cases) {
    if (seenIds.has(item.id)) throw new Error(`样本 id "${item.id}" 重复，禁止切分`)
    seenIds.add(item.id)
    const family = typeof item.family === 'string' ? item.family.trim() : ''
    if (family === '') {
      throw new Error(`样本 "${item.id}" 缺少有效 family 失效族键`)
    }
    const list = groups.get(family) ?? []
    list.push(item)
    groups.set(family, list)
  }

  const active = bucketDefs.filter(b => ratios[b] > 0)
  const targets: Record<SplitBucket, number> = {
    train: (cases.length * ratios.train) / ratioSum,
    validation: (cases.length * ratios.validation) / ratioSum,
    holdout: (cases.length * ratios.holdout) / ratioSum,
  }
  const counts: Record<SplitBucket, number> = { train: 0, validation: 0, holdout: 0 }
  const buckets: Record<SplitBucket, ReplayCase<I>[]> = { train: [], validation: [], holdout: [] }
  const familyAssignments: Record<string, SplitBucket> = {}

  const orderedFamilies = [...groups.entries()]
    .map(([family, items]) => ({ family, items, hash: fnv1a32(`${String(seed)}:${family}`) }))
    .sort((a, b) => b.items.length - a.items.length || a.hash - b.hash || a.family.localeCompare(b.family))

  for (let i = 0; i < orderedFamilies.length; i++) {
    const { family, items } = orderedFamilies[i]!
    const remaining = orderedFamilies.length - i
    const emptyActive = active.filter(b => counts[b] === 0)
    const candidates = remaining <= emptyActive.length ? emptyActive : active
    let best = candidates[0]!
    let bestDelta = Number.POSITIVE_INFINITY
    let bestNormDeficit = Number.NEGATIVE_INFINITY
    for (const b of candidates) {
      const l1Delta = Math.abs(counts[b] + items.length - targets[b]) - Math.abs(counts[b] - targets[b])
      const normDeficit = (targets[b] - counts[b]) / Math.max(targets[b], 1)
      if (l1Delta < bestDelta - 1e-9 || (Math.abs(l1Delta - bestDelta) <= 1e-9 && normDeficit > bestNormDeficit + 1e-9)) {
        best = b
        bestDelta = l1Delta
        bestNormDeficit = normDeficit
      }
    }
    familyAssignments[family] = best
    counts[best] += items.length
    buckets[best].push(...items)
  }
  return { train: buckets.train, validation: buckets.validation, holdout: buckets.holdout, familyAssignments }
}

/** 强制校对基线与候选的样本 ID 集合完全一致，防挑软柿子作弊。 */
export function assertCaseSetEquality(
  baselineIds: readonly string[],
  candidateIds: readonly string[],
  label = 'case-set',
): void {
  const toUniqueSet = (ids: readonly string[], role: string) => {
    const set = new Set<string>()
    for (const id of ids) {
      if (set.has(id)) throw new Error(`${label} 作废：${role} 包含重复样本 id "${id}"`)
      set.add(id)
    }
    return set
  }
  const base = toUniqueSet(baselineIds, 'baseline')
  const cand = toUniqueSet(candidateIds, 'candidate')
  const missing = [...base].filter(id => !cand.has(id))
  const extra = [...cand].filter(id => !base.has(id))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${label} 作废：样本集不一致（缺失 [${missing.join(', ')}]，多出 [${extra.join(', ')}]）`)
  }
}
