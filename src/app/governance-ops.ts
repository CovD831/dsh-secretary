/** M2/M3 运行时治理协同入口：沉淀包自动发现与 LEDGER 派生、记忆读写与工单后补丁、统计 RSI 与校准工作台。 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { latestReport, type Ticket } from '../core/index.ts'
import { packagePath } from '../infra/paths.ts'
import {
  discoverAndRegisterDeposits, loadDepositPackage, renderDepositsLedgerMarkdown, transitionDepositStage,
  type DiscoveredDepositRecord, type Stage, type TransitionDepositStageResult,
} from '../judgement/index.ts'
import { KV } from '../kv.ts'
import {
  assembleMemoryPrompt, computeMemoryBelievabilityMetrics, listMemoryPages, proposeTicketMemoryPatches,
  readMemoryPage, tickM6AttentionLifecycle, writeUserDirectMemory,
  type FactPage, type MemoryBelievabilityMetrics, type MemoryEntry, type PendingPatchProposal,
  type UserDirectMemoryInput, type UserDirectMemoryResult, type WriteResult,
} from '../memory/index.ts'
import {
  buildCalibratedGateRecord, collectOnlineRsiSnapshot, computeExpectedCalibrationError, evaluateSealedHoldout,
  fitTemperatureScaler, readM0Events, runLeaveOneOutAblation, splitByFamily,
  type AblationCase, type CalibratedGateRecord, type ExpectedCalibrationReport, type HoldoutEvaluationResult,
  type LeaveOneOutResult, type OnlineCollectionResult, type ReplayCase, type TemperatureScaler,
} from '../rsi/index.ts'
import type { GovernanceRuntime } from './governance.ts'

export interface MemoryStudioEntryRow {
  readonly relPath: string
  readonly layer: FactPage['layer']
  readonly revision: number
  readonly entry: MemoryEntry
}

export interface MemoryStudioView {
  readonly entries: MemoryStudioEntryRow[]
  readonly pendingPatches: PendingPatchProposal[]
  readonly metrics: MemoryBelievabilityMetrics
}

export interface RsiWorkbenchView {
  readonly snapshot: OnlineCollectionResult
  readonly scaler: TemperatureScaler
  readonly calibratedRecords: CalibratedGateRecord[]
  readonly calibration: ExpectedCalibrationReport
  readonly openedHoldouts: Record<string, string>
}

export function depositDirsOf(stateDir: string): readonly string[] {
  return [packagePath('deposits'), join(stateDir, 'deposits')]
}

const SHARD_NAME_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/

/** 同步读取 M0 分片尾部最新事件序号，供 SQLite 序列初始化与只读状态查询使用。 */
export function readSyncTailSeq(memoryDir: string): number {
  const m0Dir = join(memoryDir, 'm0')
  let shards: string[]
  try { shards = readdirSync(m0Dir).filter(n => SHARD_NAME_RE.test(n)).sort() } catch { return 0 }
  for (let i = shards.length - 1; i >= 0; i--) {
    const fd = openSync(join(m0Dir, shards[i]!), 'r')
    try {
      const { size } = fstatSync(fd)
      for (let win = Math.min(size, 64 * 1024); size > 0; win = Math.min(size, win * 2)) {
        const offset = size - win, buf = Buffer.allocUnsafe(win)
        let filled = 0
        while (filled < win) { const n = readSync(fd, buf, filled, win - filled, offset + filled); if (n === 0) break; filled += n }
        const endNl = buf.subarray(0, filled).lastIndexOf(0x0a)
        if (endNl >= 0) {
          const lines = buf.subarray(0, endNl + 1).toString('utf8').split('\n')
          for (let j = lines.length - 1; j >= (offset > 0 ? 1 : 0); j--) {
            const line = lines[j]?.trim()
            if (!line) continue
            try { const seq = (JSON.parse(line) as { seq?: unknown }).seq; if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) return seq } catch { continue }
          }
        }
        if (offset === 0) break
      }
    } finally { closeSync(fd) }
  }
  return 0
}

