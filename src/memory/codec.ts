/** 记忆实体页与 M6 账本的确定性 Markdown + YAML 编解码及路径防逃逸读写。 */
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseFrontmatterData } from '../judgement/yaml.ts'
import type {
  AttentionItem, FactLayer, FactPage, LedgerPage, MemoryEntry,
  MemoryLayer, MemoryPage, MemoryPageTarget, MemoryScope,
} from './types.ts'

const SAFE_SEGMENT_RE = /^[a-z0-9_-]{1,128}$/
const SAFE_REL_PATH_RE = /^(?:m1\/[a-z0-9_-]{1,128}\.md|m2\/profile\.md|m3\/[a-z0-9_-]{1,128}\/[a-z0-9_-]{1,128}\.md|m4\/patterns\.md|m6\/ledger\.md)$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const ENTRY_FIELDS: readonly (keyof MemoryEntry)[] = [
  'id', 'statement', 'scope', 'sourceType', 'sourceRef', 'observedAt', 'validFrom', 'validTo',
  'supersedes', 'invalidatedBy', 'invalidationReason', 'confidence', 'author', 'taint',
  'clearance', 'topicKey', 'verbatimQuote', 'workspacesSeen', 'seenCount', 'importance',
  'lastAccessedAt', 'triggerKeys', 'm2Kind', 'resident',
]

const ATTENTION_FIELDS: readonly (keyof AttentionItem)[] = [
  'id', 'kind', 'status', 'question', 'sourceRefs', 'conflictingEntryIds', 'clearance',
  'stickyTurns', 'cooldownMs', 'delaySeen', 'seenCount', 'remainingStickyTurns',
  'cooldownUntil', 'updatedAt',
]

export function assertSafeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT_RE.test(value)) {
    throw new Error(`非法记忆路径段 ${label}: "${value}"（仅允许 [a-z0-9_-]）`)
  }
  return value
}

export function resolveMemoryRelPath(target: MemoryPageTarget): string {
  switch (target.layer) {
    case 'm1':
      return `m1/${assertSafeSegment(target.slug ?? '', 'slug')}.md`
    case 'm2':
      return 'm2/profile.md'
    case 'm3':
      return `m3/${assertSafeSegment(target.workspaceKey ?? '', 'workspaceKey')}/${assertSafeSegment(target.slug ?? '', 'slug')}.md`
    case 'm4':
      return 'm4/patterns.md'
    case 'm6':
      return 'm6/ledger.md'
  }
}

