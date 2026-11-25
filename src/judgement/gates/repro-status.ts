import type { GateDef, Verdict } from '../types.ts'

export type ReproTerminalState = 'reproduced' | 'not-reproduced' | 'blocked-needs-info' | 'blocked-needs-env'
export type ReproProposedAction = 'label-only' | 'open-fix-pr' | 'close-issue'

export interface ReproStatusParams {
  readonly require_script_for_reproduced: boolean
  readonly min_red_output_chars: number
}

export const DEFAULT_REPRO_STATUS_PARAMS: ReproStatusParams = Object.freeze({
  require_script_for_reproduced: true,
  min_red_output_chars: 10,
})

export interface ReproStatusCtx {
  readonly terminalState?: ReproTerminalState | string | null
  readonly reproScriptPath?: string | null
  readonly redOutput?: string | null
  readonly matrixTried?: readonly string[] | null
  readonly proposedAction?: ReproProposedAction | string
  readonly humanConfirmedClose?: boolean
  readonly params?: Partial<ReproStatusParams>
}

declare module '../types.ts' {
  interface PointCatalog {
    'verify.repro-evidence': ReproStatusCtx
  }
}

const VALID_TERMINAL_STATES = new Set<string>(['reproduced', 'not-reproduced', 'blocked-needs-info', 'blocked-needs-env'])
const VALID_ACTIONS = new Set<string>(['label-only', 'open-fix-pr', 'close-issue'])

function validateParams(p: ReproStatusParams): string | undefined {
  if (typeof p.require_script_for_reproduced !== 'boolean') {
    return `参数 require_script_for_reproduced=${String(p.require_script_for_reproduced)} 必须为布尔值`
  }
  if (!Number.isFinite(p.min_red_output_chars) || p.min_red_output_chars < 1 || p.min_red_output_chars > 500) {
    return `参数 min_red_output_chars=${String(p.min_red_output_chars)} 超出允许范围 [1, 500]`
  }
  return undefined
}

/** 校验复现四终态证据链，严禁 not-reproduced 假阴性单独触发关单或无红输出开修复 PR。 */
export function evaluateReproStatus(
  ctx: ReproStatusCtx,
  boundParams?: Partial<ReproStatusParams>,
): Verdict {
  const p: ReproStatusParams = { ...DEFAULT_REPRO_STATUS_PARAMS, ...ctx.params, ...boundParams }
  const paramErr = validateParams(p)
  if (paramErr) return { kind: 'deny', blockers: [paramErr] }

  if (ctx.terminalState === undefined || ctx.terminalState === null || (typeof ctx.terminalState === 'string' && ctx.terminalState.trim() === '')) {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少复现终态 terminalState' }
  }
  if (typeof ctx.terminalState !== 'string' || !VALID_TERMINAL_STATES.has(ctx.terminalState)) {
    return {
      kind: 'deny',
      blockers: [`非法复现终态 "${String(ctx.terminalState)}"，必须为 reproduced | not-reproduced | blocked-needs-info | blocked-needs-env`],
    }
  }
  if (ctx.proposedAction !== undefined && !VALID_ACTIONS.has(ctx.proposedAction)) {
    return { kind: 'deny', blockers: [`未知复现后继动作 "${String(ctx.proposedAction)}"`] }
  }

  if (ctx.matrixTried !== undefined && ctx.matrixTried !== null && !Array.isArray(ctx.matrixTried)) {
    return { kind: 'deny', blockers: ['matrixTried 必须为字符串数组'] }
  }

  const blockers: string[] = []
  const matrix = Array.isArray(ctx.matrixTried)
    ? ctx.matrixTried.map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
    : []

  if (ctx.terminalState === 'not-reproduced') {
    if (ctx.proposedAction === 'close-issue' && ctx.humanConfirmedClose !== true) {
      blockers.push('not-reproduced 禁关铁律：复现假阴性严禁未经人工确认单独触发关单')
    }
    if (matrix.length === 0) {
      blockers.push('not-reproduced 终态必须携带非空 matrixTried 声明已测试的环境矩阵范围')
    }
  } else if (
    (ctx.terminalState === 'blocked-needs-info' || ctx.terminalState === 'blocked-needs-env') &&
    ctx.proposedAction === 'close-issue' &&
    ctx.humanConfirmedClose !== true
  ) {
    blockers.push(`${ctx.terminalState} 未经人工确认严禁触发关单`)
  }

  if (ctx.terminalState === 'reproduced') {
    const script = typeof ctx.reproScriptPath === 'string' ? ctx.reproScriptPath.trim() : ''
    const redLen = typeof ctx.redOutput === 'string' ? ctx.redOutput.trim().length : 0
    if (p.require_script_for_reproduced && script === '') {
      blockers.push('reproduced 终态缺少落盘复现脚本路径 reproScriptPath')
    }
    if (redLen < p.min_red_output_chars) {
      blockers.push(`reproduced 终态红灯输出长度(${redLen})不足最小阈值 ${p.min_red_output_chars}`)
    }
  }

  if (ctx.proposedAction === 'open-fix-pr' && ctx.terminalState !== 'reproduced') {
    blockers.push(`仅 reproduced 终态允许发起修复 PR（当前终态为 ${ctx.terminalState}）`)
  }

  if (blockers.length > 0) return { kind: 'deny', blockers: blockers as [string, ...string[]] }
  return {
    kind: 'allow',
    produced: {
      terminalState: ctx.terminalState,
      action: ctx.proposedAction ?? 'label-only',
      ...(matrix.length > 0 ? { matrixTried: matrix } : {}),
    },
  }
}

export function createReproStatusGate(boundParams?: Partial<ReproStatusParams>): GateDef<'verify.repro-evidence'> {
  return {
    kind: 'gate',
    id: 'verify.repro-evidence',
    version: 1,
    point: 'verify.repro-evidence',
    description: '复现四终态与脚本红灯证据硬门，拦截 not-reproduced 假阴性误关单',
    side: 'hard',
    placement: { timing: 'pre', enforce: true },
    requires: ['terminalState'],
    gate: ctx => evaluateReproStatus(ctx, boundParams),
  }
}

export const reproStatusGate: GateDef<'verify.repro-evidence'> = createReproStatusGate()
