/** 因果链回溯 + 1-Hop 代码焦点交集根因聚类与分档特征向量提取。 */
import type { DepositDraft } from '../authoring/types.ts'
import type { SourceRef, SpineEnvelope } from '../spine/types.ts'
import { buildWorkspaceOneHopGraph, evaluateClusterQuality, toClusterDraft, type ClusterQualityReport } from './clustering-eval.ts'
import type { FourWayAttribution } from './types.ts'

export { buildWorkspaceOneHopGraph, evaluateClusterQuality, toClusterDraft, type ClusterQualityReport }
export type SafetyDirection = 'fail-closed' | 'neutral' | 'fail-open'
export type ProblemRootKind = 'contract-anomaly' | 'code-locus' | 'policy-probe' | 'gate-contract' | 'authoring-gate' | 'memory-conflict' | 'spec-ruling' | 'explicit'

export interface ProblemClusterFeatures {
  readonly entryPointCount: number; readonly oneHopFileCount: number; readonly sharedLocusCount: number
  readonly deterministicOracle: boolean; readonly safetyDirection: SafetyDirection
  readonly distinctWorkspaces: number; readonly distinctTickets: number; readonly distinctDays: number
  readonly maxRetryCount: number; readonly explainedSymptomCount: number
}

export interface ProblemCluster {
  readonly key: string; readonly rootKind: ProblemRootKind; readonly category: string
  readonly point?: string; readonly toolName?: string; readonly attribution?: FourWayAttribution
  readonly loci: readonly string[]; readonly sharedLoci: readonly string[]
  readonly workspaces: readonly string[]; readonly ticketIds: readonly string[]; readonly distinctDays: readonly string[]
  readonly refs: readonly SourceRef[]; readonly explainedSymptoms: readonly SourceRef[]
  readonly features: ProblemClusterFeatures; readonly qualifiesForRung1: boolean; readonly draft?: DepositDraft
}

export interface ClusterProblemOptions {
  readonly mode?: 'production' | 'e2e'; readonly minSeen?: number; readonly minDistinctDays?: number
  readonly oneHopGraph?: Readonly<Record<string, readonly string[]>>
}

interface RawSignal {
  key: string; rootKind: ProblemRootKind; category: string; point?: string; toolName?: string; attribution?: FourWayAttribution
  workspace?: string; ticketId?: string; day?: string; ref: SourceRef; loci: Set<string>; entryPoint: string
  artifacts: Set<string>; callIds: Set<string>; lastGateSeq?: number; explainedSymptoms: SourceRef[]
  deterministicOracle: boolean; safetyDirection: SafetyDirection; explicit?: boolean
}

const NEGATIVE_OPT_RE = /^(?:reject|deny|block|veto|refuse|opt-deny|opt-reject)/i
const TEST_PATH_RE = /(?:^|\/)tests?\/|\.(?:spec|test)\.[^/]+$/i
const PATH_TOKEN_RE = /(?:src|tests?)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+|\.env(?:\.[A-Za-z0-9_.-]+)?/g
const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const ticketIdOf = (ev: SpineEnvelope): string | undefined =>
  isRec(ev.payload) && typeof ev.payload['ticketId'] === 'string' && ev.payload['ticketId'].trim()
    ? ev.payload['ticketId'].trim() : ev.stream.startsWith('ticket:') ? ev.stream.slice(7) || undefined : undefined
const prefixPath = (ws: string | undefined, path: string): string => (path.includes(':') ? path : ws ? `${ws}:${path}` : path)

function extractTexts(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) extractTexts(x, out)
  else if (isRec(v)) for (const x of Object.values(v)) extractTexts(x, out)
  return out
}

function extractArtifacts(p: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  for (const s of extractTexts(p)) for (const m of s.matchAll(PATH_TOKEN_RE)) out.add(m[0])
  return out
}

function classifyGateContract(point: string, verdictKind: string, detailText: string): { key: string; rootKind: ProblemRootKind } {
  if (verdictKind === 'unmeasured') return { key: `gate-contract:${point}:shell-blind`, rootKind: 'gate-contract' }
  if (point === 'verify.changed-paths') {
    if (/漏报/.test(detailText)) return { key: `gate-contract:${point}:undeclared-path`, rootKind: 'gate-contract' }
    if (/伪造/.test(detailText)) return { key: `gate-contract:${point}:forged-path`, rootKind: 'gate-contract' }
  }
  if (point === 'verify.secret-path-guard') return { key: 'policy-probe:secret-path:.env', rootKind: 'policy-probe' }
  return { key: `gate-contract:${point}:${verdictKind}`, rootKind: 'gate-contract' }
}

