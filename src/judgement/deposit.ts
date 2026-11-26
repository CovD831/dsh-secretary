import { readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { evaluateCompiledEntry, validateDeclarativeRule } from './declarative.ts'
import { extractPlaybookSection, validateAndNormalizePlaybook } from './playbook.ts'
import { createJudgementRegistry, isValidScopeStage } from './registry.ts'
import { auditRequires } from './requires.ts'
import { parseFrontmatterData } from './yaml.ts'
import {
  BASE_SCOPES, type AnyGateDef, type AnyStandingOrderDef, type DeclarativeRule, type DepositManifest, type EvaluatorDef,
  type MandateBinding, type ParamSpec, type Point, type ProofRecord, type RegistryEntry,
  type Stage, type UnmeasuredCause, type Verdict,
} from './types.ts'

export interface DepositSections { readonly intent: string; readonly criterion: string; readonly examples: string; readonly exceptions: string; readonly repairHint: string }
export interface DepositViolation { readonly rule: string; readonly field: string; readonly reason: string; readonly fix: string; readonly suggestion?: string }
export type DepositAdmissionResult =
  | { readonly admitted: true; readonly manifest: DepositManifest; readonly sections?: DepositSections }
  | { readonly admitted: false; readonly violations: readonly DepositViolation[] }
export interface DepositCase { readonly name: string; readonly expected: Verdict['kind']; readonly ctx: unknown; readonly expectedCause?: UnmeasuredCause }
export interface DepositCaseResult { readonly name: string; readonly expected: Verdict['kind']; readonly actual: Verdict; readonly passed: boolean }
export interface DepositCasesReport {
  readonly ok: boolean; readonly total: number; readonly passed: number; readonly failed: number
  readonly mutationPassed: boolean; readonly results: readonly DepositCaseResult[]; readonly error?: string
}

const KNOWN_SCOPE_SET = new Set<string>(BASE_SCOPES)
const VALID_STAGES = new Set<string>(['shadow', 'observe', 'enforce', 'retired'])
const ALLOWED_COUNTER_ACTION_RE = /^(?:propose|(?:proposal|defect|rule-defect)\.[a-z0-9-]+)$/
const SECTION_ALIASES: Record<keyof DepositSections, readonly string[]> = {
  intent: ['意图', 'intent'], criterion: ['判据', 'criterion', 'criteria'],
  examples: ['正反例', '正例与反例', '正例与负例', 'examples'], exceptions: ['例外', 'exceptions'],
  repairHint: ['修复指引', '被拦时的话', 'repair hint', 'remediation'],
}
const SECTION_LABELS: Record<keyof DepositSections, string> = { intent: '意图', criterion: '判据', examples: '正反例', exceptions: '例外', repairHint: '修复指引' }

export function extractDepositSections(body: string): { sections: Partial<DepositSections>; missing: (keyof DepositSections)[] } {
  const buckets = new Map<keyof DepositSections, string[]>()
  let current: keyof DepositSections | undefined
  for (const line of body.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (h) {
      const title = h[1]!.trim().toLowerCase()
      current = (Object.keys(SECTION_ALIASES) as (keyof DepositSections)[]).find(k => SECTION_ALIASES[k].includes(title))
      continue
    }
    if (current) { const arr = buckets.get(current) ?? []; arr.push(line); buckets.set(current, arr) }
  }
  const sections: { -readonly [K in keyof DepositSections]?: string } = {}
  const missing: (keyof DepositSections)[] = []
  for (const key of Object.keys(SECTION_LABELS) as (keyof DepositSections)[]) {
    const text = (buckets.get(key) ?? []).join('\n').trim()
    if (text === '') missing.push(key); else sections[key] = text
  }
  return { sections, missing }
}

/** 解析 `<deposit-id>/DEPOSIT.md`（YAML/JSON frontmatter + 五节正文）。 */
export function parseDepositMarkdown(content: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(content.trimStart())
  if (!match) throw new Error('缺少 "---" 包裹的 YAML/JSON frontmatter')
  const rawManifest = parseFrontmatterData(match[1]!)
  const prose = (match[2] ?? '').trim()
  const { sections, missing } = extractDepositSections(prose)
  const playbookSection = extractPlaybookSection(prose)
  return { rawManifest, prose, sections, missingSections: missing, ...(playbookSection ? { playbookSection } : {}) }
}

function isValidParamSpec(spec: unknown): spec is ParamSpec {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return false
  const s = spec as Record<string, unknown>
  if (s['type'] === 'number') {
    const { default: def, min, max } = s
    if (def !== undefined && (typeof def !== 'number' || !Number.isFinite(def))) return false
    if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) return false
    if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) return false
    if (typeof min === 'number' && typeof max === 'number' && min > max) return false
    if (typeof def === 'number' && ((typeof min === 'number' && def < min) || (typeof max === 'number' && def > max))) return false
    return true
  }
  if (s['type'] === 'string') return s['default'] === undefined || typeof s['default'] === 'string'
  if (s['type'] === 'boolean') return s['default'] === undefined || typeof s['default'] === 'boolean'
  if (s['type'] === 'enum' && Array.isArray(s['values']) && s['values'].length > 0 && s['values'].every(v => typeof v === 'string' && v.trim() !== '')) {
    return s['default'] === undefined || (typeof s['default'] === 'string' && s['values'].includes(s['default']))
  }
  return false
}

