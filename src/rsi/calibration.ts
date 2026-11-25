/** 统计 RSI 校准底座：多种子 Bootstrap CI、Holdout 开封门、全注册表留一消融与温度/Platt 校准。 */
import type { Point, RunEntry, Verdict } from '../judgement/types.ts'
import type { ExtendedJudgementRegistry } from '../judgement/registry.ts'
import type { SpineDraft } from '../spine/types.ts'
import { compareWindows, confidenceOf, fnv1a32, pairedCaseDeltas, splitByFamily, toEvaluationReading } from './evaluator.ts'
import { runHistoricalReplay } from './replay.ts'
import { assertSplitIsolation, compareParamCandidates } from './sweep.ts'
import type {
  AblationCase, BootstrapCIResult, CalibratedDecision, CalibratedGateRecord, CalibrationBin,
  ExpectedCalibrationReport, FamilySplit, HoldoutEvaluationResult, LeaveOneOutGateImpact,
  LeaveOneOutResult, ParamSweepOptions, ReplayCase, ReplayGateFn, ReplayOptions,
  RuleConflictPair, SplitRatios, TemperatureScaler,
} from './types.ts'

function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6D2B79F5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** 多随机种子（>=3）Bootstrap 95% 置信区间；CI 跨 0 时诚实返回 unmeasured。 */
export function bootstrapDeltaCI(
  deltas: readonly number[],
  options: { readonly seeds?: readonly (number | string)[]; readonly iterationsPerSeed?: number; readonly confidenceLevel?: number } = {},
): BootstrapCIResult {
  const seeds = options.seeds ?? [101, 202, 303]
  const confidenceLevel = options.confidenceLevel ?? 0.95
  if (confidenceLevel <= 0 || confidenceLevel >= 1) throw new Error('confidenceLevel 须严格介于 (0, 1)')
  const distinctSeedCount = new Set(seeds.map(String)).size
  if (distinctSeedCount < 3) {
    return { verdict: 'unmeasured', mean: undefined, lower: undefined, upper: undefined, confidenceLevel, seeds, sampleSize: deltas.length, crossesZero: true, reason: `独立随机种子不足 3 个（去重后仅 ${distinctSeedCount} 个）` }
  }
  if (deltas.length < 2 || deltas.some(d => !Number.isFinite(d))) {
    return { verdict: 'unmeasured', mean: undefined, lower: undefined, upper: undefined, confidenceLevel, seeds, sampleSize: deltas.length, crossesZero: true, reason: '样本量 < 2 或含非有限差值' }
  }
  const iters = Math.max(50, options.iterationsPerSeed ?? 400), bootMeans: number[] = [], n = deltas.length
  for (const seed of seeds) {
    const rand = mulberry32(fnv1a32(String(seed)))
    for (let i = 0; i < iters; i++) {
      let sum = 0
      for (let j = 0; j < n; j++) sum += deltas[Math.floor(rand() * n)]!
      bootMeans.push(sum / n)
    }
  }
  bootMeans.sort((a, b) => a - b)
  const alpha = (1 - confidenceLevel) / 2
  const lower = bootMeans[Math.floor(alpha * (bootMeans.length - 1))]!
  const upper = bootMeans[Math.ceil((1 - alpha) * (bootMeans.length - 1))]!
  const mean = deltas.reduce((s, x) => s + x, 0) / n
  const crossesZero = lower <= 0 && upper >= 0
  const verdict = crossesZero ? 'unmeasured' : lower > 0 ? 'improved' : 'regressed'
  return {
    verdict, mean, lower, upper, confidenceLevel, seeds, sampleSize: n, crossesZero,
    reason: crossesZero ? `95% CI [${lower.toFixed(4)}, ${upper.toFixed(4)}] 跨越 0，无法区分随机波动` : `${verdict}: 95% CI [${lower.toFixed(4)}, ${upper.toFixed(4)}]`,
  }
}

