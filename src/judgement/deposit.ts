import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createJudgementRegistry, isValidScopeStage } from './registry.ts'
import {
  BASE_SCOPES, type AnyGateDef, type DepositManifest, type EvaluatorDef,
  type ParamSpec, type Point, type ProofRecord, type Stage, type UnmeasuredCause, type Verdict,
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
const SECTION_ALIASES: Record<keyof DepositSections, readonly string[]> = {
  intent: ['意图', 'intent'], criterion: ['判据', 'criterion', 'criteria'],
  examples: ['正反例', '正例与反例', '正例与负例', 'examples'], exceptions: ['例外', 'exceptions'],
  repairHint: ['修复指引', '被拦时的话', 'repair hint', 'remediation'],
}
const SECTION_LABELS: Record<keyof DepositSections, string> = { intent: '意图', criterion: '判据', examples: '正反例', exceptions: '例外', repairHint: '修复指引' }

function scanOutsideQuotes(text: string, onChar: (ch: string, i: number) => boolean | void): void {
  let quote: '"' | "'" | undefined
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = undefined; continue }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
    else if (depth === 0 && onChar(ch, i) === false) break
  }
}

function stripComment(line: string): string {
  let cut = line.length
  scanOutsideQuotes(line, (ch, i) => { if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) { cut = i; return false } })
  return line.slice(0, cut)
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let start = 0
  scanOutsideQuotes(text, (ch, i) => { if (ch === ',') { parts.push(text.slice(start, i)); start = i + 1 } })
  return [...parts, text.slice(start)]
}