const isPlainRecord = (val: unknown): val is Record<string, unknown> => Boolean(val && typeof val === 'object' && !Array.isArray(val))

function validateManifestFields(raw: Record<string, unknown>, prose: string): { manifest?: DepositManifest; violations: DepositViolation[] } {
  const violations: DepositViolation[] = []
  const fail = (rule: string, field: string, reason: string, fix: string, suggestion?: string) =>
    violations.push({ rule, field, reason, fix, ...(suggestion ? { suggestion } : {}) })
  const reqStr = (field: string, fix: string): string => {
    const val = raw[field]
    if (typeof val !== 'string' || val.trim() === '') { fail('missing-required-field', field, `必填字段 ${field} 缺失或为空`, fix); return '' }
    return val
  }
  const id = reqStr('id', '提供全局唯一沉淀包 id')
  const cases = reqStr('cases', '提供红绿用例相对路径，如 "cases/"')
  if (cases !== '' && (isAbsolute(cases) || cases.includes('\0') || cases.split(/[/\\]/).includes('..'))) {
    fail('invalid-cases-path', 'cases', `cases 路径 "${cases}" 存在绝对路径或上级穿越`, '仅允许包目录内的相对子路径（如 "cases/"）')
  }
  const version = typeof raw['version'] === 'number' && Number.isFinite(raw['version']) && raw['version'] > 0 ? raw['version'] : 0
  if (version === 0) fail('invalid-version', 'version', 'version 必须为正数', '设置 version: 1')
  const kind = raw['kind']
  if (kind !== 'gate' && kind !== 'standing-order' && kind !== 'evaluator' && kind !== 'counter-rule') fail('invalid-kind', 'kind', `未知 kind "${String(kind)}"`, '设置为 gate | standing-order | evaluator | counter-rule')
  const trust = raw['trust']
  if (trust !== 'owner' && trust !== 'collaborator' && trust !== 'public') fail('invalid-trust', 'trust', `非法 trust "${String(trust)}"`, '设置为 owner | collaborator | public')
  const paramsRaw = raw['params']
  if (!isPlainRecord(paramsRaw)) fail('invalid-params', 'params', 'params 必须为字典对象', '设置 params: {} 或声明类型化参数槽位')
  else {
    for (const [k, v] of Object.entries(paramsRaw)) if (!isValidParamSpec(v)) fail('invalid-param-spec', `params.${k}`, `参数槽位 "${k}" 类型或默认/区间值非法`, '核对 type/default/min/max/values')
    if (Object.keys(paramsRaw).length === 0 && (trust === 'collaborator' || trust === 'public')) {
      fail('params-required-for-shared-trust', 'params', `params 为空且 trust="${trust}"：无参数沉淀绑定私有假设，禁止共享发布`, '请在 params 中声明至少一个参数槽位，或将 trust 改为 "owner"')
    }
  }
  const point = raw['point']
  if ((kind === 'gate' || point !== undefined) && !isValidScopeStage(point, KNOWN_SCOPE_SET)) fail('invalid-point', 'point', `插入点 "${String(point)}" 非法`, `填写合法 <scope>.<stage>（scope 属 ${BASE_SCOPES.join('/')}）`)
  const enforceRaw = raw['enforce']
  if (enforceRaw !== undefined && typeof enforceRaw !== 'boolean') fail('invalid-enforce', 'enforce', `enforce 必须为严格布尔值（收到 ${typeof enforceRaw}）`, '请设置为 true 或 false')
  const placementRaw = raw['placement']
  let validPlacement = false
  if (placementRaw !== undefined) {
    if (!isPlainRecord(placementRaw) || (placementRaw['timing'] !== 'pre' && placementRaw['timing'] !== 'post') || typeof placementRaw['enforce'] !== 'boolean') {
      fail('invalid-placement', 'placement', 'placement 必须包含合法 timing (pre|post) 与布尔 enforce', '示例：{ timing: "pre", enforce: false }')
    } else {
      validPlacement = true
      if (placementRaw['timing'] === 'post' && placementRaw['enforce'] === true) fail('invalid-placement', 'placement', '事后口 (post) 严禁设置 enforce: true', '请改为 pre 或 enforce: false')
    }
  }
  const stage = raw['stage']
  if (stage !== undefined && (typeof stage !== 'string' || !VALID_STAGES.has(stage))) fail('invalid-stage', 'stage', `非法 stage "${String(stage)}"`, '设置为 shadow | observe | enforce | retired')
  const side = raw['side']
  if (side !== undefined && side !== 'hard' && side !== 'soft') fail('invalid-side', 'side', `非法 side "${String(side)}"`, '设置为 hard | soft')
  const reqsRaw = raw['requires']
  if (reqsRaw !== undefined && (!Array.isArray(reqsRaw) || reqsRaw.some(r => typeof r !== 'string' || !r.trim() || r.includes('..') || r.startsWith('.') || r.endsWith('.') || /\s/.test(r)))) {
    fail('invalid-requires', 'requires', 'requires 必须为合法点分路径字符串数组', '移除空字符串或 ".." 路径')
  }
  const actionRaw = raw['action']
  let validAction = false
  if (actionRaw !== undefined) {
    if (!isPlainRecord(actionRaw) || typeof actionRaw['name'] !== 'string' || actionRaw['name'].trim() === '') fail('invalid-action', 'action', 'action 必须为含非空 name 的对象', '示例：{ name: "proposal.create" }')
    else validAction = true
  }
  const trigger = raw['trigger']
  if (kind === 'standing-order' && (!isPlainRecord(trigger) || typeof trigger['signal'] !== 'string' || trigger['signal'].trim() === '')) fail('missing-trigger-signal', 'trigger.signal', 'standing-order 必须绑定受治理信号 trigger.signal', '设置 trigger: { signal: "<signal-name>" }')
  if (kind === 'counter-rule') {
    const actionClass = raw['actionClass'] ?? raw['action_class']
    const stageOk = stage === undefined || stage === 'shadow' || stage === 'observe'
    const enforceOk = enforceRaw === undefined || enforceRaw === false
    const placementOk = placementRaw === undefined || (validPlacement && (placementRaw as Record<string, unknown>)['enforce'] === false)
    const classOk = actionClass === undefined || actionClass === 'observe'
    const actionName = validAction ? ((actionRaw as Record<string, unknown>)['name'] as string) : ''
    const actionOk = actionRaw === undefined || (validAction && ALLOWED_COUNTER_ACTION_RE.test(actionName))
    if (!stageOk || !enforceOk || !placementOk || !classOk || !actionOk) {
      fail('constitutional-d5-counter-rule', 'kind / stage / enforce / action', '宪法冲突（裁决 D5）：counter-rule（如 Seen>=3）仅具九级梯 Rung 1 提案权，禁止 enforce: true 或直接晋升/修改规则', '请改写为 stage: "shadow"|"observe"、enforce: false、actionClass: "observe"，动作仅限 proposal.*/defect.*/rule-defect.*', 'stage: shadow\nenforce: false\nactionClass: observe\naction: { name: "proposal.create" }')
    }
  }
  if (raw['rule'] !== undefined) {
    for (const issue of validateDeclarativeRule(raw['rule'])) fail('invalid-declarative-rule', issue.field, issue.reason, '修正零代码声明式 rule 配置')
  }
  const checkedPlaybook = validateAndNormalizePlaybook(raw['playbook'], prose)
  for (const issue of checkedPlaybook.issues) fail('invalid-playbook', issue.field, issue.reason, '修正 playbook 字段或操作手册小节')
  if (violations.length > 0) return { violations }
  return {
    violations,
    manifest: {
      id, version, kind: kind as DepositManifest['kind'], params: paramsRaw as Readonly<Record<string, ParamSpec>>, trust: trust as DepositManifest['trust'], prose, cases,
      ...(point !== undefined ? { point: point as Point } : {}),
      ...(isPlainRecord(trigger) && typeof trigger['signal'] === 'string' ? { trigger: { signal: trigger['signal'] as never, ...(isPlainRecord(trigger['match']) ? { match: trigger['match'] } : {}) } } : {}),
      ...(Array.isArray(reqsRaw) ? { requires: reqsRaw as readonly string[] } : {}),
      ...(raw['proof'] ? { proof: raw['proof'] as DepositManifest['proof'] } : {}), ...(stage ? { stage: stage as Stage } : {}),
      ...(enforceRaw !== undefined ? { enforce: enforceRaw as boolean } : {}), ...(validPlacement ? { placement: placementRaw as DepositManifest['placement'] } : {}),
      ...(side ? { side: side as 'hard' | 'soft' } : {}),
      ...((raw['actionClass'] ?? raw['action_class']) ? { actionClass: (raw['actionClass'] ?? raw['action_class']) as DepositManifest['actionClass'] } : {}),
      ...(validAction ? { action: actionRaw as DepositManifest['action'] } : {}),
      ...(isPlainRecord(raw['mandate']) ? { mandate: raw['mandate'] as unknown as MandateBinding } : {}),
      ...(typeof raw['measures'] === 'string' && raw['measures'].trim() ? { measures: raw['measures'].trim() } : {}),
      ...(typeof raw['cooldownMs'] === 'number' && Number.isFinite(raw['cooldownMs']) ? { cooldownMs: raw['cooldownMs'] } : {}),
      ...(isPlainRecord(raw['rule']) ? { rule: raw['rule'] as unknown as DeclarativeRule } : {}),
      ...(checkedPlaybook.playbook ? { playbook: checkedPlaybook.playbook } : {}),
    },
  }
}

