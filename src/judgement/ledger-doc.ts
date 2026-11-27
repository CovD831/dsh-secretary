import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { packagePath } from '../infra/paths.ts'
import type { SpineAppender, SourceRef } from '../spine/types.ts'
import { compileDeclarativeEntry } from './declarative.ts'
import { loadDepositPackage, runDepositCases, type DepositCase, type DepositCasesReport, type DepositViolation } from './deposit.ts'
import {
  createAdaptiveDispatchGate, createChangeTestCoverageGate, createChangedPathsGate, createCommandContractGate,
  createDiffReviewGate, createIssueIntakeGate, createPlanReviewGate, createReplyDeskGate,
  createReproStatusGate, createVerifyRerunGate, issueIntakeGate, replyDeskGate, reproStatusGate,
} from './gates/index.ts'
import type { ExtendedJudgementRegistry } from './registry.ts'
import type { AnyGateDef, DepositManifest, ProofRecord, RegistryEntry, Stage } from './types.ts'

export type DiscoveredDepositStatus = 'registered' | 'already-registered' | 'rejected' | 'failed-cases' | 'unimplemented' | 'skipped-oss'

export interface DiscoveredDepositRecord {
  readonly id: string
  readonly dirName: string
  readonly packageDir: string
  readonly kind?: DepositManifest['kind']
  readonly point?: string
  readonly signal?: string
  readonly stage: Stage
  readonly enforce: boolean
  readonly trust?: DepositManifest['trust']
  readonly casesCount: number
  readonly status: DiscoveredDepositStatus
  readonly violations?: readonly DepositViolation[]
  readonly caseReport?: DepositCasesReport
  readonly error?: string
  readonly manifest?: DepositManifest
  readonly entry?: RegistryEntry
}

export interface DiscoverDepositsOptions {
  readonly registry: Pick<ExtendedJudgementRegistry, 'register' | 'list' | 'unregister' | 'getProof'>
  readonly dirs?: readonly string[]
  readonly stageOverrides?: Readonly<Record<string, Stage>>
  readonly registerSeededOssGates?: boolean
  readonly proofs?: Readonly<Record<string, ProofRecord>>
}

export interface DiscoverDepositsReport {
  readonly records: readonly DiscoveredDepositRecord[]
  readonly registeredIds: readonly string[]
  readonly rejectedIds: readonly string[]
  readonly failedCaseIds: readonly string[]
}

export interface TransitionDepositStageInput {
  readonly id: string
  readonly toStage: Stage
  readonly registry: Pick<ExtendedJudgementRegistry, 'register' | 'list' | 'unregister' | 'getProof'>
  readonly stageOverrides: Readonly<Record<string, Stage>>
  readonly manifest?: DepositManifest
  readonly entry?: RegistryEntry
  readonly cases?: readonly DepositCase[]
  readonly proof?: ProofRecord
  readonly appender?: SpineAppender
  readonly actor?: string
  readonly reason?: string
  readonly now?: () => Date
}

export type TransitionDepositStageResult =
  | { readonly ok: true; readonly id: string; readonly fromStage: Stage | 'unregistered'; readonly toStage: Stage; readonly stageOverrides: Record<string, Stage>; readonly sourceRef?: SourceRef }
  | { readonly ok: false; readonly code: string; readonly reason: string }

const VALID_STAGES = new Set<Stage>(['shadow', 'observe', 'enforce', 'retired'])
export const OSS_SEEDED_GATE_IDS: ReadonlySet<string> = new Set(['intake.bug-quadruple', 'verify.repro-evidence', 'outward.reply-desk'])
export const RESERVED_BUILTIN_DEPOSIT_IDS: ReadonlySet<string> = new Set([
  'workspace.gc.safety', 'ticket.dispatch.isolation-ceiling', 'ticket.adaptive-dispatch', 'ticket.plan-review',
  'verify.changed-paths', 'verify.rerun', 'verify.command-contract', 'verify.change-test-coverage', 'verify.diff-review',
  'intake.bug-quadruple', 'verify.repro-evidence', 'outward.reply-desk', 'verify.secret-path-guard',
  'replay.ci-evaluator', 'friction.seen-three', 'ticket.stale-patrol',
])

