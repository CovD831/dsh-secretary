import { execFile } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { assembleCapsule, buildCapsuleSections, matchPitfalls, measureSectionsBytes } from './capsule.ts'
import type { CallSite, ImportedSignatureBlock, SliceRequest, SliceResult } from './types.ts'

export { assembleCapsule, matchPitfalls, parseRelativeImports, resolveLocalImport, walkWorkspaceFiles }

const execFileAsync = promisify(execFile)
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'lib', 'coverage', '.next'])
const RG_IGNORE_GLOBS = [...IGNORED_DIRS].flatMap(d => ['--glob', `!${d}`])
const TEST_FILE_RE = /(?:^|\/)tests\/.*\.(?:spec|test)\.[^/]+$|\.(?:spec|test)\.[^/]+$/
const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs']

function toPosix(p: string): string { return p.replace(/\\/g, '/') }

async function resolveSafeRepoFile(rootReal: string, candidateAbs: string): Promise<string | undefined> {
  try {
    const info = await stat(candidateAbs)
    if (!info.isFile()) return undefined
    const real = await realpath(candidateAbs)
    const rel = toPosix(relative(rootReal, real))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
    return rel
  } catch {
    return undefined
  }
}

function collectBalancedBlock(lines: readonly string[], startIdx: number): { text: string; nextIdx: number } {
  let depth = 0
  let started = false
  const out: string[] = []
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i]!
    out.push(line)
    for (const ch of line) {
      if (ch === '{') { depth += 1; started = true }
      else if (ch === '}') depth -= 1
    }
    if ((started && depth <= 0) || (!started && line.trimEnd().endsWith(';'))) {
      return { text: out.join('\n'), nextIdx: i + 1 }
    }
  }
  return { text: out.join('\n'), nextIdx: lines.length }
}

function stripImplBody(lines: readonly string[], startIdx: number): { sig: string; nextIdx: number } {
  const head: string[] = []
  let parenDepth = 0
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i]!
    const bodyIdx = (() => {
      for (let c = 0; c < line.length; c += 1) {
        const ch = line[c]!
        if (ch === '(') parenDepth += 1
        else if (ch === ')') parenDepth -= 1
        else if (ch === '{' && parenDepth <= 0) return c
      }
      return -1
    })()
    if (bodyIdx >= 0) {
      head.push(line.slice(0, bodyIdx).trimEnd() + ';')
      const block = collectBalancedBlock(lines, i)
      return { sig: head.join('\n'), nextIdx: block.nextIdx }
    }
    head.push(line)
    if (parenDepth <= 0 && line.trimEnd().endsWith(';')) return { sig: head.join('\n'), nextIdx: i + 1 }
  }
  return { sig: head.join('\n'), nextIdx: lines.length }
}

/** 从直接被 import 的模块提取导出类型与函数签名，剥除内部实现体。 */
export function extractExportedSignatures(content: string): string[] {
  const lines = content.split(/\r?\n/)
  const sigs: string[] = []
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i]!.trimStart()
    if (/^export\s+(?:type|interface|enum)\b/.test(trimmed)) {
      const { text, nextIdx } = collectBalancedBlock(lines, i)
      sigs.push(text.trimEnd()); i = nextIdx; continue
    }
    if (/^export\s+(?:default\s+)?(?:async\s+)?function\b/.test(trimmed)) {
      const { sig, nextIdx } = stripImplBody(lines, i)
      sigs.push(sig.trimEnd()); i = nextIdx; continue
    }
    if (/^export\s+(?:abstract\s+)?class\b/.test(trimmed)) {
      sigs.push(lines[i]!.replace(/\{.*$/, '{ ... }').trimEnd())
      i = collectBalancedBlock(lines, i).nextIdx; continue
    }
    if (/^export\s+(?:declare\s+)?(?:const|let|var)\b/.test(trimmed)) {
      const line = lines[i]!
      const eq = line.indexOf('=')
      if (eq > 0 && /=>|\bfunction\b|\{\s*$/.test(line.slice(eq))) {
        sigs.push(line.slice(0, eq).trimEnd() + ';')
        i = collectBalancedBlock(lines, i).nextIdx; continue
      }
      sigs.push(line.trimEnd())
    }
    i += 1
  }
  return sigs
}

