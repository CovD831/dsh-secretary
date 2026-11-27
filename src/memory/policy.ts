/** 持久化 Bot 通用记忆策略契约：统一分泌与多群持久化 Bot 的密级、作用域与直改权限边界。 */
import type { Clearance, FactLayer, MemoryScope, RecallCaller } from './types.ts'

export interface PersistentBotMemoryPolicy {
  readonly botId: string
  readonly role: 'secretary' | 'worker'
  readonly maxClearance: Clearance
  readonly readableScopes: readonly MemoryScope[] | 'all'
  readonly writableLayers: readonly FactLayer[]
  readonly directOverrideChannels: readonly string[]
  readonly workspaceId?: string
  readonly residentMaxChars: number
  readonly deltaMaxChars: number
  readonly recallTimeoutMs: number
}

/** 构造私人秘书主会话记忆策略：私密全权限、允许本地鉴权 `secretary-bus` 直改偏好。 */
export function createSecretaryMemoryPolicy(masterId: string): PersistentBotMemoryPolicy {
  return {
    botId: masterId,
    role: 'secretary',
    maxClearance: 'private',
    readableScopes: 'all',
    writableLayers: ['m1', 'm2', 'm3'],
    directOverrideChannels: ['secretary-bus'],
    residentMaxChars: 2200,
    deltaMaxChars: 1500,
    recallTimeoutMs: 1500,
  }
}

/** 构造持久化群组 Bot 记忆策略：工作区级隔离、禁止读取 `private`/M2、禁止口头直改覆盖。 */
export function createGroupBotMemoryPolicy(botId: string, groupId: string): PersistentBotMemoryPolicy {
  return {
    botId,
    role: 'worker',
    maxClearance: 'workspace',
    readableScopes: ['global', `workspace:${groupId}`],
    writableLayers: ['m1', 'm3'],
    directOverrideChannels: [],
    workspaceId: groupId,
    residentMaxChars: 1600,
    deltaMaxChars: 1200,
    recallTimeoutMs: 1500,
  }
}

/** 将 Bot 策略投影为底层 `RecallCaller`，确保召回与 FTS 共用同一隔离契约。 */
export function callerFromPolicy(policy: PersistentBotMemoryPolicy): RecallCaller {
  return {
    role: policy.role,
    maxClearance: policy.maxClearance,
    ...(policy.workspaceId ? { workspaceId: policy.workspaceId } : {}),
  }
}

/** 判断某消息渠道是否被该 Bot 策略授权直接升级为 `user_direct` 覆盖权威。 */
export function canPolicyDirectOverride(
  policy: PersistentBotMemoryPolicy,
  source: string,
  localAuthenticated: boolean,
): boolean {
  return localAuthenticated && policy.directOverrideChannels.includes(source)
}
