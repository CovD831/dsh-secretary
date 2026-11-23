import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { createJudgementRegistry } from '../src/judgement/index.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'
import { createSpineAppender, ensureSpineSchema } from '../src/spine/index.ts'
import {
  WORKSPACE_GC_GATE,
  checkMandateIsolation,
  createWorkspaceRegistry,
  executeWorkspaceGc,
  findWorktreeObservation,
  isBranchMergedIntoBase,
  observeWorktrees,
  planWorkspaceGc,
  provisionWorktree,
  registerDispatchIsolationGate,
  registerWorkspaceGcGate,
  runWorkspaceGc,
  type GcSubject,
  type WorkspaceDef,
} from '../src/workspaces/index.ts'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return stdout.trim()
}

async function initRepo(dir: string): Promise<{ repoDir: string; baseSha: string }> {
  const repoDir = join(dir, 'repo')
  mkdirSync(repoDir, { recursive: true })
  await git(repoDir, 'init', '-b', 'main')
  await git(repoDir, 'config', 'user.name', 'Test User')
  await git(repoDir, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(repoDir, 'README.md'), 'init\n')
  await git(repoDir, 'add', 'README.md')
  await git(repoDir, 'commit', '-m', 'init')
  return { repoDir, baseSha: await git(repoDir, 'rev-parse', 'HEAD') }
}

const makeWs = (repoDir: string, overrides: Partial<WorkspaceDef> = {}): WorkspaceDef => ({
  id: 'core-app', repository: repoDir, baseBranch: 'main', branchPrefix: 'agent/', isolation: 'I2', ...overrides,
})

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('workspaces zero-double-write registry & isolation pairing', () => {
  it('projects store.settings().workspaces, validates id/path, and stores KV.runtime.masters', () => {
    const dir = makeTempDir('ws-reg-')
    const repoDir = join(dir, 'repo')
    mkdirSync(repoDir, { recursive: true })
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    try {
      const registry = createWorkspaceRegistry(store)
      expect(registry.list()).toEqual([])

      const ws = makeWs(repoDir, { source: 'github', isolation: 'I1' })
      store.saveSettings(SettingsSchema.parse({ workspaces: [ws] }))
      expect(registry.list()).toEqual([ws])
      expect(registry.resolve({ execution: { name: 'fix-a', directory: join(dir, 'wt'), assignment: '', workspace: 'core-app' } })).toEqual(ws)
      expect(registry.resolve({ execution: { name: 'fix-a', directory: join(dir, 'wt'), assignment: '' } })).toBeUndefined()

      store.set(KV.runtime.masters, { 'core-app': 'master-core-app' })
      expect(store.get(KV.runtime.masters)).toEqual({ 'core-app': 'master-core-app' })

      expect(() => SettingsSchema.parse({ workspaces: [{ ...ws, id: 'Bad_Id' }] })).toThrow()
      expect(() => SettingsSchema.parse({ workspaces: [{ ...ws, repository: 'relative/path' }] })).toThrow()
      expect(() => SettingsSchema.parse({ workspaces: [ws, ws] })).toThrow(/Duplicate workspace IDs/)
    } finally { store.close() }
  })

  it('enforces Mandate x isolation ceiling so worktree never elevates I1/I2 permissions', async () => {
    const reg = createJudgementRegistry()
    registerDispatchIsolationGate(reg)
    const i1Ws = makeWs('/tmp/repo', { isolation: 'I1' })
    const i2Ws = makeWs('/tmp/repo', { isolation: 'I2' })
    const i4Ws = makeWs('/tmp/repo', { isolation: 'I4' })

    expect(checkMandateIsolation('read', i1Ws).kind).toBe('allow')
    expect(checkMandateIsolation('local-write', i1Ws).kind).toBe('deny')
    expect((await reg.evaluate('ticket.dispatch', { mandateCeiling: 'commit', workspace: i1Ws })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('ticket.dispatch', { mandateCeiling: 'push-branch', workspace: i2Ws })).verdict.kind).toBe('allow')
    expect((await reg.evaluate('ticket.dispatch', { mandateCeiling: 'merge', workspace: i2Ws })).verdict.kind).toBe('deny')
    expect((await reg.evaluate('ticket.dispatch', { mandateCeiling: 'merge', workspace: i4Ws })).verdict.kind).toBe('allow')
  })
})

