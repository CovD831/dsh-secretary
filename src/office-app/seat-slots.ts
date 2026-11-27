/** 工位多椅展开（双人可用协作桌后排）、紧急度优先落座与超编人数显式统计纯函数模块。 */
import type { Facing, GridPoint, RoomEntity } from './layout-solver.ts'
import type { OfficeWorldPlan, WorldWingPlan } from './world-types.ts'

export interface SeatSlot {
  readonly seatId: string
  readonly suiteId: string
  readonly assetId: string
  readonly u: number
  readonly v: number
  readonly facing: Facing
  readonly seatCell: GridPoint
  readonly cropH: number
  readonly sitSink: number
  readonly zDelta: number
}

export interface PriorityTicketLike {
  readonly id: string
  readonly stage: string
  readonly action?: string
  readonly updatedAt: string
}

export function chairForSuite(suite: RoomEntity): RoomEntity {
  if (suite.assetId === 'desk_cluster') {
    return { id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u: suite.anchor.u + 0.72, v: suite.anchor.v - 2.22 }, size: [1, 1], facing: 'SW', mirrorX: true, footprint: [] }
  }
  if (suite.assetId === 'collab_table') {
    return { id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u: suite.anchor.u + 0.35, v: suite.anchor.v - 1.90 }, size: [1, 1], facing: 'SW', mirrorX: true, footprint: [] }
  }
  const isRec = suite.suiteKind === 'reception', isExec = suite.assetId === 'exec_desk', faceSE = isRec || suite.facing === 'SE'
  const u = isRec ? suite.anchor.u - 0.88 : isExec ? suite.anchor.u + 1.14 : faceSE ? suite.anchor.u - 0.73 : suite.anchor.u + 0.60
  const v = isRec ? suite.anchor.v + 1.05 : isExec ? suite.anchor.v - 1.32 : faceSE ? suite.anchor.v + 0.60 : suite.anchor.v - 0.73
  const facing: Facing = faceSE ? 'SE' : 'SW'
  return { id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u, v }, size: [1, 1], facing, mirrorX: facing === 'SW', footprint: [] }
}

/** `char_worker.png` 仅含 SE/SW 朝前视角，因此 `collab_table` 仅展开左/右后排两张朝前座椅。 */
export function seatSlotsForSuite(suite: RoomEntity): SeatSlot[] {
  if (suite.assetId === 'collab_table') {
    const ch = chairForSuite(suite)
    return [
      {
        seatId: suite.id, suiteId: suite.id, assetId: suite.assetId,
        u: ch.anchor.u, v: ch.anchor.v, facing: 'SW',
        seatCell: suite.seatCell ?? { u: suite.anchor.u + 1, v: suite.anchor.v - 1 },
        cropH: 29, sitSink: 0, zDelta: 1,
      },
      {
        seatId: `${suite.id}#nw`, suiteId: suite.id, assetId: suite.assetId,
        u: suite.anchor.u - 1.45, v: suite.anchor.v - 0.10, facing: 'SE',
        seatCell: { u: suite.anchor.u - 1, v: suite.anchor.v + 1 },
        cropH: 29, sitSink: 0, zDelta: 1,
      },
    ]
  }
  const ch = chairForSuite(suite)
  const sc = ch.facing === 'SE' ? { u: ch.anchor.u + 0.35, v: ch.anchor.v - 0.05 } : { u: ch.anchor.u - 0.05, v: ch.anchor.v + 0.35 }
  const isTall = suite.assetId === 'desk_cluster' || suite.assetId === 'exec_desk'
  return [{
    seatId: suite.id, suiteId: suite.id, assetId: suite.assetId,
    u: sc.u, v: sc.v, facing: ch.facing,
    seatCell: suite.seatCell ?? { u: Math.round(ch.anchor.u), v: Math.round(ch.anchor.v) },
    cropH: 48, sitSink: isTall ? -2 : 2, zDelta: -3,
  }]
}

export function wingSeatSlots(wing: WorldWingPlan): SeatSlot[] {
  return wing.suites.filter(s => s.suiteKind === 'workstation').flatMap(seatSlotsForSuite)
}

export function findSeatSlot(world: OfficeWorldPlan, seatId: string): { seat: SeatSlot; suite: RoomEntity } | undefined {
  for (const s of [...world.lobby.suites, ...world.wings.flatMap(w => w.suites)]) {
    for (const slot of seatSlotsForSuite(s)) if (slot.seatId === seatId) return { seat: slot, suite: s }
  }
  return undefined
}

export function ticketSeatPriority(t: Pick<PriorityTicketLike, 'stage' | 'action'>): number {
  if (t.stage === 'person') return t.action === 'blocked' || t.action === 'failed' ? 1 : 0
  return t.stage === 'working' ? 2 : 3
}

export function assignRoomTicketsToSeats<T extends PriorityTicketLike>(
  tickets: readonly T[],
  world: OfficeWorldPlan,
  resolveRoomId: (ticket: T) => string,
): { assignments: Map<string, { roomId: string; seatId: string }>; roomOverflows: Record<string, number> } {
  const byRoom = new Map<string, T[]>()
  for (const t of tickets) {
    const rid = resolveRoomId(t)
    const list = byRoom.get(rid) ?? []
    list.push(t)
    byRoom.set(rid, list)
  }
  const assignments = new Map<string, { roomId: string; seatId: string }>()
  const roomOverflows: Record<string, number> = {}
  for (const wing of world.wings) {
    if (!wing.workspaceId || wing.vacant || wing.kind !== 'studio') continue
    const seats = wingSeatSlots(wing)
    const list = (byRoom.get(wing.workspaceId) ?? []).slice()
      .sort((a, b) => ticketSeatPriority(a) - ticketSeatPriority(b) || b.updatedAt.localeCompare(a.updatedAt))
    for (let i = 0; i < Math.min(list.length, seats.length); i++) {
      assignments.set(list[i]!.id, { roomId: wing.workspaceId, seatId: seats[i]!.seatId })
    }
    if (list.length > seats.length) roomOverflows[wing.workspaceId] = list.length - seats.length
  }
  return { assignments, roomOverflows }
}
