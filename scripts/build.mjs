import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ts from 'typescript'

const root = new URL('..', import.meta.url).pathname
const out = join(root, 'dist')
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
async function build(directory) {
  await mkdir(join(out, directory), { recursive: true })
  for (const entry of await readdir(join(root, 'src', directory), { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) { await build(file); continue }
    if (!file.endsWith('.ts')) continue
    const source = await readFile(join(root, 'src', file), 'utf8')
    const result = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true },
      fileName: file,
    })
    await writeFile(join(out, file.replace(/\.ts$/, '.js')), result.outputText.replaceAll(/(from\s+['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2'))
  }
}
await build('.')
console.log('构建完成：dist 仅含 JavaScript，宿主导入为相对路径。')
