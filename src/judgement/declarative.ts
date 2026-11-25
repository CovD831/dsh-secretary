import { confidenceOf } from '../rsi/evaluator.ts'
import { auditRequires, readPath } from './requires.ts'
import {
  ISOLATION_CEILINGS,
  type ActionClass, type ActionName, type AnyGateDef, type AnyStandingOrderDef,
  type CommandCheckConfig, type DeclarativeRule, type DeclarativeRuleIssue, type DepositManifest,
  type EvaluationReading, type EvaluatorDef, type MandateBinding, type ParamSpec, type PathRulesConfig,
  type Point, type PredicateOp, type PredicatesConfig, type RegistryEntry, type SignalName, type Verdict,
  type WorkflowSopConfig,
} from './types.ts'

export type { CommandCheckConfig, DeclarativeRule, DeclarativeRuleIssue, PathRulesConfig, PredicateClause, PredicateOp, PredicatesConfig, WorkflowSopConfig, WorkflowSopStep } from './types.ts'

export const GOVERNED_SIGNALS: ReadonlySet<string> = new Set<SignalName>(['ticket.stale', 'friction.repeated', 'verify.failed', 'ci.replay_completed'])
export const GOVERNED_ACTIONS: ReadonlySet<string> = new Set<ActionName>(['proposal.create', 'defect.record', 'rule-defect.record', 'ticket.remind', 'ticket.escalate', 'ticket.tag'])
const VALID_OPS = new Set<PredicateOp>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'matches', 'non_empty'])
const FORBIDDEN_RULE_KEYS = new Set(['shell', 'command', 'exec', 'bash', 'pwsh', 'script', 'eval', 'code'])
const SAFE_PATH_RE = /^[a-zA-Z0-9_.-]+(?:\.[a-zA-Z0-9_.-]+)*$/
const COUNTER_ACTION_RE = /^(?:propose|(?:proposal|defect|rule-defect)\.[a-z0-9-]+)$/
const ATTACHED_EVALUATORS = new WeakMap<object, (ctx: unknown) => Verdict | Promise<Verdict>>()
const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim() !== '')

function globToRegex(glob: string): RegExp {
  const body = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\0DS\0').replace(/\*\*/g, '\0DD\0')
    .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0DS\0/g, '(?:.*/)?').replace(/\0DD\0/g, '.*')
  return new RegExp(`^${body}$`)
}

function normalizePath(raw: string): { ok: true; path: string } | { ok: false; reason: string } {
  const s = raw.trim().replace(/\\/g, '/')
  if (!s) return { ok: false, reason: '路径为空' }
  if (s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:/.test(s)) return { ok: false, reason: `禁止绝对或主目录路径 "${raw}"` }
  const segs = s.split('/').filter(p => p !== '' && p !== '.')
  if (segs.some(p => p === '..')) return { ok: false, reason: `禁止上级穿越 ".." 路径 "${raw}"` }
  const norm = segs.join('/')
  return norm ? { ok: true, path: norm } : { ok: false, reason: `路径规范化后为空 "${raw}"` }
}

function safeRegex(pattern: string): RegExp | undefined {
  if (pattern.length === 0 || pattern.length > 256) return undefined
  try { return new RegExp(pattern) } catch { return undefined }
}

