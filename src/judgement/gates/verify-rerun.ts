import type { GateDef, Verdict } from '../types.ts'

export interface RerunRecord {
  readonly command: string
  readonly exitCode: number | null
  readonly verifierRole: string
  readonly timedOut?: boolean
  readonly aborted?: boolean
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

declare module '../types.ts' {
  interface PointCatalog {
    'verify.rerun': VerifyRerunCtx
  }
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
