/** 原生会话有序工具链提取与 FDE 工作流 SOP 半自动提炼器（Trace-to-SOP Miner）。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { DepositDraft, DepositFixtureCase } from '../authoring/types.ts'
import type { CommandCheckConfig } from '../judgement/types.ts'
import { redactValue } from '../spine/redact.ts'
import type { SpineEnvelope } from '../spine/types.ts'
import type { JoinedSessionMetricRow, LabelledEventRecord, ReplayCase, SessionStepPhase, SessionStepTrace } from './types.ts'

export interface MineWorkflowSopInput {
  readonly events: readonly SpineEnvelope[]
  readonly joinedSessionMetrics: readonly JoinedSessionMetricRow[]
  readonly replayCases?: readonly ReplayCase[]
  readonly labelHits?: readonly LabelledEventRecord[]
  readonly minSupport?: number
}

const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'bash_persistent', 'pwsh_persistent', 'run_command'])
const LOCATE_TOOLS = new Set(['read', 'read_file', 'view_file', 'glob', 'grep', 'grep_search', 'rg', 'find', 'find_by_name', 'list', 'list_dir', 'ls', 'search'])
const EDIT_TOOLS = new Set(['edit', 'write', 'edit_file', 'write_file', 'replace_file_content', 'multi_replace_file_content', 'apply_patch', 'notebook_edit'])
const VERIFY_CMD_RE = /\b(vitest|jest|mocha|pytest|tsc|typecheck|eslint|lint|tsdown|build|test|check)\b/i
const LOCATE_CMD_RE = /^(?:rg|grep|find|ls|cat|head|tail|git\s+(?:status|log|diff|show))\b/i
const EDIT_CMD_RE = /^(?:sed|awk|tee|mv|cp|mkdir|rm|touch|git\s+(?:add|commit|apply))\b/i
const isRec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return redactValue(raw).value
  try { return redactValue(JSON.parse(raw)).value } catch { return redactValue(raw).value }
}

function topDirOf(args: unknown): string {
  if (!isRec(args)) return 'workspace'
  const rawPath = args['file_path'] ?? args['path'] ?? args['filePath'] ?? args['TargetFile'] ?? args['Directory'] ?? args['SearchPath'] ?? args['dir']
  if (typeof rawPath !== 'string' || !rawPath.trim()) return 'workspace'
  const segs = rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean)
  if (segs.length <= 1) return segs[0]?.includes('.') ? 'root' : (segs[0] || 'workspace')
  return segs[0]!.replace(/[^a-zA-Z0-9._-]/g, '') || 'workspace'
}

function normalizeShellCommand(rawCmd: string): { phase: SessionStepPhase; skeleton: string } {
  const scrubbed = redactValue(rawCmd).value.replace(/^(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)+/, '').trim()
  const unwrapped = scrubbed.replace(/^(?:pnpm|npm\s+run|npx|yarn|bun)\s+/, '').trim()
  let skeleton = 'shell:exec'
  if (/\bvitest\b/i.test(scrubbed)) skeleton = 'vitest run'
  else if (/\b(tsc|typecheck)\b/i.test(scrubbed)) skeleton = /\btsc\b/i.test(scrubbed) && !scrubbed.includes('--noEmit') ? 'tsc' : 'tsc --noEmit'
  else if (/\btsdown\b/i.test(scrubbed)) skeleton = 'tsdown'
  else if (/^(?:pnpm|npm|yarn|bun)\s+test\b/i.test(scrubbed)) skeleton = 'pnpm test'
  else if (/^(?:pnpm|npm|yarn|bun)\s+build\b/i.test(scrubbed)) skeleton = 'pnpm build'
  else if (/\beslint\b/i.test(scrubbed)) skeleton = 'eslint'
  else skeleton = unwrapped.split(/\s+/).filter(t => /^[a-zA-Z0-9._-]+$/.test(t) && !t.includes('REDACTED')).slice(0, 2).join(' ').slice(0, 32) || 'shell:exec'
  const phase: SessionStepPhase = VERIFY_CMD_RE.test(scrubbed) ? 'verify' : LOCATE_CMD_RE.test(unwrapped) ? 'locate' : EDIT_CMD_RE.test(unwrapped) ? 'edit' : 'other'
  return { phase, skeleton }
}

function classifyToolCall(tool: string, rawArgs: unknown): { phase: SessionStepPhase; skeleton: string } {
  const lower = tool.toLowerCase(), args = parseArgs(rawArgs)
  if (lower.includes('report') || lower === 'present') return { phase: 'report', skeleton: 'report:ready' }
  if (SHELL_TOOLS.has(lower)) {
    const cmd = isRec(args) ? (args['command'] ?? args['CommandLine'] ?? args['cmd'] ?? args['script']) : undefined
    return typeof cmd === 'string' && cmd.trim() ? normalizeShellCommand(cmd) : { phase: 'other', skeleton: 'shell:exec' }
  }
  if (EDIT_TOOLS.has(lower)) return { phase: 'edit', skeleton: `edit:${topDirOf(args)}` }
  if (LOCATE_TOOLS.has(lower)) return { phase: 'locate', skeleton: `${lower.includes('read') || lower === 'view_file' ? 'read' : 'locate'}:${topDirOf(args)}` }
  return { phase: 'other', skeleton: lower.replace(/[^a-z0-9._:-]+/g, '-').slice(0, 48) || 'other' }
}

function parseToolResultOutcome(tool: string, text: string, isError: boolean, meta: unknown): { isError: boolean; exitCode?: number } {
  if (isRec(meta) && typeof meta['exitCode'] === 'number' && Number.isFinite(meta['exitCode'])) return { isError: isError || meta['exitCode'] !== 0, exitCode: meta['exitCode'] }
  if (/\n?\[killed by signal: ([^\]\n]+)\]$/.test(text)) return { isError: true }
  const exit = /\n?\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) { const code = Number(exit[1]); return { isError: isError || code !== 0, exitCode: code } }
  const pending = /^started background job |\[still running after \d+ms; moved to background job /.test(text)
  return SHELL_TOOLS.has(tool.toLowerCase()) && !isError && !pending ? { isError: false, exitCode: 0 } : { isError }
}

/** 从原生 DSH 会话事件提取脱敏后的低基数有序工具调用步骤序列。 */
export function extractSessionStepSequence(events: readonly SessionEvent[], maxSteps = 64): SessionStepTrace[] {
  const limit = Math.max(1, maxSteps), steps: SessionStepTrace[] = [], byCallId = new Map<string, number>()
  for (const ev of events) {
    if (ev.type === 'tool/call') {
      if (steps.length >= limit) continue
      const { phase, skeleton } = classifyToolCall(ev.data.name, ev.data.arguments)
      byCallId.set(String(ev.data.callId), steps.length)
      steps.push({ stepIndex: steps.length, tool: ev.data.name, phase, skeleton, isError: false })
    } else if (ev.type === 'tool/result') {
      const idx = byCallId.get(String(ev.data.message.toolCallId ?? ev.data.message.source?.callId ?? ''))
      if (idx === undefined) continue
      const cur = steps[idx]!, text = ev.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      const out = parseToolResultOutcome(cur.tool, text, Boolean(ev.data.message.isError), ev.data.meta)
      steps[idx] = { ...cur, isError: out.isError, ...(out.exitCode !== undefined ? { exitCode: out.exitCode } : {}) }
    }
  }
  return steps
}

