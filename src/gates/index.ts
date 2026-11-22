// DEPS: src/gates/registry (仅类型)
// RESPONSIBILITY: 唯一定义已启用 gate；新 gate 在此加入注册表
// MODULE: gates
// ---
import type { GateDefinition } from './registry.js'

export const gateRegistry: GateDefinition[] = []
