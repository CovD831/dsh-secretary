import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { GateDef, Verdict } from '../types.ts'

export interface RerunRecord {
  readonly command: string
  readonly exitCode: number | null
  readonly verifierRole: string
  readonly timedOut?: boolean
  readonly aborted?: boolean
  readonly noSandbox?: boolean
}

export interface RedGreenRecord {
  readonly command: string
  readonly exitCodeWithoutFix: number | null
  readonly exitCodeWithFix: number | null
  readonly verifierRole: string
}

export interface VerifyRerunParams {
  readonly require_red_green: boolean
  readonly require_independent_verifier: boolean
}

export const DEFAULT_VERIFY_RERUN_PARAMS: VerifyRerunParams = Object.freeze({
  require_red_green: true,
  require_independent_verifier: true,
})

export interface VerifyRerunCtx {
  readonly taskType: 'feature' | 'fix' | 'refactor' | 'docs' | string
  readonly builderRole: string
  readonly claimedDone: boolean
  readonly rerun?: RerunRecord | null
  readonly redGreen?: RedGreenRecord | null
  readonly params?: Partial<VerifyRerunParams>
}

export interface VerifyCommandResult {
  readonly command: string
  readonly exitCode: number | null
  readonly durationMs: number
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly stdoutSha256: string
  readonly stdoutTail: string
  readonly stderrTail: string
}

export interface ExecuteVerifyRerunOptions {
  readonly ticketId?: string
  readonly revision?: string | number
  readonly taskType?: string
  readonly builderRole?: string
  readonly verifierRole?: string
  readonly timeoutMs?: number
  readonly maxCommands?: number
  readonly signal?: AbortSignal
  readonly cache?: Map<string, ExecuteVerifyRerunReport>
  readonly runCommand?: (command: string, cwd: string, opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<{
    exitCode: number | null
    timedOut?: boolean
    aborted?: boolean
    noSandbox?: boolean
    stdout?: string
    stderr?: string
  }>
  readonly redGreen?: RedGreenRecord | null
  readonly params?: Partial<VerifyRerunParams>
}

export interface ExecuteVerifyRerunReport {
  readonly ctx: VerifyRerunCtx
  readonly verdict: Verdict
  readonly cached: boolean
  readonly cmdHash: string
  readonly cacheKey?: string
  readonly results: readonly VerifyCommandResult[]
}

declare module '../types.ts' {
  interface PointCatalog {
    'verify.rerun': VerifyRerunCtx
  }
}

const DEFAULT_RERUN_CACHE = new Map<string, ExecuteVerifyRerunReport>()
const MAX_CACHE_ENTRIES = 500
const VERIFY_BLOCK_RE = /```verify\s*\r?\n([\s\S]*?)```/g

/** 从 assignment/acceptance 文本的 ```` ```verify ```` 代码块中提取可执行验证命令列表。 */
export function extractVerifyCommandsFromText(text?: string): string[] {
  if (!text) return []
  const cmds: string[] = []
  VERIFY_BLOCK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = VERIFY_BLOCK_RE.exec(text)) !== null) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed !== '') cmds.push(trimmed)
    }
  }
  return cmds
}