const ticketIdOf = (ev: SpineEnvelope): string | undefined =>
  isRec(ev.payload) && typeof ev.payload['ticketId'] === 'string' && ev.payload['ticketId'].trim()
    ? ev.payload['ticketId'].trim() : (ev.stream.startsWith('ticket:') ? ev.stream.slice(7) || undefined : undefined)

interface TicketTraceSummary {
  readonly ticketId: string; readonly steps: readonly SessionStepTrace[]; readonly verifyCommands: readonly string[]
  readonly failedVerifyCommand?: { readonly command: string; readonly exitCode?: number }
  readonly refs: readonly string[]; readonly isClean: boolean; readonly hadReworkOrFailure: boolean
}

function buildTicketSummaries(input: MineWorkflowSopInput): TicketTraceSummary[] {
  const rowBySeq = new Map(input.joinedSessionMetrics.map(r => [r.envelopeSeq, r]))
  const caseById = new Map((input.replayCases ?? []).map(c => [c.id, c]))
  const labelsByTicket = new Map<string, Set<string>>()
  for (const h of input.labelHits ?? []) if (h.ticketId) labelsByTicket.set(h.ticketId, (labelsByTicket.get(h.ticketId) ?? new Set()).add(h.label))
  const byTicket = new Map<string, SpineEnvelope[]>()
  for (const ev of input.events) { const tid = ticketIdOf(ev); if (tid) byTicket.set(tid, [...(byTicket.get(tid) ?? []), ev]) }

  const summaries: TicketTraceSummary[] = []
  for (const [tid, tEvents] of byTicket) {
    const steps: SessionStepTrace[] = [], seenSession = new Set<string>()
    let gateDenied = false, endedClean = false
    for (const ev of tEvents) {
      const p = isRec(ev.payload) ? ev.payload : {}
      if (ev.type === 'gate.evaluated' && isRec(p['verdict']) && p['verdict']['kind'] === 'deny') gateDenied = true
      if (ev.type === 'ticket.ended' && (p['outcome'] === 'completed' || p['outcome'] === 'merged')) endedClean = true
      const row = rowBySeq.get(ev.seq)
      if (row?.steps?.length) {
        const key = row.sessionId ?? `seq:${row.envelopeSeq}`
        if (!seenSession.has(key)) { seenSession.add(key); steps.push(...row.steps) }
      }
    }
    const verifySteps = steps.filter(s => s.phase === 'verify')
    const passedVerify = [...new Set(verifySteps.filter(s => !s.isError && (s.exitCode === undefined || s.exitCode === 0)).map(s => s.skeleton))].sort()
    const failedStep = verifySteps.find(s => s.isError || (s.exitCode !== undefined && s.exitCode !== 0)) ?? steps.find(s => s.isError)
    const tLabels = labelsByTicket.get(tid)
    const hadLabelFriction = Boolean(tLabels && (tLabels.has('L1:verify_failed') || tLabels.has('L2:gate_denied_fixed') || tLabels.has('L3:rework_retry') || tLabels.has('L5:tool_error')))
    const rc = caseById.get(tid)
    const isClean = rc ? rc.expectedOutcome === 'clean' : (endedClean && !failedStep)
    const converged = (gateDenied || hadLabelFriction || Boolean(failedStep)) && passedVerify.length > 0 && (endedClean || rc?.expectedOutcome === 'clean' || !steps[steps.length - 1]?.isError)
    summaries.push({
      ticketId: tid, steps, verifyCommands: passedVerify,
      ...(failedStep ? { failedVerifyCommand: { command: failedStep.skeleton, ...(failedStep.exitCode !== undefined ? { exitCode: failedStep.exitCode } : {}) } } : {}),
      refs: tEvents.slice(0, 6).map(e => `m0:${e.seq}#${e.id}`), isClean: isClean || converged, hadReworkOrFailure: gateDenied || hadLabelFriction || Boolean(failedStep),
    })
  }
  return summaries
}

