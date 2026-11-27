import type { GateDef, Verdict } from '../types.ts'

export interface CommandContractParams {
  readonly require_non_empty_for_code: boolean
  readonly forbid_noop_commands: boolean
}

export const DEFAULT_COMMAND_CONTRACT_PARAMS: CommandContractParams = Object.freeze({
  require_non_empty_for_code: true,
  forbid_noop_commands: true,
})

export interface CommandContractCtx {
  readonly verifyCommands?: readonly string[] | null
  readonly codeChangedPaths?: readonly string[] | null
  readonly params?: Partial<CommandContractParams>
}

declare module '../types.ts' {
  interface PointCatalog {
    'verify.command-contract': CommandContractCtx
  }
}

const NODE_NOOP_RE = /^node\s+(?:-e|--eval)\s+["']?\s*(?:process\.exit\(\s*0\s*\)|console\.log\([^)]*\))\s*;?\s*["']?$/i
const PY_NOOP_RE = /^python3?\s+-c\s+["']?\s*(?:pass|print\([^)]*\)|import\s+sys;\s*sys\.exit\(\s*0\s*\))\s*;?\s*["']?$/i
const PIPE_SWALLOW_RE = /^(?:true|:|exit\s+0|pwd|cat|head|tail|tee|more|less|wc|echo|printf)(?:\s|$)/i
const FAIL_ONLY_RE = /^(?:false|exit\s+[1-9]\d*|return\s+[1-9]\d*)(?:\s*;.*)?$/i
const SUBSHELL_C_RE = /^(?:env\s+)?(?:(?:ba|z|da)?sh)\s+-[a-z]*c\s+(['"])([\s\S]+)\1$/i

function stripCommentsAndTrailingSemi(cmd: string): string {
  let out = '', quote: "'" | '"' | null = null, escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (escaped) { out += ch; escaped = false; continue }
    if (ch === '\\' && quote !== "'") { out += ch; escaped = true; continue }
    if ((ch === "'" || ch === '"') && (!quote || quote === ch)) { quote = quote ? null : ch; out += ch; continue }
    if (!quote && ch === '#' && (i === 0 || /[\s;&|()]/.test(cmd[i - 1]!))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i += 1
      continue
    }
    out += ch
  }
  return out.trim().replace(/;+\s*$/, '').trim()
}

function stripOuterGroup(raw: string): string {
  let cur = stripCommentsAndTrailingSemi(raw)
  while ((cur.startsWith('(') && cur.endsWith(')')) || (cur.startsWith('{') && cur.endsWith('}'))) {
    const open = cur[0]!, close = open === '(' ? ')' : '}'
    let depth = 0, quote: "'" | '"' | null = null, escaped = false, closedAtEnd = false
    for (let i = 0; i < cur.length; i++) {
      const ch = cur[i]!
      if (escaped) { escaped = false; continue }
      if (ch === '\\' && quote !== "'") { escaped = true; continue }
      if ((ch === "'" || ch === '"') && (!quote || quote === ch)) { quote = quote ? null : ch; continue }
      if (quote) continue
      if (ch === open) depth += 1
      else if (ch === close) {
        depth -= 1
        if (depth === 0) { closedAtEnd = i === cur.length - 1; break }
      }
    }
    if (!closedAtEnd) break
    cur = stripCommentsAndTrailingSemi(cur.slice(1, -1))
  }
  return cur
}

function splitTopLevel(cmd: string, kind: 'seq' | 'bool' | 'pipe'): { op: string; text: string }[] {
  const out: { op: string; text: string }[] = []
  let cur = '', nextOp = '', quote: "'" | '"' | null = null, escaped = false, paren = 0, brace = 0
  const push = (op: string) => {
    const s = cur.trim()
    if (s) out.push({ op: nextOp, text: s })
    cur = ''; nextOp = op
  }
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!, nxt = cmd[i + 1]
    if (escaped) { cur += ch; escaped = false; continue }
    if (ch === '\\' && quote !== "'") { cur += ch; escaped = true; continue }
    if ((ch === "'" || ch === '"') && (!quote || quote === ch)) { quote = quote ? null : ch; cur += ch; continue }
    if (!quote) {
      if (ch === '(') paren += 1
      else if (ch === ')' && paren > 0) paren -= 1
      else if (ch === '{') brace += 1
      else if (ch === '}' && brace > 0) brace -= 1
      if (paren === 0 && brace === 0) {
        if (kind === 'seq' && (ch === ';' || ch === '\n')) { push(';'); continue }
        if (kind === 'bool' && ((ch === '&' && nxt === '&') || (ch === '|' && nxt === '|'))) { push(ch + nxt); i += 1; continue }
        if (kind === 'pipe' && ch === '|' && nxt !== '|') { push('|'); continue }
      }
    }
    cur += ch
  }
  const tail = cur.trim()
  if (tail) out.push({ op: nextOp, text: tail })
  return out
}

function isNoopAtom(seg: string): boolean {
  const s = stripOuterGroup(seg)
  if (/^(?:true|:|pwd|exit\s+0)$/i.test(s)) return true
  if (/^(?:echo|printf)\b/i.test(s)) return true
  return NODE_NOOP_RE.test(s) || PY_NOOP_RE.test(s)
}

function isEffectiveNoop(seg: string, pipefail: boolean): boolean {
  const pipes = splitTopLevel(stripOuterGroup(seg), 'pipe')
  if (pipes.length > 1 && !pipefail) {
    const sink = stripOuterGroup(pipes[pipes.length - 1]!.text)
    if (PIPE_SWALLOW_RE.test(sink) || isNoopAtom(sink)) return true
  }
  return pipes.length <= 1 && isNoopAtom(pipes[0]?.text ?? seg)
}

export function inspectVerifyCommand(raw: string, depth = 0): string | undefined {
  const cmd = stripOuterGroup(raw)
  if (!cmd) return '验收命令为空白字符串'
  const seqs = splitTopLevel(cmd, 'seq')
  if (seqs.length === 0) return '验收命令为空操作或永真命令，无法证伪缺陷'
  const pipefail = /\bset\s+(?:-[a-z]*o\s+pipefail|-[a-z]*pipefail)\b/i.test(cmd)
  const lastStmt = seqs[seqs.length - 1]!.text
  const parts = splitTopLevel(stripOuterGroup(lastStmt), 'bool')
  if (parts.length === 0 || parts.every(p => isEffectiveNoop(p.text, pipefail))) {
    return `验收命令 "${raw.trim()}" 为空操作或仅输出无断言，无法证伪缺陷`
  }
  let swallowed = false
  for (const part of parts) {
    if (part.op === '||' && !FAIL_ONLY_RE.test(part.text.trim())) {
      swallowed = true
    } else if (part.op === '&&' && swallowed && !isEffectiveNoop(part.text, pipefail)) {
      swallowed = false
    }
    if (depth < 3) {
      const m = SUBSHELL_C_RE.exec(stripOuterGroup(part.text))
      if (m) {
        const innerErr = inspectVerifyCommand(m[2]!, depth + 1)
        if (innerErr) return innerErr
      }
    }
  }
  if (swallowed) return `验收命令 "${raw.trim()}" 存在 || 吞掉失败退出码，无法证伪缺陷`
  return undefined
}

/** 验收命令契约门：改动实质代码时校验 verifyCommands 非空且含真实可证伪断言（禁空操作/吞退出码）。 */
export function evaluateCommandContract(
  ctx: CommandContractCtx,
  boundParams?: Partial<CommandContractParams>,
): Verdict {
  const p: CommandContractParams = { ...DEFAULT_COMMAND_CONTRACT_PARAMS, ...ctx.params, ...boundParams }
  if (ctx.codeChangedPaths === undefined || ctx.codeChangedPaths === null) {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少 codeChangedPaths 输入' }
  }
  if (ctx.codeChangedPaths.length === 0) {
    return { kind: 'allow', produced: { skipped: 'no-code-changes' } }
  }
  if (ctx.verifyCommands === undefined || ctx.verifyCommands === null) {
    return { kind: 'unmeasured', cause: 'missing-input', detail: '缺少 verifyCommands 输入' }
  }
  const cmds = ctx.verifyCommands.map(c => c.trim()).filter(Boolean)
  if (p.require_non_empty_for_code && cmds.length === 0) {
    return { kind: 'unmeasured', cause: 'no-evidence', detail: '改动了实质代码但未配置任何验收命令 verifyCommands' }
  }
  if (p.forbid_noop_commands) {
    const blockers = cmds.map(inspectVerifyCommand).filter((b): b is string => Boolean(b))
    if (blockers.length > 0) return { kind: 'deny', blockers: blockers as [string, ...string[]] }
  }
  return { kind: 'allow', produced: { checkedCommands: cmds.length, codeFiles: ctx.codeChangedPaths.length } }
}

export function createCommandContractGate(boundParams?: Partial<CommandContractParams>): GateDef<'verify.command-contract'> {
  return {
    kind: 'gate',
    id: 'verify.command-contract',
    version: 1,
    point: 'verify.command-contract',
    description: '改动代码时要求存在有效且不吞退出码的可证伪验收命令 verifyCommands',
    side: 'hard',
    placement: { timing: 'pre', enforce: true },
    requires: ['codeChangedPaths', 'verifyCommands'],
    gate: ctx => evaluateCommandContract(ctx, boundParams),
  }
}

export const verifyCommandContractGate: GateDef<'verify.command-contract'> = createCommandContractGate()