function attachOrAbsorb(ticketsSignals: Map<string, RawSignal[]>, ev: SpineEnvelope, tid: string | undefined, artifacts: Set<string>): boolean {
  if (!tid) return false
  const list = ticketsSignals.get(tid) ?? []
  const isEnvSignal = [...artifacts].some(a => a.startsWith('.env'))
  const callId = isRec(ev.payload) && typeof ev.payload['callId'] === 'string' ? ev.payload['callId'] : undefined
  const isReport = ev.type === 'worker.tool_finished' && isRec(ev.payload) && ev.payload['toolName'] === 'orchestrator_report'
  const absorb = (target: RawSignal) => {
    target.explainedSymptoms.push({ seq: ev.seq, id: ev.id })
    if (ev.type === 'gate.evaluated') target.lastGateSeq = ev.seq
    return true
  }
  const anomaly = list.find(s => s.rootKind === 'contract-anomaly')
  if (anomaly && ((ev.type === 'gate.evaluated' && isEnvSignal) || (callId && anomaly.callIds.has(callId))
    || (isReport && (anomaly.lastGateSeq !== undefined ? ev.seq - anomaly.lastGateSeq <= 3 : list.some(s => s.category.startsWith('gate.')))))) return absorb(anomaly)
  const probe = list.find(s => s.rootKind === 'policy-probe')
  if (probe && (isEnvSignal || (callId && probe.callIds.has(callId)) || (isReport && probe.lastGateSeq !== undefined && ev.seq - probe.lastGateSeq <= 3))) return absorb(probe)
  const prevGate = [...list].reverse().find(s => s.category.startsWith('gate.') && ev.seq - s.ref.seq <= 3)
  if (prevGate && isReport) return absorb(prevGate)
  return false
}