function buildSopDraft(
  signature: string, verifyCommands: readonly string[], mode: 'rework-converged' | 'frequent-sop',
  group: readonly TicketTraceSummary[], failedSample?: { readonly ticketId: string; readonly command: string; readonly exitCode?: number },
): DepositDraft {
  const slug = signature.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'verify'
  const sample = group[0]!, phases = [...new Set(sample.steps.map(s => s.phase))].filter(p => p !== 'other')
  const cases: DepositFixtureCase[] = [
    { name: `sop-allow-${sample.ticketId}`, expected: 'allow', ctx: { commands: verifyCommands.map(command => ({ command, exitCode: 0 })) }, note: `来自真实工单 ${sample.ticketId} 的完整验证轨迹` },
    failedSample
      ? { name: `sop-deny-failed-${failedSample.ticketId}`, expected: 'deny', ctx: { commands: [{ command: failedSample.command, exitCode: failedSample.exitCode ?? 1 }] }, note: `来自真实返工/失败工单 ${failedSample.ticketId} 的失败命令反例` }
      : { name: `sop-deny-missing-${sample.ticketId}`, expected: 'deny', ctx: { commands: verifyCommands.length > 1 ? verifyCommands.slice(0, -1).map(command => ({ command, exitCode: 0 })) : [{ command: 'echo skipped', exitCode: 0 }] }, note: '缺少必需验证命令的反事实反例' },
    { name: 'sop-unmeasured-missing-commands', expected: 'unmeasured', expectedCause: 'missing-input', ctx: {}, note: '缺少 commands 输入时诚实返回 unmeasured' },
  ]
  const stepsMd = [
    phases.includes('locate') ? '1. 定位上下文（locate/read）' : '1. 确认目标范围',
    phases.includes('edit') ? '2. 执行外科手术修改（edit）' : '2. 完成变更准备',
    `3. 依次运行验证命令并确保退出码为 0：${verifyCommands.map(c => `\`${c}\``).join('、')}`,
    '4. 汇报完成与实证（report:ready）',
  ].join('\n')
  const modeDesc = mode === 'rework-converged' ? '返工收敛提炼（Rework-to-Clean）' : `高频成功 SOP 归纳（support=${group.length}）`
  const rule: CommandCheckConfig = { kind: 'command_check', inputField: 'commands', requiredCommands: verifyCommands, requireExitZero: true }
  const draft: DepositDraft & { readonly rule: CommandCheckConfig } = {
    id: `sop.${slug}`, name: `工作流验证 SOP (${verifyCommands.join(' + ')})`, version: 1, author: 'rsi-sop-miner',
    scope: 'private', kind: 'gate', level: 'object', point: 'verify.preflight',
    trigger: { on: 'completion.claimed', mode: 'on-event' }, requires: ['commands'],
    params: { require_exit_zero: { type: 'boolean', default: true } },
    exceptions: ['仅作为影子候选提案呈现，须经人工认领与离线回放验证后方可晋升'],
    repairHint: `请执行必需验证命令并确保全部退出码为 0：${verifyCommands.join(', ')}`,
    intent: `${modeDesc}：完成变更后必须通过 ${verifyCommands.join(' + ')} 验证。`,
    rubricBody: `完成变更后必须依次执行必需验证命令并确保全部返回退出码 0。\n\n## 操作步骤\n${stepsMd}\n\n- 提炼模式：${modeDesc}\n- 样本工单：${group.map(g => g.ticketId).join(', ')}`,
    enforce: false, stage: 'shadow', actionClass: 'observe',
    origin: { kind: 'friction-mined', refs: [...new Set(group.flatMap(g => g.refs))].slice(0, 16) }, cases, rule,
  }
  return redactValue(draft).value
}