/** 扫描内置与状态目录沉淀包，应用持久化阶段覆盖并刷新只读 `<stateDir>/deposits/LEDGER.md`。 */
export async function syncDepositsAndLedger(gov: GovernanceRuntime): Promise<{ records: readonly DiscoveredDepositRecord[]; markdown: string }> {
  const stageOverrides = gov.storeRef.get(KV.governance.depositStages) ?? {}
  const report = await discoverAndRegisterDeposits({
    registry: gov.registry,
    dirs: depositDirsOf(gov.stateDir),
    stageOverrides,
    registerSeededOssGates: true,
  })
  const ledger = await renderDepositsLedgerMarkdown(report.records, {
    outPath: join(gov.stateDir, 'deposits', 'LEDGER.md'),
    generatedAt: gov.nowDate().toISOString(),
  })
  return { records: report.records, markdown: ledger.markdown }
}

/** 受控切换沉淀包阶段（守宪法 D5、红绿变异用例与 ProofRecord），持久化阶段表并刷新 `LEDGER.md`。 */
export async function changeDepositStage(
  gov: GovernanceRuntime,
  input: { id: string; toStage: Stage; reason?: string; actor?: string },
): Promise<TransitionDepositStageResult> {
  const currentOverrides = gov.storeRef.get(KV.governance.depositStages) ?? {}
  const synced = await discoverAndRegisterDeposits({
    registry: gov.registry, dirs: depositDirsOf(gov.stateDir), stageOverrides: currentOverrides, registerSeededOssGates: true,
  })
  const hit = synced.records.find(r => r.id === input.id)
  let cases = undefined
  if (hit?.packageDir) {
    const loaded = await loadDepositPackage(hit.packageDir).catch(() => undefined)
    if (loaded?.admission.admitted) cases = loaded.cases
  }
  const result = await transitionDepositStage({
    id: input.id, toStage: input.toStage, registry: gov.registry, stageOverrides: currentOverrides,
    ...(hit?.manifest ? { manifest: hit.manifest } : {}),
    ...(hit?.entry ? { entry: hit.entry } : {}),
    ...(cases ? { cases } : {}),
    appender: gov.appender, actor: input.actor ?? 'boss',
    ...(input.reason ? { reason: input.reason } : {}),
    now: () => gov.nowDate(),
  })
  if (result.ok) {
    gov.storeRef.set(KV.governance.depositStages, result.stageOverrides)
    await syncDepositsAndLedger(gov)
  }
  return result
}

/** 秘书主会话轮次前刷新 M2/M6 常驻与相关记忆块（无条目时返回空串零膨胀）。 */
export async function refreshSecretaryMemoryBlock(gov: GovernanceRuntime, query: string, tickTurn = true): Promise<string> {
  return gov.memoryRepoLock.run(async () => {
    if (tickTurn && existsSync(join(gov.memoryDir, 'm6', 'ledger.md'))) {
      await tickM6AttentionLifecycle(gov.memory, gov.memoryDir, gov.nowDate()).catch(() => undefined)
    }
    if (!existsSync(gov.memoryDir)) return ''
    const res = await assembleMemoryPrompt({
      dir: gov.memoryDir, caller: { role: 'secretary', maxClearance: 'private' },
      query, ftsIndex: gov.ftsIndex, now: gov.nowDate(),
    })
    const hasAny = res.receipt.resident.includedIds.length > 0
      || res.receipt.triggered.includedIds.length > 0
      || res.receipt.retrieved.includedIds.length > 0
      || res.attentionItems.length > 0
    return hasAny ? `\n\n${res.text}` : ''
  })
}