export interface EvaluateSealedHoldoutOptions<I> {
  readonly baselineGate: ReplayGateFn<I>; readonly candidateGate: ReplayGateFn<I>
  readonly split: FamilySplit<I>; readonly candidateId: string; readonly actorId?: string
  readonly minGeneralizationRatio?: number; readonly replayOptions?: ReplayOptions
  readonly seeds?: readonly (number | string)[]; readonly now?: () => Date
}

/** 封存 Holdout 开封器：核验 holdoutDelta / trainDelta >= 0.5 并生成不可逆 holdout.opened 审计事件。 */
export async function evaluateSealedHoldout<I>(options: EvaluateSealedHoldoutOptions<I>): Promise<HoldoutEvaluationResult> {
  if (options.split.train.length === 0 || options.split.holdout.length === 0) throw new Error('evaluateSealedHoldout 需要非空 train 与 holdout 样本集')
  assertSplitIsolation(options.split)
  const replayOpts = options.replayOptions ?? {}, minRatio = options.minGeneralizationRatio ?? 0.5
  const [baseTrain, candTrain, baseHoldout, candHoldout] = await Promise.all([
    runHistoricalReplay(options.baselineGate, options.split.train, replayOpts),
    runHistoricalReplay(options.candidateGate, options.split.train, replayOpts),
    runHistoricalReplay(options.baselineGate, options.split.holdout, replayOpts),
    runHistoricalReplay(options.candidateGate, options.split.holdout, replayOpts),
  ])
  const trainDelta = candTrain.netBenefit / candTrain.totalCases - baseTrain.netBenefit / baseTrain.totalCases
  const holdoutDelta = candHoldout.netBenefit / candHoldout.totalCases - baseHoldout.netBenefit / baseHoldout.totalCases
  const generalizationRatio = trainDelta > 0 ? holdoutDelta / trainDelta : undefined
  const holdoutCI = bootstrapDeltaCI(pairedCaseDeltas(baseHoldout, candHoldout), { ...(options.seeds ? { seeds: options.seeds } : {}) })
  const windowComparison = compareWindows(
    { failures: baseHoldout.misses + baseHoldout.falseBlocks, opportunities: baseHoldout.totalCases },
    { failures: candHoldout.misses + candHoldout.falseBlocks, opportunities: candHoldout.totalCases },
  )
  const measurable = candHoldout.totalCases - candHoldout.unmeasuredCount
  const reading = toEvaluationReading(candHoldout.catches + candHoldout.trueAllows, measurable)
  const unmeasuredIncreased = candHoldout.unmeasuredCount > baseHoldout.unmeasuredCount
  const promoted = trainDelta > 0 && generalizationRatio !== undefined && generalizationRatio >= minRatio
    && candHoldout.falseBlocks <= baseHoldout.falseBlocks && !unmeasuredIncreased
    && measurable > 0 && holdoutCI.verdict === 'improved'
  const reason = trainDelta <= 0 ? '训练集无净收益提升 (trainDelta <= 0)'
    : measurable <= 0 ? 'Holdout 全部样本为 unmeasured，禁止晋升'
      : unmeasuredIncreased ? `Holdout 不可测样本增加 (${candHoldout.unmeasuredCount} > ${baseHoldout.unmeasuredCount})`
        : generalizationRatio === undefined || generalizationRatio < minRatio ? `泛化比不足 (${(generalizationRatio ?? 0).toFixed(3)} < ${minRatio})`
          : candHoldout.falseBlocks > baseHoldout.falseBlocks ? `Holdout 误拦回归 (${candHoldout.falseBlocks} > ${baseHoldout.falseBlocks})`
            : holdoutCI.verdict !== 'improved' ? `Holdout 多种子 CI 未显著改善 (${holdoutCI.reason})`
              : 'Holdout 开封验证通过'
  const openedAt = (options.now ?? (() => new Date()))().toISOString()
  const auditEvent: SpineDraft<Record<string, unknown>> = {
    id: `rsi:holdout.opened:${options.candidateId}:${openedAt}`, at: openedAt, stream: `rsi:${options.candidateId}`, type: 'holdout.opened',
    source: { kind: 'system', ref: options.actorId ?? 'rsi.holdout' }, evidence: [{ kind: 'event', ref: `holdout:${options.candidateId}` }], taint: 'trusted',
    payload: { candidateId: options.candidateId, holdoutCaseIds: candHoldout.caseIds, trainDelta, holdoutDelta, generalizationRatio, promoted, openedAt, reason },
  }
  return {
    promoted, verdict: reading.verdict, trainDelta, holdoutDelta, generalizationRatio,
    baselineTrain: baseTrain, candidateTrain: candTrain, baselineHoldout: baseHoldout, candidateHoldout: candHoldout,
    holdoutCI, windowComparison, reading, auditEvent, reason,
  }
}