const BUILTIN_FACTORIES: Readonly<Record<string, (bound?: Record<string, unknown>) => AnyGateDef>> = {
  'ticket.adaptive-dispatch': b => createAdaptiveDispatchGate(b as never),
  'ticket.plan-review': b => createPlanReviewGate(b as never),
  'verify.changed-paths': b => createChangedPathsGate(b as never),
  'verify.rerun': b => createVerifyRerunGate(b as never),
  'verify.command-contract': b => createCommandContractGate(b as never),
  'verify.change-test-coverage': b => createChangeTestCoverageGate(b as never),
  'verify.diff-review': b => createDiffReviewGate(b as never),
  'intake.bug-quadruple': b => createIssueIntakeGate(b as never),
  'verify.repro-evidence': b => createReproStatusGate(b as never),
  'outward.reply-desk': b => createReplyDeskGate(b as never),
}

export const BUILTIN_EXECUTABLE_DEPOSIT_IDS: ReadonlySet<string> = new Set(Object.keys(BUILTIN_FACTORIES))

export function createBuiltinGate(id: string, boundParams?: Record<string, unknown>): AnyGateDef | undefined {
  return BUILTIN_FACTORIES[id]?.(boundParams)
}

/** 根据沉淀清单解析内置 TS 判据或调用零代码声明式编译器。 */
export function resolveDepositEntry(manifest: DepositManifest): RegistryEntry | undefined {
  if (manifest.rule || manifest.kind === 'standing-order') return compileDeclarativeEntry(manifest)
  return BUILTIN_FACTORIES[manifest.id]?.()
}

async function listPackageDirs(rootDir: string): Promise<{ dirName: string; packageDir: string }[]> {
  let entries
  try { entries = (await readdir(rootDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)) } catch { return [] }
  const dirs: { dirName: string; packageDir: string }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const packageDir = join(rootDir, entry.name)
    const md = await lstat(join(packageDir, 'DEPOSIT.md')).catch(() => undefined)
    if (md?.isFile() && !md.isSymbolicLink()) dirs.push({ dirName: entry.name, packageDir })
  }
  return dirs
}

