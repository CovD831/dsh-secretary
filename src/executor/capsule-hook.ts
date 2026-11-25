/** 执行器发射前机械 1-Hop 切片、关键词 rg 定位与自适应派发钩子。 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { assembleCapsule, sliceWorkspaceContext, type ContextCapsule, type PitfallNote, type SliceResult } from '../context/index.ts'
import type { Assignment, Ticket } from '../core/index.ts'
import { DEFAULT_ADAPTIVE_DISPATCH_PARAMS, type ThinkingTier } from '../judgement/gates/index.ts'
import type { JudgementRegistry, Verdict } from '../judgement/index.ts'
import type { SpineDraft } from '../spine/types.ts'

const execFileAsync = promisify(execFile)
const DSH_BUNDLED_RG = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'lib', 'coverage', '.next', '.local'])
const CODE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|jsx|py|go|rs)$/
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'fix', 'add', 'update', 'change', 'check', 'please',
  'bot', 'src', 'test', 'tests', 'file', 'files', 'code', 'issue', 'bug', 'feature', 'work', 'ticket', 'task',
  'not', 'note', 'routing', 'source', 'request', 'scope', 'proactively', 'accepted', 'under', 'verify', 'pnpm', 'npm',
  '普通任务', '无路径', '修复', '修改', '新增', '检查', '看看', '一下', '问题', '功能', '模块', '文件', '代码', '请帮我', '验收标准',
])

export interface LaunchDispatchPlan {
  readonly executionMode: 'solo' | 'team'
  readonly thinkingTier: ThinkingTier
  readonly escalateReason?: string
}

export interface PreparedLaunchCapsule {
  readonly verdict: Verdict
  readonly dispatch?: LaunchDispatchPlan
  readonly blocked?: readonly [string, ...string[]]
  readonly capsule: ContextCapsule
  readonly slice: SliceResult
}

export interface LaunchCapsuleInput {
  readonly ticket: Pick<Ticket, 'id' | 'title' | 'assignments' | 'execution'>
  readonly assignment?: Pick<Assignment, 'id'>
  readonly workspaceDir: string
  readonly triggerText?: string
  readonly registry: Pick<JudgementRegistry, 'evaluate'>
  readonly recordSpine?: (event: SpineDraft<Record<string, unknown>>) => void
  readonly retryCount?: number
  readonly allowTeam?: boolean
  readonly maxBytes?: number
  readonly pitfallNotes?: readonly PitfallNote[]
  readonly rgBin?: string
}

const PATH_CANDIDATE_RE =
  /(?<![A-Za-z0-9_./:-])((?:\.\/)?(?:(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,10}))(?::\d+(?:-\d+)?)?(?:#L?\d+(?:-L?\d+)?)?(?![A-Za-z0-9_./-])/g

let hookSeq = 0

/** 从工单标题、任务说明与触发文本中提取相对文件路径候选，过滤 URL 与目录穿越。 */
export function extractCandidatePaths(texts: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const raw of texts) {
    if (!raw) continue
    const scrubbed = raw.replace(/https?:\/\/\S+/g, ' ')
    PATH_CANDIDATE_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PATH_CANDIDATE_RE.exec(scrubbed)) !== null) {
      const cleaned = match[1]!.replace(/\\/g, '/').replace(/^\.\//, '')
      if (!cleaned || cleaned.startsWith('/') || cleaned.split('/').includes('..')) continue
      seen.add(cleaned)
    }
  }
  return [...seen]
}

async function resolveExistingRepoFiles(workspaceDir: string, candidates: readonly string[]): Promise<string[]> {
  if (!workspaceDir.trim() || candidates.length === 0) return []
  let rootReal: string
  try {
    rootReal = await realpath(resolve(workspaceDir))
  } catch {
    return []
  }
  const verified: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    try {
      const abs = resolve(rootReal, candidate)
      const info = await stat(abs)
      if (!info.isFile()) continue
      const real = await realpath(abs)
      const rel = relative(rootReal, real).replace(/\\/g, '/')
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || seen.has(rel)) continue
      seen.add(rel)
      verified.push(rel)
    } catch {
      continue
    }
  }
  return verified
}

function countFailedRetries(assignments: readonly Pick<Assignment, 'state' | 'endedReason' | 'report'>[]): number {
  return assignments.filter(a => a.state === 'ended' && (a.report?.state === 'failed' || a.endedReason === 'retried')).length
}

