import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assembleCapsule,
  matchPitfalls,
  sliceWorkspaceContext,
  type PitfallNote,
} from '../src/context/index.ts'
import { loadDepositPackage, runDepositCases } from '../src/judgement/index.ts'
import {
  adaptiveDispatchGate,
  createAdaptiveDispatchGate,
  createChangedPathsGate,
  createVerifyRerunGate,
  verifyChangedPathsGate,
  verifyRerunGate,
} from '../src/judgement/gates/index.ts'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ctx-slice-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'src', 'core'), { recursive: true })
  mkdirSync(join(root, 'src', 'app'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })

  writeFileSync(join(root, 'src', 'core', 'ledger.ts'), [
    'export interface LedgerEntry {',
    '  readonly id: string',
    '  readonly amount: number',
    '}',
    'export function formatEntry(entry: LedgerEntry): string {',
    '  const SECRET_INTERNAL_BODY = "internal-impl-should-be-stripped"',
    '  return `${entry.id}:${entry.amount}:${SECRET_INTERNAL_BODY}`',
    '}',
    'function privateHelper(): number { return 42 }',
  ].join('\n'))

  writeFileSync(join(root, 'src', 'core', 'billing.ts'), [
    "import { formatEntry, type LedgerEntry } from './ledger.ts'",
    'export function computeTotal(items: readonly LedgerEntry[]): number {',
    '  return items.reduce((sum, item) => sum + item.amount, 0)',
    '}',
    'export function renderSummary(entry: LedgerEntry): string {',
    '  return formatEntry(entry)',
    '}',
  ].join('\n'))

  writeFileSync(join(root, 'src', 'app', 'runner.ts'), [
    "import { computeTotal } from '../core/billing.ts'",
    'export function runBilling(): number {',
    '  return computeTotal([{ id: "x", amount: 10 }])',
    '}',
  ].join('\n'))

  writeFileSync(join(root, 'tests', 'billing.spec.ts'), [
    "import { computeTotal } from '../src/core/billing.ts'",
    'test("billing", () => computeTotal([]))',
  ].join('\n'))
  return root
}

describe('context slicer, pitfalls, and capsule budget', () => {
  it('extracts 1-hop signatures without bodies, call sites, related tests, and falls back cleanly without rg', async () => {
    const root = makeWorkspace()
    const notes: PitfallNote[] = [
      { id: 'hit-and', triggerKeys: ['computeTotal'], andKeys: ['LedgerEntry'], notKeys: ['DEPRECATED_SKIP'], content: '需保持只读投影契约', sourceRef: { seq: 1, id: 'm0-1' } },
      { id: 'excluded-not', triggerKeys: ['computeTotal'], notKeys: ['renderSummary'], content: '不应命中' },
    ]
    const slice = await sliceWorkspaceContext({
      workspaceRoot: root,
      entryFiles: ['src/core/billing.ts'],
      pitfallNotes: notes,
      rgBin: 'nonexistent-rg-binary-for-fallback-test',
    })
    expect(slice.usedFallback).toBe(true)
    expect(slice.fallbackReason).toContain('ENOENT')
    expect(slice.metrics.targetFiles).toBe(1)
    expect(slice.importedSignatures).toHaveLength(1)
    const sigText = slice.importedSignatures[0]!.signatures.join('\n')
    expect(sigText).toContain('export interface LedgerEntry')
    expect(sigText).toContain('export function formatEntry(entry: LedgerEntry): string;')
    expect(sigText).not.toContain('SECRET_INTERNAL_BODY')
    expect(sigText).not.toContain('privateHelper')
    expect(slice.callSites.some(c => c.file === 'src/app/runner.ts' && c.text.includes('computeTotal'))).toBe(true)
    expect(slice.relatedTests).toContain('tests/billing.spec.ts')
    expect(slice.matchedPitfalls.map(p => p.id)).toEqual(['hit-and'])

    // 用真实可执行脚本验证 execFile(rg) 非降级路径
    const binDir = mkdtempSync(join(tmpdir(), 'mock-rg-'))
    tempDirs.push(binDir)
    const mockRg = join(binDir, 'rg')
    writeFileSync(mockRg, [
      '#!/bin/sh',
      'if [ "$1" = "--files" ]; then',
      '  printf "src/core/billing.ts\\nsrc/app/runner.ts\\ntests/billing.spec.ts\\n"',
      'else',
      '  printf "src/app/runner.ts:3:  return computeTotal([{ id: \\"x\\", amount: 10 }])\\ntests/billing.spec.ts:2:test(\\"billing\\", () => computeTotal([]))\\n"',
      'fi',
    ].join('\n'))
    chmodSync(mockRg, 0o755)

    const rgSlice = await sliceWorkspaceContext({ workspaceRoot: root, entryFiles: ['src/core/billing.ts'], rgBin: mockRg })
    expect(rgSlice.usedFallback).toBe(false)
    expect(rgSlice.fallbackReason).toBeUndefined()
    expect(rgSlice.callSites).toHaveLength(1)
    expect(rgSlice.relatedTests).toEqual(['tests/billing.spec.ts'])
  })

  it('supports case-insensitive substring/word-boundary/AND/NOT pitfall matching and explicit overflow accounting', async () => {
    const notes: PitfallNote[] = [
      { id: 'wb-hit', triggerKeys: ['gate'], wordBoundary: true, content: 'word boundary ok' },
      { id: 'wb-miss', triggerKeys: ['gate'], wordBoundary: true, content: 'should not match delegate' },
    ]
    expect(matchPitfalls('call delegate now', notes)).toEqual([])
    expect(matchPitfalls('run GATE check', notes).map(n => n.id)).toEqual(['wb-hit', 'wb-miss'])

    const root = makeWorkspace()
    const slice = await sliceWorkspaceContext({
      workspaceRoot: root,
      entryFiles: ['src/core/billing.ts'],
      pitfallNotes: [{ id: 'p1', triggerKeys: ['computeTotal'], content: 'Pitfall detail' }],
      rgBin: 'nonexistent-rg',
    })
    const fit = assembleCapsule(slice, slice.metrics.totalBytes + 200)
    expect(fit.overflow).toBe(false)
    expect(fit.droppedItems).toEqual([])

    const tight = assembleCapsule(slice, 120)
    expect(tight.overflow).toBe(true)
    expect(tight.droppedItems.length).toBeGreaterThan(0)
    expect(tight.droppedItems.every(d => d.reason === 'budget-exceeded' && d.bytes > 0)).toBe(true)
    expect(tight.usedBytes).toBeLessThanOrEqual(120)
  })
})