/** 工单收尾时从真实报告摘取逐字引证，生成待老板确认的 M3/M4 记忆补丁提案（不自动越权直写）。 */
export async function collectPostTicketPatches(gov: GovernanceRuntime, ticket: Ticket): Promise<PendingPatchProposal[]> {
  const summary = latestReport(ticket)?.summary?.trim()
  const wsId = ticket.execution?.workspace
  if (!summary || summary.length < 12) return []
  const events = await readM0Events({ db: gov.storeRef.db, memoryDir: gov.memoryDir })
  const ticketEvent = [...events].reverse().find(e => e.stream === `ticket:${ticket.id}`)
  if (!ticketEvent) return []
  const firstSentence = summary.split(/[\n。！？!?]/)[0]?.trim() ?? summary.slice(0, 80)
  if (!firstSentence) return []
  const out = await gov.memoryRepoLock.run(() => proposeTicketMemoryPatches({
    memoryDir: gov.memoryDir, ticketId: ticket.id, apply: false, author: 'consolidator',
    candidates: [{
      layer: wsId ? 'm3' : 'm1',
      ...(wsId ? { workspaceKey: wsId } : { slug: 'tickets' }),
      scope: wsId ? `workspace:${wsId}` : 'global',
      statement: `工单「${ticket.title}」经验：${firstSentence}`,
      sourceRef: { seq: ticketEvent.seq, id: ticketEvent.id },
      verbatimQuote: firstSentence,
      evidenceText: summary,
      topicKey: ticket.execution?.dispatchKey ?? `ticket-${ticket.id.slice(0, 8)}`,
    }],
  }))
  if (out.proposals.length > 0) {
    gov.storeRef.atomic(() => {
      const existing = gov.storeRef.get(KV.governance.memoryPatches) ?? []
      const keys = new Set(existing.map(p => `${p.targetRelPath}:${p.statement}`))
      const fresh = out.proposals.filter(p => !keys.has(`${p.targetRelPath}:${p.statement}`))
      if (fresh.length > 0) gov.storeRef.set(KV.governance.memoryPatches, [...existing, ...fresh].slice(-100))
    })
  }
  return [...out.proposals]
}

/** 读取记忆工作台表格视图：M1–M4 条目、待审逐字补丁与 3 项可信指标。 */
export async function readMemoryStudioView(gov: GovernanceRuntime): Promise<MemoryStudioView> {
  const [pages, spineEvents] = await Promise.all([
    gov.memoryRepoLock.run(() => existsSync(gov.memoryDir) ? listMemoryPages(gov.memoryDir, ['m1', 'm2', 'm3', 'm4']) : Promise.resolve([])),
    readM0Events({ db: gov.storeRef.db, memoryDir: gov.memoryDir }),
  ])
  const entries: MemoryStudioEntryRow[] = []
  for (const { relPath, page } of pages) {
    if (page.layer === 'm6') continue
    for (const entry of (page as FactPage).entries) entries.push({ relPath, layer: page.layer, revision: page.revision, entry })
  }
  const metrics = await gov.memoryRepoLock.run(() => computeMemoryBelievabilityMetrics(gov.memoryDir, spineEvents, gov.nowDate()))
  const pendingPatches = gov.storeRef.get(KV.governance.memoryPatches) ?? []
  return { entries, pendingPatches, metrics }
}

/** 老板在记忆表格直改或新增偏好/避坑（写 M0 `memory.user_direct` + 重建 FTS5 派生索引）。 */
export async function saveDirectMemory(gov: GovernanceRuntime, input: UserDirectMemoryInput): Promise<UserDirectMemoryResult> {
  const res = await writeUserDirectMemory(gov.memory, gov.appender, { ...input, now: gov.nowDate() })
  if (res.writeResult.kind === 'accepted') await gov.ftsIndex.rebuild().catch(() => undefined)
  return res
}