function extractDispatchPlan(verdict: Verdict): LaunchDispatchPlan | undefined {
  if (verdict.kind !== 'allow') return undefined
  const raw = (verdict.produced?.['ticket.adaptive-dispatch']
    ?? (verdict.produced ? Object.values(verdict.produced)[0] : undefined)) as Record<string, unknown> | undefined
  const mode = raw?.['executionMode'] === 'team' ? 'team' : 'solo'
  const tier = raw?.['thinkingTier']
  const thinkingTier: ThinkingTier = tier === 'high' || tier === 'medium' || tier === 'low'
    ? tier : DEFAULT_ADAPTIVE_DISPATCH_PARAMS.default_thinking
  const reason = typeof raw?.['escalateReason'] === 'string' && raw['escalateReason'] ? raw['escalateReason'] : undefined
  return { executionMode: mode, thinkingTier, ...(reason ? { escalateReason: reason } : {}) }
}

/** 从自然语言标题与描述中提取标识符与领域关键词（优先标识符，过滤模板噪声与停用词），用于无显式路径时的 rg 定位。 */
export function extractSearchKeywords(texts: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const cleanedTexts = texts.filter((t): t is string => Boolean(t)).map(raw =>
    raw
      .replace(/Routing note \(not the source request\):/gi, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(PATH_CANDIDATE_RE, ' '),
  )
  // 第一轮优先提取驼峰/下划线代码标识符，防止被模板短词挤占配额
  for (const scrubbed of cleanedTexts) {
    for (const m of scrubbed.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,39}/g)) {
      const tok = m[0]!
      if ((/[A-Z_]/.test(tok.slice(1)) || tok.length >= 6) && !STOP_WORDS.has(tok.toLowerCase())) seen.add(tok)
      if (seen.size >= 14) return [...seen]
    }
  }
  for (const scrubbed of cleanedTexts) {
    for (const m of scrubbed.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,39}/g)) {
      const tok = m[0]!
      if (!STOP_WORDS.has(tok.toLowerCase())) seen.add(tok)
      if (seen.size >= 14) return [...seen]
    }
    for (const m of scrubbed.matchAll(/[\u4e00-\u9fa5]{2,8}/g)) {
      const tok = m[0]!
      if (!STOP_WORDS.has(tok)) seen.add(tok)
      if (seen.size >= 14) return [...seen]
    }
  }
  return [...seen]
}

async function walkCodeFiles(root: string, dir = root, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (IGNORE_DIRS.has(ent.name)) continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) await walkCodeFiles(root, full, out)
    else if (ent.isFile() && CODE_FILE_RE.test(ent.name)) out.push(relative(root, full).replace(/\\/g, '/'))
  }
  return out
}

async function locateFilesByKeywords(workspaceDir: string, keywords: readonly string[], rgBin?: string): Promise<string[]> {
  if (!workspaceDir.trim() || keywords.length === 0) return []
  let rootReal: string
  try { rootReal = await realpath(resolve(workspaceDir)) } catch { return [] }
  const scores = new Map<string, number>()
  const bump = (rel: string, weight = 1) => {
    const posix = rel.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!posix || posix.startsWith('..') || !CODE_FILE_RE.test(posix)) return
    const bonus = /(?:^|\/)tests?\//.test(posix) || /\.(?:spec|test)\./.test(posix) ? 0.5 : 2
    scores.set(posix, (scores.get(posix) ?? 0) + weight * bonus)
  }
  const bin = rgBin ?? (existsSync(DSH_BUNDLED_RG) ? DSH_BUNDLED_RG : 'rg')
  try {
    const ignoreGlobs = [...IGNORE_DIRS].flatMap(d => ['--glob', `!${d}`])
    const args = ['-l', '-F', '-i', ...ignoreGlobs, ...keywords.flatMap(k => ['-e', k]), '--', '.']
    const res = await execFileAsync(bin, args, { cwd: rootReal, timeout: 4000, maxBuffer: 1024 * 1024 }).catch((err: unknown) => {
      if ((err as { code?: unknown } | null)?.code === 1) return { stdout: '' }
      throw err
    })
    for (const line of res.stdout.split(/\r?\n/).filter(Boolean)) bump(line, 1)
  } catch {
    const files = await walkCodeFiles(rootReal)
    for (const rel of files) {
      const content = await readFile(join(rootReal, rel), 'utf8').catch(() => '')
      const lower = content.toLowerCase()
      for (const kw of keywords) if (lower.includes(kw.toLowerCase())) bump(rel, 1)
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([f]) => f)
}

