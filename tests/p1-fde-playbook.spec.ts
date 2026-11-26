import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GovernanceRuntime } from '../src/app/governance.ts'
import { Store } from '../src/app/store.ts'
import type { Assignment, Ticket, Trigger } from '../src/core/index.ts'
import { prepareLaunchCapsule } from '../src/executor/capsule-hook.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import { PreExecuteCompletionGuard } from '../src/executor/pre-execute-gates.ts'
import {
  admitDeposit, captureRegistryGeneration, compileDeclarativeRuleFn, createJudgementRegistry,
  evaluatePointAtGeneration, matchDepositPlaybooks, parseDepositMarkdown,
  renderPlaybookCapsuleBlock, validateDeclarativeRule,
  type AnyGateDef,
} from '../src/judgement/index.ts'
import { KV } from '../src/kv.ts'

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true }) })

const FIVE_SECTIONS = `## 意图\n测试意图\n## 判据\n测试判据\n## 正反例\n正例与反例\n## 例外\n无例外\n## 修复指引\n按步骤修复`
const nowIso = () => new Date().toISOString()
const baseTicket = (id: string, execution: Ticket['execution'], assignments: Ticket['assignments']): Ticket => ({
  id, decisionId: `dec-${id}`, title: 'fix src/a.ts', createdAt: nowIso(), updatedAt: nowIso(),
  origin: { kind: 'trigger', triggerId: 'trig-1' } as unknown as Ticket['origin'],
  mandate: { scope: 'workspace:ws-main', strength: 'explicit', policyVersion: 'v1' } as unknown as Ticket['mandate'],
  channels: [], inputs: [], undelivered: [], assignments, execution,
})