/** 反自报完成核证硬门：强制独立方重跑通过，且 fix 类任务须附撤修复红灯记录。 */
export function evaluateVerifyRerun(
  ctx: VerifyRerunCtx,
  boundParams?: Partial<VerifyRerunParams>,
): Verdict {
  const p: VerifyRerunParams = { ...DEFAULT_VERIFY_RERUN_PARAMS, ...ctx.params, ...boundParams }
  if (!ctx.claimedDone) {
    return { kind: 'allow', produced: { status: 'not-claiming-done' } }
  }
  const builder = ctx.builderRole.trim()
  if (builder === '') {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少实现方角色 builderRole' }
  }

  const rerun = ctx.rerun
  if (!rerun) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: '缺少独立重跑验证记录 rerun' }
  }
  if (typeof rerun.command !== 'string' || rerun.command.trim() === '') {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: '重跑记录缺少有效 command' }
  }
  if (rerun.noSandbox) {
    return { kind: 'unmeasured', cause: 'no-sandbox', detail: '缺少受沙箱约束的会话 shell 执行器（ctx.shell + sandboxPolicy），禁止在宿主进程裸跑命令' }
  }
  if (rerun.timedOut || rerun.aborted) {
    return { kind: 'unmeasured', cause: 'timeout', detail: `验证命令 "${rerun.command}" 超时或被中止` }
  }
  const verifier = rerun.verifierRole.trim()
  if (verifier === '') {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: '重跑记录缺少 verifierRole' }
  }
  if (p.require_independent_verifier && verifier === builder) {
    return { kind: 'deny', blockers: [`禁止自报自验：验证方 "${verifier}" 与实现方 "${builder}" 角色相同`] }
  }
  if (typeof rerun.exitCode !== 'number' || !Number.isInteger(rerun.exitCode)) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: `验证命令 "${rerun.command}" 缺少有效整数退出码` }
  }
  if (rerun.exitCode !== 0) {
    return { kind: 'deny', blockers: [`独立重跑命令 "${rerun.command}" 失败，退出码 ${rerun.exitCode}`] }
  }

  if (ctx.taskType === 'fix' && p.require_red_green) {
    const rg = ctx.redGreen
    if (!rg) {
      return { kind: 'unmeasured', cause: 'no-evidence', detail: 'fix 类任务须附带撤修复红灯记录 redGreen' }
    }
    if (typeof rg.command !== 'string' || rg.command.trim() === '') {
      return { kind: 'unmeasured', cause: 'no-evidence', detail: 'redGreen 记录缺少有效 command' }
    }
    const rgVerifier = rg.verifierRole.trim()
    if (rgVerifier === '') {
      return { kind: 'unmeasured', cause: 'no-evidence', detail: 'redGreen 记录缺少 verifierRole' }
    }
    if (p.require_independent_verifier && rgVerifier === builder) {
      return { kind: 'deny', blockers: [`禁止自报自验：红绿验证方 "${rgVerifier}" 与实现方 "${builder}" 角色相同`] }
    }
    if (!Number.isInteger(rg.exitCodeWithoutFix) || !Number.isInteger(rg.exitCodeWithFix)) {
      return { kind: 'unmeasured', cause: 'no-evidence', detail: 'redGreen 记录缺少有效的整数撤修复/含修复退出码' }
    }
    if (rg.exitCodeWithoutFix === 0) {
      return { kind: 'deny', blockers: [`fix 任务红绿核证失败：撤去修复后 "${rg.command}" 仍返回 0，未证明覆盖缺陷`] }
    }
    if (rg.exitCodeWithFix !== 0) {
      return { kind: 'deny', blockers: [`fix 任务红绿核证失败：合入修复后 "${rg.command}" 返回 ${rg.exitCodeWithFix}`] }
    }
  }

  return {
    kind: 'allow',
    produced: {
      verifiedBy: verifier,
      command: rerun.command,
      exitCode: 0,
      ...(ctx.taskType === 'fix' && p.require_red_green ? { redGreenVerified: true } : {}),
    },
  }
}

