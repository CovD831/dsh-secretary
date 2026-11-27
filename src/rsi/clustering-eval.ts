/** 聚类辅助器：1-Hop 相对导入图构建、Rung 1 草案生成与 Purity / Inverse Purity / BCubed F1 评估。 */
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { DepositDraft } from '../authoring/types.ts'
import { parseRelativeImports, resolveLocalImport, walkWorkspaceFiles } from '../context/slicer.ts'
import { isValidScopeStage } from '../judgement/registry.ts'
import { BASE_SCOPES } from '../judgement/types.ts'
import type { SourceRef } from '../spine/types.ts'
import type { FourWayAttribution } from './types.ts'

export interface ClusterQualityReport {
  readonly evaluatedEvents: number
  readonly clusterCount: number
  readonly suppressedNoiseCount: number
  readonly purity: number
  readonly inversePurity: number
  readonly bcubedF1: number
}

const KNOWN_SCOPES = new Set<string>(BASE_SCOPES)
const CODE_EXT_RE = /\.(?:ts|tsx|mts|cts|js|mjs|py|go|rs)$/
const TEST_PATH_RE = /(?:^|\/)tests?\/|\.(?:spec|test)\.[^/]+$/i

/** 生成 Rung 1 影子规则草案，供生产周期阈值或 E2E 模式候选提取复用。 */
export function toClusterDraft(
  key: string, category: string, point: string | undefined, toolName: string | undefined,
  attribution: FourWayAttribution | undefined, refs: readonly SourceRef[], distinctDays: readonly string[], seenCount: number,
): DepositDraft {
  const safeSlug = key.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'cluster'
  const validPoint = point && isValidScopeStage(point, KNOWN_SCOPES) ? point : 'verify.preflight'
  return {
    id: `friction.${safeSlug}`, name: `在线摩擦候选 (${category})`, version: 1, author: 'rsi-online-collector',
    scope: 'private', kind: 'counter-rule', level: 'object', point: validPoint,
    trigger: { on: category, mode: 'on-event' }, requires: ['ticket.id'],
    params: { min_seen: { type: 'number', default: 3, min: 1 }, min_distinct_days: { type: 'number', default: 3, min: 1 } },
    exceptions: ['仅作为 Rung 1 候选提议呈现，须补齐正反例并经离线回放后方可晋升'],
    repairHint: `同类摩擦 (${key}) 已跨越 ${distinctDays.length} 个自然日累计 ${seenCount} 次，请补充判据并核验。`,
    intent: `针对高频根因摩擦 ${key}（归因: ${attribution ?? 'missing_rule'}）生成 Rung 1 规则草案。`,
    rubricBody: `在 ${distinctDays.join(', ') || 'e2e'} 观测到 ${seenCount} 次 ${category}${toolName ? ` (${toolName})` : ''}，建为影子提案。`,
    enforce: false, stage: 'shadow', actionClass: 'observe', action: { name: 'proposal.create' },
    origin: { kind: 'friction-mined', refs: refs.map(r => `m0:${r.seq}#${r.id}`) }, cases: [],
  }
}

/** 扫描各工作区源码的 1-Hop 相对导入图，复用 slicer 导入解析逻辑，零 LLM 成本。 */
export async function buildWorkspaceOneHopGraph(
  workspaceDirs: Readonly<Record<string, string>>,
): Promise<Record<string, readonly string[]>> {
  const graph: Record<string, string[]> = {}
  for (const [ws, dir] of Object.entries(workspaceDirs)) {
    let rootReal: string
    try { rootReal = await realpath(resolve(dir)) } catch { continue }
    const files = (await walkWorkspaceFiles(rootReal)).filter(f => CODE_EXT_RE.test(f) && !TEST_PATH_RE.test(f))
    for (const rel of files) {
      let text: string
      try { text = await readFile(join(rootReal, rel), 'utf8') } catch { continue }
      const deps: string[] = []
      for (const spec of parseRelativeImports(text)) {
        const resolved = await resolveLocalImport(rel, spec, rootReal)
        if (resolved && !TEST_PATH_RE.test(resolved)) deps.push(`${ws}:${resolved}`)
      }
      if (deps.length > 0) graph[`${ws}:${rel}`] = [...new Set(deps)].sort()
    }
  }
  return graph
}

/** 计算 Purity、Inverse Purity 与 BCubed F1（未入簇非噪声事件按独立遗漏点计罚，严禁丢样本刷高纯度）。 */
export function evaluateClusterQuality(
  clusters: readonly { readonly refs: readonly SourceRef[]; readonly explainedSymptoms?: readonly SourceRef[] }[],
  allEvaluatedSeqs: readonly number[],
  groundTruthBySeq: Readonly<Record<number, string>>,
): ClusterQualityReport {
  const signalSeqs = allEvaluatedSeqs.filter(s => groundTruthBySeq[s] && groundTruthBySeq[s] !== 'noise')
  const seqToCluster = new Map<number, string>()
  clusters.forEach((c, idx) => {
    const cid = `c-${idx}`
    for (const r of c.refs) seqToCluster.set(r.seq, cid)
    for (const r of c.explainedSymptoms ?? []) seqToCluster.set(r.seq, cid)
  })
  const suppressedNoiseCount = allEvaluatedSeqs.filter(s => groundTruthBySeq[s] === 'noise' && !seqToCluster.has(s)).length
  if (signalSeqs.length === 0) return { evaluatedEvents: 0, clusterCount: clusters.length, suppressedNoiseCount, purity: 1, inversePurity: 1, bcubedF1: 1 }

  const predBuckets = new Map<string, number[]>()
  const goldBuckets = new Map<string, number[]>()
  const predOf: Record<number, string> = {}
  for (const seq of signalSeqs) {
    const pid = seqToCluster.get(seq) ?? `singleton:${seq}`
    const gid = groundTruthBySeq[seq]!
    predOf[seq] = pid
    predBuckets.set(pid, [...(predBuckets.get(pid) ?? []), seq])
    goldBuckets.set(gid, [...(goldBuckets.get(gid) ?? []), seq])
  }
  const majorityHit = (bMap: Map<string, number[]>, targetMap: Readonly<Record<number, string>>) => {
    let hits = 0
    for (const items of bMap.values()) {
      const cnt = new Map<string, number>()
      for (const s of items) { const k = targetMap[s]!; cnt.set(k, (cnt.get(k) ?? 0) + 1) }
      hits += Math.max(...cnt.values())
    }
    return hits / signalSeqs.length
  }
  let sumP = 0, sumR = 0
  for (const s of signalSeqs) {
    const pItems = predBuckets.get(predOf[s]!)!
    const gItems = goldBuckets.get(groundTruthBySeq[s]!)!
    const sameBoth = pItems.filter(x => groundTruthBySeq[x] === groundTruthBySeq[s]).length
    sumP += sameBoth / pItems.length
    sumR += sameBoth / gItems.length
  }
  const bp = sumP / signalSeqs.length, br = sumR / signalSeqs.length
  return {
    evaluatedEvents: signalSeqs.length, clusterCount: clusters.length, suppressedNoiseCount,
    purity: majorityHit(predBuckets, groundTruthBySeq), inversePurity: majorityHit(goldBuckets, predOf),
    bcubedF1: bp + br > 0 ? (2 * bp * br) / (bp + br) : 0,
  }
}