/** 机器准入门 + 宪法纠正门（裁决 D5）：字符串与对象入口均强制校验五节正文。 */
export function admitDeposit(input: string | DepositManifest): DepositAdmissionResult {
  if (typeof input === 'string') {
    let parsed: ReturnType<typeof parseDepositMarkdown>
    try { parsed = parseDepositMarkdown(input) } catch (err) {
      return { admitted: false, violations: [{ rule: 'frontmatter-parse', field: 'frontmatter', reason: `frontmatter 解析失败：${err instanceof Error ? err.message : String(err)}`, fix: '以 "---" 包裹合法 YAML/JSON frontmatter' }] }
    }
    const violations: DepositViolation[] = parsed.missingSections.map(key => ({ rule: 'missing-prose-section', field: `prose.${key}`, reason: `缺少或留空必填小节「${SECTION_LABELS[key]}」`, fix: `补充 "## ${SECTION_LABELS[key]}" 非空说明` }))
    const checked = validateManifestFields(parsed.rawManifest, parsed.prose)
    violations.push(...checked.violations)
    return violations.length > 0 || !checked.manifest ? { admitted: false, violations } : { admitted: true, manifest: checked.manifest, sections: parsed.sections as DepositSections }
  }
  const { sections, missing } = extractDepositSections(input.prose ?? '')
  const violations: DepositViolation[] = missing.map(key => ({ rule: 'missing-prose-section', field: `prose.${key}`, reason: `缺少或留空必填小节「${SECTION_LABELS[key]}」`, fix: `补充 "## ${SECTION_LABELS[key]}" 非空说明` }))
  const checked = validateManifestFields(input as unknown as Record<string, unknown>, input.prose)
  violations.push(...checked.violations)
  return violations.length > 0 || !checked.manifest ? { admitted: false, violations } : { admitted: true, manifest: checked.manifest, sections: sections as DepositSections }
}

