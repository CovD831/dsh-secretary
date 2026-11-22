// DEPS: src/contracts, src/events (仅类型)
// RESPONSIBILITY: 定义 gate 唯一注册条目、判定结果与 fixture 契约
// MODULE: gates
// ---
import type { Agent, ToolExecution } from '../contracts.js'
import type { LogWriter } from '../events.js'

export type GatePoint = 'admission' | 'contract' | 'dispatch' | 'completion' | 'delivery' | 'runtime'
export type GateVerdict = 'allow' | 'deny' | 'unmeasured'
export interface GateContext {
  exec: ToolExecution
  workspaceId: string
  writer: LogWriter
  agent: Agent
}
export interface GateJudgment {
  verdict: GateVerdict
  reason: string
  evidence: Record<string, unknown> | null
}
export interface GateDefinition {
  id: string
  point: GatePoint
  version: string
  matches(toolName: string, args: unknown): boolean
  judge(ctx: GateContext): Promise<GateJudgment> | GateJudgment
  fixtures: { red: string; green: string }
}