/** 从 M0 事件流执行去噪、工单因果链回溯与 1-Hop 焦点交集聚类，并提取路由特征向量。 */
export function clusterProblemEvents(events: readonly SpineEnvelope[], options: ClusterProblemOptions = {}): ProblemCluster[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  const mode = options.mode ?? 'production', oneHopGraph = options.oneHopGraph ?? {}
  const wsByTicket = new Map<string, string>(), endedByTicket = new Map<string, string>()
  const bashErrorsByTicket = new Map<string, number>(), declaredSrcByTicket = new Map<string, string[]>()
  const rulingById = new Map<string, { artifacts: Set<string>; question: string; callId?: string }>()

  for (const ev of ordered) {
    const p = isRec(ev.payload) ? ev.payload : {}, tid = ticketIdOf(ev)
    if (typeof p['workspace'] === 'string' && tid) wsByTicket.set(tid, p['workspace'])
    if (tid && Array.isArray(p['declaredPaths'])) {
      const wsHint = (typeof p['workspace'] === 'string' ? p['workspace'] : undefined) ?? wsByTicket.get(tid)
      const paths = p['declaredPaths'].filter((x): x is string => typeof x === 'string' && !TEST_PATH_RE.test(x) && !x.startsWith('.env')).map(a => prefixPath(wsHint, a))
      if (paths.length > 0) declaredSrcByTicket.set(tid, [...new Set([...(declaredSrcByTicket.get(tid) ?? []), ...paths])])
    }
    if (ev.type === 'ruling.queued' && typeof p['rulingId'] === 'string') {
      rulingById.set(p['rulingId'], {
        artifacts: extractArtifacts(p), question: String(p['question'] ?? ''),
        ...(typeof p['callId'] === 'string' ? { callId: p['callId'] } : {}),
      })
    } else if (ev.type === 'ticket.ended' && tid) endedByTicket.set(tid, String(p['outcome'] ?? 'completed'))
    else if (ev.type === 'worker.tool_finished' && tid && p['isError'] === true && p['toolName'] === 'bash') {
      bashErrorsByTicket.set(tid, (bashErrorsByTicket.get(tid) ?? 0) + 1)
    }
  }

  const signals: RawSignal[] = [], signalsByTicket = new Map<string, RawSignal[]>()
  const pushSignal = (s: RawSignal) => { signals.push(s); if (s.ticketId) signalsByTicket.set(s.ticketId, [...(signalsByTicket.get(s.ticketId) ?? []), s]) }

  for (const ev of ordered) {
    const p = isRec(ev.payload) ? ev.payload : {}, tid = ticketIdOf(ev)
    const ws = (typeof p['workspace'] === 'string' ? p['workspace'] : undefined) ?? (tid ? wsByTicket.get(tid) : undefined)
    const day = /^\d{4}-\d{2}-\d{2}/.test(ev.at) ? ev.at.slice(0, 10) : undefined
    const explicitKey = typeof p['clusterKey'] === 'string' ? p['clusterKey'] : typeof p['frictionKey'] === 'string' ? p['frictionKey'] : undefined
    const ref: SourceRef = { seq: ev.seq, id: ev.id }, artifacts = extractArtifacts(p)
    const srcPaths = [...artifacts].filter(a => !TEST_PATH_RE.test(a) && !a.startsWith('.env')).map(a => prefixPath(ws, a))

    if (ev.type === 'gate.evaluated') {
      const pt = String(p['point'] ?? 'unknown'), vKind = isRec(p['verdict']) ? String(p['verdict']['kind'] ?? 'allow') : 'allow'
      if ((vKind !== 'deny' && vKind !== 'unmeasured') || (!explicitKey && pt === 'workspace.gc' && isRec(p['plan']) && p['plan']['kind'] === 'keep')) continue
      if (!explicitKey && attachOrAbsorb(signalsByTicket, ev, tid, artifacts)) continue
      const detailText = extractTexts(p['verdict']).concat(extractTexts(p['shellAudit'])).join(' ')
      const rerunPaths = srcPaths.length > 0 ? srcPaths : (pt === 'verify.rerun' && tid ? declaredSrcByTicket.get(tid) ?? [] : [])
      const cls = explicitKey ? { key: explicitKey, rootKind: 'explicit' as const }
        : rerunPaths.length > 0 && pt === 'verify.rerun' ? { key: `code-locus:${rerunPaths[0]}`, rootKind: 'code-locus' as const }
        : classifyGateContract(pt, vKind, detailText)
      pushSignal({
        key: cls.key, rootKind: cls.rootKind, category: vKind === 'deny' ? 'gate.deny' : 'gate.unmeasured', point: pt,
        attribution: vKind === 'unmeasured' ? 'unmeasurable' : 'wrong_rule', workspace: ws, ticketId: tid, day, ref,
        loci: new Set(rerunPaths), entryPoint: rerunPaths[0] ?? `${ws ?? 'global'}:${tid ?? pt}`, artifacts, callIds: new Set(),
        explainedSymptoms: [], deterministicOracle: vKind !== 'unmeasured', safetyDirection: 'neutral', explicit: Boolean(explicitKey),
      })
    } else if (ev.type === 'worker.tool_finished' && p['isError'] === true) {
      const toolName = typeof p['toolName'] === 'string' ? p['toolName'] : 'tool'
      if (!explicitKey && attachOrAbsorb(signalsByTicket, ev, tid, artifacts)) continue
      const completedTddNoise = !explicitKey && toolName === 'bash' && p['hasDiff'] === false && tid
        && (endedByTicket.get(tid) === 'completed' || endedByTicket.get(tid) === 'merged')
        && srcPaths.length === 0 && ![...artifacts].some(a => a.startsWith('.env')) && (bashErrorsByTicket.get(tid) ?? 0) <= 1
      if (completedTddNoise) continue
      pushSignal({
        key: explicitKey ?? (srcPaths[0] ? `code-locus:${srcPaths[0]}` : `tool-error:${ws ?? 'global'}:${tid ?? ev.seq}:${toolName}`),
        rootKind: explicitKey ? 'explicit' : srcPaths[0] ? 'code-locus' : 'gate-contract',
        category: 'worker.tool_error', toolName, attribution: 'missing_rule', workspace: ws, ticketId: tid, day, ref,
        loci: new Set(srcPaths), entryPoint: srcPaths[0] ?? `${ws ?? 'global'}:${tid ?? toolName}:${toolName}`, artifacts, callIds: new Set(),
        explainedSymptoms: [], deterministicOracle: true, safetyDirection: 'neutral', explicit: Boolean(explicitKey),
      })
    } else if (ev.type === 'escalation.ruled') {
      const escId = String(p['escalationId'] ?? ''), queued = rulingById.get(escId)
      for (const a of queued?.artifacts ?? []) artifacts.add(a)
      const optId = String(p['optionId'] ?? ''), decision = String(p['decision'] ?? ''), rKind = String(p['rulingKind'] ?? 'secretary_ask')
      const contractInversion = rKind !== 'secretary_ask' && decision === 'approve' && NEGATIVE_OPT_RE.test(optId)
      const hasSecret = [...artifacts].some(a => a.startsWith('.env'))
      const escPaths = contractInversion || hasSecret ? [] : [...artifacts].filter(a => !TEST_PATH_RE.test(a) && !a.startsWith('.env')).map(a => prefixPath(ws, a))
      const failOpenText = /(?:disable|turn\s+off|force\s+reset)/i.test(`${queued?.question ?? ''} ${String(p['note'] ?? '')}`)
      const attr = (typeof p['attribution'] === 'string' ? p['attribution'] : 'missing_rule') as FourWayAttribution
      const rootKind: ProblemRootKind = explicitKey ? 'explicit' : contractInversion ? 'contract-anomaly'
        : hasSecret ? 'policy-probe' : escPaths.length > 0 && rKind !== 'secretary_ask' ? 'code-locus' : 'spec-ruling'
      const key = explicitKey ?? (contractInversion ? 'contract-inversion:dsh_approval:negative-option-approved'
        : hasSecret ? 'policy-probe:secret-path:.env'
        : escPaths.length > 0 ? `spec-ruling:${escPaths[0]}` : `spec-ruling:${ws ?? 'global'}:${optId || escId || attr}`)
      pushSignal({
        key, rootKind, category: 'escalation.ruled', toolName: typeof p['toolName'] === 'string' ? p['toolName'] : undefined,
        attribution: contractInversion ? 'wrong_rule' : attr, workspace: ws, ticketId: tid, day, ref,
        loci: new Set(escPaths), entryPoint: `${ws ?? 'global'}:${escId || ev.seq}`, artifacts,
        callIds: new Set(queued?.callId ? [queued.callId] : []), explainedSymptoms: [],
        deterministicOracle: contractInversion || (rKind !== 'secretary_ask' && hasSecret),
        safetyDirection: contractInversion || (decision === 'reject' && (hasSecret || failOpenText)) ? 'fail-closed' : failOpenText ? 'fail-open' : 'neutral',
        explicit: Boolean(explicitKey),
      })
    } else if (ev.type === 'authoring.admission_rejected') {
      const ruleId = String(p['ruleId'] ?? 'unknown')
      pushSignal({
        key: explicitKey ?? `authoring-gate:${ruleId}`, rootKind: explicitKey ? 'explicit' : 'authoring-gate',
        category: 'authoring.admission_rejected', point: 'authoring.admission', attribution: 'wrong_rule', workspace: ws, ticketId: tid, day, ref,
        loci: new Set(), entryPoint: `${String(p['draftId'] ?? 'draft')}:${ruleId}`, artifacts, callIds: new Set(), explainedSymptoms: [],
        deterministicOracle: true, safetyDirection: 'neutral', explicit: Boolean(explicitKey),
      })
    } else if (ev.type === 'memory.rejected') {
      if (!explicitKey && p['action'] === 'dismiss' && p['layer'] === 'm6' && !p['reason']) continue
      const reason = String(p['reason'] ?? 'rejected')
      pushSignal({
        key: explicitKey ?? `memory-conflict:${reason}`, rootKind: explicitKey ? 'explicit' : 'memory-conflict',
        category: 'memory.rejected', point: 'memory.write', attribution: reason === 'topic-conflict' ? 'rule_conflict' : 'wrong_rule',
        workspace: ws, ticketId: tid, day, ref, loci: new Set(), entryPoint: `${ws ?? 'global'}:${reason}:${ev.seq}`, artifacts, callIds: new Set(),
        explainedSymptoms: [], deterministicOracle: reason !== 'topic-conflict', safetyDirection: 'neutral', explicit: Boolean(explicitKey),
      })
    } else if (ev.type === 'ticket.circuit_broken') {
      pushSignal({
        key: explicitKey ?? 'gate-contract:circuit-broken', rootKind: explicitKey ? 'explicit' : 'gate-contract',
        category: 'ticket.circuit_broken', point: 'ticket.dispatch', attribution: 'missing_rule', workspace: ws, ticketId: tid, day, ref,
        loci: new Set(), entryPoint: `${ws ?? 'global'}:${tid ?? ev.seq}`, artifacts, callIds: new Set(), explainedSymptoms: [],
        deterministicOracle: true, safetyDirection: 'neutral', explicit: Boolean(explicitKey),
      })
    }
  }

  // 并查集按 1-Hop 焦点交集归并 code-locus 信号，其余按明确键分组
  const n = signals.length, parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)))
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
  const expandN1 = (loci: Set<string>) => {
    const s = new Set<string>()
    for (const l of loci) { s.add(l); for (const d of oneHopGraph[l] ?? []) s.add(d) }
    return s
  }
  const n1Sets = signals.map(s => expandN1(s.loci))
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = signals[i]!, b = signals[j]!
    if (a.key === b.key) { union(i, j); continue }
    if (!a.explicit && !b.explicit && a.rootKind === 'code-locus' && b.rootKind === 'code-locus' && a.workspace === b.workspace) {
      for (const l of n1Sets[i]!) if (n1Sets[j]!.has(l)) { union(i, j); break }
    }
  }

  const groups = new Map<number, RawSignal[]>()
  for (let i = 0; i < n; i++) { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), signals[i]!]) }
  const minSeen = options.minSeen ?? (mode === 'e2e' ? 2 : 3), minDays = options.minDistinctDays ?? (mode === 'e2e' ? 1 : 3)
  const safetyRank = { 'fail-open': 2, 'fail-closed': 1, neutral: 0 } as const

  return [...groups.values()].map(list => {
    const lociCount = new Map<string, number>()
    for (const sig of list) for (const l of expandN1(sig.loci)) lociCount.set(l, (lociCount.get(l) ?? 0) + 1)
    const sharedLoci = [...lociCount.entries()].filter(([, c]) => c >= 2).map(([l]) => l).sort()
    const allLoci = [...lociCount.keys()].sort()
    const directLoci = new Set(list.flatMap(s => [...s.loci]))
    const impactCount = directLoci.size + sharedLoci.filter(l => !directLoci.has(l)).length
    const first = list[0]!, key = first.rootKind === 'code-locus' && sharedLoci.length > 0 && !first.explicit ? `code-locus:${sharedLoci[0]}` : first.key
    const days = [...new Set(list.map(s => s.day).filter((d): d is string => Boolean(d)))].sort()
    const ticketIds = [...new Set(list.map(s => s.ticketId).filter((t): t is string => Boolean(t)))].sort()
    const workspaces = [...new Set(list.map(s => s.workspace).filter((w): w is string => Boolean(w)))].sort()
    const refs = list.map(s => s.ref), explainedSymptoms = list.flatMap(s => s.explainedSymptoms)
    const byTicketHit = new Map<string, number>()
    for (const s of list) if (s.ticketId) byTicketHit.set(s.ticketId, (byTicketHit.get(s.ticketId) ?? 0) + 1)
    const features: ProblemClusterFeatures = {
      entryPointCount: new Set(list.map(s => s.entryPoint)).size, oneHopFileCount: Math.max(1, impactCount),
      sharedLocusCount: sharedLoci.length, deterministicOracle: list.every(s => s.deterministicOracle),
      safetyDirection: list.reduce<SafetyDirection>((b, s) => safetyRank[s.safetyDirection] > safetyRank[b] ? s.safetyDirection : b, 'neutral'),
      distinctWorkspaces: workspaces.length, distinctTickets: ticketIds.length, distinctDays: days.length,
      maxRetryCount: byTicketHit.size > 0 ? Math.max(...byTicketHit.values()) : 1, explainedSymptomCount: explainedSymptoms.length,
    }
    const qualifiesForRung1 = mode === 'e2e'
      ? (first.rootKind === 'contract-anomaly' || (refs.length >= minSeen && days.length >= minDays && (workspaces.length >= 2 || ticketIds.length >= 2 || sharedLoci.length >= 1)))
      : (refs.length >= minSeen && days.length >= minDays && (ticketIds.length === 0 || ticketIds.length >= Math.min(2, minSeen)))
    const draft = qualifiesForRung1 ? toClusterDraft(key, first.category, first.point, first.toolName, first.attribution, refs, days, refs.length) : undefined
    return {
      key, rootKind: first.rootKind, category: first.category,
      ...(first.point ? { point: first.point } : {}), ...(first.toolName ? { toolName: first.toolName } : {}),
      ...(first.attribution ? { attribution: first.attribution } : {}),
      loci: allLoci, sharedLoci, workspaces, ticketIds, distinctDays: days, refs, explainedSymptoms, features, qualifiesForRung1,
      ...(draft ? { draft } : {}),
    }
  })
}
