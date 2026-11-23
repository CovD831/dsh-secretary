/** 作者面 S3 离线回放执行器：在冻结样本集上运行判据并产出双轨报告卡。 */
import type { Verdict } from '../judgement/types.ts'
import type {
  ReplayCase,
  ReplayCaseClassification,
  ReplayCaseTrace,
  ReplayGateFn,
  ReplayGateOutcome,
  ReplayOptions,
  ReplayReportCard,
} from './types.ts'

function normalizeVerdict(raw: unknown): Verdict {
  if (!raw || typeof raw !== 'object') return { kind: 'unmeasured', cause: 'parse-failed', detail: '判据返回非对象裁决' }
  const v = raw as Record<string, unknown>
  if (v['kind'] === 'allow') return raw as Verdict
  if (v['kind'] === 'deny' && Array.isArray(v['blockers']) && v['blockers'].length > 0) return raw as Verdict
  if (v['kind'] === 'unmeasured' && typeof v['cause'] === 'string' && typeof v['detail'] === 'string') return raw as Verdict
  return { kind: 'unmeasured', cause: 'parse-failed', detail: `判据返回非法裁决形态: ${String(v['kind'])}` }
}

function normalizeGateOutcome(raw: ReplayGateOutcome): { verdict: Verdict; deltaTokens?: number; deltaMs?: number } {
  if (raw && typeof raw === 'object' && 'verdict' in raw) {
    return { verdict: normalizeVerdict(raw.verdict), deltaTokens: raw.deltaTokens, deltaMs: raw.deltaMs }
  }
  return { verdict: normalizeVerdict(raw) }
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
  if (perEval !== undefined && Number.isFinite(perEval)) { sum += perEval; measured = true }
  if (perTrigger !== undefined && Number.isFinite(perTrigger)) { if (isDeny) sum += perTrigger; measured = true }
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
  let triggeredCount = 0, catches = 0, falseBlocks = 0, misses = 0, trueAllows = 0, unknownLabelCount = 0, unmeasuredCount = 0
  let sumTokens = 0, sumMs = 0, measuredTokens = 0, measuredMs = 0, unmeasuredTokens = 0, unmeasuredMs = 0
  const cm = options.costModel
  const fbMult = cm?.falseBlockMultiplier ?? 1

  for (const item of cases) {
    if (seenIds.has(item.id)) throw new Error(`回放作废：存在重复样本 id "${item.id}"`)
    seenIds.add(item.id)
    caseIds.push(item.id)
    let outcome: { verdict: Verdict; deltaTokens?: number; deltaMs?: number }
    try { outcome = normalizeGateOutcome(await gateFn(item.input, item)) }
    catch (err) { outcome = { verdict: { kind: 'unmeasured', cause: 'threw', detail: err instanceof Error ? err.message : String(err) } } }

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
      caseId: item.id, family: item.family, expectedOutcome: item.expectedOutcome, verdict: outcome.verdict, classification: cls,
      ...(dTokens !== undefined ? { deltaTokens: dTokens } : {}), ...(dMs !== undefined ? { deltaMs: dMs } : {}),
    })
  }

  const totalCases = cases.length
  const coverageDiscount = totalCases === 0 ? 0 : (totalCases - unmeasuredCount) / totalCases
  const costState = totalCases === 0 || (measuredTokens === 0 && measuredMs === 0)
    ? 'unmeasured' : unmeasuredTokens > 0 || unmeasuredMs > 0 ? 'partial' : 'measured'

  return {
    caseIds, totalCases, triggeredCount, catches, falseBlocks, misses, trueAllows, unknownLabelCount, unmeasuredCount,
    coverageDiscount, netBenefit: catches - falseBlocks - misses,
    marginalCost: { deltaTokens: measuredTokens === 0 ? undefined : sumTokens, deltaMs: measuredMs === 0 ? undefined : sumMs, state: costState },
    cases: traces,
  }
}