function parseScalar(raw: string): unknown {
  const s = raw.trim()
  if (s === '' || s === 'null' || s === '~') return null
  if (s === 'true' || s === 'false') return s === 'true'
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    return inner === '' ? [] : splitTopLevel(inner).map(parseScalar)
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim()
    const obj: Record<string, unknown> = {}
    if (inner === '') return obj
    for (const pair of splitTopLevel(inner)) {
      const idx = pair.indexOf(':')
      if (idx <= 0) throw new Error(`无效内联对象项 "${pair.trim()}"`)
      obj[pair.slice(0, idx).trim().replace(/^['"]|['"]$/g, '')] = parseScalar(pair.slice(idx + 1))
    }
    return obj
  }
  return s
}

function parseYamlLines(lines: readonly { indent: number; text: string }[], start: number, baseIndent: number): [unknown, number] {
  if (start >= lines.length) return [{}, start]
  if (lines[start]!.text.startsWith('- ') || lines[start]!.text === '-') {
    const arr: unknown[] = []
    let i = start
    while (i < lines.length && lines[i]!.indent === baseIndent && (lines[i]!.text.startsWith('- ') || lines[i]!.text === '-')) {
      const rest = lines[i]!.text.slice(1).trim()
      if (rest === '' && i + 1 < lines.length && lines[i + 1]!.indent > baseIndent) {
        const [nested, next] = parseYamlLines(lines, i + 1, lines[i + 1]!.indent)
        arr.push(nested); i = next
      } else { arr.push(rest === '' ? null : parseScalar(rest)); i += 1 }
    }
    return [arr, i]
  }
  const obj: Record<string, unknown> = {}
  let i = start
  while (i < lines.length && lines[i]!.indent >= baseIndent) {
    const cur = lines[i]!
    if (cur.indent > baseIndent) throw new Error(`YAML 缩进错误："${cur.text}"`)
    const colon = cur.text.indexOf(':')
    if (colon <= 0) throw new Error(`YAML 键值语法错误："${cur.text}"`)
    const key = cur.text.slice(0, colon).trim().replace(/^['"]|['"]$/g, '')
    const rest = cur.text.slice(colon + 1).trim()
    if (rest !== '') { obj[key] = parseScalar(rest); i += 1 }
    else if (i + 1 < lines.length && lines[i + 1]!.indent > baseIndent) {
      const [nested, next] = parseYamlLines(lines, i + 1, lines[i + 1]!.indent)
      obj[key] = nested; i = next
    } else { obj[key] = {}; i += 1 }
  }
  return [obj, i]
}

function parseFrontmatterData(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error('frontmatter 内容为空')
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON frontmatter 必须为对象')
    return parsed as Record<string, unknown>
  }
  const lines = raw.split(/\r?\n/).map(stripComment).filter(l => l.trim() !== '').map(l => ({ indent: l.length - l.trimStart().length, text: l.trim() }))
  if (lines.length === 0) throw new Error('YAML frontmatter 内容为空')
  const [parsed] = parseYamlLines(lines, 0, lines[0]!.indent)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('YAML frontmatter 顶层必须为键值对象')
  return parsed as Record<string, unknown>
}

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
  return { rawManifest, prose, sections, missingSections: missing }
}

function isValidParamSpec(spec: unknown): spec is ParamSpec {
  if (!spec || typeof spec !== 'object') return false
  const s = spec as Record<string, unknown>
  if (s['type'] === 'string' || s['type'] === 'number' || s['type'] === 'boolean') return true
  return s['type'] === 'enum' && Array.isArray(s['values']) && s['values'].length > 0 && s['values'].every(v => typeof v === 'string' && v.trim() !== '')
}

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
  const cases = reqStr('cases', '提供红绿用例指针，如 "cases/"')
  const version = typeof raw['version'] === 'number' && Number.isFinite(raw['version']) && raw['version'] > 0 ? raw['version'] : 0
  if (version === 0) fail('invalid-version', 'version', 'version 必须为正数', '设置 version: 1')
  const kind = raw['kind']
  if (kind !== 'gate' && kind !== 'standing-order' && kind !== 'evaluator' && kind !== 'counter-rule') fail('invalid-kind', 'kind', `未知 kind "${String(kind)}"`, '设置为 gate | standing-order | evaluator | counter-rule')
  const trust = raw['trust']
  if (trust !== 'owner' && trust !== 'collaborator' && trust !== 'public') fail('invalid-trust', 'trust', `非法 trust "${String(trust)}"`, '设置为 owner | collaborator | public')
  const paramsRaw = raw['params']
  if (!paramsRaw || typeof paramsRaw !== 'object' || Array.isArray(paramsRaw)) {
    fail('invalid-params', 'params', 'params 必须为字典对象', '设置 params: {} 或声明类型化参数槽位')
  } else {
    for (const [k, v] of Object.entries(paramsRaw)) if (!isValidParamSpec(v)) fail('invalid-param-spec', `params.${k}`, `参数槽位 "${k}" 缺少合法 type`, '使用 string/number/boolean/enum')
    if (Object.keys(paramsRaw).length === 0 && (trust === 'collaborator' || trust === 'public')) {
      fail('params-required-for-shared-trust', 'params', `params 为空且 trust="${trust}"：无参数沉淀绑定私有假设，禁止共享发布`, '请在 params 中声明至少一个参数槽位，或将 trust 改为 "owner"')
    }
  }
  const point = raw['point']
  if ((kind === 'gate' || point !== undefined) && !isValidScopeStage(point, KNOWN_SCOPE_SET)) fail('invalid-point', 'point', `插入点 "${String(point)}" 非法`, `填写合法 <scope>.<stage>（scope 属 ${BASE_SCOPES.join('/')}）`)
  const placement = raw['placement'] as Record<string, unknown> | undefined
  if (placement && placement['timing'] === 'post' && placement['enforce'] === true) fail('invalid-placement', 'placement', '事后口 (post) 严禁设置 enforce: true', '请改为 pre 或 enforce: false')
  const stage = raw['stage']
  if (stage !== undefined && (typeof stage !== 'string' || !VALID_STAGES.has(stage))) fail('invalid-stage', 'stage', `非法 stage "${String(stage)}"`, '设置为 shadow | observe | enforce | retired')
  const trigger = raw['trigger'] as Record<string, unknown> | undefined
  if (kind === 'standing-order' && (!trigger || typeof trigger['signal'] !== 'string' || trigger['signal'].trim() === '')) fail('missing-trigger-signal', 'trigger.signal', 'standing-order 必须绑定受治理信号 trigger.signal', '设置 trigger: { signal: "<signal-name>" }')
  if (kind === 'counter-rule') {
    const action = raw['action'] as Record<string, unknown> | undefined
    const actionClass = (raw['actionClass'] ?? raw['action_class']) as string | undefined
    const actionName = typeof action?.['name'] === 'string' ? action['name'] : ''
    const badAction = actionName !== '' && (/promote|modify|mutate|install|write[-_.]?rule|enforce/i.test(actionName) || !/propos|defect/i.test(actionName))
    if (raw['enforce'] === true || placement?.['enforce'] === true || stage === 'enforce' || (actionClass !== undefined && actionClass !== 'observe') || badAction) {
      fail('constitutional-d5-counter-rule', 'kind / stage / enforce / action', '宪法冲突（裁决 D5）：counter-rule（如 Seen>=3）仅具九级梯 Rung 1 提案权，禁止 enforce: true 或直接晋升/修改规则', '请改写为 stage: "shadow" 或 "observe"、enforce: false、actionClass: "observe"，且动作仅产提案或缺陷工单', 'stage: shadow\nenforce: false\nactionClass: observe\naction: { name: "proposal.create" }')
    }
  }
  if (violations.length > 0) return { violations }
  return {
    violations,
    manifest: {
      id, version, kind: kind as DepositManifest['kind'], params: paramsRaw as Readonly<Record<string, ParamSpec>>, trust: trust as DepositManifest['trust'], prose, cases,
      ...(point !== undefined ? { point: point as Point } : {}),
      ...(trigger && typeof trigger['signal'] === 'string' ? { trigger: { signal: trigger['signal'] as never } } : {}),
      ...(raw['proof'] ? { proof: raw['proof'] as DepositManifest['proof'] } : {}), ...(raw['stage'] ? { stage: raw['stage'] as Stage } : {}),
      ...(raw['enforce'] !== undefined ? { enforce: Boolean(raw['enforce']) } : {}), ...(raw['placement'] ? { placement: raw['placement'] as DepositManifest['placement'] } : {}),
      ...((raw['actionClass'] ?? raw['action_class']) ? { actionClass: (raw['actionClass'] ?? raw['action_class']) as DepositManifest['actionClass'] } : {}),
      ...(raw['action'] ? { action: raw['action'] as DepositManifest['action'] } : {}),
    },
  }
}

/** 机器准入门 + 宪法纠正门（裁决 D5）。 */
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
  const checked = validateManifestFields(input as unknown as Record<string, unknown>, input.prose)
  if (typeof input.prose !== 'string' || input.prose.trim() === '') checked.violations.push({ rule: 'missing-prose', field: 'prose', reason: 'prose 正文不能为空', fix: '补充完整五节说明正文' })
  return checked.violations.length > 0 || !checked.manifest ? { admitted: false, violations: checked.violations } : { admitted: true, manifest: checked.manifest }
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

/** 加载并准入 `<deposit-id>/DEPOSIT.md` 与对应 `cases/` 目录。 */
export async function loadDepositPackage(depositDir: string): Promise<{ admission: DepositAdmissionResult; cases: DepositCase[] }> {
  const admission = admitDeposit(await readFile(join(depositDir, 'DEPOSIT.md'), 'utf8'))
  const cases = admission.admitted ? await loadDepositCases(resolve(depositDir, admission.manifest.cases)) : []
  return { admission, cases }
}

/** 通用红绿 `cases/` 运行器：校验正例/反例/缺输入例，并执行恒 allow 禁用变异检查。 */
export async function runDepositCases(
  gate: AnyGateDef,
  cases: readonly DepositCase[],
  options: { readonly proof?: ProofRecord; readonly evaluator?: EvaluatorDef } = {},
): Promise<DepositCasesReport> {
  const redCases = cases.filter(c => c.expected === 'deny')
  const greenCases = cases.filter(c => c.expected === 'allow')
  if (redCases.length === 0 || greenCases.length === 0) {
    return { ok: false, total: cases.length, passed: 0, failed: cases.length, mutationPassed: false, results: [], error: '红绿 fixture 不完整：至少需 1 条 allow 正例与 1 条 deny 反例' }
  }
  const makeReg = (target: AnyGateDef) => {
    const reg = createJudgementRegistry({ ...(options.proof ? { proofs: [options.proof] } : {}) })
    if (options.evaluator) reg.register(options.evaluator, 'enforce')
    reg.register(target, 'enforce')
    return reg
  }
  const reg = makeReg(gate)
  const results: DepositCaseResult[] = []
  for (const c of cases) {
    const ev = await reg.evaluate(gate.point, c.ctx as never)
    const causeOk = c.expectedCause === undefined || (ev.verdict.kind === 'unmeasured' && ev.verdict.cause === c.expectedCause)
    results.push({ name: c.name, expected: c.expected, actual: ev.verdict, passed: ev.verdict.kind === c.expected && causeOk })
  }
  const mutant = makeReg({ ...gate, gate: () => ({ kind: 'allow' }) } as AnyGateDef)
  let mutationPassed = true
  for (const red of redCases) {
    const ev = await mutant.evaluate(gate.point, red.ctx as never)
    if (ev.verdict.kind !== 'allow') { mutationPassed = false; break }
  }
  const passed = results.filter(r => r.passed).length
  return { ok: results.length === passed && mutationPassed, total: results.length, passed, failed: results.length - passed, mutationPassed, results }
}