/** 审批或驳回待审工单后记忆补丁（带 `expectedRevision` 乐观锁防并发陈旧覆盖）。 */
export async function decideMemoryPatch(
  gov: GovernanceRuntime,
  index: number,
  decision: 'approve' | 'dismiss',
): Promise<{ ok: boolean; writeResult?: WriteResult; reason?: string }> {
  const list = [...(gov.storeRef.get(KV.governance.memoryPatches) ?? [])]
  if (index < 0 || index >= list.length) return { ok: false, reason: 'patch-not-found' }
  const target = list[index]!
  if (decision === 'dismiss') {
    list.splice(index, 1)
    gov.storeRef.set(KV.governance.memoryPatches, list)
    return { ok: true }
  }
  const curPage = await gov.memoryRepoLock.run(() => readMemoryPage(gov.memoryDir, target.targetRelPath))
  const writeResult = await gov.memory.propose({ ...target, expectedRevision: curPage?.revision ?? target.expectedRevision })
  if (writeResult.kind === 'accepted') {
    list.splice(index, 1)
    gov.storeRef.set(KV.governance.memoryPatches, list)
    await gov.ftsIndex.rebuild().catch(() => undefined)
    return { ok: true, writeResult }
  }
  return { ok: false, writeResult, reason: writeResult.reason }
}

/** 聚合统计 RSI、四分归因、L1–L13 回填、Seen>=3 Rung 1 候选与预筛校准 ECE 工作台数据。 */
export async function readRsiStudioView(
  gov: GovernanceRuntime,
  persistence?: Pick<SessionPersistence, 'flush' | 'open'>,
): Promise<RsiWorkbenchView> {
  const snapshot = await collectOnlineRsiSnapshot({
    db: gov.storeRef.db, memoryDir: gov.memoryDir, ...(persistence ? { persistence } : {}),
  })
  const fitted = fitTemperatureScaler(snapshot.calibratedRecords)
  const storedScaler = gov.storeRef.get(KV.governance.temperatureScaler)
  const scaler = fitted.fitted ? fitted : (storedScaler ?? fitted)
  if (fitted.fitted) gov.storeRef.set(KV.governance.temperatureScaler, fitted)
  const calibratedRecords = snapshot.calibratedRecords.map(r => buildCalibratedGateRecord({
    gateId: r.gateId, callId: r.callId, ticketId: r.ticketId, rawScore: r.rawScore,
    ...(r.groundTruthBackfill ? { groundTruthBackfill: r.groundTruthBackfill } : {}),
  }, scaler))
  const calibration = computeExpectedCalibrationError(calibratedRecords)
  const openedHoldouts = gov.storeRef.get(KV.governance.openedHoldouts) ?? {}
  return { snapshot, scaler, calibratedRecords, calibration, openedHoldouts }
}

/** 运行全注册表留一消融（识别冗余规则与冲突对）。 */
export function runRsiAblationCheck(gov: GovernanceRuntime, cases: readonly AblationCase[]): Promise<LeaveOneOutResult> {
  return runLeaveOneOutAblation(gov.registry, cases)
}

/** 受控开封封存 Holdout（单候选不可逆一次开封，强制写 `holdout.opened` M0 审计事件）。 */
export async function openRsiSealedHoldout(
  gov: GovernanceRuntime,
  input: { candidateId: string; cases: readonly ReplayCase<unknown>[]; point: string },
): Promise<{ ok: true; result: HoldoutEvaluationResult } | { ok: false; reason: string }> {
  const opened = gov.storeRef.get(KV.governance.openedHoldouts) ?? {}
  if (opened[input.candidateId]) return { ok: false, reason: `Holdout "${input.candidateId}" 已于 ${opened[input.candidateId]} 开封，禁止重复调参刷分` }
  if (input.cases.length < 4) return { ok: false, reason: '样本集至少需 4 条带独立 family 的历史用例方可切分 Holdout' }
  const split = splitByFamily(input.cases)
  if (split.train.length === 0 || split.holdout.length === 0) return { ok: false, reason: '切分后 train 或 holdout 为空，请补充不同 family 样本' }
  const result = await evaluateSealedHoldout({
    baselineGate: () => ({ kind: 'allow' }),
    candidateGate: async ctx => (await gov.registry.evaluate(input.point as never, ctx as never)).verdict,
    split, candidateId: input.candidateId, actorId: 'boss', now: () => gov.nowDate(),
  })
  gov.storeRef.atomic(() => {
    gov.appender.append(result.auditEvent)
    gov.storeRef.set(KV.governance.openedHoldouts, { ...opened, [input.candidateId]: gov.nowDate().toISOString() })
  })
  return { ok: true, result }
}