async function resolveRealWithMissingTail(targetPath: string): Promise<string> {
  const abs = resolve(targetPath)
  try {
    return await realpath(abs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(abs)
    if (parent === abs) return abs
    return join(await resolveRealWithMissingTail(parent), basename(abs))
  }
}

async function assertNoSymlinkSegments(rootAbs: string, relPath: string): Promise<void> {
  let cursor = rootAbs
  for (const part of relPath.split('/')) {
    cursor = join(cursor, part)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new Error(`拒绝访问符号链接记忆路径: ${relPath}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
}

/** 校验目标相对路径严格位于 memoryGitDir 真实路径内，拦截 `..` 与软链逃逸。 */
export async function assertSafeMemoryPath(memoryGitDir: string, relPath: string): Promise<string> {
  const normalized = relPath.replace(/\\/g, '/')
  if (!SAFE_REL_PATH_RE.test(normalized)) {
    throw new Error(`非法记忆相对路径: "${relPath}"`)
  }
  const rootAbs = resolve(memoryGitDir)
  await assertNoSymlinkSegments(rootAbs, normalized)
  const rootReal = await resolveRealWithMissingTail(rootAbs)
  const targetReal = await resolveRealWithMissingTail(join(rootAbs, normalized))
  const rel = relative(rootReal, targetReal)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`记忆路径越界逃逸: "${relPath}"`)
  }
  return targetReal
}

function sanitizeParsedValue(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sanitizeParsedValue)
  if (val && typeof val === 'object') {
    const out = Object.create(null) as Record<string, unknown>
    for (const [k, v] of Object.entries(val)) {
      if (FORBIDDEN_KEYS.has(k)) throw new Error(`禁止危险键名: "${k}"`)
      out[k] = sanitizeParsedValue(v)
    }
    return out
  }
  return val
}

function parseYamlScalarValue(raw: string): unknown {
  const s = raw.trim()
  if (s === '' || s === 'null' || s === '~') return null
  if (s.startsWith('"') || s.startsWith('[') || s.startsWith('{') || s === 'true' || s === 'false' || /^-?\d+(?:\.\d+)?$/.test(s)) {
    try { return sanitizeParsedValue(JSON.parse(s)) } catch { /* 回退至 YAML 标量/内联解析 */ }
  }
  return parseFrontmatterData(`v: ${s}`).v
}

function parseRecordBlock(lines: readonly string[]): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) throw new Error(`无效记忆条目字段行: "${trimmed}"`)
    const key = trimmed.slice(0, colon).trim().replace(/^['"]|['"]$/g, '')
    if (!key || FORBIDDEN_KEYS.has(key)) throw new Error(`非法记忆条目字段名: "${key}"`)
    out[key] = parseYamlScalarValue(trimmed.slice(colon + 1))
  }
  return out
}

function formatRecordBlock<T extends object>(record: T, keys: readonly (keyof T)[]): string {
  const lines: string[] = []
  const bag = record as Record<string, unknown>
  for (const key of keys) {
    const val = bag[key as string]
    if (val !== undefined) lines.push(`${String(key)}: ${JSON.stringify(val)}`)
  }
  return lines.join('\n')
}

export function formatChangeLogLine(
  at: string, action: string, targetId: string,
  ref: { seq: number; id: string }, author: string, detail: string,
): string {
  const clean = (s: string) => s.replace(/[\r\n|]+/g, ' ').trim()
  return `${clean(at)} | ${clean(action)} | ${clean(targetId)} | seq=${ref.seq}#${clean(ref.id)} | ${clean(author)} | ${clean(detail)}`
}

export function encodeMemoryPage(page: MemoryPage): string {
  const head = [
    '---',
    `version: ${page.version}`,
    `layer: ${JSON.stringify(page.layer)}`,
    `pageKey: ${JSON.stringify(page.pageKey)}`,
    `scope: ${JSON.stringify(page.scope)}`,
    `revision: ${page.revision}`,
    `updatedAt: ${JSON.stringify(page.updatedAt)}`,
    '---',
    '',
    `# Memory Page: ${page.pageKey}`,
    '',
    page.layer === 'm6' ? '## Ledger' : '## Entries',
    '',
  ]
  const blocks = page.layer === 'm6'
    ? page.items.map(item => `### ${item.id}\n\`\`\`yaml\n${formatRecordBlock(item, ATTENTION_FIELDS)}\n\`\`\``)
    : page.entries.map(entry => `### ${entry.id}\n\`\`\`yaml\n${formatRecordBlock(entry, ENTRY_FIELDS)}\n\`\`\``)
  const logs = page.changeLog.map(line => `- ${line.replace(/[\r\n]+/g, ' ').trim()}`)
  return [...head, ...blocks, ...(blocks.length ? [''] : []), '## Change Log', '', ...logs, ''].join('\n')
}

export function decodeMemoryPage(raw: string): MemoryPage {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!fmMatch) throw new Error('记忆页缺少有效的 YAML frontmatter')
  const meta = parseFrontmatterData(fmMatch[1]!)
  const layer = meta.layer as MemoryLayer
  if (!['m1', 'm2', 'm3', 'm4', 'm6'].includes(layer)) throw new Error(`未知记忆层级: ${String(layer)}`)
  const pageKey = String(meta.pageKey ?? '')
  const scope = String(meta.scope ?? 'global') as MemoryScope
  const revision = Number(meta.revision ?? 0)
  const updatedAt = String(meta.updatedAt ?? '')
  const bodyLines = fmMatch[2]!.split(/\r?\n/)
  const records: Record<string, unknown>[] = []
  const changeLog: string[] = []
  let section: 'items' | 'changelog' | undefined
  let inYaml = false
  let buf: string[] = []
  for (const line of bodyLines) {
    const trimmed = line.trim()
    if (inYaml) {
      if (trimmed === '```') { records.push(parseRecordBlock(buf)); buf = []; inYaml = false }
      else buf.push(line)
      continue
    }
    if (trimmed === '## Entries' || trimmed === '## Ledger') { section = 'items'; continue }
    if (trimmed === '## Change Log') { section = 'changelog'; continue }
    if (section === 'items' && trimmed === '```yaml') { inYaml = true; buf = []; continue }
    if (section === 'changelog' && trimmed.startsWith('- ')) changeLog.push(trimmed.slice(2).trim())
  }
  if (inYaml) throw new Error('记忆页 YAML 块未闭合')
  if (layer === 'm6') {
    return {
      version: 1, layer: 'm6', pageKey, scope, revision, updatedAt,
      items: records as unknown as AttentionItem[], changeLog,
    } satisfies LedgerPage
  }
  return {
    version: 1, layer: layer as FactLayer, pageKey, scope, revision, updatedAt,
    entries: records as unknown as MemoryEntry[], changeLog,
  } satisfies FactPage
}

export async function readMemoryPage(memoryGitDir: string, relPath: string): Promise<MemoryPage | undefined> {
  const safePath = await assertSafeMemoryPath(memoryGitDir, relPath)
  try {
    return decodeMemoryPage(await readFile(safePath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function writeMemoryPage(memoryGitDir: string, relPath: string, page: MemoryPage): Promise<string> {
  const safePath = await assertSafeMemoryPath(memoryGitDir, relPath)
  await mkdir(dirname(safePath), { recursive: true })
  await writeFile(safePath, encodeMemoryPage(page), 'utf8')
  return relPath
}

async function listDirSafe(absDir: string): Promise<string[]> {
  try {
    const info = await lstat(absDir)
    if (info.isSymbolicLink()) throw new Error(`拒绝扫描符号链接目录: ${absDir}`)
    return await readdir(absDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function listMemoryPages(
  memoryGitDir: string,
  layers: readonly MemoryLayer[] = ['m1', 'm2', 'm3', 'm4', 'm6'],
): Promise<{ relPath: string; page: MemoryPage }[]> {
  const root = resolve(memoryGitDir)
  const relPaths: string[] = []
  if (layers.includes('m1')) {
    for (const f of (await listDirSafe(join(root, 'm1'))).filter(n => n.endsWith('.md')).sort()) relPaths.push(`m1/${f}`)
  }
  if (layers.includes('m2')) relPaths.push('m2/profile.md')
  if (layers.includes('m3')) {
    for (const ws of (await listDirSafe(join(root, 'm3'))).sort()) {
      for (const f of (await listDirSafe(join(root, 'm3', ws))).filter(n => n.endsWith('.md')).sort()) relPaths.push(`m3/${ws}/${f}`)
    }
  }
  if (layers.includes('m4')) relPaths.push('m4/patterns.md')
  if (layers.includes('m6')) relPaths.push('m6/ledger.md')
  const pages: { relPath: string; page: MemoryPage }[] = []
  for (const relPath of relPaths) {
    const page = await readMemoryPage(root, relPath)
    if (page) pages.push({ relPath, page })
  }
  return pages
}
