/** 轻量级 TS 执行器：调用仓库内置 rolldown 将扩展语法编至 .artifacts/ 后交由 Node 原生运行。 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const [entry, ...rest] = process.argv.slice(2)
if (!entry) {
  console.error('Usage: node scripts/run-ts.mjs <entry.ts> [...args]')
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
const deps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
])
try {
  for (const d of readdirSync(resolve('node_modules/@deepseek-ai'))) deps.add(`@deepseek-ai/${d}`)
} catch { /* 忽略目录缺失 */ }

const outDir = resolve('.artifacts')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `${basename(entry, '.ts')}.mjs`)

execFileSync(resolve('node_modules/.bin/rolldown'), [
  resolve(entry), '--platform', 'node', '-f', 'esm', '-o', outFile, '--external', [...deps].join(','),
], { stdio: 'inherit' })

try {
  execFileSync(process.execPath, [outFile, ...rest.filter(a => a !== '--')], { stdio: 'inherit' })
} catch (err) {
  process.exit(typeof err === 'object' && err && 'status' in err && typeof err.status === 'number' ? err.status : 1)
}
