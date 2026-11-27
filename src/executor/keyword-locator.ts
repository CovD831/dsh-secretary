/** 无显式路径时的关键词 rg/Node 源码定位辅助（与 capsule-hook 主流程解耦以控单文件行数）。 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export const DSH_BUNDLED_RG = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'lib', 'coverage', '.next', '.local'])
const CODE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|jsx|py|go|rs)$/

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

export async function locateFilesByKeywords(workspaceDir: string, keywords: readonly string[], rgBin?: string): Promise<string[]> {
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