/** 校验零代码声明式规则积木（path_rules / command_check / predicates / workflow_sop），拦截任意 shell 注入与非法操作符。 */
export function validateDeclarativeRule(raw: unknown): DeclarativeRuleIssue[] {
  const issues: DeclarativeRuleIssue[] = []
  const push = (field: string, reason: string) => issues.push({ field, reason })
  if (!isRec(raw)) return [{ field: 'rule', reason: 'rule 必须为对象' }]
  for (const k of Object.keys(raw)) if (FORBIDDEN_RULE_KEYS.has(k)) push(`rule.${k}`, `禁止零代码规则声明可执行字段 "${k}"`)
  const kind = raw['kind']
  if (kind === 'path_rules') {
    for (const key of ['forbiddenGlobs', 'allowedPrefixes'] as const) if (raw[key] !== undefined && !isStrArr(raw[key])) push(`rule.${key}`, `${key} 必须为非空字符串数组`)
    if (raw['maxChangedFiles'] !== undefined && (typeof raw['maxChangedFiles'] !== 'number' || !Number.isInteger(raw['maxChangedFiles']) || raw['maxChangedFiles'] <= 0)) push('rule.maxChangedFiles', 'maxChangedFiles 必须为正整数')
  } else if (kind === 'command_check') {
    if (raw['requiredCommands'] !== undefined && !isStrArr(raw['requiredCommands'])) push('rule.requiredCommands', 'requiredCommands 必须为非空字符串数组')
    if (raw['forbidPatterns'] !== undefined && (!Array.isArray(raw['forbidPatterns']) || raw['forbidPatterns'].some(p => typeof p !== 'string' || !safeRegex(p)))) push('rule.forbidPatterns', 'forbidPatterns 需合法正则字符串数组')
  } else if (kind === 'predicates') {
    if (!Array.isArray(raw['clauses']) || raw['clauses'].length === 0) return [...issues, { field: 'rule.clauses', reason: 'predicates 至少需 1 条 clause' }]
    if (raw['mode'] !== undefined && raw['mode'] !== 'all' && raw['mode'] !== 'any') push('rule.mode', 'mode 仅允许 all | any')
    raw['clauses'].forEach((c, i) => {
      if (!isRec(c)) { push(`rule.clauses[${i}]`, 'clause 必须为对象'); return }
      if (typeof c['path'] !== 'string' || !SAFE_PATH_RE.test(c['path']) || c['path'].includes('..')) push(`rule.clauses[${i}].path`, '路径格式非法')
      if (typeof c['op'] !== 'string' || !VALID_OPS.has(c['op'] as PredicateOp)) push(`rule.clauses[${i}].op`, `未知操作符 "${String(c['op'])}"`)
      if (c['op'] === 'matches' && c['param'] === undefined && (typeof c['value'] !== 'string' || !safeRegex(c['value']))) push(`rule.clauses[${i}].value`, 'matches 需合法正则字符串 (<=256 字符)')
      if (c['op'] === 'in' && c['param'] === undefined && !Array.isArray(c['value'])) push(`rule.clauses[${i}].value`, 'in 需数组 value')
    })
  } else if (kind === 'workflow_sop') {
    if (!Array.isArray(raw['steps']) || raw['steps'].length === 0) push('rule.steps', 'workflow_sop 至少需 1 个检查步骤')
    else raw['steps'].forEach((s, i) => { if (!isRec(s) || typeof s['id'] !== 'string' || !s['id'].trim()) push(`rule.steps[${i}].id`, 'SOP 步骤缺少非空 id') })
    if (raw['signal'] !== undefined && (typeof raw['signal'] !== 'string' || !GOVERNED_SIGNALS.has(raw['signal']))) push('rule.signal', '信号不在受治理 SignalCatalog 内')
    if (raw['action'] !== undefined && (!isRec(raw['action']) || typeof raw['action']['name'] !== 'string' || !GOVERNED_ACTIONS.has(raw['action']['name']))) push('rule.action.name', '动作不在受治理 ActionCatalog 内')
  } else push('rule.kind', `未知零代码积木 "${String(kind)}"`)
  return issues
}

function defaultParamsOf(specs?: Readonly<Record<string, ParamSpec>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, s] of Object.entries(specs ?? {})) if (s && typeof s === 'object' && 'default' in s && s.default !== undefined) out[k] = s.default
  return out
}