/** 发射前提取工作区 1-Hop 切片（显式路径优先，缺失时走关键词 rg 定位）、计算自适应派发档位并记录事件脊。 */
export async function prepareLaunchCapsule(input: LaunchCapsuleInput): Promise<PreparedLaunchCapsule | undefined> {
  const { ticket, assignment, workspaceDir, triggerText, registry, recordSpine } = input
  const texts = [triggerText, ticket.title, ticket.execution?.assignment]
  const candidates = extractCandidatePaths(texts)
  let entryFiles = await resolveExistingRepoFiles(workspaceDir, candidates)
  if (entryFiles.length === 0) {
    const keywords = extractSearchKeywords(texts)
    entryFiles = await locateFilesByKeywords(workspaceDir, keywords, input.rgBin)
  }
  const retryCount = input.retryCount ?? countFailedRetries(ticket.assignments)
  const verifyCmds = ticket.execution?.verifyCommands
  if (entryFiles.length === 0 && retryCount === 0 && (!verifyCmds || verifyCmds.length === 0)) return undefined

  const resolvedRg = input.rgBin ?? (existsSync(DSH_BUNDLED_RG) ? DSH_BUNDLED_RG : undefined)
  const slice: SliceResult = entryFiles.length > 0
    ? await sliceWorkspaceContext({
        workspaceRoot: workspaceDir,
        entryFiles,
        ...(triggerText ? { queryText: triggerText } : {}),
        ...(input.pitfallNotes ? { pitfallNotes: input.pitfallNotes } : {}),
        ...(resolvedRg ? { rgBin: resolvedRg } : {}),
      })
    : {
        workspaceRoot: workspaceDir, targetFiles: [], targetContents: [], importedSignatures: [],
        callSites: [], relatedTests: [], matchedPitfalls: [], usedFallback: false,
        metrics: { targetFiles: 0, importedTypesCount: 0, callSiteCount: 0, relatedTestsCount: 0, totalBytes: 0, durationMs: 0 },
      }
  const evaluation = await registry.evaluate('ticket.adaptive-dispatch', {
    metrics: slice.metrics,
    retryCount,
    ...(input.allowTeam !== undefined ? { allowTeam: input.allowTeam } : {}),
  })
  const dispatch = extractDispatchPlan(evaluation.verdict)
  const blocked = evaluation.verdict.kind === 'deny' ? evaluation.verdict.blockers : undefined
  const baseCapsule = assembleCapsule(slice, input.maxBytes ?? DEFAULT_ADAPTIVE_DISPATCH_PARAMS.max_capsule_bytes)
  const verifyHeader = verifyCmds?.length ? `## 标准验证命令\n\`\`\`verify\n${verifyCmds.join('\n')}\n\`\`\`\n\n` : ''
  const capsule: ContextCapsule = verifyHeader && Buffer.byteLength(verifyHeader + baseCapsule.text, 'utf8') <= baseCapsule.budgetBytes
    ? { ...baseCapsule, text: verifyHeader + baseCapsule.text, usedBytes: Buffer.byteLength(verifyHeader + baseCapsule.text, 'utf8') }
    : baseCapsule

  if (recordSpine) {
    const sessionPtr = `dsh-session:worker-${ticket.id}`
    recordSpine({
      id: `gate:ticket.adaptive-dispatch:${ticket.id}:${assignment?.id ?? 'launch'}:${++hookSeq}`,
      stream: `ticket:${ticket.id}`,
      type: 'gate.evaluated',
      source: { kind: 'system', ref: 'executor.capsule-hook' },
      evidence: [
        { kind: 'event', ref: `session:worker-${ticket.id}` },
        { kind: 'event', ref: sessionPtr },
      ],
      taint: 'trusted',
      payload: {
        point: 'ticket.adaptive-dispatch',
        ticketId: ticket.id,
        ...(assignment ? { assignmentId: assignment.id } : {}),
        sessionPtr,
        entryFiles: slice.targetFiles,
        metrics: slice.metrics,
        retryCount,
        verdict: evaluation.verdict,
        ...(dispatch ? { dispatch } : {}),
        ...(blocked ? { blocked } : {}),
        capsuleBytes: capsule.usedBytes,
        overflow: capsule.overflow,
        droppedItems: capsule.droppedItems,
      },
    })
  }

  return {
    verdict: evaluation.verdict,
    ...(dispatch ? { dispatch } : {}),
    ...(blocked ? { blocked } : {}),
    capsule,
    slice,
  }
}