/** 从 `<deposit-id>/cases/` 读取全部 `.json` 红绿用例。 */
export async function loadDepositCases(casesDir: string): Promise<DepositCase[]> {
  const names = (await readdir(casesDir)).filter(f => f.endsWith('.json')).sort()
  const out: DepositCase[] = []
  for (const name of names) {
    const parsed = JSON.parse(await readFile(join(casesDir, name), 'utf8')) as DepositCase | DepositCase[]
    if (Array.isArray(parsed)) out.push(...parsed); else out.push(parsed)
  }
  return out
}

/** 加载并准入 `<deposit-id>/DEPOSIT.md` 与包目录内 `cases/`。 */
export async function loadDepositPackage(depositDir: string): Promise<{ admission: DepositAdmissionResult; cases: DepositCase[] }> {
  const admission = admitDeposit(await readFile(join(depositDir, 'DEPOSIT.md'), 'utf8'))
  if (!admission.admitted) return { admission, cases: [] }
  const rootReal = await realpath(resolve(depositDir))
  const casesReal = await realpath(resolve(rootReal, admission.manifest.cases))
  const rel = relative(rootReal, casesReal)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`cases 路径 "${admission.manifest.cases}" 越出沉淀包目录`)
  return { admission, cases: await loadDepositCases(casesReal) }
}