async function resolveLocalImport(fromFile: string, specifier: string, rootReal: string): Promise<string | undefined> {
  if (!specifier.startsWith('.')) return undefined
  const baseDir = dirname(resolve(rootReal, fromFile))
  const raw = resolve(baseDir, specifier)
  const stem = raw.replace(/\.(?:js|mjs|cjs|jsx)$/, '')
  const candidates = [
    raw, ...RESOLVE_EXTS.map(e => `${raw}${e}`),
    ...RESOLVE_EXTS.map(e => `${stem}${e}`), ...RESOLVE_EXTS.map(e => join(raw, `index${e}`)),
  ]
  for (const cand of candidates) {
    const safeRel = await resolveSafeRepoFile(rootReal, cand)
    if (safeRel) return safeRel
  }
  return undefined
}

function parseRelativeImports(content: string): string[] {
  const specs: string[] = []
  const re = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s+['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) specs.push(m[1] ?? m[2]!)
  return [...new Set(specs)]
}

function extractOwnSymbols(content: string): string[] {
  const syms: string[] = []
  const re = /^\s*export\s+(?:async\s+)?(?:function|class|interface|type|enum|const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) syms.push(m[1]!)
  return syms
}

async function walkWorkspaceFiles(root: string, dir = root, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    if (IGNORED_DIRS.has(ent.name)) continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) await walkWorkspaceFiles(root, full, out)
    else if (ent.isFile()) out.push(toPosix(relative(root, full)))
  }
  return out
}

async function scanWithNode(rootReal: string, needles: readonly string[], entryStems: readonly string[]) {
  const files = (await walkWorkspaceFiles(rootReal)).sort()
  const hits: CallSite[] = []
  const tests = new Set<string>()
  for (const rel of files) {
    const isTest = TEST_FILE_RE.test(rel)
    if (isTest && entryStems.some(s => basename(rel).toLowerCase().includes(s.toLowerCase()))) tests.add(rel)
    if (needles.length === 0) continue
    let raw: string
    try { raw = await readFile(join(rootReal, rel), 'utf8') } catch { continue }
    const lines = raw.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!
      if (needles.some(n => line.includes(n))) {
        if (isTest) tests.add(rel)
        else hits.push({ file: rel, line: i + 1, text: line.trimEnd() })
      }
    }
  }
  return { hits, tests: [...tests].sort() }
}

async function searchWorkspace(rootReal: string, needles: readonly string[], entryStems: readonly string[], req: SliceRequest) {
  const rgBin = req.rgBin ?? 'rg'
  const timeout = req.timeoutMs ?? 5000
  const maxBuffer = req.maxRgOutputBytes ?? 2 * 1024 * 1024
  try {
    const filesRes = await execFileAsync(rgBin, ['--files', ...RG_IGNORE_GLOBS, '--'], { cwd: rootReal, timeout, maxBuffer })
    const allFiles = filesRes.stdout.split(/\r?\n/).filter(Boolean).map(toPosix)
    const tests = new Set<string>(allFiles.filter(f => TEST_FILE_RE.test(f) && entryStems.some(s => basename(f).toLowerCase().includes(s.toLowerCase()))))
    const hits: CallSite[] = []
    if (needles.length > 0) {
      const searchArgs = [
        '--line-number', '--no-heading', '--color', 'never', '-F',
        ...RG_IGNORE_GLOBS, ...needles.flatMap(n => ['-e', n]), '--', '.',
      ]
      const res = await execFileAsync(rgBin, searchArgs, { cwd: rootReal, timeout, maxBuffer }).catch((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code
        if (code === 1) return { stdout: '' }
        throw err
      })
      for (const rawLine of res.stdout.split(/\r?\n/)) {
        const m = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(rawLine)
        if (!m) continue
        const file = toPosix(m[1]!)
        if (TEST_FILE_RE.test(file)) tests.add(file)
        else hits.push({ file, line: Number(m[2]), text: m[3]!.trimEnd() })
      }
    }
    return { hits, tests: [...tests].sort(), usedFallback: false as const }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const reason = code === 'ENOENT' ? 'rg binary not found (ENOENT), used Node workspace scan' : `rg failed (${String(code ?? err)}), used Node workspace scan`
    const scanned = await scanWithNode(rootReal, needles, entryStems)
    return { ...scanned, usedFallback: true as const, fallbackReason: reason }
  }
}

