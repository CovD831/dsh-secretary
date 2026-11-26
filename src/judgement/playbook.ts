/** FDE 双面沉淀 Playbook 校验、渐进式匹配渲染与会话规则集代际锁定（Worker Generations）。 */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KV, type Key, type PersistedTicketGeneration } from '../kv.ts'
import { admitDeposit } from './deposit.ts'
import type { ExtendedJudgementRegistry } from './registry.ts'
import type { PlaybookSpec, PlaybookWhen, Point, PointCatalog, PointEvaluation, RunEntry, Stage, Verdict } from './types.ts'

const FORBIDDEN_PLAYBOOK_KEYS = new Set(['shell', 'command', 'exec', 'bash', 'pwsh', 'script', 'eval', 'code'])
const PLAYBOOK_HEADINGS = new Set(['操作手册', 'playbook', 'sop'])
const MAX_SUMMARY = 300, MAX_STEP = 500, MAX_STEPS = 30, MAX_SECTION = 8192, MAX_GENERATIONS = 500

export interface PlaybookCandidate { readonly id: string; readonly stage: Stage; readonly playbook: PlaybookSpec }
export interface MatchedPlaybook extends PlaybookCandidate { readonly matchedBy: readonly ('workspace' | 'glob' | 'keyword' | 'default')[] }
export interface PlaybookRenderResult { readonly text: string; readonly matchedIds: string[]; readonly fullIds: string[]; readonly indexOnlyIds: string[]; readonly usedBytes: number }
export interface RegistryGeneration { readonly hash: string; readonly capturedAt: string; readonly stages: Record<string, Stage>; readonly versions: Record<string, number> }

const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim() !== '')

function globToRegex(glob: string): RegExp {
  const body = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\0DS\0').replace(/\*\*/g, '\0DD\0')
    .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0DS\0/g, '(?:.*/)?').replace(/\0DD\0/g, '.*')
  return new RegExp(`^${body}$`)
}

/** 从沉淀包正文提取可选 `## 操作手册` / `## Playbook` / `## SOP` 小节文本。 */
export function extractPlaybookSection(prose: string): string | undefined {
  const lines: string[] = []
  let active = false
  for (const line of prose.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (h) { active = PLAYBOOK_HEADINGS.has(h[1]!.trim().toLowerCase()); continue }
    if (active) lines.push(line)
  }
  const text = lines.join('\n').trim()
  return text === '' ? undefined : text
}

function parseStepsFromSection(sectionText: string): string[] {
  return sectionText.split(/\r?\n/).map(l => l.trim().replace(/^(?:[-*]|\d+[.)])\s+/, '').trim()).filter(Boolean).slice(0, MAX_STEPS)
}

