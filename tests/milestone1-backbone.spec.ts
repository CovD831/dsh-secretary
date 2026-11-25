/** 里程碑 1 全链路红绿验证：中文秘书总线、三档沙箱审批、多工作区真建树+CoW、自然语言 rg 胶囊、Solo/Team 真切换与防烧钱熔断。 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '../src/app/ruling-queue.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { SpineEnvelope } from '../src/spine/types.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

const execFileAsync = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout.trim()
const tempDirs: string[] = []
afterEach(() => { while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true }) })

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

function readAllM0(memoryDir: string): SpineEnvelope<Record<string, unknown>>[] {
  const m0 = join(memoryDir, 'm0')
  if (!existsSync(m0)) return []
  return readdirSync(m0).filter(n => n.endsWith('.jsonl')).sort().flatMap(f =>
    readFileSync(join(m0, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as SpineEnvelope<Record<string, unknown>>),
  )
}

async function initWorkspaceRepo(root: string) {
  const repoDir = join(root, 'sample-ws')
  mkdirSync(join(repoDir, 'src', 'billing'), { recursive: true })
  mkdirSync(join(repoDir, 'tests'), { recursive: true })
  mkdirSync(join(repoDir, 'vendor-cache'), { recursive: true })
  writeFileSync(join(repoDir, 'src', 'billing', 'invoice.ts'), [
    'export interface InvoiceLine { readonly sku: string; readonly cents: number }',
    'export function computeInvoiceTotal(lines: readonly InvoiceLine[]): number {',
    '  return lines.reduce((sum, item) => sum + item.cents, 0)',
    '}',
  ].join('\n'))
  writeFileSync(join(repoDir, 'tests', 'invoice.spec.ts'), "import { computeInvoiceTotal } from '../src/billing/invoice.ts'\nexport const ok = computeInvoiceTotal([]) === 0\n")
  writeFileSync(join(repoDir, 'vendor-cache', 'dep.json'), '{"cached":true}\n')
  writeFileSync(join(repoDir, '.env'), 'SECRET_KEY=never_copy_me\n')
  await git(repoDir, 'init', '-b', 'main')
  await git(repoDir, 'config', 'user.name', 'Test'); await git(repoDir, 'config', 'user.email', 'test@example.com')
  await git(repoDir, 'add', 'src', 'tests'); await git(repoDir, 'commit', '-m', 'initial')
  return repoDir
}

describe('里程碑 1：原生秘书总线、三档权限沙箱与两层极速自适应派发', () => {
  it('1) 中文秘书五工具 + 桌面总线正门 + 封堵 orchestrator_eval_read 读仓破口 + settings/workspaces 全链路读写', async () => {
    const h = await startRuntime()
    try {
      const wsDir = await initWorkspaceRepo(makeTempDir('m1-ws-'))
      const getSettings = await h.api('GET', 'settings')
      expect(getSettings.status).toBe(200)
      expect((getSettings.body.blocks as Record<string, unknown>)['workspaces']).toEqual({ value: [], revision: 0 })

      // 通过 PUT settings/workspaces 保存多工作区配置（含 cowPaths、approvalMode、verifyCommands）
      const saveWs = await h.api('PUT', 'settings/workspaces', {
        revision: 0,
        value: [{
          id: 'billing',
          repository: wsDir,
          baseBranch: 'main',
          branchPrefix: 'sec/',
          isolation: 'I2',
          prepare: 'printf "prepared-ok" > .prepared-marker',
          approvalMode: 'smart-auto',
          cowPaths: ['vendor-cache', '.env'],
          verifyCommands: ['pnpm test'],
        }],
      })
      expect(saveWs.status).toBe(200)
      expect(h.runtime.settings.block('workspaces')).toMatchObject({
        revision: 1,
        value: [expect.objectContaining({ id: 'billing', approvalMode: 'smart-auto' })],
      })

      // 封堵主会话 orchestrator_eval_read 读文件/目录破口
      const masterTools = h.tools.get(h.runtime.masterId)!
      for (const name of ['secretary_say', 'secretary_ask', 'secretary_handover', 'secretary_dispatch', 'secretary_status']) {
        expect(masterTools.has(name), name).toBe(true)
      }
      await expect(h.runTool(h.runtime.masterId, 'orchestrator_eval_read', {
        trigger_id: 'any', resource: 'file', path: 'src/index.ts',
      })).rejects.toThrow()

      // 桌面主对话消息入站（trusted） vs 外部飞书入站（untrusted taint 绝不洗白为 derived/clean）
      const deskMsg = await h.api('POST', 'secretary/messages', { text: '帮我检查发票总价计算逻辑' })
      expect(deskMsg.status).toBe(200)
      h.runtime.receive(feishu('77', '@bot 外部用户消息'))
      await h.runtime.idle()

      // 秘书三说话工具 + 飞书薄出口转发 + 单件待裁队列
      const trFeishu = h.runtime.store.triggers.get('feishu:om_77')
      const sayRes = await h.runTool(h.runtime.masterId, 'secretary_say', {
        text: '收到，马上安排检查发票模块。', expression: 'working', ...(trFeishu ? { trigger_id: trFeishu.id } : {}),
      })
      expect(sayRes).toMatchObject({ ok: true })
      await expect(h.runTool(h.runtime.masterId, 'secretary_say', {
        text: '字'.repeat(41), expression: 'neutral',
      })).rejects.toThrow()

      const askRes = await h.runTool(h.runtime.masterId, 'secretary_ask', {
        question: '折扣行是否允许负数金额？',
        options: [
          { id: 'allow-neg', label: '允许负数抵扣', consequence: '总额保底为 0', recommended: true },
          { id: 'forbid-neg', label: '禁止负数', consequence: '遇到负值直接抛错', recommended: false },
        ],
      }) as { ok: boolean; ruling_id: string }
      expect(askRes.ok).toBe(true)

      const handoverRes = await h.runTool(h.runtime.masterId, 'secretary_handover', {
        conclusion: '已完成初步派单与边界梳理',
        reason: '需要确认负额折扣规则',
        impact: '影响结算模块边界断言',
        evidence_refs: [`ruling:${askRes.ruling_id}`],
      })
      expect(handoverRes).toMatchObject({ ok: true })

      const feed = await h.api('GET', 'secretary/feed')
      expect(feed.status).toBe(200)
      expect((feed.body.items as unknown[]).length).toBeGreaterThanOrEqual(4)
      expect(feed.body.activeRuling).toMatchObject({ id: askRes.ruling_id, kind: 'secretary_ask' })

      // 查不存在工单如实返回 found=false（没查到）
      expect(await h.runTool(h.runtime.masterId, 'secretary_status', { ticket_id: 'non-existent' }))
        .toMatchObject({ found: false, message: expect.stringContaining('没查到') })

      await h.runtime.governance.flush()
      const m0 = readAllM0(h.runtime.governance.memoryDir)
      const extTriggerEv = m0.find(e => e.type === 'trigger.received' && e.payload['triggerId'] !== deskMsg.body.triggerId)
      const deskTriggerEv = m0.find(e => e.type === 'trigger.received' && e.payload['triggerId'] === deskMsg.body.triggerId)
      expect(extTriggerEv?.taint).toBe('untrusted')
      expect(deskTriggerEv?.taint).toBe('trusted')
    } finally {
      await h.stop()
    }
  }, 20_000)

  it('2) 多工作区真分支 Worktree + CoW 依赖快拷（拒拷 .env）+ prepare 共存 + 自然语言关键词 rg 胶囊 + Solo/Team 与思考档真切换', async () => {
    const h = await startRuntime()
    try {
      const wsDir = await initWorkspaceRepo(makeTempDir('m1-launch-'))
      const presetCalls: [string, string][] = []
      const modelSelects: unknown[] = []
      const restrictHistory = new Map<string, { allow?: string[] }[]>()

      Object.assign(h.ctx.get('permissionPresets') as object, {
        set: (session: { id: string }, preset: string) => { presetCalls.push([session.id, preset]) },
      })
      const origCreate = h.controller.create
      h.controller.create = vi.fn(async (arg: { sessionId: string }) => {
        await origCreate(arg)
        const ag = h.agents.get(arg.sessionId) as unknown as {
          model?: { select: (s: unknown) => void }
          ctx: { tools: { get: (n: string) => unknown; restrict: (r: { allow?: string[] }) => () => void } }
        }
        ag.model = { select: s => { modelSelects.push([arg.sessionId, s]) } }
        ag.ctx.tools.get = (name: string) => ({ name })
        ag.ctx.tools.restrict = (rule: { allow?: string[] }) => {
          restrictHistory.set(arg.sessionId, [...(restrictHistory.get(arg.sessionId) ?? []), rule])
          return () => {}
        }
      })

      await h.api('PUT', 'settings/workspaces', {
        revision: 0,
        value: [{
          id: 'billing', repository: wsDir, baseBranch: 'main', branchPrefix: 'sec/', isolation: 'I2',
          prepare: 'printf "ready" > .prepared-ok', approvalMode: 'smart-auto',
          cowPaths: ['vendor-cache', '.env'], verifyCommands: ['pnpm test'],
        }],
      })
      await h.api('PUT', 'settings/executor', {
        revision: h.runtime.store.blockRevision('executor'),
        value: { ...h.runtime.store.settings().executor, model: { provider: 'mock-p', model: 'mock-m' } },
      })

      // 自然语言派单（不含字面文件路径 src/billing/invoice.ts，只提 computeInvoiceTotal 标识符！）
      const dispatched = await h.runTool(h.runtime.masterId, 'secretary_dispatch', {
        title: '核对发票汇总函数',
        objective: '检查 computeInvoiceTotal 在空数组与多行条目下的汇总结果',
        acceptance: '单测全部通过且无类型错误',
        verify_commands: ['pnpm test'],
        dispatch_key: 'billing-invoice-check',
        worktree_name: 'check-invoice-total',
        workspace: 'billing',
      }) as { ok: boolean; reused: boolean; ticket: { ticket_id: string } }
      expect(dispatched).toMatchObject({ ok: true, reused: false })
      const ticketId = dispatched.ticket.ticket_id

      // 同一 dispatch_key 再次派发幂等复用，不重复建单
      const reused = await h.runTool(h.runtime.masterId, 'secretary_dispatch', {
        title: '核对发票汇总函数',
        objective: '补充零金额边界检查',
        acceptance: '单测通过',
        verify_commands: ['pnpm test'],
        dispatch_key: 'billing-invoice-check',
        worktree_name: 'check-invoice-total',
        workspace: 'billing',
      })
      expect(reused).toMatchObject({ ok: true, reused: true, ticket: { ticket_id: ticketId } })

      await h.runtime.pump()
      await h.runtime.idle()

      const storedTicket = h.runtime.store.tickets.get(ticketId)!
      const wtDir = storedTicket.execution!.directory
      // 证明真分支 Worktree + CoW 快拷 + prepare 命令三者同时在 wtDir 内生效，且绝未拷贝 .env！
      expect(await git(wtDir, ' symbolic-ref', '--short', 'HEAD').catch(() => git(wtDir, 'rev-parse', '--abbrev-ref', 'HEAD')))
        .toMatch(/^sec\/check-invoice-total-/)
      expect(existsSync(join(wtDir, 'vendor-cache', 'dep.json'))).toBe(true)
      expect(existsSync(join(wtDir, '.env'))).toBe(false)
      expect(h.subprocess.spawn).toHaveBeenCalledWith(expect.objectContaining({
        cwd: wtDir,
        argv: expect.arrayContaining(['printf "ready" > .prepared-ok']),
      }))

      // 证明关键词 rg 胶囊定位到了 src/billing/invoice.ts，且简单单选了 solo + low 思考档并收紧 team_task_* 工具！
      expect(storedTicket.execution).toMatchObject({ workspace: 'billing', executionMode: 'solo', thinkingTier: 'low' })
      const workerId = `worker-${ticketId}`
      const launchMsg = h.deliveries.mock.calls.find(([c]) => c.sessionId === workerId)![0]
      const launchPayload = JSON.parse(launchMsg.text) as { dispatch_plan: unknown; context_capsule: { text: string } }
      expect(launchPayload.dispatch_plan).toEqual({ executionMode: 'solo', thinkingTier: 'low' })
      expect(launchPayload.context_capsule.text).toContain('src/billing/invoice.ts')
      expect(launchPayload.context_capsule.text).toContain('```verify\npnpm test\n```')

      const lastSoloAllow = restrictHistory.get(workerId)!.at(-1)!.allow!
      expect(lastSoloAllow).not.toContain('team_task_create')
      expect(presetCalls).toContainEqual([workerId, 'workspace-write'])
      expect(modelSelects).toContainEqual([workerId, { provider: 'mock-p', model: 'mock-m', reasoningEffort: 'low' }])

      // 当同一类任务返工达到阈值（>=2 次失败重试）时，自动升档为 team + high 思考档并解锁 team_task_*！
      const teamTicket = {
        ...storedTicket,
        id: 'tk-team-escalate',
        execution: { ...storedTicket.execution!, name: 'team-escalate-tk', directory: join(wtDir, '..', 'team-escalate-tk') },
        assignments: [
          { id: 'f1', state: 'ended' as const, createdAt: '1', endedReason: 'retried', report: { state: 'failed' as const, summary: 'err1', at: '1' } },
          { id: 'f2', state: 'ended' as const, createdAt: '2', endedReason: 'retried', report: { state: 'failed' as const, summary: 'err2', at: '2' } },
          { id: 'f3', state: 'pending' as const, createdAt: '3' },
        ],
      }
      h.runtime.store.tickets.save(teamTicket)
      h.runtime.executor.start(teamTicket, teamTicket.assignments[2]!)
      await h.runtime.pump()
      await h.runtime.idle()

      const updatedTeam = h.runtime.store.tickets.get('tk-team-escalate')!
      expect(updatedTeam.execution).toMatchObject({ executionMode: 'team', thinkingTier: 'high' })
      const teamWorkerId = 'worker-tk-team-escalate'
      expect(restrictHistory.get(teamWorkerId)!.at(-1)!.allow).toEqual(expect.arrayContaining([
        'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update', 'wait_agent',
      ]))
      expect(modelSelects).toContainEqual([teamWorkerId, { provider: 'mock-p', model: 'mock-m', reasoningEffort: 'high' }])
    } finally {
      await h.stop()
    }
  }, 25_000)

  it('3) 三档权限（smart-auto / always-ask / full-trust）+ approval/request 单件待裁闭环 + 轮次/Token 熔断 + 外部副作用崩溃停在 unknown', async () => {
    const h = await startRuntime()
    try {
      const { ticket, sessionId } = await h.acceptedTicket(feishu('88', '@bot 修复构建脚本'))
      const agent = h.agents.get(sessionId)!
      const wtDir = ticket.execution!.directory

      const firePreExecute = (name: string, args: unknown) =>
        h.ctx.waterfall('tools/pre-execute', {
          callId: `call-${Math.random()}` as never, rootCallId: 'r1' as never, token: Symbol() as never,
          name, arguments: args, agent: agent as never, signal: new AbortController().signal,
        }, async (): Promise<PreToolDecision> => ({ kind: 'allow' }))

      // 默认 smart-auto：Worktree 内写普通代码直放，越界写或 git push 触发 ask 并记录校准对
      expect(await firePreExecute('write', { file_path: join(wtDir, 'src/ok.ts') })).toEqual({ kind: 'allow' })
      expect(await firePreExecute('write', { file_path: '/etc/hosts' })).toMatchObject({ kind: 'ask' })
      expect(await firePreExecute('bash', { command: 'git push origin HEAD' })).toMatchObject({ kind: 'ask' })

      // 切换 always-ask：连 Worktree 内普通写也触发 ask
      const putAlways = await h.api('PUT', 'settings/executor', {
        revision: h.runtime.store.blockRevision('executor'),
        value: { ...h.runtime.store.settings().executor, approvalMode: 'always-ask', maxTokens: 500 },
      })
      expect(putAlways.status).toBe(200)
      expect(await firePreExecute('write', { file_path: join(wtDir, 'src/ok.ts') })).toMatchObject({ kind: 'ask' })

      // 切换 full-trust：高危命令直放
      const putTrust = await h.api('PUT', 'settings/executor', {
        revision: h.runtime.store.blockRevision('executor'),
        value: { ...h.runtime.store.settings().executor, approvalMode: 'full-trust', maxTokens: 500 },
      })
      expect(putTrust.status).toBe(200)
      expect(await firePreExecute('bash', { command: 'git push origin HEAD' })).toEqual({ kind: 'allow' })

      // DSH approval/request 汇入统一单件待裁队列，老板拍板 approve 异步返回 allowed-once 并落盘四分归因
      const pendingApproval = h.ctx.waterfall('approval/request', {
        agent: agent as never, toolName: 'bash', callId: 'call-push-1' as never, reason: '执行 git push',
      }, async (): Promise<ApprovalOutcome> => 'unavailable')
      await vi.waitFor(async () => {
        const q = await h.api('GET', 'rulings?status=pending')
        expect(q.body.active).toMatchObject({ kind: 'dsh_approval', toolName: 'bash' })
      })
      const activeId = ((await h.api('GET', 'rulings')).body.active as { id: string }).id
      const decided = await h.api('POST', `rulings/${activeId}/decide`, {
        decision: 'approve', attribution: 'missing_rule', note: '允许推送测试分支',
      })
      expect(decided.status).toBe(200)
      expect(await pendingApproval).toBe('allowed-once')

      // 记录外部副作用后若宿主重启：严禁盲目自动重跑，必须停在 blocked + unknown_side_effect 待裁！
      h.ctx.emit('tools/result', {
        callId: 'call-push-1' as never, rootCallId: 'call-push-1' as never, token: Symbol() as never,
        name: 'bash', arguments: { command: 'git push origin main' }, agent: agent as never, signal: new AbortController().signal,
      }, { isError: false, value: {}, content: [] })
      expect(h.runtime.store.tickets.get(ticket.id)!.execution?.externalSideEffects).toContain('bash:git push')

      h.runtime.executor.resume()
      await vi.waitFor(() => {
        const afterResume = h.runtime.store.tickets.get(ticket.id)!
        expect(afterResume.assignments).toHaveLength(1)
        expect(afterResume.assignments[0]!.report?.state).toBe('blocked')
        expect(afterResume.assignments[0]!.report?.summary).toContain('unknown')
      })
      expect(h.runtime.governance.rulings.list('pending').some(r => r.escalationType === 'unknown_side_effect')).toBe(true)

      // 另起一单验证单工单 Token 超限防烧钱熔断硬停！
      const { ticket: runawayTk, sessionId: runawaySid } = await h.acceptedTicket(feishu('89', '@bot 跑个大重构'))
      const runawayAgent = h.agents.get(runawaySid)!
      const runawaySession = (runawayAgent as unknown as { session: unknown }).session
      h.ctx.emit('session/event', runawaySession as never, {
        type: 'assistant/message',
        data: { usage: { inputTokens: 400, outputTokens: 250, totalTokens: 650 } },
      } as never)
      expect(runawayAgent.cancel).toHaveBeenCalled()
      expect(h.runtime.store.tickets.get(runawayTk.id)!.assignments[0]!.report?.state).toBe('blocked')
      expect(h.runtime.governance.rulings.list('pending').some(r => r.ticketId === runawayTk.id && r.escalationType === 'runaway_breaker')).toBe(true)

      await h.runtime.governance.flush()
      const m0 = readAllM0(h.runtime.governance.memoryDir)
      expect(m0.some(e => e.type === 'gate.calibrated_pre_screen')).toBe(true)
      expect(m0.some(e => e.type === 'escalation.ruled' && e.payload['attribution'] === 'missing_rule')).toBe(true)
      expect(m0.some(e => e.type === 'ticket.circuit_broken')).toBe(true)
    } finally {
      await h.stop()
    }
  }, 20_000)
})
