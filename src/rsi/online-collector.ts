/** M0 在线事件采集、L1–L13 天然标签回填、四分归因分母统计与 Seen>=3 跨 3 自然日 Rung 1 候选提取。 */
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { DepositDraft } from '../authoring/types.ts'
import { isValidScopeStage } from '../judgement/registry.ts'
import { BASE_SCOPES } from '../judgement/types.ts'
import type { SourceRef, SpineEnvelope } from '../spine/types.ts'
import { compareWindows, computeBehavioralMetrics, toEvaluationReading } from './evaluator.ts'
import { createPersistenceSessionReader, extractSessionPtr, joinNativeSessionMetrics, type SessionEventsReader } from './trace-bridge.ts'
import type {
  AttributionSummary, CalibratedGateRecord, FourWayAttribution, FrictionCluster,
  JoinedSessionMetricRow, LabelledEventRecord, NaturalBackfillLabel,
  OnlineCollectionResult, ReplayCase, TaskBehaviorRecord, WindowSample,
} from './types.ts'

const SHARD_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const KNOWN_SCOPES = new Set<string>(BASE_SCOPES)
const ALL_LABELS: readonly NaturalBackfillLabel[] = [
  'L1:verify_failed', 'L2:gate_denied_fixed', 'L3:rework_retry', 'L4:circuit_broken',
  'L5:tool_error', 'L6:escalation_queued', 'L7:ruling_decided', 'L8:memory_rejected',
  'L9:memory_corrected', 'L10:recall_dropped', 'L11:unmeasured_gap', 'L12:external_taint', 'L13:draft_abandoned',
]
const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))

export interface OnlineCollectOptions {
  readonly events?: readonly SpineEnvelope[]
  readonly db?: DatabaseSync
  readonly memoryDir?: string
  readonly persistence?: Pick<SessionPersistence, 'flush' | 'open'>
  readonly readSessionEvents?: SessionEventsReader
  readonly baselineWindow?: WindowSample
  readonly windowDurationMs?: number
  readonly minSeen?: number
  readonly minDistinctDays?: number
}

function parseEnvelope(raw: string): SpineEnvelope | undefined {
  const s = raw.trim()
  if (!s) return undefined
  try {
    const o = JSON.parse(s) as Partial<SpineEnvelope>
    return o && typeof o.seq === 'number' && Number.isSafeInteger(o.seq) && o.seq > 0 && typeof o.id === 'string' && typeof o.type === 'string'
      ? (o as SpineEnvelope) : undefined
  } catch { return undefined }
}