/** 扫描内置与状态目录沉淀包，绑定内置 TS 或零代码规则、校验红绿+变异用例，并按持久化 stageOverrides 注入注册表。 */
export async function discoverAndRegisterDeposits(options: DiscoverDepositsOptions): Promise<DiscoverDepositsReport> {
  const { registry, dirs = [], stageOverrides = {}, registerSeededOssGates = true, proofs = {} } = options
  const records: DiscoveredDepositRecord[] = []
  const registeredIds: string[] = []
  const rejectedIds: string[] = []
  const failedCaseIds: string[] = []
  const seenIds = new Set<string>()

  const builtinDepositsDir = resolve(packagePath('deposits'))
  for (const rootDir of dirs) {
    const isBuiltinDir = resolve(rootDir) === builtinDepositsDir
    for (const { dirName, packageDir } of await listPackageDirs(rootDir)) {
      let loaded: Awaited<ReturnType<typeof loadDepositPackage>>
      try { loaded = await loadDepositPackage(packageDir) } catch (err) {
        rejectedIds.push(dirName)
        records.push({ id: dirName, dirName, packageDir, stage: 'shadow', enforce: false, casesCount: 0, status: 'rejected', error: err instanceof Error ? err.message : String(err) })
        continue
      }
      if (!loaded.admission.admitted) {
        rejectedIds.push(dirName)
        records.push({ id: dirName, dirName, packageDir, stage: 'shadow', enforce: false, casesCount: loaded.cases.length, status: 'rejected', violations: loaded.admission.violations })
        continue
      }
      const m = loaded.admission.manifest
      if (!isBuiltinDir && RESERVED_BUILTIN_DEPOSIT_IDS.has(m.id) && (registerSeededOssGates || !OSS_SEEDED_GATE_IDS.has(m.id))) {
        rejectedIds.push(m.id)
        records.push({ id: m.id, dirName, packageDir, kind: m.kind, ...(m.point ? { point: m.point } : {}), stage: 'shadow', enforce: false, trust: m.trust, casesCount: loaded.cases.length, status: 'rejected', error: `禁止外部沉淀包覆盖内置保留 ID "${m.id}"`, manifest: m })
        continue
      }
      if (!registerSeededOssGates && isBuiltinDir && OSS_SEEDED_GATE_IDS.has(m.id)) continue
      if (seenIds.has(m.id)) {
        rejectedIds.push(m.id)
        records.push({ id: m.id, dirName, packageDir, kind: m.kind, ...(m.point ? { point: m.point } : {}), stage: 'shadow', enforce: false, trust: m.trust, casesCount: loaded.cases.length, status: 'rejected', error: `重复沉淀 ID "${m.id}"：后扫目录不得覆盖先注册判据`, manifest: m })
        continue
      }
      seenIds.add(m.id)
      const targetStage: Stage = stageOverrides[m.id] ?? m.stage ?? 'shadow'
      if (m.kind === 'counter-rule' && targetStage === 'enforce') {
        rejectedIds.push(m.id)
        records.push({ id: m.id, dirName, packageDir, kind: m.kind, ...(m.point ? { point: m.point } : {}), stage: targetStage, enforce: false, trust: m.trust, casesCount: loaded.cases.length, status: 'rejected', error: '宪法冲突（D5）：counter-rule 严禁覆盖注册为 enforce', manifest: m })
        continue
      }
      let entry: RegistryEntry | undefined
      try { entry = resolveDepositEntry(m) } catch (err) {
        rejectedIds.push(m.id)
        records.push({ id: m.id, dirName, packageDir, kind: m.kind, ...(m.point ? { point: m.point } : {}), stage: targetStage, enforce: false, trust: m.trust, casesCount: loaded.cases.length, status: 'rejected', error: err instanceof Error ? err.message : String(err), manifest: m })
        continue
      }
      if (!entry) {
        records.push({ id: m.id, dirName, packageDir, kind: m.kind, ...(m.point ? { point: m.point } : {}), stage: targetStage, enforce: false, trust: m.trust, casesCount: loaded.cases.length, status: 'unimplemented', manifest: m })
        continue
      }
      const proof = proofs[m.id] ?? registry.getProof(m.id)
      const caseReport = await runDepositCases(entry, loaded.cases, proof ? { proof } : {})
      if (!caseReport.ok || !caseReport.mutationPassed) {
        failedCaseIds.push(m.id)
        records.push({ id: m.id, dirName, packageDir, kind: m.kind, ...(m.point ? { point: m.point } : {}), stage: targetStage, enforce: false, trust: m.trust, casesCount: loaded.cases.length, status: 'failed-cases', caseReport, ...(caseReport.error ? { error: caseReport.error } : {}), manifest: m, entry })
        continue
      }
      const existing = registry.list().find(e => e.id === entry.id)
      const hasOverride = Object.hasOwn(stageOverrides, m.id)
      if (existing && (!hasOverride || existing.stage === targetStage)) {
        const effEnforce = existing.stage === 'enforce' && (entry.kind !== 'gate' || entry.placement.enforce)
        records.push({ id: m.id, dirName, packageDir, kind: m.kind, ...(m.point ? { point: m.point } : {}), ...(m.trigger?.signal ? { signal: m.trigger.signal } : {}), stage: existing.stage, enforce: effEnforce, trust: m.trust, casesCount: loaded.cases.length, status: 'already-registered', caseReport, manifest: m, entry })
        continue
      }
      if (existing) registry.unregister(entry.id)
      registry.register(entry, targetStage)
      registeredIds.push(m.id)
      const effEnforce = targetStage === 'enforce' && (entry.kind !== 'gate' || entry.placement.enforce)
      records.push({ id: m.id, dirName, packageDir, kind: m.kind, ...(m.point ? { point: m.point } : {}), ...(m.trigger?.signal ? { signal: m.trigger.signal } : {}), stage: targetStage, enforce: effEnforce, trust: m.trust, casesCount: loaded.cases.length, status: 'registered', caseReport, manifest: m, entry })
    }
  }
  if (registerSeededOssGates) {
    for (const gate of [issueIntakeGate, reproStatusGate, replyDeskGate] as const) {
      if (registry.list().some(e => e.id === gate.id)) continue
      const stage = stageOverrides[gate.id] ?? 'observe'
      registry.register(gate, stage)
      registeredIds.push(gate.id)
    }
  }
  return { records, registeredIds, rejectedIds, failedCaseIds }
}

