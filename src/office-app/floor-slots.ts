/** 非拆除式（只建不拆 + 空房闲置 + 单平面横向扩展）工作区-槽位稳定映射表。 */
import type { WorkspaceWingSpec } from './world-types.ts'

export type SlotIndex = number

export interface FloorSlotEntry {
  readonly floor: 0
  readonly slot: SlotIndex
  readonly status: 'active' | 'vacant'
  readonly workspaceId?: string
  readonly roomSeed: number
}

export function normalizeWorkspaceSpecs(workspaces: readonly WorkspaceWingSpec[]): WorkspaceWingSpec[] {
  const seen = new Set<string>(), deduped: WorkspaceWingSpec[] = []
  for (const ws of workspaces) if (!seen.has(ws.id)) { seen.add(ws.id); deduped.push(ws) }
  const defIdx = deduped.findIndex((w) => w.id === 'default')
  return defIdx === -1 ? [{ id: 'default', title: 'default' }, ...deduped] : [deduped[defIdx]!, ...deduped.filter((_, i) => i !== defIdx)]
}

export function hashWorkspaceSeed(baseSeed: number, wsId: string): number {
  const base = Math.max(1, Math.min(999999, Math.floor(baseSeed) || 1))
  if (base === 1) return 1
  let h = (2166136261 ^ base) >>> 0
  for (let i = 0; i < wsId.length; i++) {
    h ^= wsId.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h % 999998) + 2
}

export function reconcileSlotRegistry(
  prev: readonly { floor?: number; slot: number; status: 'active' | 'vacant'; workspaceId?: string; roomSeed: number }[],
  workspaces: readonly WorkspaceWingSpec[], baseSeed: number,
): FloorSlotEntry[] {
  const list = normalizeWorkspaceSpecs(workspaces), liveSet = new Set(list.map((w) => w.id))
  const next: FloorSlotEntry[] = [], assigned = new Set<string>(), usedSlots = new Set<number>()

  for (const e of prev) {
    const flatSlot = Math.max(0, (e.floor && e.floor > 0 ? e.floor * 3 : 0) + Math.floor(e.slot))
    if (usedSlots.has(flatSlot)) continue
    usedSlots.add(flatSlot)
    if (e.status === 'active' && e.workspaceId && liveSet.has(e.workspaceId) && !assigned.has(e.workspaceId)) {
      assigned.add(e.workspaceId)
      next.push({ floor: 0, slot: flatSlot, status: 'active', workspaceId: e.workspaceId, roomSeed: hashWorkspaceSeed(baseSeed, e.workspaceId) })
    } else {
      next.push({ floor: 0, slot: flatSlot, status: 'vacant', roomSeed: e.roomSeed })
    }
  }

  for (const ws of list) {
    if (assigned.has(ws.id)) continue
    assigned.add(ws.id)
    const vacantIdx = next.findIndex((e) => e.status === 'vacant')
    if (vacantIdx !== -1) {
      const v = next[vacantIdx]!
      next[vacantIdx] = { floor: 0, slot: v.slot, status: 'active', workspaceId: ws.id, roomSeed: hashWorkspaceSeed(baseSeed, ws.id) }
      continue
    }
    let slot = 0
    while (usedSlots.has(slot)) slot++
    usedSlots.add(slot)
    next.push({ floor: 0, slot, status: 'active', workspaceId: ws.id, roomSeed: hashWorkspaceSeed(baseSeed, ws.id) })
  }

  return next.sort((a, b) => a.slot - b.slot)
}

export function getSlotEntry(entries: readonly FloorSlotEntry[], slot: number): FloorSlotEntry | undefined {
  return entries.find((e) => e.slot === slot)
}

export function reclaimVacantSlots(entries: readonly FloorSlotEntry[]): FloorSlotEntry[] {
  return entries.filter((e) => e.status === 'active')
}

export const SEED_STORAGE_KEY = 'dsh_office_world_seed'
export const SLOT_STORAGE_KEY = 'dsh_office_slot_registry_v1'

export function readInitialSeed(): number {
  try {
    const n = typeof localStorage !== 'undefined' ? Number.parseInt(localStorage.getItem(SEED_STORAGE_KEY) ?? '', 10) : NaN
    return Number.isInteger(n) && n >= 1 && n <= 999999 ? n : 1
  } catch { return 1 }
}

export function readSlotRegistry(): FloorSlotEntry[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = JSON.parse(localStorage.getItem(SLOT_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw.flatMap((e) => {
      if (!e || typeof e.slot !== 'number' || !Number.isInteger(e.slot) || e.slot < 0 || (e.status !== 'active' && e.status !== 'vacant')) return []
      const flatSlot = (typeof e.floor === 'number' && e.floor > 0 ? e.floor * 3 : 0) + e.slot
      return [{ floor: 0 as const, slot: flatSlot, status: e.status, ...(typeof e.workspaceId === 'string' ? { workspaceId: e.workspaceId } : {}), roomSeed: typeof e.roomSeed === 'number' ? e.roomSeed : 1 }]
    })
  } catch { return [] }
}