/** 校验并规范化 frontmatter `playbook` 字段及可选正文操作手册小节，拦截可执行 shell 键与超长噪声。 */
export function validateAndNormalizePlaybook(raw: unknown, prose: string): { playbook?: PlaybookSpec; issues: { field: string; reason: string }[] } {
  const issues: { field: string; reason: string }[] = []
  const sectionText = extractPlaybookSection(prose)
  if (sectionText && sectionText.length > MAX_SECTION) issues.push({ field: 'prose.playbook', reason: `操作手册小节超过 ${MAX_SECTION} 字符噪声上限` })
  if (raw === undefined) {
    if (!sectionText) return { issues }
    const steps = parseStepsFromSection(sectionText).map(s => s.slice(0, MAX_STEP))
    return steps.length === 0 ? { issues } : { issues, playbook: { summary: steps[0]!.slice(0, MAX_SUMMARY), steps } }
  }
  if (!isRec(raw)) return { issues: [...issues, { field: 'playbook', reason: 'playbook 必须为字典对象' }] }
  for (const k of Object.keys(raw)) if (FORBIDDEN_PLAYBOOK_KEYS.has(k)) issues.push({ field: `playbook.${k}`, reason: `禁止 playbook 声明可执行字段 "${k}"` })
  const summary = typeof raw['summary'] === 'string' ? raw['summary'].trim() : ''
  if (!summary) issues.push({ field: 'playbook.summary', reason: 'playbook.summary 必须为非空字符串' })
  else if (summary.length > MAX_SUMMARY) issues.push({ field: 'playbook.summary', reason: `playbook.summary 不得超过 ${MAX_SUMMARY} 字符` })

  let when: PlaybookWhen | undefined
  if (raw['when'] !== undefined) {
    if (!isRec(raw['when'])) issues.push({ field: 'playbook.when', reason: 'playbook.when 必须为对象' })
    else {
      for (const k of Object.keys(raw['when'])) if (FORBIDDEN_PLAYBOOK_KEYS.has(k)) issues.push({ field: `playbook.when.${k}`, reason: `禁止 playbook.when 声明可执行字段 "${k}"` })
      for (const key of ['workspaces', 'globs', 'keywords'] as const) {
        if (raw['when'][key] !== undefined && !isStrArr(raw['when'][key])) issues.push({ field: `playbook.when.${key}`, reason: `playbook.when.${key} 必须为非空字符串数组` })
      }
      when = {
        ...(isStrArr(raw['when']['workspaces']) ? { workspaces: raw['when']['workspaces'] } : {}),
        ...(isStrArr(raw['when']['globs']) ? { globs: raw['when']['globs'] } : {}),
        ...(isStrArr(raw['when']['keywords']) ? { keywords: raw['when']['keywords'] } : {}),
      }
    }
  }
  let steps: string[] | undefined
  if (raw['steps'] !== undefined) {
    if (!isStrArr(raw['steps'])) issues.push({ field: 'playbook.steps', reason: 'playbook.steps 必须为非空字符串数组' })
    else if (raw['steps'].length > MAX_STEPS) issues.push({ field: 'playbook.steps', reason: `playbook.steps 不得超过 ${MAX_STEPS} 步` })
    else if (raw['steps'].some(s => s.length > MAX_STEP)) issues.push({ field: 'playbook.steps', reason: `playbook.steps 单步不得超过 ${MAX_STEP} 字符` })
    else steps = raw['steps'].map(s => s.trim())
  } else if (sectionText) steps = parseStepsFromSection(sectionText).map(s => s.slice(0, MAX_STEP))

  if (issues.length > 0) return { issues }
  return { issues, playbook: { summary, ...(when ? { when } : {}), ...(steps?.length ? { steps } : {}) } }
}

/** 扫描处于 `observe` / `enforce` 阶段且含 `playbook` 的沉淀包，按工作区、文件 glob 或关键词匹配。 */
export function matchDepositPlaybooks(input: {
  readonly deposits: readonly { readonly id: string; readonly stage: Stage; readonly playbook?: PlaybookSpec }[]
  readonly workspace?: string; readonly entryFiles?: readonly string[]; readonly title?: string; readonly triggerText?: string
}): MatchedPlaybook[] {
  const haystack = `${input.title ?? ''}\n${input.triggerText ?? ''}`.toLowerCase()
  const files = (input.entryFiles ?? []).map(f => f.replace(/\\/g, '/').replace(/^\.\//, ''))
  const matched: MatchedPlaybook[] = []
  for (const d of input.deposits) {
    if (!d.playbook || (d.stage !== 'observe' && d.stage !== 'enforce')) continue
    const w = d.playbook.when
    if (!w || (!w.workspaces?.length && !w.globs?.length && !w.keywords?.length)) {
      matched.push({ id: d.id, stage: d.stage, playbook: d.playbook, matchedBy: ['default'] }); continue
    }
    const by: ('workspace' | 'glob' | 'keyword')[] = []
    if (w.workspaces?.length && input.workspace && w.workspaces.includes(input.workspace)) by.push('workspace')
    if (w.globs?.length && files.length > 0) { const res = w.globs.map(globToRegex); if (files.some(f => res.some(re => re.test(f)))) by.push('glob') }
    if (w.keywords?.length && haystack.trim() !== '' && w.keywords.some(kw => haystack.includes(kw.toLowerCase()))) by.push('keyword')
    if (by.length > 0) matched.push({ id: d.id, stage: d.stage, playbook: d.playbook, matchedBy: by })
  }
  return matched
}

/** 渐进式渲染 Playbook 注入块：预算内展开完整步骤，超出预算降级为单行 `summary` 索引。 */
export function renderPlaybookCapsuleBlock(matched: readonly MatchedPlaybook[], maxBytes = 4096): PlaybookRenderResult {
  const header = '## FDE 操作手册 (Playbooks)\n'
  if (matched.length === 0 || maxBytes <= 0 || Buffer.byteLength(header, 'utf8') > maxBytes) {
    return { text: '', matchedIds: [], fullIds: [], indexOnlyIds: [], usedBytes: 0 }
  }
  let out = header
  const matchedIds: string[] = [], fullIds: string[] = [], indexOnlyIds: string[] = []
  for (const item of matched) {
    const stepsText = item.playbook.steps?.length ? item.playbook.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') + '\n' : ''
    const fullBlock = `### ${item.id}\n${item.playbook.summary}\n${stepsText}`
    const indexLine = `- [${item.id}] ${item.playbook.summary}\n`
    if (Buffer.byteLength(out + fullBlock, 'utf8') <= maxBytes) { out += fullBlock; matchedIds.push(item.id); fullIds.push(item.id) }
    else if (Buffer.byteLength(out + indexLine, 'utf8') <= maxBytes) { out += indexLine; matchedIds.push(item.id); indexOnlyIds.push(item.id) }
  }
  if (matchedIds.length === 0) return { text: '', matchedIds: [], fullIds: [], indexOnlyIds: [], usedBytes: 0 }
  const text = out.trimEnd()
  return { text, matchedIds, fullIds, indexOnlyIds, usedBytes: Buffer.byteLength(text, 'utf8') }
}

/** 捕获当前判局注册表非 `retired` 条目的确定性 SHA-256 代际快照 (`gen-<12hex>`)。 */
export function captureRegistryGeneration(registry: Pick<ExtendedJudgementRegistry, 'list'>, capturedAt = new Date().toISOString()): RegistryGeneration {
  const active = registry.list().filter(e => e.stage !== 'retired').sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version)
  const stages: Record<string, Stage> = {}, versions: Record<string, number> = {}, lines: string[] = []
  for (const e of active) { stages[e.id] = e.stage; versions[e.id] = e.version; lines.push(`${e.id}@${e.version}:${e.stage}`) }
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12)
  return { hash: `gen-${digest}`, capturedAt, stages, versions }
}