/** 提取目标文件 1-Hop 邻域客观切片（无硬编码阈值，零 LLM 成本）。 */
export async function sliceWorkspaceContext(request: SliceRequest): Promise<SliceResult> {
  const started = Date.now()
  const rootReal = await realpath(resolve(request.workspaceRoot))
  const targetFiles: string[] = []
  const seenTargets = new Set<string>()
  const targetContents: { file: string; content: string }[] = []
  const importedMap = new Map<string, ImportedSignatureBlock>()
  const derivedSymbols = new Set<string>((request.symbols ?? []).map(s => s.trim()).filter(Boolean))
  const entryStems: string[] = []

  for (const rawEntry of request.entryFiles ?? []) {
    const rel = await resolveSafeRepoFile(rootReal, resolve(rootReal, rawEntry))
    if (!rel || seenTargets.has(rel)) continue
    seenTargets.add(rel)
    targetFiles.push(rel)
    entryStems.push(basename(rel, extname(rel)))
    const content = await readFile(join(rootReal, rel), 'utf8')
    targetContents.push({ file: rel, content })
    for (const s of extractOwnSymbols(content)) derivedSymbols.add(s)
    for (const spec of parseRelativeImports(content)) {
      const resolvedMod = await resolveLocalImport(rel, spec, rootReal)
      if (!resolvedMod || importedMap.has(resolvedMod)) continue
      const sigs = extractExportedSignatures(await readFile(join(rootReal, resolvedMod), 'utf8'))
      importedMap.set(resolvedMod, { sourceFile: resolvedMod, importedFrom: spec, signatures: sigs })
    }
  }

  const needles = [...new Set([...derivedSymbols, ...entryStems.filter(s => s.length >= 2)])].filter(s => s !== '')
  const found = await searchWorkspace(rootReal, needles, entryStems, request)
  const callSites = found.hits.filter(h => !seenTargets.has(h.file))
  const importedSignatures = [...importedMap.values()]
  const importedTypesCount = importedSignatures.reduce((acc, b) => acc + b.signatures.length, 0)
  const haystack = [request.queryText ?? '', ...targetFiles, ...targetContents.map(t => t.content), ...importedSignatures.flatMap(b => [b.sourceFile, ...b.signatures]), ...callSites.map(c => `${c.file}:${c.line}: ${c.text}`), ...found.tests].join('\n')
  const matchedPitfalls = matchPitfalls(haystack, request.pitfallNotes ?? [])
  const provisional: SliceResult = {
    workspaceRoot: rootReal, targetFiles, targetContents, importedSignatures, callSites, relatedTests: found.tests, matchedPitfalls,
    usedFallback: found.usedFallback, ...(found.usedFallback ? { fallbackReason: found.fallbackReason } : {}),
    metrics: { targetFiles: targetFiles.length, importedTypesCount, callSiteCount: callSites.length, relatedTestsCount: found.tests.length, totalBytes: 0, durationMs: Date.now() - started },
  }
  const fullBytes = measureSectionsBytes(buildCapsuleSections(provisional))
  return { ...provisional, metrics: { ...provisional.metrics, totalBytes: fullBytes, durationMs: Date.now() - started } }
}