/** 从 SQLite event_spine 与 memoryDir/m0/*.jsonl 读取并按 seq 升序去重合并 M0 事件流。 */
export async function readM0Events(options: Pick<OnlineCollectOptions, 'events' | 'db' | 'memoryDir'>): Promise<SpineEnvelope[]> {
  const bySeq = new Map<number, SpineEnvelope>()
  for (const ev of options.events ?? []) if (Number.isSafeInteger(ev.seq) && ev.seq > 0) bySeq.set(ev.seq, ev)
  if (options.db) {
    try {
      if (options.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_spine'").get()) {
        for (const r of options.db.prepare('SELECT value FROM event_spine ORDER BY seq ASC').all() as { value?: unknown }[]) {
          if (typeof r.value === 'string') { const ev = parseEnvelope(r.value); if (ev) bySeq.set(ev.seq, ev) }
        }
      }
    } catch { /* 空库或未初始化忽略 */ }
  }
  if (options.memoryDir) {
    const m0Dir = join(resolve(options.memoryDir), 'm0')
    try {
      if (!(await lstat(m0Dir)).isSymbolicLink()) {
        for (const name of (await readdir(m0Dir)).filter(n => SHARD_FILE_RE.test(n)).sort()) {
          const p = join(m0Dir, name)
          const st = await lstat(p).catch(() => undefined)
          if (!st || !st.isFile() || st.isSymbolicLink()) continue
          const raw = await readFile(p, 'utf8')
          const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1)
          for (const line of complete.split('\n')) { const ev = parseEnvelope(line); if (ev) bySeq.set(ev.seq, ev) }
        }
      }
    } catch { /* 无 m0 目录忽略 */ }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function normalizeAttribution(raw: unknown): FourWayAttribution | undefined {
  if (raw === 'missing_rule' || raw === 'wrong_rule' || raw === 'unmeasurable' || raw === 'rule_conflict') return raw
  if (raw === 'gate_gap') return 'missing_rule'
  if (raw === 'exec_mistake') return 'wrong_rule'
  if (raw === 'env_transient') return 'unmeasurable'
  if (raw === 'mandate_unclear') return 'rule_conflict'
  return undefined
}

function ticketIdOf(ev: SpineEnvelope): string | undefined {
  if (isRec(ev.payload) && typeof ev.payload['ticketId'] === 'string' && ev.payload['ticketId'].trim()) return ev.payload['ticketId'].trim()
  if (ev.stream.startsWith('ticket:')) return ev.stream.slice(7) || undefined
  return undefined
}

function toClusterDraft(key: string, category: string, point: string | undefined, toolName: string | undefined,
  attribution: FourWayAttribution | undefined, refs: readonly SourceRef[], distinctDays: readonly string[], seenCount: number): DepositDraft {
  const safeSlug = key.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'cluster'
  const validPoint = point && isValidScopeStage(point, KNOWN_SCOPES) ? point : 'verify.preflight'
  return {
    id: `friction.${safeSlug}`, name: `在线摩擦候选 (${category})`, version: 1, author: 'rsi-online-collector',
    scope: 'private', kind: 'counter-rule', level: 'object', point: validPoint,
    trigger: { on: category, mode: 'on-event' }, requires: ['ticket.id'],
    params: { min_seen: { type: 'number', default: 3, min: 1 }, min_distinct_days: { type: 'number', default: 3, min: 1 } },
    exceptions: ['仅作为 Rung 1 候选提议呈现，须补齐正反例并经离线回放后方可晋升'],
    repairHint: `同类摩擦 (${key}) 已跨越 ${distinctDays.length} 个自然日累计 ${seenCount} 次，请补充判据并核验。`,
    intent: `针对高频跨日摩擦 ${key}（归因: ${attribution ?? 'missing_rule'}）生成 Rung 1 规则草案。`,
    rubricBody: `在 ${distinctDays.join(', ')} 观测到 ${seenCount} 次 ${category}${toolName ? ` (${toolName})` : ''}，建为影子提案。`,
    enforce: false, stage: 'shadow', actionClass: 'observe', action: { name: 'proposal.create' },
    origin: { kind: 'friction-mined', refs: refs.map(r => `m0:${r.seq}#${r.id}`) }, cases: [],
  }
}

/** 采集 M0 事件并执行 L1–L13 回填、四分归因、行为指标计算与 Rung 1 候选提取。 */
export async function collectOnlineRsiSnapshot(options: OnlineCollectOptions): Promise<OnlineCollectionResult> {
  const events = await readM0Events(options)
  const reader = options.readSessionEvents ?? (options.persistence ? createPersistenceSessionReader(options.persistence) : undefined)
  const joinedSessionMetrics: JoinedSessionMetricRow[] = reader ? await joinNativeSessionMetrics(events, reader) : []
  const joinedBySeq = new Map(joinedSessionMetrics.map(r => [r.envelopeSeq, r]))

  const labelCounts = Object.fromEntries(ALL_LABELS.map(l => [l, 0])) as Record<NaturalBackfillLabel, number>
  const attrCounts: Record<FourWayAttribution, number> = { missing_rule: 0, wrong_rule: 0, unmeasurable: 0, rule_conflict: 0 }
  const labelHits: LabelledEventRecord[] = []
  const byTicket = new Map<string, SpineEnvelope[]>()
  const deniedTickets = new Set<string>()
  const clusterMap = new Map<string, { category: string; point?: string; toolName?: string; attribution?: FourWayAttribution; refs: SourceRef[]; days: Set<string> }>()
  const callToolIds = new Set<string>()
  const rulingTruthByCall = new Map<string, 'clean' | 'defect'>()
  const rulingTruthByTicket = new Map<string, 'clean' | 'defect'>()
  const preScreens: { gateId: string; callId: string; ticketId: string; rawScore: number; calibratedProb: number; threshold: number; decision: string }[] = []

  let toolExecFallback = 0
  let hasEscalationSurface = false
  const addLabel = (ev: SpineEnvelope, label: NaturalBackfillLabel, extra?: { attribution?: FourWayAttribution; clusterKey?: string; point?: string; toolName?: string }) => {
    const tid = ticketIdOf(ev)
    labelCounts[label] += 1
    labelHits.push({ seq: ev.seq, id: ev.id, at: ev.at, ...(tid ? { ticketId: tid } : {}), label, ...extra })
  }
  const addFriction = (ev: SpineEnvelope, key: string, category: string, point?: string, toolName?: string, attr?: FourWayAttribution) => {
    const day = /^\d{4}-\d{2}-\d{2}/.test(ev.at) ? ev.at.slice(0, 10) : undefined
    const cur = clusterMap.get(key) ?? { category, ...(point ? { point } : {}), ...(toolName ? { toolName } : {}), ...(attr ? { attribution: attr } : {}), refs: [], days: new Set<string>() }
    cur.refs.push({ seq: ev.seq, id: ev.id })
    if (day) cur.days.add(day)
    clusterMap.set(key, cur)
  }

  for (const ev of events) {
    const p = isRec(ev.payload) ? ev.payload : {}
    const tid = ticketIdOf(ev)
    if (tid) byTicket.set(tid, [...(byTicket.get(tid) ?? []), ev])
    const joined = joinedBySeq.get(ev.seq)
    const explicitKey = typeof p['clusterKey'] === 'string' ? p['clusterKey'] : typeof p['frictionKey'] === 'string' ? p['frictionKey'] : undefined
    const explicitAttr = normalizeAttribution(p['attribution'])

    if (ev.type === 'gate.evaluated') {
      const pt = typeof p['point'] === 'string' ? p['point'] : undefined
      const vKind = isRec(p['verdict']) ? p['verdict']['kind'] : undefined
      if (vKind === 'deny') {
        if (tid) deniedTickets.add(tid)
        if (pt?.startsWith('verify.')) addLabel(ev, 'L1:verify_failed', { ...(pt ? { point: pt } : {}) })
        if (p['falseBlock'] === true) attrCounts.wrong_rule += 1
        addFriction(ev, explicitKey ?? `gate-deny:${pt ?? 'unknown'}`, 'gate.deny', pt, undefined, explicitAttr ?? 'wrong_rule')
      } else if (vKind === 'allow' && tid && deniedTickets.has(tid)) {
        addLabel(ev, 'L2:gate_denied_fixed', { ...(pt ? { point: pt } : {}) })
      } else if (vKind === 'unmeasured') {
        attrCounts.unmeasurable += 1
        addLabel(ev, 'L11:unmeasured_gap', { attribution: 'unmeasurable', ...(pt ? { point: pt } : {}) })
        addFriction(ev, explicitKey ?? `gate-unmeasured:${pt ?? 'unknown'}`, 'gate.unmeasured', pt, undefined, 'unmeasurable')
      }
    } else if (ev.type === 'gate.calibrated_pre_screen') {
      const callId = String(p['callId'] ?? ev.id)
      callToolIds.add(callId)
      if (typeof p['rawScore'] === 'number') {
        preScreens.push({
          gateId: String(p['gateId'] ?? 'approval.smart-auto'), callId, ticketId: tid ?? 'unknown',
          rawScore: p['rawScore'], calibratedProb: typeof p['calibratedProb'] === 'number' ? p['calibratedProb'] : p['rawScore'],
          threshold: typeof p['threshold'] === 'number' ? p['threshold'] : 0.5, decision: String(p['decision'] ?? 'allow'),
        })
      }
    } else if (ev.type === 'worker.tool_finished') {
      const callId = typeof p['callId'] === 'string' ? p['callId'] : undefined
      if (callId) callToolIds.add(callId); else toolExecFallback += 1
      if (p['isError'] === true) {
        const toolName = typeof p['toolName'] === 'string' ? p['toolName'] : 'tool'
        addLabel(ev, 'L5:tool_error', { toolName, attribution: 'missing_rule' })
        if (/verify|test|typecheck|tsc|vitest/i.test(`${toolName} ${String(p['command'] ?? '')}`)) addLabel(ev, 'L1:verify_failed', { toolName })
        addFriction(ev, explicitKey ?? `tool-error:${toolName}`, 'worker.tool_error', undefined, toolName, explicitAttr ?? 'missing_rule')
      }
    } else if (ev.type === 'ticket.circuit_broken') {
      attrCounts.missing_rule += 1
      addLabel(ev, 'L4:circuit_broken', { attribution: 'missing_rule' })
      addFriction(ev, explicitKey ?? 'circuit-broken', 'ticket.circuit_broken', 'ticket.dispatch', undefined, 'missing_rule')
    } else if (ev.type === 'ticket.resumed') {
      addLabel(ev, 'L3:rework_retry')
    } else if (ev.type === 'ruling.queued') {
      hasEscalationSurface = true
      addLabel(ev, 'L6:escalation_queued')
    } else if (ev.type === 'escalation.ruled') {
      hasEscalationSurface = true
      const attr = explicitAttr ?? 'missing_rule'
      attrCounts[attr] += 1
      addLabel(ev, 'L7:ruling_decided', { attribution: attr })
      const gt = p['groundTruth'] === 'clean' || p['groundTruth'] === 'defect' ? p['groundTruth'] : (p['decision'] === 'approve' ? 'clean' : 'defect')
      if (typeof p['callId'] === 'string') rulingTruthByCall.set(p['callId'], gt)
      if (tid) rulingTruthByTicket.set(tid, gt)
      if (attr !== 'unmeasurable') addFriction(ev, explicitKey ?? `ruling:${attr}:${String(p['toolName'] ?? 'general')}`, 'escalation.ruled', undefined, typeof p['toolName'] === 'string' ? p['toolName'] : undefined, attr)
    } else if (ev.type === 'memory.rejected') {
      const reason = String(p['reason'] ?? 'rejected')
      if (reason === 'topic-conflict') attrCounts.rule_conflict += 1
      addLabel(ev, 'L8:memory_rejected', { attribution: reason === 'topic-conflict' ? 'rule_conflict' : 'wrong_rule' })
      addFriction(ev, explicitKey ?? `memory-rejected:${reason}`, 'memory.rejected', 'memory.write', undefined, reason === 'topic-conflict' ? 'rule_conflict' : 'wrong_rule')
    } else if (ev.type === 'memory.tombstoned' || ev.type === 'memory.corrected' || (ev.type === 'memory.accepted' && ((Array.isArray(p['supersededIds']) && p['supersededIds'].length > 0) || p['m2Kind'] === 'correction_repair'))) {
      addLabel(ev, 'L9:memory_corrected')
    } else if (ev.type === 'memory.recall.dropped') {
      addLabel(ev, 'L10:recall_dropped')
    } else if (ev.type === 'authoring.abandoned_at' || ev.type === 'authoring.admission_rejected') {
      addLabel(ev, 'L13:draft_abandoned')
    } else if (ev.type === 'ticket.ended' && (p['outcome'] === 'completed' || p['outcome'] === 'merged') && tid && deniedTickets.has(tid)) {
      addLabel(ev, 'L2:gate_denied_fixed')
    }
    if (ev.taint === 'untrusted' && (ev.type === 'ruling.queued' || ev.type === 'memory.rejected' || ev.type === 'escalation.ruled')) addLabel(ev, 'L12:external_taint')
    if (joined) {
      if (joined.metricsState === 'unmeasured') addLabel(ev, 'L11:unmeasured_gap', { attribution: 'unmeasurable' })
      if ((joined.failedCommandCount ?? 0) > 0) addLabel(ev, 'L5:tool_error')
    }
  }

  const taskRecords: TaskBehaviorRecord[] = []
  const replayCases: ReplayCase[] = []
  const labelsByTicket = new Map<string, Set<NaturalBackfillLabel>>()
  for (const hit of labelHits) if (hit.ticketId) labelsByTicket.set(hit.ticketId, (labelsByTicket.get(hit.ticketId) ?? new Set()).add(hit.label))

  let defectTickets = 0, cleanTickets = 0
  for (const [tid, tEvents] of byTicket) {
    const attempts: { at?: number; outcome: 'completed' | 'failed' | 'cancelled' }[] = []
    let escCount = 0, retrySignals = 0, startCount = 0
    for (const ev of tEvents) {
      const atMs = Date.parse(ev.at), p = isRec(ev.payload) ? ev.payload : {}
      if (ev.type === 'assignment.started') startCount += 1
      else if (ev.type === 'assignment.ended') {
        const r = String(p['reason'] ?? '')
        if (/retry|retried|fail|block/i.test(r)) { retrySignals += 1; attempts.push({ ...(Number.isFinite(atMs) ? { at: atMs } : {}), outcome: 'failed' }) }
        else attempts.push({ ...(Number.isFinite(atMs) ? { at: atMs } : {}), outcome: 'completed' })
      } else if (ev.type === 'ticket.circuit_broken') attempts.push({ ...(Number.isFinite(atMs) ? { at: atMs } : {}), outcome: 'failed' })
      else if (ev.type === 'ticket.ended') {
        const out = String(p['outcome'] ?? 'completed')
        attempts.push({ ...(Number.isFinite(atMs) ? { at: atMs } : {}), outcome: out === 'cancelled' || out === 'stopped' ? 'cancelled' : out === 'failed' ? 'failed' : 'completed' })
      } else if (ev.type === 'ruling.queued') escCount += 1
    }
    if (startCount > 1 || retrySignals > 0) addLabel(tEvents[tEvents.length - 1]!, 'L3:rework_retry')
    if (attempts.length > 0) taskRecords.push({ taskId: tid, attempts, ...(hasEscalationSurface ? { escalations: escCount } : {}) })

    const tLabels = labelsByTicket.get(tid) ?? new Set<NaturalBackfillLabel>()
    const hasDefect = tLabels.has('L1:verify_failed') || tLabels.has('L4:circuit_broken') || tLabels.has('L5:tool_error') || attempts.some(a => a.outcome === 'failed') || rulingTruthByTicket.get(tid) === 'defect'
    const hasClean = !hasDefect && (attempts.some(a => a.outcome === 'completed') || rulingTruthByTicket.get(tid) === 'clean')
    const expectedOutcome = hasDefect ? 'defect' : hasClean ? 'clean' : 'unknown'
    if (expectedOutcome === 'defect') defectTickets += 1; else if (expectedOutcome === 'clean') cleanTickets += 1
    const jRow = tEvents.map(e => joinedBySeq.get(e.seq)).find(r => r && r.metricsState !== 'unmeasured')
    const ptr = tEvents.map(extractSessionPtr).find(Boolean)
    replayCases.push({
      id: tid, family: [...tLabels][0] ?? 'ticket', input: { ticketId: tid, labels: [...tLabels], events: tEvents }, expectedOutcome,
      ...(jRow?.tokens?.totalTokens !== undefined ? { tokens: jRow.tokens.totalTokens } : {}),
      ...(jRow?.durationMs !== undefined ? { durationMs: jRow.durationMs } : {}),
      ...(ptr ? { sessionEventPtr: ptr } : {}),
    })
  }

  const totalTickets = byTicket.size
  const joinedTools = joinedSessionMetrics.reduce((s, r) => s + (r.toolCalls ?? 0), 0)
  const totalToolExecutions = Math.max(callToolIds.size + toolExecFallback, joinedTools)
  const totalAttributed = attrCounts.missing_rule + attrCounts.wrong_rule + attrCounts.unmeasurable + attrCounts.rule_conflict
  const div = (n: number, d: number) => (d > 0 ? n / d : undefined)
  const attribution: AttributionSummary = {
    counts: attrCounts, totalAttributed, totalTickets, totalToolExecutions,
    ratePerTicket: { missing_rule: div(attrCounts.missing_rule, totalTickets), wrong_rule: div(attrCounts.wrong_rule, totalTickets), unmeasurable: div(attrCounts.unmeasurable, totalTickets), rule_conflict: div(attrCounts.rule_conflict, totalTickets) },
    ratePerToolExecution: { missing_rule: div(attrCounts.missing_rule, totalToolExecutions), wrong_rule: div(attrCounts.wrong_rule, totalToolExecutions), unmeasurable: div(attrCounts.unmeasurable, totalToolExecutions), rule_conflict: div(attrCounts.rule_conflict, totalToolExecutions) },
  }

  const minSeen = options.minSeen ?? 3, minDays = options.minDistinctDays ?? 3
  const clusters: FrictionCluster[] = []
  const candidateDrafts: DepositDraft[] = []
  for (const [key, c] of clusterMap) {
    const distinctDays = [...c.days].sort(), seenCount = c.refs.length
    const qualifiesForRung1 = seenCount >= minSeen && distinctDays.length >= minDays
    const draft = qualifiesForRung1 ? toClusterDraft(key, c.category, c.point, c.toolName, c.attribution, c.refs, distinctDays, seenCount) : undefined
    if (draft) candidateDrafts.push(draft)
    clusters.push({ key, category: c.category, ...(c.point ? { point: c.point } : {}), ...(c.toolName ? { toolName: c.toolName } : {}),
      ...(c.attribution ? { attribution: c.attribution } : {}), seenCount, distinctDays, refs: c.refs, qualifiesForRung1, ...(draft ? { draft } : {}) })
  }

  const calibratedRecords: CalibratedGateRecord[] = preScreens.map(ps => {
    const gt = rulingTruthByCall.get(ps.callId) ?? rulingTruthByTicket.get(ps.ticketId)
      ?? (labelsByTicket.get(ps.ticketId)?.has('L4:circuit_broken') || labelsByTicket.get(ps.ticketId)?.has('L1:verify_failed') ? 'defect' : undefined)
    return {
      gateId: ps.gateId, callId: ps.callId, ticketId: ps.ticketId, rawScore: ps.rawScore, calibratedProb: ps.calibratedProb,
      thresholdBand: [Math.max(0, ps.threshold - 0.3), Math.min(1, ps.threshold + 0.3)],
      decision: ps.decision === 'ask' ? 'ask' : ps.decision === 'block' ? 'block' : ps.decision === 'deterministic_gate' ? 'deterministic_gate' : 'allow',
      ...(gt ? { groundTruthBackfill: gt } : {}),
    }
  })

  const half = Math.floor(replayCases.length / 2)
  const beforeWin: WindowSample = options.baselineWindow ?? (half > 0
    ? { failures: replayCases.slice(0, half).filter(c => c.expectedOutcome === 'defect').length, opportunities: half }
    : { failures: 0, opportunities: 0 })
  const afterWin: WindowSample = options.baselineWindow
    ? { failures: defectTickets, opportunities: totalTickets, ...(options.windowDurationMs !== undefined ? { durationMs: options.windowDurationMs } : {}) }
    : (half > 0 ? { failures: replayCases.slice(half).filter(c => c.expectedOutcome === 'defect').length, opportunities: replayCases.length - half } : { failures: 0, opportunities: 0 })

  return {
    eventCount: events.length, labelHits, labelCounts, taskRecords,
    behavioralMetrics: computeBehavioralMetrics(taskRecords), replayCases, joinedSessionMetrics,
    attribution, clusters, candidateDrafts, calibratedRecords,
    effectivenessReading: toEvaluationReading(cleanTickets, defectTickets + cleanTickets),
    windowComparison: compareWindows(beforeWin, afterWin),
  }
}
