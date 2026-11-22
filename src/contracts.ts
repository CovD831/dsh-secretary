// DEPS: 无
// RESPONSIBILITY: 定义源码核对过的宿主最小结构，仅用于编译期约束
// MODULE: secretary
// ---
export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

export interface Session {
  id: string
  header: { agentPreset?: string; workspaceId?: string }
  snapshotEvents(): SessionEvent[]
}

export interface Agent {
  id: string
  session: Session
  whenIdle(): Promise<void>
  followup(message: { id: string; role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: 'user' } }): void
  ctx: {
    tools: {
      register(definition: unknown): unknown
      restrict(filter: { allow: string[] }): unknown
      schemas(agent: Agent): Array<{ name: string }>
      execute(request: { agent: Agent; signal: AbortSignal; calls: unknown[] }): Promise<{ results: unknown[] }>
    }
  }
}

export interface ToolExecution {
  callId: string
  name: string
  arguments: unknown
  signal: AbortSignal
  agent?: Agent
}

export type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string }

export interface ToolResult {
  isError: boolean
  error?: { info?: { name?: string; code?: string; reason?: string } }
  meta?: unknown
}

export interface Context {
  get<T = unknown>(name: string): T | undefined
  on(event: string, listener: (...args: any[]) => any, options?: { prepend: true }): unknown
  on(event: 'session/event', listener: (session: Session, event: SessionEvent) => undefined): unknown
  on(event: 'tools/result', listener: (exec: ToolExecution, result: ToolResult) => undefined): unknown
  on(event: 'agent/status', listener: (payload: { agent: Agent; status: 'idle' | 'running' }) => undefined): unknown
  on(event: 'tools/pre-execute', listener: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>, options?: { prepend: true }): unknown
  inject(services: string[], setup: (ctx: never) => unknown): unknown
  effect(setup: () => (() => void) | Promise<() => void>): unknown
}
