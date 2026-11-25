/** 沉淀包安全落盘器：逐段 lstat 防软链逃逸、落盘前凭据拦截与完整元数据输出。 */
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { admitDeposit } from '../judgement/deposit.ts'
import { redactValue } from '../spine/redact.ts'
import { validateDepositDraft } from './funnel.ts'
import type { DepositDraft, WrittenDepositPackage } from './types.ts'

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

function isInsideDir(parentReal: string, childReal: string): boolean {
  const rel = relative(parentReal, childReal)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function assertNoSymlinkAt(targetPath: string, label: string): Promise<void> {
  try {
    const info = await lstat(targetPath)
    if (info.isSymbolicLink()) throw new Error(`拒绝访问符号链接路径 (${label}): ${targetPath}`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

async function assertNoSymlinkSegments(rootAbs: string, segments: readonly string[]): Promise<void> {
  let cursor = rootAbs
  for (const part of segments) {
    cursor = join(cursor, part)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new Error(`拒绝访问符号链接路径: ${segments.join('/')}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break
      throw err
    }
  }
}

/** 通过机器门、红绿用例与密钥拦截后，安全落盘为可被 loadDepositPackage 无损加载的标准沉淀包。 */
export async function writeDepositDraftPackage(rootDir: string, draft: DepositDraft): Promise<WrittenDepositPackage> {
  const check = validateDepositDraft(draft)
  if (!check.ok) {
    if (check.gate === 'machine') throw new Error(`机器门拒绝落盘：${check.violations.map(v => `${v.ruleId}(${v.field})`).join('; ')}`)
    throw new Error(check.message)
  }
  const secretScan = redactValue({
    name: draft.name, intent: draft.intent, rubricBody: draft.rubricBody,
    repairHint: draft.repairHint, exceptions: draft.exceptions, cases: draft.cases,
  })
  if (secretScan.redacted.length > 0) throw new Error(`拒绝落盘：检测到敏感凭据 (${secretScan.redacted.join(', ')})`)
  if (!SAFE_ID_RE.test(draft.id) || draft.id.includes('..')) throw new Error(`非法包目录名 "${draft.id}"`)

  const rootAbs = resolve(rootDir)
  await assertNoSymlinkAt(rootAbs, 'rootDir')
  await mkdir(rootAbs, { recursive: true })
  const rootReal = await realpath(rootAbs)
  const pkgTarget = resolve(rootReal, draft.id)
  if (relative(rootReal, pkgTarget) !== draft.id) throw new Error(`非法包目录路径 "${draft.id}"：疑似目录穿越`)

  await assertNoSymlinkSegments(rootReal, [draft.id, 'cases', 'cases.json'])
  await assertNoSymlinkSegments(rootReal, [draft.id, 'DEPOSIT.md'])
  const casesDir = join(pkgTarget, 'cases')
  await mkdir(casesDir, { recursive: true })
  const pkgReal = await realpath(pkgTarget)
  const casesReal = await realpath(casesDir)
  if (!isInsideDir(rootReal, pkgReal) || !isInsideDir(pkgReal, casesReal)) throw new Error(`包路径 "${draft.id}" 越出根目录`)

  const depositMdPath = join(pkgReal, 'DEPOSIT.md')
  const casesPath = join(casesReal, 'cases.json')
  await assertNoSymlinkAt(depositMdPath, 'DEPOSIT.md')
  await assertNoSymlinkAt(casesPath, 'cases.json')

  const manifest: Record<string, unknown> = {
    id: draft.id,
    version: draft.version,
    kind: draft.kind,
    point: draft.point,
    scope: draft.scope,
    requires: draft.requires,
    params: draft.params,
    trust: draft.scope === 'private' ? 'owner' : draft.scope === 'public' ? 'public' : 'collaborator',
    cases: 'cases/',
    actionClass: draft.actionClass,
    origin: { kind: draft.origin.kind, ...(draft.origin.refs ? { origin_refs: draft.origin.refs } : {}) },
    ...(draft.mandateRef ? { mandate_ref: draft.mandateRef } : {}),
    ...(draft.mandateCeiling ? { mandate_ceiling: draft.mandateCeiling } : {}),
    ...(draft.stage ? { stage: draft.stage } : {}),
    ...(draft.enforce !== undefined ? { enforce: draft.enforce } : {}),
    ...(draft.action ? { action: draft.action } : {}),
    ...(draft.kind === 'standing-order' ? { trigger: { signal: draft.trigger.signal ?? draft.trigger.on } } : {}),
  }
  const examplesMd = draft.cases.map(c => `- [${c.expected}] \`${c.name}\`${c.note ? `：${c.note}` : ''}`).join('\n')
  const exceptionsMd = draft.exceptions.length > 0 ? draft.exceptions.map(e => `- ${e}`).join('\n') : '暂无显式例外。'
  const depositMd = [
    '---', JSON.stringify(manifest, null, 2), '---',
    `## 意图\n${draft.intent.trim()}`,
    `## 判据\n${draft.rubricBody.trim() || draft.intent.trim()}`,
    `## 正例与反例\n${examplesMd}`,
    `## 例外\n${exceptionsMd}`,
    `## 被拦时的话\n${draft.repairHint.trim() || '请补充必需输入或修复不合规项后重试。'}`,
  ].join('\n\n') + '\n'

  const admission = admitDeposit(depositMd)
  if (!admission.admitted) throw new Error(`生成包自检未过准入：${admission.violations.map(v => `${v.rule}:${v.reason}`).join('; ')}`)
  const serializedCases = draft.cases.map(({ name, expected, ctx, expectedCause }) => ({
    name, expected, ctx, ...(expectedCause ? { expectedCause } : {}),
  }))
  await writeFile(depositMdPath, depositMd, 'utf8')
  await writeFile(casesPath, `${JSON.stringify(serializedCases, null, 2)}\n`, 'utf8')
  return { packageDir: pkgReal, depositMdPath, casesPath }
}
