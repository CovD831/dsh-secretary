import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { GovernanceRuntime } from '../src/app/governance.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'
import { extractCandidatePaths, extractSearchKeywords, prepareLaunchCapsule } from '../src/executor/capsule-hook.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { compileDeclarativeEntry } from '../src/judgement/declarative.ts'
import { createJudgementRegistry } from '../src/judgement/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { readDepositsProjection, readSpineProjection } from '../src/projection/index.ts'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []
const makeTempDir = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(d)
  return d
}
const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout.trim()

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('P3 capsule pollution, worktree double-prepare, and domain-agnostic kernel', () => {
  it('1. strips verify code blocks & node_modules, and recalls src/app/ruling-queue.ts for oral Chinese', async () => {
    const query = '哎，帮我叫人去项目里查一下，咱们待办拍板队列最多存多少条记录？'
    const assignment = `${query}\n\n## 标准验证命令\n\`\`\`verify\n./node_modules/.bin/tsc --noEmit\n\`\`\`\n`
    const candidates = extractCandidatePaths([query, assignment])
    expect(candidates).not.toContain('node_modules/.bin/tsc')

    const keywords = extractSearchKeywords([query, assignment])
    expect(keywords.length).toBeLessThanOrEqual(14)
    expect(keywords).toContain('队列')

    const reg = createJudgementRegistry()
    const ticket: Pick<Ticket, 'id' | 'title' | 'assignments' | 'execution'> = {
      id: 't-cn-recall',
      title: query,
      assignments: [{ id: 'a1', state: 'pending', createdAt: '2026-11-26T00:00:00Z' }],
      execution: { name: 'cn-recall', directory: process.cwd(), assignment },
    }
    const prepared = await prepareLaunchCapsule({
      ticket,
      assignment: ticket.assignments[0]!,
      workspaceDir: process.cwd(),
      triggerText: query,
      registry: reg,
    })
    expect(prepared).toBeDefined()
    expect(prepared!.slice.targetFiles).not.toContain('node_modules/.bin/tsc')
    expect(prepared!.slice.targetFiles).toContain('src/app/ruling-queue.ts')
  })

  it('2. avoids global executor.prepare when structured workspace is bound, while running workspace.prepare', async () => {
    const root = makeTempDir('dsh-double-prep-')
    const repoDir = join(root, 'repo')
    const stateDir = join(root, 'state')
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(repoDir, 'README.md'), '# test\n')
    await git(repoDir, 'init', '-b', 'main')
    await git(repoDir, 'config', 'user.name', 'Test')
    await git(repoDir, 'config', 'user.email', 'test@example.com')
    await git(repoDir, 'add', '.')
    await git(repoDir, 'commit', '-m', 'init')

    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    store.saveSettings(SettingsSchema.parse({
      executor: { prepare: 'echo GLOBAL_SHOULD_NOT_RUN && exit 1' },
      workspaces: [{
        id: 'app',
        repository: repoDir,
        baseBranch: 'main',
        branchPrefix: 'agent/',
        isolation: 'I2',
        prepare: 'touch ws-hook-ran.txt',
      }],
    }))
    const wtDir = join(stateDir, 'wts', 't-ws-prep')
    const ticket: Ticket = {
      id: 't-ws-prep', title: 'test ws prepare', decisionId: 'd1', channels: [], undelivered: [],
      createdAt: '2026-11-26T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z',
      mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'u1' }, scope: 'test' },
      origin: { triggerId: 'tr1', triggerIds: ['tr1'] },
      assignments: [{ id: 'a1', state: 'pending', createdAt: '2026-11-26T00:00:00Z' }],
      inputs: [],
      execution: { name: 't-ws-prep', directory: wtDir, assignment: 'do work', workspace: 'app' },
    }
    const spawnedArgvs: string[][] = []
    const subprocess = {
      spawn: (spec: { argv: readonly string[]; cwd?: string }) => {
        spawnedArgvs.push([...spec.argv])
        const p = spec.argv[0] === 'sh'
          ? execFileAsync(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd }).then(
              r => ({ exitCode: 0, stdout: r.stdout, stderr: r.stderr }),
              () => ({ exitCode: 1, stdout: '', stderr: 'failed' }),
            )
          : Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
        return {
          done: p.then(r => ({ exitCode: r.exitCode })),
          collected: {
            stdout: { readFrom: async () => ({ text: (await p).stdout }) },
            stderr: { readFrom: async () => ({ text: (await p).stderr }) },
          },
        }
      },
    }
    const controller = new AbortController()
    const exec = new DshExecutor({
      context: { agents: { get: () => undefined }, on: () => () => {}, subprocess } as never,
      engine: { assignmentStarted: () => {}, inputsDelivered: () => {}, inputsRead: () => {}, turnEnded: () => {}, deliveryFailed: () => {}, report: () => ticket, assignmentInterrupted: () => {} },
      store, effects: new Effects(store, new HealthBoard()), health: new HealthBoard().claim('worker'),
      machine: { stateDir }, lifetime: controller.signal,
      sessions: { ensure: async () => ({ inbox: { remove: () => false } }) as never, prompt: async () => {}, holds: async () => false, relay: () => {}, promptedId: id => id as never },
      closing: () => false, paused: () => false, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined,
    })
    await (exec as unknown as { prepareDirectory(t: Ticket): Promise<void> }).prepareDirectory(ticket)
    expect(existsSync(join(wtDir, 'README.md'))).toBe(true)
    expect(existsSync(join(wtDir, 'ws-hook-ran.txt'))).toBe(true)
    expect(spawnedArgvs.some(a => a.join(' ').includes('GLOBAL_SHOULD_NOT_RUN'))).toBe(false)
    controller.abort()
    store.close()
  })

  it('3. ships clean GovernanceRuntime without OSS gates and triggers custom intake.received / outbox.send gates', async () => {
    const stateDir = makeTempDir('gov-clean-kernel-')
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    const gov = new GovernanceRuntime({ store, stateDir })
    await gov.recover()

    const ids = gov.registry.list().map(e => e.id)
    expect(ids).not.toContain('intake.bug-quadruple')
    expect(ids).not.toContain('verify.repro-evidence')
    expect(ids).not.toContain('outward.reply-desk')
    const deps = await readDepositsProjection(store, stateDir)
    expect(deps.admittedCount).toBe(11)

    gov.registry.register(compileDeclarativeEntry({
      id: 'user.intake-nonempty', kind: 'gate', version: 1, point: 'intake.received',
      trust: 'owner', stage: 'enforce', enforce: true, params: {}, prose: 'test',
      requires: ['body'],
      rule: { kind: 'predicates', mode: 'all', clauses: [{ path: 'body', op: 'non_empty', message: 'body required' }] },
      cases: 'cases.json',
    }), 'enforce')
    gov.registry.register(compileDeclarativeEntry({
      id: 'user.outbox-nonempty', kind: 'gate', version: 1, point: 'outbox.send',
      trust: 'owner', stage: 'enforce', enforce: true, params: {}, prose: 'test',
      requires: ['body'],
      rule: { kind: 'predicates', mode: 'all', clauses: [{ path: 'body', op: 'non_empty', message: 'outbox body required' }] },
      cases: 'cases.json',
    }), 'enforce')

    store.triggers.save({
      id: 'tr-custom-1', source: 'feishu', threads: [{ source: 'feishu', id: 'c1' }],
      actor: { source: 'feishu', id: 'u1' }, human: true, at: '2026-11-26T00:00:00Z', text: '', meta: {},
    })
    gov.recordDomainEvent({ type: 'trigger.received', at: '2026-11-26T00:00:00Z', data: { triggerId: 'tr-custom-1', threads: ['feishu:c1'] } })
    const outVerdict = await gov.evaluateOutbound({ id: 'out-1', channel: { source: 'feishu', target: 'c1' } as never, text: '', kind: 'reply' })
    expect(outVerdict.kind).toBe('deny')
    await gov.flush()

    const spine = await readSpineProjection(store, stateDir, { type: 'gate.evaluated', limit: 20 })
    expect(spine.items.some(e => (e.payload as Record<string, unknown>)['point'] === 'intake.received')).toBe(true)
    expect(spine.items.some(e => (e.payload as Record<string, unknown>)['point'] === 'outbox.send')).toBe(true)

    await gov.shutdown()
    store.close()
  })

  it('4. admits disk-installed outbox.send & OSS-same-ID deposit packages under <stateDir>/deposits/', async () => {
    const stateDir = makeTempDir('gov-disk-deposits-')
    const outboxPkgDir = join(stateDir, 'deposits', 'user-outbox-guard')
    const ossPkgDir = join(stateDir, 'deposits', 'user-oss-override')
    mkdirSync(join(outboxPkgDir, 'cases'), { recursive: true })
    mkdirSync(join(ossPkgDir, 'cases'), { recursive: true })

    writeFileSync(join(outboxPkgDir, 'DEPOSIT.md'), `---\n${JSON.stringify({
      id: 'outbox.no-secret-token', version: 1, kind: 'gate', point: 'outbox.send',
      trust: 'owner', cases: 'cases/', stage: 'enforce', enforce: true, side: 'hard',
      placement: { timing: 'pre', enforce: true }, actionClass: 'block', requires: ['body'], params: {},
      rule: { kind: 'predicates', mode: 'all', clauses: [{ path: 'body', op: 'matches', value: '^safe:', message: 'must start with safe:' }] },
    }, null, 2)}\n---\n\n## 意图\n禁止外发未标记 safe: 的内容。\n\n## 判据\n不匹配 ^safe: 返回 deny。\n\n## 正反例\n见 cases。\n\n## 例外\n无。\n\n## 修复指引\n请以 safe: 开头。\n`)
    writeFileSync(join(outboxPkgDir, 'cases', 'cases.json'), JSON.stringify([
      { name: 'ok', expected: 'allow', ctx: { body: 'safe: hello world' } },
      { name: 'bad', expected: 'deny', ctx: { body: 'TOP_SECRET' } },
    ], null, 2))

    writeFileSync(join(ossPkgDir, 'DEPOSIT.md'), `---\n${JSON.stringify({
      id: 'intake.bug-quadruple', version: 1, kind: 'gate', point: 'intake.received',
      trust: 'owner', cases: 'cases/', stage: 'observe', enforce: false, side: 'hard',
      placement: { timing: 'pre', enforce: false }, actionClass: 'block', requires: ['body'], params: {},
      rule: { kind: 'predicates', mode: 'all', clauses: [{ path: 'body', op: 'non_empty', message: 'body required' }] },
    }, null, 2)}\n---\n\n## 意图\n用户显式安装的同名包应正常准入。\n\n## 判据\n非空放行。\n\n## 正反例\n见 cases。\n\n## 例外\n无。\n\n## 修复指引\n请补充正文。\n`)
    writeFileSync(join(ossPkgDir, 'cases', 'cases.json'), JSON.stringify([
      { name: 'ok', expected: 'allow', ctx: { body: 'bug report' } },
      { name: 'bad', expected: 'deny', ctx: { body: '' } },
    ], null, 2))

    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    const gov = new GovernanceRuntime({ store, stateDir })
    await gov.recover()

    const regIds = gov.registry.list().map(e => e.id)
    expect(regIds).toContain('outbox.no-secret-token')
    expect(regIds).toContain('intake.bug-quadruple')

    const ledger = readFileSync(join(stateDir, 'deposits', 'LEDGER.md'), 'utf8')
    expect(ledger).toContain('outbox.no-secret-token')
    expect(ledger).toContain('intake.bug-quadruple')

    const proj = await readDepositsProjection(store, stateDir)
    expect(proj.admittedCount).toBe(13)
    expect(proj.items.find(i => i.id === 'outbox.no-secret-token')?.admitted).toBe(true)
    expect(proj.items.find(i => i.id === 'intake.bug-quadruple')?.admitted).toBe(true)

    const blocked = await gov.evaluateOutbound({ id: 'm-sec', channel: { source: 'feishu', target: 'c1' } as never, text: 'TOP_SECRET', kind: 'reply' })
    expect(blocked.kind).toBe('deny')

    await gov.shutdown()
    store.close()
  })
})