/** 安全流转沉淀阶段（守 D5 禁升 counter-rule、enforce 须过红绿+变异与 proof），更新 stageOverrides 与注册表并记入 M0。 */
export async function transitionDepositStage(input: TransitionDepositStageInput): Promise<TransitionDepositStageResult> {
  if (!VALID_STAGES.has(input.toStage)) return { ok: false, code: 'invalid-stage', reason: `非法目标阶段: ${String(input.toStage)}` }
  const existing = input.registry.list().find(e => e.id === input.id)
  const fromStage = existing?.stage ?? 'unregistered'
  const entry = input.entry ?? (input.manifest ? resolveDepositEntry(input.manifest) : undefined)
  if (!entry) return { ok: false, code: 'missing-entry', reason: `缺少条目 "${input.id}" 的可执行实现（须提供 manifest 或 entry）` }
  const isCounter = input.manifest?.kind === 'counter-rule' || (entry.kind === 'gate' && entry.placement.enforce === false)
  if (isCounter && input.toStage === 'enforce') {
    return { ok: false, code: 'constitutional-d5', reason: `宪法冲突（D5）：${input.id} 为非强制提案规则，严禁晋升至 enforce` }
  }
  if (input.toStage === 'enforce' && input.cases) {
    const report = await runDepositCases(entry, input.cases, input.proof ? { proof: input.proof } : {})
    if (!report.ok || !report.mutationPassed) return { ok: false, code: 'cases-failed', reason: report.error || '红绿用例或恒 allow 变异校验未通过' }
  }
  if (entry.kind === 'gate' && entry.proof && input.toStage !== 'shadow' && input.toStage !== 'retired') {
    if (!input.proof && !input.registry.getProof(input.id)) {
      return { ok: false, code: 'missing-proof', reason: `判据 "${input.id}" 要求有效 ProofRecord 方可晋升至 ${input.toStage}` }
    }
  }
  if (existing) input.registry.unregister(input.id)
  input.registry.register(entry, input.toStage)
  const nextOverrides: Record<string, Stage> = { ...input.stageOverrides, [input.id]: input.toStage }
  const nowIso = (input.now ?? (() => new Date()))().toISOString()
  const sourceRef = input.appender?.append({
    id: `deposit:stage:${input.id}:${input.toStage}:${nowIso}`,
    at: nowIso, stream: `deposit:${input.id}`, type: 'deposit.stage_transitioned',
    source: { kind: 'system', ref: input.actor ?? 'governance.deposits' }, evidence: [], taint: 'trusted',
    payload: { depositId: input.id, fromStage, toStage: input.toStage, ...(input.reason ? { reason: input.reason } : {}) },
  })
  return { ok: true, id: input.id, fromStage, toStage: input.toStage, stageOverrides: nextOverrides, ...(sourceRef ? { sourceRef } : {}) }
}

/** 生成只读派生视图 `LEDGER.md`（永不作为真源反向回写），可选安全写出至磁盘路径。 */
export async function renderDepositsLedgerMarkdown(
  records: readonly DiscoveredDepositRecord[],
  options: { readonly outPath?: string; readonly generatedAt?: string } = {},
): Promise<{ readonly markdown: string; readonly writtenPath?: string }> {
  const counts: Record<Stage, number> = { shadow: 0, observe: 0, enforce: 0, retired: 0 }
  for (const r of records) if (r.status === 'registered' || r.status === 'already-registered') counts[r.stage] += 1
  const lines = [
    '# Deposits Ledger（只读派生视图）', '',
    '> 只读派生视图（Read-only derived projection）：由唯一沉淀注册表与红绿准入结果编译生成，严禁手工回写覆盖真源。', '',
    `- 生成时间：${options.generatedAt ?? new Date().toISOString()}`,
    `- 扫描总数：${records.length}（shadow: ${counts.shadow}, observe: ${counts.observe}, enforce: ${counts.enforce}, retired: ${counts.retired}）`, '',
    '| ID | Kind | Point / Signal | Stage | Enforce | Trust | Cases | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...records.map(r => `| \`${r.id}\` | ${r.kind ?? '-'} | ${r.point ?? r.signal ?? '-'} | ${r.stage} | ${r.enforce} | ${r.trust ?? '-'} | ${r.casesCount} | ${r.status} |`),
    '',
  ]
  const markdown = lines.join('\n')
  if (!options.outPath) return { markdown }
  const outAbs = resolve(options.outPath)
  await mkdir(dirname(outAbs), { recursive: true })
  const st = await lstat(outAbs).catch(() => undefined)
  if (st?.isSymbolicLink()) throw new Error(`拒绝写入符号链接 LEDGER.md: ${outAbs}`)
  await writeFile(outAbs, markdown, 'utf8')
  return { markdown, writtenPath: outAbs }
}