describe('seed deposits and parameterized gates', () => {
  it('loads and passes red-green + mutation checks for all 3 seed deposits in deposits/', async () => {
    const repoRoot = resolve(import.meta.dirname, '..')
    const targets = [
      { dir: 'ticket-adaptive-dispatch', gate: adaptiveDispatchGate },
      { dir: 'verify-changed-paths', gate: verifyChangedPathsGate },
      { dir: 'verify-rerun', gate: verifyRerunGate },
    ] as const
    for (const t of targets) {
      const { admission, cases } = await loadDepositPackage(join(repoRoot, 'deposits', t.dir))
      expect(admission.admitted, `${t.dir} admission`).toBe(true)
      const report = await runDepositCases(t.gate as never, cases)
      expect(report.error, `${t.dir} report error`).toBeUndefined()
      expect(report.mutationPassed, `${t.dir} mutation`).toBe(true)
      expect(report.ok, `${t.dir} ok`).toBe(true)
    }
  })

  it('switches adaptive-dispatch behavior cleanly between fast-style and robust-style params', async () => {
    const mediumSlice = { targetFiles: 5, importedTypesCount: 8, callSiteCount: 12, relatedTestsCount: 3, totalBytes: 12000, durationMs: 25 }
    const fastGate = createAdaptiveDispatchGate({ solo_max_files: 10, max_capsule_bytes: 32000, default_thinking: 'low', escalate_after_fails: 3 })
    const robustGate = createAdaptiveDispatchGate({ solo_max_files: 3, max_capsule_bytes: 8000, default_thinking: 'medium', escalate_after_fails: 1 })

    const fastRes = await fastGate.gate({ metrics: mediumSlice, retryCount: 1 })
    expect(fastRes).toEqual({ kind: 'allow', produced: { executionMode: 'solo', thinkingTier: 'low' } })

    const robustRes = await robustGate.gate({ metrics: mediumSlice, retryCount: 1 })
    expect(robustRes.kind).toBe('allow')
    if (robustRes.kind === 'allow') {
      expect(robustRes.produced?.['executionMode']).toBe('team')
      expect(robustRes.produced?.['thinkingTier']).toBe('high')
      expect(String(robustRes.produced?.['escalateReason'])).toContain('solo_max_files')
    }
  })

  it('respects strict_untracked on verify.changed-paths and require_red_green on verify.rerun', async () => {
    const relaxedPaths = createChangedPathsGate({ strict_untracked: false })
    const pathsRes = await relaxedPaths.gate({
      allowedPaths: ['src/a.ts'], sessionDiffs: ['src/a.ts'], gitDirtyPaths: ['src/a.ts'], untrackedPaths: ['tmp/scratch.txt'],
    })
    expect(pathsRes.kind).toBe('allow')

    const noRedGreen = createVerifyRerunGate({ require_red_green: false })
    const rerunRes = await noRedGreen.gate({
      taskType: 'fix', builderRole: 'builder', claimedDone: true,
      rerun: { command: 'pnpm test', exitCode: 0, verifierRole: 'verifier' },
    })
    expect(rerunRes.kind).toBe('allow')
  })
})