/** 受控重跑验证命令集（支持超时、`ticketId+revision+cmdHash` 幂等缓存、SHA-256 摘要，要求显式提供会话沙箱 runner），并交由 `verifyRerunGate` 裁决。 */
export async function executeVerifyRerunCommands(
  commands: readonly string[],
  cwd: string,
  options: ExecuteVerifyRerunOptions = {},
): Promise<ExecuteVerifyRerunReport> {
  const normalized = commands.map(c => c.trim()).filter(Boolean)
  const cmdHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16)
  const cacheKey = options.ticketId !== undefined ? `${options.ticketId}:${String(options.revision ?? 0)}:${cmdHash}` : undefined
  const storeKey = cacheKey ? `${resolve(cwd || '.')}|${cacheKey}` : undefined
  const cache = options.cache ?? DEFAULT_RERUN_CACHE
  if (storeKey) {
    const hit = cache.get(storeKey)
    if (hit && hit.verdict.kind === 'allow') return { ...hit, cached: true }
  }

  const builderRole = options.builderRole ?? 'worker'
  const verifierRole = options.verifierRole ?? 'verifier'
  const taskType = options.taskType ?? 'feature'
  const baseCtx = (rerun: RerunRecord | null): VerifyRerunCtx => ({
    taskType, builderRole, claimedDone: true, rerun,
    ...(options.redGreen !== undefined ? { redGreen: options.redGreen } : {}),
    ...(options.params ? { params: options.params } : {}),
  })
  const finalize = (ctx: VerifyRerunCtx, results: VerifyCommandResult[]): ExecuteVerifyRerunReport => {
    const verdict = evaluateVerifyRerun(ctx, options.params)
    const report: ExecuteVerifyRerunReport = { ctx, verdict, cached: false, cmdHash, ...(cacheKey ? { cacheKey } : {}), results }
    if (storeKey && verdict.kind === 'allow') {
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(storeKey, report)
    }
    return report
  }

  const maxCmds = options.maxCommands ?? 10
  if (normalized.length === 0 || normalized.length > maxCmds) {
    return finalize(baseCtx(null), [])
  }
  const cwdOk = await stat(cwd).then(s => s.isDirectory(), () => false)
  if (!cwdOk) {
    return finalize(baseCtx(null), [])
  }
  if (!options.runCommand) {
    return finalize(baseCtx({ command: normalized[0]!, exitCode: null, verifierRole, noSandbox: true }), [])
  }

  const timeoutMs = Math.min(Math.max(1000, options.timeoutMs ?? 120_000), 600_000)
  const runner = options.runCommand
  const results: VerifyCommandResult[] = []
  let finalRerun: RerunRecord = { command: normalized.join(' && '), exitCode: 0, verifierRole }

  for (const command of normalized) {
    const started = Date.now()
    const raw = await runner(command, cwd, { timeoutMs, ...(options.signal ? { signal: options.signal } : {}) })
    const stdout = raw.stdout ?? ''
    const stderr = raw.stderr ?? ''
    const timedOut = Boolean(raw.timedOut)
    const aborted = Boolean(raw.aborted)
    const noSandbox = Boolean(raw.noSandbox)
    results.push({
      command, exitCode: raw.exitCode, durationMs: Date.now() - started, timedOut, aborted,
      stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
      stdoutTail: stdout.slice(-500), stderrTail: stderr.slice(-500),
    })
    if (noSandbox || timedOut || aborted || raw.exitCode === null || raw.exitCode !== 0) {
      finalRerun = {
        command, exitCode: raw.exitCode, verifierRole,
        ...(timedOut ? { timedOut: true } : {}), ...(aborted ? { aborted: true } : {}), ...(noSandbox ? { noSandbox: true } : {}),
      }
      break
    }
  }
  return finalize(baseCtx(finalRerun), results)
}

export function createVerifyRerunGate(boundParams?: Partial<VerifyRerunParams>): GateDef<'verify.rerun'> {
  return {
    kind: 'gate',
    id: 'verify.rerun',
    version: 1,
    point: 'verify.rerun',
    description: '工人声称完成时要求独立方重跑验证，fix 任务另需撤修复红灯证据',
    side: 'hard',
    placement: { timing: 'pre', enforce: true },
    requires: ['taskType', 'builderRole', 'claimedDone'],
    gate: ctx => evaluateVerifyRerun(ctx, boundParams),
  }
}

export const verifyRerunGate: GateDef<'verify.rerun'> = createVerifyRerunGate()