async function resolveObserveGateVerdict(gate: AnyGateDef, ctx: unknown, ev: Awaited<ReturnType<ReturnType<typeof createJudgementRegistry>['evaluate']>>): Promise<Verdict> {
  if (ev.verdict.kind !== 'allow') return { kind: 'deny', blockers: ['非强制判据违反不阻塞原则'] }
  const hit = ev.ran.find(r => r.id === gate.id)
  if (!hit || hit.outcome === 'skipped') return { kind: 'unmeasured', cause: 'all-skipped', detail: 'skipped' }
  if (hit.outcome === 'allow') return { kind: 'allow' }
  if (hit.outcome === 'deny') return { kind: 'deny', blockers: [hit.detail || 'denied'] }
  if (!auditRequires(ctx, gate.requires).ok) return { kind: 'unmeasured', cause: 'missing-input', detail: hit.detail || 'missing-input' }
  try { return await gate.gate(ctx as never) } catch { return { kind: 'unmeasured', cause: 'threw', detail: hit.detail || 'threw' } }
}

/** 通用红绿 `cases/` 运行器：支持 gate / counter-rule / standing-order / evaluator，并执行恒 allow 禁用变异检查。 */
export async function runDepositCases(
  entry: RegistryEntry,
  cases: readonly DepositCase[],
  options: { readonly proof?: ProofRecord; readonly evaluator?: EvaluatorDef } = {},
): Promise<DepositCasesReport> {
  const redCases = cases.filter(c => c.expected === 'deny'), greenCases = cases.filter(c => c.expected === 'allow')
  if (redCases.length === 0 || greenCases.length === 0) {
    return { ok: false, total: cases.length, passed: 0, failed: cases.length, mutationPassed: false, results: [], error: '红绿 fixture 不完整：至少需 1 条 allow 正例与 1 条 deny 反例' }
  }
  const makeReg = (target: RegistryEntry) => {
    const reg = createJudgementRegistry({ ...(options.proof ? { proofs: [options.proof] } : {}) })
    if (options.evaluator) reg.register(options.evaluator, 'enforce')
    reg.register(target, 'enforce')
    return reg
  }
  const reg = makeReg(entry)
  const results: DepositCaseResult[] = []
  for (const c of cases) {
    let actual: Verdict
    if (entry.kind === 'gate') {
      const ev = await reg.evaluate(entry.point, c.ctx as never)
      actual = entry.placement.enforce ? ev.verdict : await resolveObserveGateVerdict(entry, c.ctx, ev)
    } else {
      actual = await evaluateCompiledEntry(entry, c.ctx)
    }
    const causeOk = c.expectedCause === undefined || (actual.kind === 'unmeasured' && actual.cause === c.expectedCause)
    results.push({ name: c.name, expected: c.expected, actual, passed: actual.kind === c.expected && causeOk })
  }
  let mutationPassed = true
  if (entry.kind === 'gate') {
    const mutantGate = { ...entry, gate: () => ({ kind: 'allow' }) } as AnyGateDef
    const mutant = makeReg(mutantGate)
    for (const red of redCases) {
      const ev = await mutant.evaluate(entry.point, red.ctx as never)
      const v = entry.placement.enforce ? ev.verdict : await resolveObserveGateVerdict(mutantGate, red.ctx, ev)
      if (v.kind !== 'allow') { mutationPassed = false; break }
    }
  } else {
    const mutantEntry: RegistryEntry = entry.kind === 'standing-order'
      ? { ...entry, trigger: { signal: entry.trigger.signal }, cooldownMs: undefined } as AnyStandingOrderDef
      : { ...entry, evaluate: () => ({ verdict: 'effective', probability: 1, reasons: ['mutant'] }) }
    for (const red of redCases) {
      const v = await evaluateCompiledEntry(mutantEntry, red.ctx)
      if (v.kind !== 'allow') { mutationPassed = false; break }
    }
  }
  const passed = results.filter(r => r.passed).length
  return { ok: results.length === passed && mutationPassed, total: results.length, passed, failed: results.length - passed, mutationPassed, results }
}