/** 串联 splitByFamily + compareParamCandidates + 可选 Holdout 开封的完整参数寻优闭环。 */
export async function evaluateSweepAndHoldout<I, P>(
  buildGateWithParams: (params: P) => ReplayGateFn<I>,
  candidates: readonly P[],
  cases: readonly ReplayCase<I>[],
  options: ParamSweepOptions<P> & { readonly ratios?: SplitRatios; readonly seed?: string | number; readonly openHoldout?: boolean; readonly candidateId?: string } = {},
) {
  const split = splitByFamily(cases, options.ratios, options.seed)
  const sweep = await compareParamCandidates(buildGateWithParams, candidates, split, options)
  const holdout = options.openHoldout && sweep.recommended && options.baseline !== undefined
    ? await evaluateSealedHoldout({
        baselineGate: buildGateWithParams(options.baseline), candidateGate: buildGateWithParams(sweep.recommended.params),
        split, candidateId: options.candidateId ?? 'sweep-candidate',
      })
    : undefined
  return { split, sweep, holdout }
}

function reconstructWithoutGate(ran: readonly RunEntry[], observed: readonly RunEntry[], removeId: string): Verdict {
  const obsSet = new Set(observed.map(o => `${o.id}:${o.outcome}`)), remaining = ran.filter(r => r.id !== removeId)
  if (remaining.length === 0) return { kind: 'allow' }
  const blockers: string[] = []
  let unmeasured: string | undefined, activeEval = 0, enforcingCount = 0
  for (const r of remaining) {
    if (r.outcome === 'skipped') continue
    const isEnforcing = !obsSet.has(`${r.id}:${r.outcome}`)
    if (isEnforcing) enforcingCount += 1
    activeEval += 1
    if (r.outcome === 'deny' && isEnforcing) blockers.push(r.detail ?? r.id)
    else if (r.outcome === 'unmeasured' && isEnforcing && !unmeasured) unmeasured = r.detail ?? r.id
  }
  if (enforcingCount > 0 && activeEval === 0) return { kind: 'unmeasured', cause: 'all-skipped', detail: '其余判据全部跳过' }
  if (blockers.length > 0) return { kind: 'deny', blockers: blockers as [string, ...string[]] }
  if (unmeasured) return { kind: 'unmeasured', cause: 'no-evidence', detail: unmeasured }
  return { kind: 'allow' }
}