describe('Orca true-branch worktree provisioning & DshExecutor integration', () => {
  it('provisions a true branch worktree, records branch.<name>.base and M0 event, and fails closed on bad base', async () => {
    const dir = makeTempDir('ws-prov-')
    const { repoDir, baseSha } = await initRepo(dir)
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    try {
      ensureSpineSchema(store.db)
      const appender = createSpineAppender(store)
      const targetDir = join(dir, 'worktrees', 'fix-bug-123456789012')
      const provisioned = await provisionWorktree({
        ticketId: '123456789012abcd', workspace: makeWs(repoDir), executionName: 'fix-bug-123456789012', targetDir, appender,
      })

      expect(provisioned).toMatchObject({ ticketId: '123456789012abcd', workspace: 'core-app', branch: 'agent/fix-bug-123456789012', base: baseSha })
      expect(provisioned.at.seq).toBeGreaterThan(0)
      expect(await git(targetDir, 'symbolic-ref', '--short', 'HEAD')).toBe('agent/fix-bug-123456789012')
      expect(await git(repoDir, 'config', '--get', 'branch.agent/fix-bug-123456789012.base')).toBe(baseSha)

      const row = store.db.prepare('SELECT value FROM event_spine WHERE seq = ?').get(provisioned.at.seq) as { value: string }
      expect(JSON.parse(row.value)).toMatchObject({ type: 'workspace.provisioned', stream: 'ticket:123456789012abcd', payload: { branch: 'agent/fix-bug-123456789012', base: baseSha } })

      const badTarget = join(dir, 'worktrees', 'bad-base')
      await expect(provisionWorktree({
        ticketId: 'bad-ticket', workspace: makeWs(repoDir, { baseBranch: 'nonexistent-branch' }), executionName: 'bad-base', targetDir: badTarget,
      })).rejects.toThrow()
      expect(existsSync(badTarget)).toBe(false)
    } finally { store.close() }
  })

  it('delegates DshExecutor.prepareDirectory to provisionWorktree and fails closed without blind retry on error', async () => {
    const dir = makeTempDir('ws-exec-')
    const { repoDir, baseSha } = await initRepo(dir)
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    const board = new HealthBoard()
    const effects = new Effects(store, board)
    try {
      store.saveSettings(SettingsSchema.parse({ workspaces: [makeWs(repoDir), makeWs(repoDir, { id: 'broken-ws', baseBranch: 'missing-ref' })] }))
      const ensure = vi.fn(async () => ({ inbox: { remove: vi.fn() } }) as never)
      const prompt = vi.fn(async () => {})
      const report = vi.fn((ticketId: string, payload: { state: string; summary: string }) => {
        const cur = store.tickets.get(ticketId)!
        const updated = { ...cur, assignments: cur.assignments.map((a, i) => i === cur.assignments.length - 1
          ? { ...a, state: 'ended' as const, report: { ...payload, state: payload.state as 'failed', at: new Date().toISOString() } } : a) }
        store.tickets.save(updated)
        return updated
      })
      const executor = new DshExecutor({
        context: {
          subprocess: { spawn: () => ({ done: Promise.resolve({ exitCode: 1 }), collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } }) },
          agents: { get: () => undefined },
        } as never,
        engine: { assignmentStarted: vi.fn(), inputsDelivered: vi.fn(), inputsRead: vi.fn(), turnEnded: vi.fn(), deliveryFailed: vi.fn(), report: report as never, assignmentInterrupted: vi.fn() },
        store, effects, health: board.claim('worker'), machine: { stateDir: dir }, lifetime: new AbortController().signal,
        sessions: { ensure, prompt, promptedId: id => id as never, relay: vi.fn(), holds: vi.fn(async () => false) },
        closing: () => false, paused: () => false, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined,
      })

      const goodDir = join(dir, 'work', 'feat-good-ticket123456')
      const goodTicket: Ticket = {
        id: 'ticket1234567890', title: 'Good worktree', decisionId: 'd1',
        mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
        channels: [], assignments: [{ id: 'a1', state: 'pending', createdAt: '2026-11-24T00:00:00.000Z' }],
        inputs: [], undelivered: [], createdAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:00:00.000Z',
        origin: { triggerId: 'tr1', triggerIds: ['tr1'] },
        execution: { name: 'feat-good-ticket123456', directory: goodDir, assignment: '', workspace: 'core-app' },
      }
      effects.start()
      store.tickets.save(goodTicket)
      executor.start(goodTicket, goodTicket.assignments[0]!)
      await effects.idle('launch')
      expect(ensure).toHaveBeenCalledOnce()
      expect(await git(goodDir, 'symbolic-ref', '--short', 'HEAD')).toBe('agent/feat-good-ticket123456')
      expect(await git(repoDir, 'config', '--get', 'branch.agent/feat-good-ticket123456.base')).toBe(baseSha)

      const badDir = join(dir, 'work', 'feat-bad-ticket999999')
      const badTicket: Ticket = {
        ...goodTicket, id: 'ticket9999999999',
        assignments: [{ id: 'a2', state: 'pending', createdAt: '2026-11-24T00:00:00.000Z' }],
        execution: { name: 'feat-bad-ticket999999', directory: badDir, assignment: '', workspace: 'broken-ws' },
      }
      store.tickets.save(badTicket)
      executor.start(badTicket, badTicket.assignments[0]!)
      await effects.idle('launch')
      expect(report).toHaveBeenCalledWith('ticket9999999999', expect.objectContaining({ state: 'failed' }))
      expect(existsSync(badDir)).toBe(false)
    } finally { store.close() }
  })
})

