// DEPS: src/constants, src/contracts, src/dispatch (仅类型)
// RESPONSIBILITY: 以持久工作区映射识别管辖会话
// MODULE: secretary
// ---
import { WORKSPACE_STORAGE_SPEC, WORKSPACE_TABLE } from './constants.js'
import type { Agent } from './contracts.js'
import type { StorageDomain } from './dispatch.js'

export async function workspaceOf(agent: Agent, storage: StorageDomain): Promise<string | null> {
  const domain = await storage.open(WORKSPACE_STORAGE_SPEC)
  try {
    for (const [workspaceId, sessionId] of domain.table(WORKSPACE_TABLE).entries()) {
      if (sessionId === agent.id) return workspaceId
    }
    return null
  } finally {
    await domain.close()
  }
}