/** 全注册表留一消融：不破坏原注册表地逐个摘除判据重跑回放，识别冗余规则与规则打架。 */
export async function runLeaveOneOutAblation(
  registry: Pick<ExtendedJudgementRegistry, 'list' | 'evaluate'>,
  cases: readonly AblationCase[],
  options: { readonly defaultPoint?: Point; readonly perGateEvalTokens?: number; readonly perGateEvalMs?: number; readonly perGateTriggerTokens?: number } = {},
): Promise<LeaveOneOutResult> {
  const gates = registry.list().filter(e => e.kind === 'gate' && e.stage !== 'retired')
  const fallbackPoint = options.defaultPoint ?? gates[0]?.point
  const evalCache = new Map<string, { verdict: Verdict; ran: readonly RunEntry[]; observed: readonly RunEntry[] }>()
  for (const c of cases) {
    const pt = c.point ?? (typeof (c.input as { point?: unknown })?.point === 'string' ? (c.input as { point: Point }).point : fallbackPoint)
    if (!pt) { evalCache.set(c.id, { verdict: { kind: 'unmeasured', cause: 'missing-input', detail: '缺少挂载点 point' }, ran: [], observed: [] }); continue }
    const ctx = (c.input && typeof c.input === 'object' && 'ctx' in (c.input as Record<string, unknown>)) ? (c.input as { ctx: unknown }).ctx : c.input
    const ev = await registry.evaluate(pt, ctx as never)
    evalCache.set(c.id, { verdict: ev.verdict, ran: ev.ran, observed: ev.observed })
  }
  const replayCases: ReplayCase<AblationCase>[] = cases.map(c => ({ id: c.id, family: c.family, input: c, expectedOutcome: c.expectedOutcome }))
  const baseline = await runHistoricalReplay(c => evalCache.get(c.id)!.verdict, replayCases)
  const evalTok = options.perGateEvalTokens ?? 10, evalMs = options.perGateEvalMs ?? 1, trigTok = options.perGateTriggerTokens ?? 20
  const impacts: LeaveOneOutGateImpact[] = []
  for (const g of gates) {
    const ablated = await runHistoricalReplay(c => {
      const cached = evalCache.get(c.id)!
      return g.stage === 'enforce' ? reconstructWithoutGate(cached.ran, cached.observed, g.id) : cached.verdict
    }, replayCases)
    let evaluations = 0, triggers = 0
    for (const c of cases) {
      const hit = [...evalCache.get(c.id)!.ran, ...evalCache.get(c.id)!.observed].find(r => r.id === g.id)
      if (hit && hit.outcome !== 'skipped') { evaluations += 1; if (hit.outcome === 'deny') triggers += 1 }
    }
    const uniqueCatches = Math.max(0, baseline.catches - ablated.catches)
    const redundant = g.stage === 'enforce' && evaluations > 0 && ablated.netBenefit >= baseline.netBenefit && ablated.falseBlocks <= baseline.falseBlocks && uniqueCatches === 0
    impacts.push({
      gateId: g.id, stage: g.stage, evaluations, uniqueCatches, ablatedReport: ablated,
      deltaBenefit: ablated.netBenefit - baseline.netBenefit, deltaFalseBlocks: ablated.falseBlocks - baseline.falseBlocks,
      savedTokens: evaluations * evalTok + triggers * trigTok, savedMs: evaluations * evalMs,
      redundant, harmful: ablated.netBenefit > baseline.netBenefit,
    })
  }
  const pairMap = new Map<string, { gateA: string; gateB: string; caseIds: string[]; type: RuleConflictPair['conflictType'] }>()
  for (const c of cases) {
    const ran = evalCache.get(c.id)!.ran, allows = ran.filter(r => r.outcome === 'allow').map(r => r.id), denies = ran.filter(r => r.outcome === 'deny').map(r => r.id)
    for (const d of denies) for (const a of allows) {
      const pairKey = `${a}<->${d}`
      const cur = pairMap.get(pairKey) ?? { gateA: a, gateB: d, caseIds: [], type: c.expectedOutcome === 'clean' ? 'false-block-override' : 'allow-vs-deny' }
      if (c.expectedOutcome === 'clean') cur.type = 'false-block-override'
      cur.caseIds.push(c.id); pairMap.set(pairKey, cur)
    }
  }
  const conflicts: RuleConflictPair[] = [...pairMap.values()].map(p => ({
    gateA: p.gateA, gateB: p.gateB, caseIds: p.caseIds, conflictType: p.type,
    detail: `${p.gateA} 放行与 ${p.gateB} 拦截在 ${p.caseIds.length} 条样本存在分歧`,
  }))
  return { baseline, impacts, redundantGateIds: impacts.filter(i => i.redundant).map(i => i.gateId), harmfulGateIds: impacts.filter(i => i.harmful).map(i => i.gateId), conflicts }
}