describe('workspace.gc red-green safety gate & safe execution', () => {
  const endedTicket = (id: string, directory: string): GcSubject['ticket'] => ({
    id, ended: { at: '2026-11-24T00:00:00.000Z', by: 'executor', outcome: 'completed' },
    execution: { name: id, directory, assignment: '', workspace: 'core-app' },
  })

  it('red-green: removes clean merged worktree & branch, keeps dirty / unmerged / unmeasured', async () => {
    const dir = makeTempDir('ws-gc-')
    const { repoDir } = await initRepo(dir)
    const ws = makeWs(repoDir)
    const reg = createJudgementRegistry()
    registerWorkspaceGcGate(reg)

    // 1. 已合并干净树 → allow → remove-worktree-and-branch → 真实移除目录与分支
    const mergedDir = join(dir, 'wt-merged')
    const mergedProv = await provisionWorktree({ ticketId: 't-merged', workspace: ws, executionName: 'merged-1', targetDir: mergedDir })
    writeFileSync(join(mergedDir, 'merged.txt'), 'ok\n')
    await git(mergedDir, 'add', 'merged.txt')
    await git(mergedDir, 'commit', '-m', 'merged work')
    await git(repoDir, 'merge', '--no-ff', mergedProv.branch, '-m', 'merge branch')

    const obs1 = findWorktreeObservation(await observeWorktrees(repoDir), mergedDir)
    const isMerged1 = await isBranchMergedIntoBase(repoDir, mergedProv.branch, 'main')
    expect(obs1?.dirty).toBe(false)
    expect(isMerged1).toBe(true)
    const gcRes1 = await runWorkspaceGc(repoDir, reg, { ticket: endedTicket('t-merged', mergedDir), tree: obs1, mergedIntoBase: isMerged1, now: '2026-11-24T00:05:00.000Z' })
    expect(gcRes1).toMatchObject({ removed: true, branchRemoved: true, plan: { kind: 'remove-worktree-and-branch', branch: mergedProv.branch } })
    expect(existsSync(mergedDir)).toBe(false)

    // 2. 有未提交脏文件 → deny → keep
    const dirtyDir = join(dir, 'wt-dirty')
    const dirtyProv = await provisionWorktree({ ticketId: 't-dirty', workspace: ws, executionName: 'dirty-1', targetDir: dirtyDir })
    writeFileSync(join(dirtyDir, 'uncommitted.txt'), 'wip\n')
    const obs2 = findWorktreeObservation(await observeWorktrees(repoDir), dirtyDir)
    expect(obs2?.dirty).toBe(true)
    expect(await planWorkspaceGc(reg, { ticket: endedTicket('t-dirty', dirtyDir), tree: obs2, mergedIntoBase: true, now: '2026-11-24T00:05:00.000Z' }))
      .toMatchObject({ kind: 'keep', because: { kind: 'deny' } })
    expect(existsSync(dirtyDir)).toBe(true)

    // 3. 分支未合并进 baseBranch → deny → keep；且 git branch -d 保底拒绝强删
    const unmergedDir = join(dir, 'wt-unmerged')
    const unmergedProv = await provisionWorktree({ ticketId: 't-unmerged', workspace: ws, executionName: 'unmerged-1', targetDir: unmergedDir })
    writeFileSync(join(unmergedDir, 'feature.txt'), 'unmerged\n')
    await git(unmergedDir, 'add', 'feature.txt')
    await git(unmergedDir, 'commit', '-m', 'unmerged commit')
    const obs3 = findWorktreeObservation(await observeWorktrees(repoDir), unmergedDir)
    const isMerged3 = await isBranchMergedIntoBase(repoDir, unmergedProv.branch, 'main')
    expect(obs3?.dirty).toBe(false)
    expect(isMerged3).toBe(false)
    expect(await planWorkspaceGc(reg, { ticket: endedTicket('t-unmerged', unmergedDir), tree: obs3, mergedIntoBase: isMerged3, now: '2026-11-24T00:05:00.000Z' }))
      .toMatchObject({ kind: 'keep', because: { kind: 'deny' } })
    const forcedBypass = await executeWorkspaceGc(repoDir, { kind: 'remove-worktree-and-branch', path: unmergedDir, branch: unmergedProv.branch })
    expect(forcedBypass).toMatchObject({ branchRemoved: false, branchPreserved: unmergedProv.branch })

    // 4. 状态未测清（dirty === undefined / mergedIntoBase === undefined / 损坏目录）→ unmeasured → keep
    expect(await planWorkspaceGc(reg, {
      ticket: endedTicket('t-unmeasured-1', dirtyDir),
      tree: { path: dirtyDir, branch: dirtyProv.branch, head: 'abc', dirty: undefined, locked: false, prunable: false },
      mergedIntoBase: true, now: '2026-11-24T00:05:00.000Z',
    })).toMatchObject({ kind: 'keep', because: { kind: 'unmeasured' } })
    expect(await planWorkspaceGc(reg, {
      ticket: endedTicket('t-unmeasured-2', dirtyDir),
      tree: { path: dirtyDir, branch: dirtyProv.branch, head: 'abc', dirty: false, locked: false, prunable: false },
      mergedIntoBase: undefined, now: '2026-11-24T00:05:00.000Z',
    })).toMatchObject({ kind: 'keep', because: { kind: 'unmeasured' } })

    rmSync(dirtyDir, { recursive: true, force: true })
    const brokenObs = findWorktreeObservation(await observeWorktrees(repoDir), dirtyDir)
    expect(brokenObs?.dirty).toBeUndefined()
    expect(await planWorkspaceGc(reg, { ticket: endedTicket('t-broken', dirtyDir), tree: brokenObs, mergedIntoBase: true, now: '2026-11-24T00:05:00.000Z' }))
      .toMatchObject({ kind: 'keep', because: { kind: 'unmeasured' } })

    expect((await WORKSPACE_GC_GATE.gate({
      ticket: { id: 'open-ticket', execution: { name: 'x', directory: unmergedDir, assignment: '' } },
      tree: { path: unmergedDir, branch: unmergedProv.branch, head: 'abc', dirty: false, locked: false, prunable: false },
      mergedIntoBase: true, now: '2026-11-24T00:05:00.000Z',
    })).kind).toBe('deny')
    expect((await WORKSPACE_GC_GATE.gate({
      ticket: endedTicket('locked-ticket', unmergedDir),
      tree: { path: unmergedDir, branch: unmergedProv.branch, head: 'abc', dirty: false, locked: true, prunable: false },
      mergedIntoBase: true, now: '2026-11-24T00:05:00.000Z',
    })).kind).toBe('deny')
  })
})