/** 从原生会话有序步骤与 M0 成败标签中半自动提炼可编译、含红绿用例的影子 SOP 草案。 */
export function mineWorkflowSopDrafts(input: MineWorkflowSopInput): DepositDraft[] {
  const minSupport = Math.max(1, input.minSupport ?? 3), summaries = buildTicketSummaries(input)
  const failedOwner = summaries.find(s => s.failedVerifyCommand)
  const failedSample = failedOwner?.failedVerifyCommand ? { ticketId: failedOwner.ticketId, ...failedOwner.failedVerifyCommand } : undefined
  const bySig = new Map<string, { verifyCommands: string[]; items: TicketTraceSummary[]; hasRework: boolean }>()
  for (const s of summaries) {
    if (!s.isClean || s.verifyCommands.length === 0) continue
    const sig = s.verifyCommands.join('+')
    const cur = bySig.get(sig) ?? { verifyCommands: [...s.verifyCommands], items: [], hasRework: false }
    cur.items.push(s); if (s.hadReworkOrFailure) cur.hasRework = true; bySig.set(sig, cur)
  }
  const drafts: DepositDraft[] = []
  for (const [sig, group] of bySig) {
    if (group.hasRework) drafts.push(buildSopDraft(sig, group.verifyCommands, 'rework-converged', group.items, failedSample))
    else if (group.items.length >= minSupport) drafts.push(buildSopDraft(sig, group.verifyCommands, 'frequent-sop', group.items, failedSample))
  }
  return drafts
}