const sigmoid = (x: number): number => x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x))
const toLogit = (score: number, space: 'probability' | 'logit'): number => space === 'logit' ? score : Math.log(Math.min(1 - 1e-6, Math.max(1e-6, score)) / (1 - Math.min(1 - 1e-6, Math.max(1e-6, score))))
const nllLoss = (pairs: readonly { z: number; y: number }[], a: number, b: number): number =>
  pairs.reduce((s, { z, y }) => { const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(a * z + b))); return s - (y * Math.log(p) + (1 - y) * Math.log(1 - p)) }, 0) / pairs.length

/** 拟合温度/Platt 缩放参数，降低预筛模型概率的 ECE 与对数损失。 */
export function fitTemperatureScaler(
  samples: readonly ({ rawScore: number; groundTruthBackfill?: 'clean' | 'defect'; label?: 'clean' | 'defect' | 0 | 1 })[],
  options: { readonly inputSpace?: 'probability' | 'logit'; readonly regularization?: number } = {},
): TemperatureScaler {
  const space = options.inputSpace ?? 'probability', reg = options.regularization ?? 1e-4, pairs: { z: number; y: number }[] = []
  for (const s of samples) {
    if (!Number.isFinite(s.rawScore)) continue
    const rawY = s.groundTruthBackfill ?? s.label
    if (rawY === 'clean' || rawY === 'defect' || rawY === 0 || rawY === 1) pairs.push({ z: toLogit(s.rawScore, space), y: rawY === 'defect' || rawY === 1 ? 1 : 0 })
  }
  const positives = pairs.filter(p => p.y === 1).length
  if (pairs.length < 2 || positives === 0 || positives === pairs.length) {
    const loss = pairs.length > 0 ? nllLoss(pairs, 1, 0) : 0
    return { temperature: 1, bias: 0, inputSpace: space, fitted: false, sampleCount: pairs.length, lossBefore: loss, lossAfter: loss }
  }
  const lossBefore = nllLoss(pairs, 1, 0)
  let a = 1, b = 0
  for (let step = 0; step < 25; step++) {
    let ga = reg * (a - 1), gb = reg * b, haa = reg, hab = 0, hbb = reg
    for (const { z, y } of pairs) { const p = sigmoid(a * z + b), w = p * (1 - p); ga += (p - y) * z; gb += (p - y); haa += w * z * z; hab += w * z; hbb += w }
    const det = haa * hbb - hab * hab
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det
    a = Math.max(0.05, Math.min(20, a - da)); b = Math.max(-10, Math.min(10, b - db))
    if (Math.abs(da) < 1e-7 && Math.abs(db) < 1e-7) break
  }
  return { temperature: 1 / a, bias: b, inputSpace: space, fitted: true, sampleCount: pairs.length, lossBefore, lossAfter: nllLoss(pairs, a, b) }
}

/** 使用拟合得到的温度缩放器将 rawScore 映射为校准后缺陷概率 [0, 1]。 */
export function calibrateProbability(rawScore: number, scaler: TemperatureScaler): number {
  if (!Number.isFinite(rawScore)) return 0.5
  return Math.min(1 - 1e-6, Math.max(1e-6, sigmoid(toLogit(rawScore, scaler.inputSpace) / scaler.temperature + scaler.bias)))
}

/** 三段决策带分类器：< low 静默放行，[low, high] 走确定性闸/待裁，> high 高置信拦截。 */
export function classifyThresholdBand(calibratedProb: number, thresholdBand: readonly [number, number] = [0.2, 0.8]): Exclude<CalibratedDecision, 'ask'> {
  const [low, high] = thresholdBand
  if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || low > high || high > 1) throw new Error(`非法阈值带 [${low}, ${high}]`)
  if (!Number.isFinite(calibratedProb)) return 'deterministic_gate'
  return calibratedProb < low ? 'allow' : calibratedProb > high ? 'block' : 'deterministic_gate'
}

