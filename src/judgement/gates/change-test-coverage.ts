import type { GateDef, Verdict } from '../types.ts'

export interface ChangeTestCoverageParams {
  readonly min_changed_code_lines: number
  readonly exempt_task_types: string
}

export const DEFAULT_CHANGE_TEST_COVERAGE_PARAMS: ChangeTestCoverageParams = Object.freeze({
  min_changed_code_lines: 30,
  exempt_task_types: 'docs',
})

export interface ChangeTestCoverageCtx {
  readonly taskType?: string
  readonly codeChangedPaths?: readonly string[] | null
  readonly testChangedPaths?: readonly string[] | null
  readonly changedCodeLines?: number | null
  readonly params?: Partial<ChangeTestCoverageParams>
}

declare module '../types.ts' {
  interface PointCatalog {
    'verify.change-test-coverage': ChangeTestCoverageCtx
  }
}

/** 变更测试伴随门：当非文档/非测试业务代码净变动达阈值且 0 个测试文件变更时报警/拦截。 */
export function evaluateChangeTestCoverage(
  ctx: ChangeTestCoverageCtx,
  boundParams?: Partial<ChangeTestCoverageParams>,
): Verdict {
  const p: ChangeTestCoverageParams = { ...DEFAULT_CHANGE_TEST_COVERAGE_PARAMS, ...ctx.params, ...boundParams }
  if (!Number.isFinite(p.min_changed_code_lines) || p.min_changed_code_lines < 1 || p.min_changed_code_lines > 500) {
    return { kind: 'deny', blockers: [`参数 min_changed_code_lines=${String(p.min_changed_code_lines)} 超出允许范围 [1, 500]`] }
  }
  if (ctx.codeChangedPaths === undefined || ctx.codeChangedPaths === null || ctx.testChangedPaths === undefined || ctx.testChangedPaths === null) {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少 codeChangedPaths 或 testChangedPaths 输入' }
  }
  if (ctx.codeChangedPaths.length === 0) {
    return { kind: 'allow', produced: { skipped: 'no-code-changes' } }
  }
  const exemptSet = new Set(String(p.exempt_task_types ?? '').split(',').map(s => s.trim()).filter(Boolean))
  if (ctx.taskType && exemptSet.has(ctx.taskType)) {
    return { kind: 'allow', produced: { skipped: 'exempt-task-type', taskType: ctx.taskType } }
  }
  if (ctx.testChangedPaths.length > 0) {
    return { kind: 'allow', produced: { tested: true, testFiles: ctx.testChangedPaths.length } }
  }
  if (typeof ctx.changedCodeLines !== 'number' || !Number.isFinite(ctx.changedCodeLines) || ctx.changedCodeLines < 0) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: '缺少有效的改动代码行数统计 changedCodeLines' }
  }
  if (ctx.changedCodeLines >= p.min_changed_code_lines) {
    return {
      kind: 'deny',
      blockers: [`变更实质业务代码 ${ctx.changedCodeLines} 行（>= ${p.min_changed_code_lines}）但未同步增改任何测试文件`],
    }
  }
  return { kind: 'allow', produced: { belowThreshold: true, changedCodeLines: ctx.changedCodeLines } }
}

export function createChangeTestCoverageGate(boundParams?: Partial<ChangeTestCoverageParams>): GateDef<'verify.change-test-coverage'> {
  return {
    kind: 'gate',
    id: 'verify.change-test-coverage',
    version: 1,
    point: 'verify.change-test-coverage',
    description: '当实质代码改动达到行数阈值且无伴随测试变更时提醒/拦截，防范未测试功能合入',
    side: 'soft',
    placement: { timing: 'pre', enforce: true },
    requires: ['codeChangedPaths', 'testChangedPaths'],
    gate: ctx => evaluateChangeTestCoverage(ctx, boundParams),
  }
}

export const verifyChangeTestCoverageGate: GateDef<'verify.change-test-coverage'> = createChangeTestCoverageGate()