/** 按发射时锁定的代际快照裁决插入点：快照时为非 `enforce` 或未注册的判据，即使热晋升也不阻断在途会话。 */
export async function evaluatePointAtGeneration<P extends Point>(
  registry: Pick<ExtendedJudgementRegistry, 'evaluate'>,
  point: P,
  ctx: PointCatalog[P],
  generation?: Pick<RegistryGeneration, 'stages' | 'versions'>,
): Promise<PointEvaluation> {
  const ev = await registry.evaluate(point, ctx)
  if (!generation) return ev
  const blockers: string[] = [], unmeasured: string[] = [], observed: RunEntry[] = [...ev.observed]
  const origObsIds = new Set(ev.observed.map(o => o.id)), obsIds = new Set(origObsIds)
  let enforcingRegistered = 0, enforcingEvaluated = 0
  for (const r of ev.ran) {
    if (generation.stages[r.id] === 'enforce' && !origObsIds.has(r.id)) {
      enforcingRegistered += 1
      if (r.outcome !== 'skipped') enforcingEvaluated += 1
      if (r.outcome === 'deny') blockers.push(r.detail ?? `[${r.id}] denied`)
      else if (r.outcome === 'unmeasured') unmeasured.push(r.detail ?? `[${r.id}] unmeasured`)
    } else if ((r.outcome === 'deny' || r.outcome === 'unmeasured') && !obsIds.has(r.id)) {
      observed.push(r); obsIds.add(r.id)
    }
  }
  const verdict: Verdict = enforcingRegistered > 0 && enforcingEvaluated === 0
    ? { kind: 'unmeasured', cause: 'all-skipped', detail: `插入点 "${point}" 在锁定代际下有 ${enforcingRegistered} 条强制判据，但本轮全部被跳过` }
    : blockers.length > 0 ? { kind: 'deny', blockers: blockers as [string, ...string[]] }
      : unmeasured.length > 0 ? { kind: 'unmeasured', cause: ev.verdict.kind === 'unmeasured' ? ev.verdict.cause : 'missing-input', detail: unmeasured.join('; ') }
        : { kind: 'allow' }
  return { ...ev, verdict, observed }
}