function evalPathRules(rule: PathRulesConfig, ctx: unknown, params: Record<string, unknown>): Verdict {
  const field = rule.inputField ?? 'changedPaths', raw = readPath(ctx, field)
  if (raw === undefined || raw === null) return { kind: 'unmeasured', cause: 'missing-input', detail: `缺少路径列表字段 "${field}"` }
  if (!Array.isArray(raw)) return { kind: 'deny', blockers: [`路径字段 "${field}" 必须为字符串数组`] }
  const blockers: string[] = [], normPaths: string[] = []
  const forbids = (rule.forbiddenGlobs ?? []).map(g => ({ g, re: globToRegex(g) }))
  const prefixes = (rule.allowedPrefixes ?? []).map(p => p.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
  for (const item of raw) {
    if (typeof item !== 'string') { blockers.push(`路径项非字符串: ${String(item)}`); continue }
    const norm = rule.rejectTraversal === false ? { ok: true as const, path: item.trim().replace(/\\/g, '/') } : normalizePath(item)
    if (!norm.ok) { blockers.push(norm.reason); continue }
    normPaths.push(norm.path)
    const hit = forbids.find(m => m.re.test(norm.path))
    if (hit) blockers.push(`命中禁止路径 (${hit.g}): ${norm.path}`)
    if (prefixes.length > 0 && !prefixes.some(pre => norm.path === pre.replace(/\/$/, '') || norm.path.startsWith(pre))) {
      blockers.push(`路径 "${norm.path}" 越出允许前缀 [${prefixes.join(', ')}]`)
    }
  }
  const maxKey = rule.maxChangedFilesParam ?? 'max_changed_files'
  const maxFiles = typeof params[maxKey] === 'number' ? (params[maxKey] as number) : rule.maxChangedFiles
  if (typeof maxFiles === 'number' && Number.isFinite(maxFiles) && raw.length > maxFiles) blockers.push(`变更文件数 (${raw.length}) 超过上限 (${maxFiles})`)
  return blockers.length > 0 ? { kind: 'deny', blockers: blockers as [string, ...string[]] } : { kind: 'allow', produced: { checkedCount: normPaths.length } }
}

function evalCommandCheck(rule: CommandCheckConfig, ctx: unknown): Verdict {
  const field = rule.inputField ?? 'commands', raw = readPath(ctx, field)
  if (raw === undefined || raw === null) return { kind: 'unmeasured', cause: 'missing-input', detail: `缺少命令记录字段 "${field}"` }
  const list = Array.isArray(raw) ? raw : (isRec(raw) || typeof raw === 'string' ? [raw] : undefined)
  if (!list) return { kind: 'deny', blockers: [`命令字段 "${field}" 格式非法`] }
  if (list.length === 0 && !(rule.requiredCommands?.length)) return { kind: 'unmeasured', cause: 'no-evidence', detail: '命令执行记录为空' }
  const blockers: string[] = [], cmds: string[] = []
  const forbids = (rule.forbidPatterns ?? []).map(p => ({ p, re: safeRegex(p) }))
  for (const entry of list) {
    const cmd = typeof entry === 'string' ? entry.trim() : (isRec(entry) && typeof entry['command'] === 'string' ? entry['command'].trim() : '')
    if (!cmd) return { kind: 'unmeasured', cause: 'no-evidence', detail: '存在空命令记录' }
    cmds.push(cmd)
    for (const f of forbids) if (f.re?.test(cmd) || cmd.includes(f.p)) blockers.push(`命中禁止命令模式 "${f.p}": ${cmd}`)
    if (isRec(entry)) {
      if (entry['timedOut'] === true || entry['aborted'] === true) return { kind: 'unmeasured', cause: 'timeout', detail: `命令 "${cmd}" 超时或中止` }
      if (rule.requireExitZero !== false) {
        const code = entry['exitCode']
        if (typeof code !== 'number' || !Number.isInteger(code)) return { kind: 'unmeasured', cause: 'no-evidence', detail: `命令 "${cmd}" 缺少整数退出码` }
        if (code !== 0) blockers.push(`命令 "${cmd}" 退出码非零 (${code})`)
      }
    } else if (rule.requireExitZero === true) return { kind: 'unmeasured', cause: 'no-evidence', detail: `命令 "${cmd}" 缺少退出码观测` }
  }
  for (const req of rule.requiredCommands ?? []) if (!cmds.some(c => c === req || c.includes(req))) blockers.push(`缺少必需验证命令: ${req}`)
  return blockers.length > 0 ? { kind: 'deny', blockers: blockers as [string, ...string[]] } : { kind: 'allow', produced: { checkedCommands: cmds } }
}

function evalClause(val: unknown, op: PredicateOp, rhs: unknown): boolean {
  if (op === 'eq') return val === rhs
  if (op === 'neq') return val !== rhs
  if (op === 'gt') return typeof val === 'number' && typeof rhs === 'number' && val > rhs
  if (op === 'gte') return typeof val === 'number' && typeof rhs === 'number' && val >= rhs
  if (op === 'lt') return typeof val === 'number' && typeof rhs === 'number' && val < rhs
  if (op === 'lte') return typeof val === 'number' && typeof rhs === 'number' && val <= rhs
  if (op === 'in') return Array.isArray(rhs) && rhs.includes(val)
  if (op === 'matches') return typeof val === 'string' && typeof rhs === 'string' && Boolean(safeRegex(rhs)?.test(val))
  if (typeof val === 'string') return val.trim().length > 0
  return Array.isArray(val) ? val.length > 0 : isRec(val) ? Object.keys(val).length > 0 : val !== undefined && val !== null
}

function evalPredicates(rule: PredicatesConfig, ctx: unknown, params: Record<string, unknown>): Verdict {
  const missing: string[] = [], evaluated: { passed: boolean; msg: string }[] = []
  for (const c of rule.clauses) {
    const val = readPath(ctx, c.path), numeric = c.op === 'gt' || c.op === 'gte' || c.op === 'lt' || c.op === 'lte'
    if (c.required !== false && (val === undefined || val === null || (numeric && (typeof val !== 'number' || !Number.isFinite(val))))) {
      missing.push(c.path); continue
    }
    const rhs = c.param !== undefined && Object.hasOwn(params, c.param) ? params[c.param] : c.value
    const passed = val !== undefined && val !== null && evalClause(val, c.op, rhs)
    evaluated.push({ passed, msg: c.message ?? `路径 "${c.path}" 未满足 ${c.op} ${JSON.stringify(rhs)}` })
  }
  if (missing.length > 0) return { kind: 'unmeasured', cause: 'missing-input', detail: `缺少必需上下文路径: ${missing.join(', ')}` }
  const rawPass = rule.mode === 'any' ? evaluated.some(e => e.passed) : evaluated.every(e => e.passed)
  if (rule.invert ? !rawPass : rawPass) return { kind: 'allow', produced: { matchedClauses: evaluated.length } }
  const blockers = evaluated.filter(e => (rule.invert ? e.passed : !e.passed)).map(e => e.msg)
  return { kind: 'deny', blockers: (blockers.length > 0 ? blockers : ['断言组合未通过']) as [string, ...string[]] }
}

function evalWorkflowSop(rule: WorkflowSopConfig, ctx: unknown): Verdict {
  const blockers: string[] = []
  let doneSet: Set<string> | undefined
  if (rule.checklistField) {
    const rawList = readPath(ctx, rule.checklistField)
    if (rawList === undefined || rawList === null) return { kind: 'unmeasured', cause: 'missing-input', detail: `缺少 SOP 检查清单字段 "${rule.checklistField}"` }
    if (!Array.isArray(rawList)) return { kind: 'deny', blockers: [`SOP 检查清单 "${rule.checklistField}" 必须为数组`] }
    doneSet = new Set(rawList.filter((v): v is string => typeof v === 'string'))
  }
  for (const s of rule.steps) {
    if (s.requiredField) {
      const v = readPath(ctx, s.requiredField)
      if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return { kind: 'unmeasured', cause: 'missing-input', detail: `SOP 步骤 "${s.id}" 缺少输入 "${s.requiredField}"` }
    }
    if (s.mustBeTrueField) {
      const b = readPath(ctx, s.mustBeTrueField)
      if (b === undefined || b === null) return { kind: 'unmeasured', cause: 'missing-input', detail: `SOP 步骤 "${s.id}" 缺少字段 "${s.mustBeTrueField}"` }
      if (b !== true) blockers.push(s.message ?? `SOP 检查项 "${s.id}" 未满足`)
    }
    if (doneSet && !doneSet.has(s.id)) blockers.push(s.message ?? `SOP 步骤 "${s.id}" 尚未完成`)
  }
  return blockers.length > 0 ? { kind: 'deny', blockers: blockers as [string, ...string[]] }
    : { kind: 'allow', produced: { completedSteps: rule.steps.map(s => s.id), ...(rule.action ? { action: rule.action } : {}) } }
}

/** 编译单条零代码积木为纯确定性三态判据函数（allow / deny / unmeasured）。 */
export function compileDeclarativeRuleFn(rule: DeclarativeRule, paramSpecs?: Readonly<Record<string, ParamSpec>>, boundOverrides?: Record<string, unknown>): (ctx: unknown) => Verdict {
  const issues = validateDeclarativeRule(rule)
  if (issues.length > 0) throw new Error(`零代码规则校验失败：${issues.map(i => `${i.field}: ${i.reason}`).join('; ')}`)
  const defaults = defaultParamsOf(paramSpecs)
  return ctx => {
    const params = { ...defaults, ...(isRec(ctx) && isRec(ctx['params']) ? ctx['params'] : {}), ...boundOverrides }
    if (rule.kind === 'path_rules') return evalPathRules(rule, ctx, params)
    if (rule.kind === 'command_check') return evalCommandCheck(rule, ctx)
    if (rule.kind === 'predicates') return evalPredicates(rule, ctx, params)
    return evalWorkflowSop(rule, ctx)
  }
}

function buildStandingOrderEvaluator(order: AnyStandingOrderDef, ruleFn?: (ctx: unknown) => Verdict, requires: readonly string[] = []): (ctx: unknown) => Verdict {
  return ctx => {
    if (!isRec(ctx)) return { kind: 'unmeasured', cause: 'missing-input', detail: 'standing-order 上下文缺失' }
    if ('signal' in ctx && (typeof ctx['signal'] !== 'string' || !ctx['signal'].trim())) return { kind: 'unmeasured', cause: 'missing-input', detail: 'signal 不能为空' }
    if (typeof ctx['signal'] === 'string' && ctx['signal'] !== order.trigger.signal) return { kind: 'deny', blockers: [`信号 "${ctx['signal']}" 与预期 "${order.trigger.signal}" 不匹配`] }
    const payload = isRec(ctx['payload']) ? ctx['payload'] : ctx
    for (const [k, exp] of Object.entries(order.trigger.match ?? {})) {
      if (payload[k] === undefined || payload[k] === null) return { kind: 'unmeasured', cause: 'missing-input', detail: `缺少 trigger.match 字段 "${k}"` }
      if (payload[k] !== exp) return { kind: 'deny', blockers: [`trigger.match.${k} 不匹配`] }
    }
    if (order.cooldownMs !== undefined && typeof ctx['elapsedMs'] === 'number' && ctx['elapsedMs'] < order.cooldownMs) return { kind: 'deny', blockers: [`处于冷却期 (${ctx['elapsedMs']}ms < ${order.cooldownMs}ms)`] }
    if (typeof ctx['isolation'] === 'string' && Object.hasOwn(ISOLATION_CEILINGS, ctx['isolation']) && !ISOLATION_CEILINGS[ctx['isolation'] as keyof typeof ISOLATION_CEILINGS].includes(order.mandate.ceiling)) {
      return { kind: 'deny', blockers: [`动作上限 ${order.mandate.ceiling} 越过隔离档 ${ctx['isolation']}`] }
    }
    if (requires.length > 0) { const a = auditRequires(payload, requires); if (!a.ok) return { kind: 'unmeasured', cause: 'missing-input', detail: `缺少字段: ${a.missing.join(', ')}` } }
    return ruleFn ? ruleFn(payload) : { kind: 'allow', produced: { signal: order.trigger.signal, action: order.action } }
  }
}

function buildEvaluatorFn(ruleFn: (ctx: unknown) => Verdict): (s: unknown) => EvaluationReading {
  return s => {
    if (!isRec(s)) return { verdict: 'unmeasured', reasons: ['缺少评估输入对象'] }
    const total = typeof s['totalCases'] === 'number' ? s['totalCases'] : typeof s['total'] === 'number' ? s['total'] : undefined
    if (total === undefined || !Number.isFinite(total) || total <= 0) return { verdict: 'unmeasured', reasons: ['样本总数缺失或为 0，禁止猜概率'] }
    const passed = typeof s['passedCases'] === 'number' ? s['passedCases'] : typeof s['successes'] === 'number' ? s['successes']
      : (typeof s['catches'] === 'number' && typeof s['trueAllows'] === 'number' ? s['catches'] + s['trueAllows'] : undefined)
    const rate = passed !== undefined ? confidenceOf(passed, total)
      : typeof s['generalizationRatio'] === 'number' && Number.isFinite(s['generalizationRatio']) ? Math.max(0, Math.min(1, s['generalizationRatio'])) : undefined
    const v = ruleFn(s)
    if (v.kind === 'unmeasured') return { verdict: 'unmeasured', reasons: [v.detail] }
    if (rate === undefined || !Number.isFinite(rate)) return { verdict: 'unmeasured', reasons: ['无法计算有限有效概率'] }
    return v.kind === 'allow' ? { verdict: 'effective', probability: rate, reasons: ['满足回放与泛化阈值'] } : { verdict: 'ineffective', probability: rate, reasons: v.blockers }
  }
}

/** 将带 `rule` 声明式配置的沉淀清单编译为真实可注册、可跑红绿与回放的 `RegistryEntry`。 */
export function compileDeclarativeEntry(manifest: DepositManifest, boundOverrides?: Record<string, unknown>): RegistryEntry {
  const ruleFn = manifest.rule ? compileDeclarativeRuleFn(manifest.rule, manifest.params, boundOverrides) : undefined
  if (manifest.kind === 'standing-order') {
    const sig = manifest.trigger?.signal, act = manifest.action?.name
    if (!sig || !GOVERNED_SIGNALS.has(sig)) throw new Error(`standing-order "${manifest.id}" 信号 "${String(sig)}" 未在 SignalCatalog 登记`)
    if (!act || !GOVERNED_ACTIONS.has(act)) throw new Error(`standing-order "${manifest.id}" 动作 "${String(act)}" 未在 ActionCatalog 登记`)
    const ceiling: ActionClass = manifest.actionClass === 'side-effecting' ? 'local-write' : manifest.actionClass === 'block' ? 'draft' : 'read'
    const mandate: MandateBinding = manifest.mandate ?? { strength: 'explicit', scope: 'workspace:*', ceiling, isolation: ceiling === 'local-write' ? 'I2' : 'I1', policyVersion: 'v1' }
    const order: AnyStandingOrderDef = {
      kind: 'standing-order', id: manifest.id, version: manifest.version, description: manifest.prose.slice(0, 120) || manifest.id,
      trigger: { signal: sig, ...(manifest.trigger?.match ? { match: manifest.trigger.match } : {}) },
      action: { name: act as ActionName, params: (manifest.action?.params ?? {}) as never }, mandate,
      ...(manifest.cooldownMs !== undefined ? { cooldownMs: manifest.cooldownMs } : {}),
    } as AnyStandingOrderDef
    ATTACHED_EVALUATORS.set(order, buildStandingOrderEvaluator(order, ruleFn, manifest.requires ?? []))
    return order
  }
  if (manifest.kind === 'evaluator') {
    if (!ruleFn) throw new Error(`evaluator "${manifest.id}" 缺少零代码 rule 配置`)
    const evaluate = buildEvaluatorFn(ruleFn)
    const evaluator: EvaluatorDef = { kind: 'evaluator', id: manifest.id, version: manifest.version, measures: manifest.measures || manifest.id, evaluate }
    ATTACHED_EVALUATORS.set(evaluator, s => readingToVerdict(evaluate(s)))
    return evaluator
  }
  if (!ruleFn) throw new Error(`${manifest.kind} "${manifest.id}" 缺少零代码 rule 配置`)
  if (manifest.kind === 'counter-rule') {
    const act = manifest.action?.name ?? 'proposal.create'
    if (manifest.enforce === true || manifest.stage === 'enforce' || manifest.actionClass === 'block' || manifest.actionClass === 'side-effecting' || !COUNTER_ACTION_RE.test(act)) {
      throw new Error(`宪法冲突（D5）：counter-rule "${manifest.id}" 禁止 enforce 或非提案动作`)
    }
    return {
      kind: 'gate', id: manifest.id, version: manifest.version, point: (manifest.point ?? 'deposit.friction') as Point,
      description: manifest.prose.slice(0, 120) || manifest.id, placement: { timing: 'pre', enforce: false }, requires: (manifest.requires ?? []) as never,
      gate: (ctx: unknown) => { const r = ruleFn(ctx); return r.kind === 'allow' ? { kind: 'allow', produced: { ...(r.produced ?? {}), action: act, mode: 'observe' } } : r },
    } as AnyGateDef
  }
  if (!manifest.point) throw new Error(`gate "${manifest.id}" 缺少 point`)
  return {
    kind: 'gate', id: manifest.id, version: manifest.version, point: manifest.point, description: manifest.prose.slice(0, 120) || manifest.id,
    ...(manifest.side ? { side: manifest.side } : {}), placement: manifest.placement ?? { timing: 'pre', enforce: manifest.enforce ?? true },
    requires: (manifest.requires ?? []) as never, ...(manifest.proof ? { proof: manifest.proof } : {}), gate: ruleFn,
  } as AnyGateDef
}

function readingToVerdict(r: EvaluationReading): Verdict {
  if (r.verdict === 'effective') return { kind: 'allow', produced: { probability: r.probability, reasons: r.reasons } }
  if (r.verdict === 'ineffective') return { kind: 'deny', blockers: (r.reasons.length ? r.reasons : ['ineffective']) as [string, ...string[]] }
  return { kind: 'unmeasured', cause: 'no-evidence', detail: r.reasons.join('; ') || 'unmeasured' }
}

/** 统一运行任意已编译条目（gate / standing-order / evaluator）的三态评估函数。 */
export async function evaluateCompiledEntry(entry: RegistryEntry, ctx: unknown): Promise<Verdict> {
  const attached = ATTACHED_EVALUATORS.get(entry)
  if (attached) return attached(ctx)
  if (entry.kind === 'gate') {
    const audit = auditRequires(ctx, entry.requires)
    return audit.ok ? entry.gate(ctx as never) : { kind: 'unmeasured', cause: 'missing-input', detail: `缺少必需输入路径: ${audit.missing.join(', ')}` }
  }
  if (entry.kind === 'standing-order') return buildStandingOrderEvaluator(entry)(ctx)
  return readingToVerdict(await entry.evaluate(ctx))
}