describe('P1 Wave 2A: FDE Playbook, Ordered SOP, Retry Capsule & Worker Generations', () => {
  it('1. parses/admits FDE playbook frontmatter + section and rejects shell keys or noise', () => {
    const md = `---
id: fde.deploy-check
version: 1
kind: gate
point: verify.rerun
trust: owner
params: {}
cases: cases/
stage: observe
playbook:
  summary: 先跑类型检查再跑单测
  when:
    workspaces: [ws-app]
    globs: ["src/**/*.ts"]
    keywords: ["deploy"]
---
${FIVE_SECTIONS}
## 操作手册
1. 运行 tsc --noEmit
2. 运行 vitest run
`
    const parsed = parseDepositMarkdown(md)
    expect(parsed.playbookSection).toContain('运行 tsc --noEmit')
    const res = admitDeposit(md)
    expect(res.admitted).toBe(true)
    if (res.admitted) {
      expect(res.manifest.playbook?.summary).toBe('先跑类型检查再跑单测')
      expect(res.manifest.playbook?.steps).toEqual(['运行 tsc --noEmit', '运行 vitest run'])
    }

    const badShell = admitDeposit(`---
id: fde.bad-shell
version: 1
kind: gate
point: verify.rerun
trust: owner
params: {}
cases: cases/
playbook:
  summary: bad
  shell: rm -rf /
---
${FIVE_SECTIONS}`)
    expect(badShell.admitted).toBe(false)
    if (!badShell.admitted) expect(badShell.violations.some(v => v.rule === 'invalid-playbook')).toBe(true)
  })

  it('2. matches observe/enforce playbooks progressively under byte budget and records matchedPlaybooks in M0', async () => {
    const matched = matchDepositPlaybooks({
      deposits: [
        { id: 'pb-shadow', stage: 'shadow', playbook: { summary: 'shadow hidden' } },
        { id: 'pb-retired', stage: 'retired', playbook: { summary: 'retired hidden' } },
        { id: 'pb-glob', stage: 'enforce', playbook: { summary: 'TS 变更手册', when: { globs: ['src/**/*.ts'] }, steps: ['步骤一：检查类型', '步骤二：跑测试'] } },
        { id: 'pb-kw', stage: 'observe', playbook: { summary: '迁移注意事项', when: { keywords: ['migration'] }, steps: ['检查数据库 schema 版本'] } },
        { id: 'pb-default', stage: 'observe', playbook: { summary: '通用默认索引说明', steps: ['这是一个很长的默认操作步骤说明，用于验证超出预算时自动降级为单行索引'] } },
      ],
      workspace: 'ws-other',
      entryFiles: ['src/app/governance.ts'],
      title: 'normal bugfix',
    })
    expect(matched.map(m => m.id)).toEqual(['pb-glob', 'pb-default'])

    const fullRender = renderPlaybookCapsuleBlock(matched, 4096)
    expect(fullRender.fullIds).toEqual(['pb-glob', 'pb-default'])
    expect(fullRender.text).toContain('步骤一：检查类型')

    const tightBudget = Buffer.byteLength('## FDE 操作手册 (Playbooks)\n### pb-glob\nTS 变更手册\n1. 步骤一：检查类型\n2. 步骤二：跑测试\n', 'utf8') + 45
    const degraded = renderPlaybookCapsuleBlock(matched, tightBudget)
    expect(degraded.fullIds).toEqual(['pb-glob'])
    expect(degraded.indexOnlyIds).toEqual(['pb-default'])
    expect(degraded.text).toContain('- [pb-default] 通用默认索引说明')

    const wsDir = makeTempDir('p1-ws-')
    mkdirSync(join(wsDir, 'src'), { recursive: true })
    writeFileSync(join(wsDir, 'src/a.ts'), 'export const a = 1\n')
    const reg = createJudgementRegistry()
    const spineEvents: Record<string, unknown>[] = []
    const prep = await prepareLaunchCapsule({
      ticket: { id: 't-1', title: 'fix src/a.ts', assignments: [], execution: { workspace: 'ws-other', name: 'fix-a', directory: wsDir, assignment: 'fix src/a.ts' } },
      assignment: { id: 'a-1' },
      workspaceDir: wsDir,
      registry: reg,
      playbooks: [{ id: 'pb-glob', stage: 'enforce', playbook: { summary: 'TS 变更手册', when: { globs: ['src/**/*.ts'] }, steps: ['先跑 tsc'] } }],
      generationHash: 'gen-1234567890ab',
      recordSpine: d => spineEvents.push(d.payload),
    })
    expect(prep?.capsule.text).toContain('先跑 tsc')
    expect(prep?.matchedPlaybooks).toEqual(['pb-glob'])
    expect(spineEvents[0]?.['matchedPlaybooks']).toEqual(['pb-glob'])
    expect(spineEvents[0]?.['generationHash']).toBe('gen-1234567890ab')
  })

  it('3. enforces ordered workflow_sop checkpoints (dependsOn & enforceOrder) with honest unmeasured/deny/allow', () => {
    expect(validateDeclarativeRule({ kind: 'workflow_sop', steps: [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }] }).length).toBeGreaterThan(0)
    expect(validateDeclarativeRule({ kind: 'workflow_sop', steps: [{ id: 'a', dependsOn: ['missing'] }] }).length).toBeGreaterThan(0)

    const fn = compileDeclarativeRuleFn({
      kind: 'workflow_sop',
      checklistField: 'completedSteps',
      enforceOrder: true,
      steps: [{ id: 'plan' }, { id: 'implement', dependsOn: ['plan'] }, { id: 'verify', dependsOn: ['implement'] }],
    })
    expect(fn({})).toMatchObject({ kind: 'unmeasured', cause: 'missing-input' })
    expect(fn({ completedSteps: ['plan', 'verify', 'implement'] })).toMatchObject({ kind: 'deny' })
    expect(fn({ completedSteps: ['plan', 'implement', 'verify'] })).toMatchObject({ kind: 'allow' })
  })

  it('4. runs prepareCapsule on retry (told=true) and attaches capsule_refresh + dispatch_plan', async () => {
    const dir = makeTempDir('p1-dsh-')
    const store = new Store(join(dir, 'store.sqlite'))
    const wsDir = join(dir, 'ws')
    mkdirSync(wsDir, { recursive: true })
    const trigger = { id: 'trig-1', source: 'feishu', text: 'fix src/a.ts', at: nowIso(), threads: [], meta: {} } as unknown as Trigger
    store.triggers.save(trigger)
    const ticket = baseTicket(
      't-retry',
      { workspace: 'ws-main', name: 'fix-a', directory: wsDir, assignment: 'fix src/a.ts', executionMode: 'solo', thinkingTier: 'medium' },
      [
        { id: 'a-1', createdAt: nowIso(), startedAt: nowIso(), state: 'ended', endedReason: 'retried', report: { state: 'failed', summary: 'test failed', at: nowIso() } },
        { id: 'a-2', createdAt: nowIso(), startedAt: nowIso(), state: 'running' },
      ],
    )
    store.tickets.save(ticket)
    const prompts: string[] = []
    const ctx = new Context()
    const exec = new DshExecutor({
      context: ctx, store,
      engine: { assignmentStarted: vi.fn(), report: vi.fn(), failed: vi.fn() },
      closing: () => false, paused: () => false, machine: { stateDir: dir }, lifetime: new AbortController().signal,
      health: {}, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined,
      sessions: {
        ensure: async () => ({ id: 'worker-t-retry', inbox: { remove: vi.fn() } }),
        holds: async () => true,
        promptedId: (id: string) => id,
        prompt: async (_sid: string, _reqId: string, text: string, _mode: string, _before: () => void, onStart?: () => void) => { prompts.push(text); onStart?.() },
        applyWorkerDispatch: vi.fn(),
        relay: vi.fn(),
      },
      effects: { enqueue: vi.fn(), handle: vi.fn() },
      prepareCapsule: async () => ({
        verdict: { kind: 'allow' },
        dispatch: { executionMode: 'team', thinkingTier: 'high', escalateReason: 'retry>=1' },
        matchedPlaybooks: ['pb-retry'],
        capsule: {
          overflow: false, budgetBytes: 4096, usedBytes: 32, text: '## FDE 操作手册 (Playbooks)\n### pb-retry\n避坑',
          sections: [], matchedPitfalls: [{ id: 'pit-1', triggerKeys: ['a.ts'], content: '小心', matchedKeys: ['a.ts'] }],
          droppedItems: [], metrics: { targetFiles: 1, importedTypesCount: 0, callSiteCount: 0, relatedTestsCount: 0, totalBytes: 10, durationMs: 1 },
        },
        slice: { workspaceRoot: wsDir, targetFiles: ['src/a.ts'], targetContents: [], importedSignatures: [], callSites: [], relatedTests: [], matchedPitfalls: [], usedFallback: false, metrics: { targetFiles: 1, importedTypesCount: 0, callSiteCount: 0, relatedTestsCount: 0, totalBytes: 10, durationMs: 1 } },
      }),
    } as unknown as ConstructorParameters<typeof DshExecutor>[0])
    await (exec as unknown as { launch: (t: Ticket, a: Assignment) => Promise<void> }).launch(ticket, ticket.assignments[1]!)
    expect(prompts).toHaveLength(1)
    const payload = JSON.parse(prompts[0]!) as Record<string, unknown>
    expect(payload['dispatch_plan']).toMatchObject({ executionMode: 'team', thinkingTier: 'high' })
    expect(payload['capsule_refresh']).toMatchObject({ matchedPlaybooks: ['pb-retry'] })
    expect(store.tickets.get('t-retry')?.execution?.executionMode).toBe('team')
    expect(store.tickets.get('t-retry')?.execution?.thinkingTier).toBe('high')
    store.close()
  })

  it('5. locks worker registry generation so hot-promoted enforce rules do not tear in-flight assignments', async () => {
    const dir = makeTempDir('p1-gen-')
    const store = new Store(join(dir, 'store.sqlite'))
    const gov = new GovernanceRuntime({ store, stateDir: join(dir, 'state') })
    const reg = gov.registry
    const wsDir = join(dir, 'ws')
    mkdirSync(join(wsDir, 'src'), { recursive: true })
    writeFileSync(join(wsDir, 'src/a.ts'), 'export const a = 1\n')
    execFileSync('git', ['init'], { cwd: wsDir })
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'add', '.'], { cwd: wsDir })
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: wsDir })

    expect(captureRegistryGeneration(reg).hash).toMatch(/^gen-[0-9a-f]{12}$/)

    const hotGate: AnyGateDef = {
      kind: 'gate', id: 'verify.hot-secret-guard', version: 1, point: 'verify.secret-path-guard',
      description: 'hot secret guard', placement: { timing: 'pre', enforce: true }, requires: ['changedPaths'],
      gate: () => ({ kind: 'deny', blockers: ['blocked by hot rule'] }),
    }
    reg.register(hotGate, 'observe')

    const ticket = baseTicket(
      't-gen',
      { workspace: 'ws-main', name: 'fix-a', directory: wsDir, assignment: 'fix src/a.ts' },
      [{ id: 'a-1', createdAt: nowIso(), startedAt: nowIso(), state: 'running' }],
    )
    store.tickets.save(ticket)
    await gov.prepareLaunchCapsule({ ticket, assignment: ticket.assignments[0]!, workspaceDir: wsDir })
    const locked = store.get(KV.governance.ticketGenerations)?.['t-gen']
    expect(locked?.assignmentId).toBe('a-1')
    expect(locked?.stages['verify.hot-secret-guard']).toBe('observe')

    reg.unregister('verify.hot-secret-guard')
    reg.register(hotGate, 'enforce')

    const evInFlight = await evaluatePointAtGeneration(reg, 'verify.secret-path-guard', { changedPaths: ['src/a.ts'] }, locked)
    expect(evInFlight.verdict.kind).toBe('allow')
    expect(evInFlight.observed.some(o => o.id === 'verify.hot-secret-guard' && o.outcome === 'deny')).toBe(true)

    const ctx = new Context()
    const guard = new PreExecuteCompletionGuard({ context: ctx, store, registry: reg, autoInstall: false })
    const guardDec = await (guard as unknown as { evaluateCompletion: (id: string, exec: unknown, args: Record<string, unknown>, isReady: boolean) => Promise<unknown> })
      .evaluateCompletion('t-gen', { callId: 'c-1', name: 'orchestrator_report', signal: new AbortController().signal, agent: { id: 'worker-t-gen' } }, { declared_paths: [] }, true)
    expect(guardDec).toBe('allow')

    await gov.prepareLaunchCapsule({ ticket, assignment: { id: 'a-2', createdAt: nowIso(), startedAt: nowIso(), state: 'running' }, workspaceDir: wsDir })
    const locked2 = store.get(KV.governance.ticketGenerations)?.['t-gen']
    expect(locked2?.stages['verify.hot-secret-guard']).toBe('enforce')
    const evNew = await evaluatePointAtGeneration(reg, 'verify.secret-path-guard', { changedPaths: ['src/a.ts'] }, locked2)
    expect(evNew.verdict.kind).toBe('deny')

    await gov.shutdown()
    store.close()
  })
})