/** 为工单当前活跃 assignment 锁定注册表代际快照并写入 `KV.governance.ticketGenerations`（同 assignmentId 幂等复用，FIFO 上限 500）。 */
export function lockTicketGeneration(
  store: { get?: <V>(k: Key<V>) => V | undefined; set?: <V>(k: Key<V>, v: V) => void },
  registry: Pick<ExtendedJudgementRegistry, 'list'>,
  ticketId: string,
  assignmentId: string,
  now = new Date(),
): RegistryGeneration {
  const prev = store.get?.(KV.governance.ticketGenerations) ?? {}
  const existing = prev[ticketId]
  if (existing && existing.assignmentId === assignmentId) {
    return { hash: existing.hash, capturedAt: existing.capturedAt, stages: existing.stages, versions: existing.versions }
  }
  const gen = captureRegistryGeneration(registry, now.toISOString())
  if (typeof store.set === 'function') {
    const next: Record<string, PersistedTicketGeneration> = {}
    for (const k of Object.keys(prev).filter(k => k !== ticketId).slice(-(MAX_GENERATIONS - 1))) next[k] = prev[k]!
    next[ticketId] = { assignmentId, ...gen }
    store.set(KV.governance.ticketGenerations, next)
  }
  return gen
}

/** 从沉淀包目录读取经 `admitDeposit` 准入且已在注册表激活（`observe`/`enforce`）的 `playbook` 候选条目。 */
export async function loadPlaybookCandidates(
  dirs: readonly string[],
  registry: Pick<ExtendedJudgementRegistry, 'list'>,
): Promise<PlaybookCandidate[]> {
  const liveStages = new Map(registry.list().map(e => [e.id, e.stage] as const))
  const seen = new Set<string>(), out: PlaybookCandidate[] = []
  for (const root of dirs) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue
      const mdPath = join(root, ent.name, 'DEPOSIT.md')
      const st = await lstat(mdPath).catch(() => undefined)
      if (!st?.isFile() || st.isSymbolicLink()) continue
      try {
        const res = admitDeposit(await readFile(mdPath, 'utf8'))
        if (!res.admitted || !res.manifest.playbook) continue
        const id = res.manifest.id
        if (seen.has(id)) continue
        seen.add(id)
        const stage = liveStages.get(id)
        if (!stage || stage === 'shadow' || stage === 'retired') continue
        out.push({ id, stage, playbook: res.manifest.playbook })
      } catch { continue }
    }
  }
  return out
}

/** 校验 `workflow_sop` 声明式规则的 `enforceOrder` 与 `dependsOn` 合法性（含存在性、无环与 `checklistField` 必填检查）。 */
export function validateWorkflowSopDeps(raw: Record<string, unknown>, push: (field: string, reason: string) => void): void {
  if (raw['enforceOrder'] !== undefined && typeof raw['enforceOrder'] !== 'boolean') push('rule.enforceOrder', 'enforceOrder 必须为布尔值')
  if (!Array.isArray(raw['steps']) || raw['steps'].length === 0) { push('rule.steps', 'workflow_sop 至少需 1 个检查步骤'); return }
  const stepIds = new Set(raw['steps'].map(s => (isRec(s) && typeof s['id'] === 'string' ? s['id'].trim() : '')).filter(Boolean))
  const depsMap = new Map<string, string[]>()
  let hasDeps = false
  raw['steps'].forEach((s, i) => {
    if (!isRec(s) || typeof s['id'] !== 'string' || !s['id'].trim()) { push(`rule.steps[${i}].id`, 'SOP 步骤缺少非空 id'); return }
    const sid = s['id'].trim()
    if (s['dependsOn'] === undefined) return
    if (!isStrArr(s['dependsOn'])) { push(`rule.steps[${i}].dependsOn`, 'dependsOn 必须为非空字符串数组'); return }
    if (s['dependsOn'].length > 0) hasDeps = true
    for (const dep of s['dependsOn']) {
      if (dep === sid) push(`rule.steps[${i}].dependsOn`, `步骤 "${sid}" 不得依赖自身`)
      else if (!stepIds.has(dep)) push(`rule.steps[${i}].dependsOn`, `dependsOn 引用了未知步骤 "${dep}"`)
    }
    depsMap.set(sid, s['dependsOn'].map(d => d.trim()))
  })
  if ((raw['enforceOrder'] === true || hasDeps) && (typeof raw['checklistField'] !== 'string' || !raw['checklistField'].trim())) {
    push('rule.checklistField', '声明了 enforceOrder 或 dependsOn 时必须提供非空 checklistField')
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const hasCycle = (id: string): boolean => visiting.has(id) || (!visited.has(id) && (visiting.add(id), (depsMap.get(id) ?? []).some(hasCycle) ? true : (visiting.delete(id), visited.add(id), false)))
  for (const id of depsMap.keys()) if (hasCycle(id)) { push('rule.steps', `dependsOn 存在循环依赖: ${id}`); break }
}
