// DEPS: node:crypto | src/constants, src/gates, src/gates/registry, src/events, src/module, src/workspace
// RESPONSIBILITY: 在工具事前钩子中执行注册 gate 并持久化每次判定
// MODULE: gates
// ---
import { randomUUID } from 'node:crypto'
import { KINDS } from '../constants.js'
import { createEnvelope } from '../events.js'
import type { Install } from '../module.js'
import { workspaceOf } from '../workspace.js'
import { gateRegistry } from './index.js'
import type { GateDefinition, GateJudgment } from './registry.js'

const UNMEASURED_REASON = '无法测量，不放行；请补齐本次观测和证据后重试。'

export async function judgeGate(gate: GateDefinition, ctx: Parameters<GateDefinition['judge']>[0]): Promise<GateJudgment> {
  try {
    const result = await gate.judge(ctx)
    if (result.verdict === 'unmeasured') {
      return { ...result, reason: `${UNMEASURED_REASON}${result.reason}` }
    }
    return result
  } catch (error) {
    return {
      verdict: 'unmeasured',
      reason: `${UNMEASURED_REASON}判据异常：${error instanceof Error ? error.message : String(error)}`,
      evidence: { error: error instanceof Error ? error.message : String(error) },
    }
  }
}

export const install: Install = (ctx, { writer }) => {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent === undefined) return await next()
    const workspaceId = await workspaceOf(exec.agent, ctx.storageDomain)
    if (workspaceId === null) return await next()
    for (const gate of gateRegistry) {
      if (!gate.matches(exec.name, exec.arguments)) continue
      const result = await judgeGate(gate, { exec, workspaceId, writer, agent: exec.agent })
      await writer.append(createEnvelope({
        id: `plugin:${randomUUID()}`, kind: KINDS.gateVerdict, sessionId: exec.agent.id,
        workspaceId, source: 'plugin', causedBy: null,
        payload: {
          gateId: gate.id, gateVersion: gate.version, verdict: result.verdict, reason: result.reason,
          toolName: exec.name, callId: exec.callId, phase: gate.point, evidence: result.evidence,
        },
      }), true)
      if (result.verdict !== 'allow') return { kind: 'deny', reason: result.reason }
    }
    return await next()
  }, { prepend: true })
}