/** 构造校准后预筛记录，同时计算后验信心供审查。 */
export function buildCalibratedGateRecord(
  input: { readonly gateId: string; readonly callId: string; readonly ticketId: string; readonly rawScore: number; readonly groundTruthBackfill?: 'clean' | 'defect' },
  scaler?: TemperatureScaler, thresholdBand: readonly [number, number] = [0.2, 0.8],
): CalibratedGateRecord & { readonly confidenceAnchor?: number } {
  const calibratedProb = scaler ? calibrateProbability(input.rawScore, scaler) : input.rawScore
  const anchor = scaler ? confidenceOf(Math.round(calibratedProb * scaler.sampleCount), scaler.sampleCount) : undefined
  return {
    gateId: input.gateId, callId: input.callId, ticketId: input.ticketId, rawScore: input.rawScore,
    calibratedProb, thresholdBand, decision: classifyThresholdBand(calibratedProb, thresholdBand),
    ...(input.groundTruthBackfill ? { groundTruthBackfill: input.groundTruthBackfill } : {}), ...(anchor !== undefined ? { confidenceAnchor: anchor } : {}),
  }
}

/** ECE 分桶期望校准误差计算器；无有效真值标签时诚实返回 unmeasured。 */
export function computeExpectedCalibrationError(records: readonly CalibratedGateRecord[], numBins = 10): ExpectedCalibrationReport {
  if (!Number.isInteger(numBins) || numBins <= 0) throw new Error(`numBins 必须为正整数（收到 ${numBins}）`)
  const labeled = records.filter(r => (r.groundTruthBackfill === 'clean' || r.groundTruthBackfill === 'defect') && Number.isFinite(r.calibratedProb) && r.calibratedProb >= 0 && r.calibratedProb <= 1)
  if (labeled.length === 0) return { state: 'unmeasured', ece: undefined, totalLabeled: 0, numBins, bins: [], reason: '缺少已回填真值标签 (groundTruthBackfill)' }
  const bucket = Array.from({ length: numBins }, (_, binIndex) => ({ binIndex, lower: binIndex / numBins, upper: (binIndex + 1) / numBins, sumP: 0, sumY: 0, count: 0 }))
  let rawValid = 0
  for (const r of labeled) {
    const b = bucket[Math.min(numBins - 1, Math.floor(r.calibratedProb * numBins))]!
    b.count += 1; b.sumP += r.calibratedProb; b.sumY += r.groundTruthBackfill === 'defect' ? 1 : 0
    if (Number.isFinite(r.rawScore) && r.rawScore >= 0 && r.rawScore <= 1) rawValid += 1
  }
  const bins: CalibrationBin[] = []
  let ece = 0
  for (const b of bucket) {
    if (b.count === 0) continue
    const avgConfidence = b.sumP / b.count, empiricalRate = b.sumY / b.count
    ece += (b.count / labeled.length) * Math.abs(empiricalRate - avgConfidence)
    bins.push({ binIndex: b.binIndex, lower: b.lower, upper: b.upper, count: b.count, avgConfidence, empiricalRate })
  }
  let rawEce: number | undefined
  if (rawValid === labeled.length) {
    const rb = Array.from({ length: numBins }, () => ({ sumR: 0, sumY: 0, count: 0 }))
    for (const r of labeled) { const b = rb[Math.min(numBins - 1, Math.floor(r.rawScore * numBins))]!; b.count += 1; b.sumR += r.rawScore; b.sumY += r.groundTruthBackfill === 'defect' ? 1 : 0 }
    rawEce = rb.reduce((s, b) => b.count === 0 ? s : s + (b.count / labeled.length) * Math.abs(b.sumY / b.count - b.sumR / b.count), 0)
  }
  return { state: 'measured', ece, ...(rawEce !== undefined ? { rawEce } : {}), totalLabeled: labeled.length, numBins, bins }
}
