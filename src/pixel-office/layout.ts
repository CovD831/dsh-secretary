export const NATIVE_W = 720
export const NATIVE_H = 450
export const DISPLAY_SCALE = 2
export const DISPLAY_W = NATIVE_W * DISPLAY_SCALE
export const DISPLAY_H = NATIVE_H * DISPLAY_SCALE
export const TILE_W = 32
export const TILE_H = 16
export const ROOM_COLS = 16
export const ROOM_ROWS = 12
export const FLOOR_ORIGIN_X = 328
export const FLOOR_ORIGIN_Y = 78
export const PORTRAIT_W = 192
export const PORTRAIT_H = 240
export const PORTRAIT_X = 20
export const PORTRAIT_Y = 202
export const DIALOG_Y = 310
export const DIALOG_H = 140

export type Facing = 'NE' | 'NW' | 'SE' | 'SW'
export type SuiteKind = 'reception' | 'executive' | 'workstation' | 'shared'
export type FurnitureKind =
  | 'reception-desk' | 'exec-desk' | 'workstation' | 'bookshelf' | 'water-cooler' | 'floor-plant' | 'wastebin'
export type WallItemKind = 'door' | 'window' | 'clock' | 'corkboard'
export type WallSide = 'back' | 'left'
export type ActorRole = 'secretary' | 'lead' | 'worker'
export type ActorPose = 'stand' | 'sit' | 'type'

export interface GridPoint { u: number; v: number }
export interface RoomTopologyTemplate { id: string; cols: number; rows: number; doorWall: WallSide; doorAt: number; doorSpan: number }
export interface WallMount { id: string; kind: WallItemKind; wall: WallSide; at: number; h: number; span: number }
export interface ActorPlacement { id: string; role: ActorRole; u: number; v: number; facing: Facing; pose: ActorPose; suiteId?: string }

export interface SuiteInstance {
  id: string
  suiteKind: SuiteKind
  furnitureKind: FurnitureKind
  anchor: GridPoint
  size: readonly [number, number]
  facing: Facing
  mirrorX: boolean
  wallTouch?: WallSide | 'right'
  footprint: GridPoint[]
}

export interface RoomPlan {
  topologyId: string
  workspaceId: string
  workspaceOrder: number
  seed: number
  cols: number
  rows: number
  doorCells: GridPoint[]
  suites: SuiteInstance[]
  shared: SuiteInstance[]
  wallMounts: WallMount[]
  actors: ActorPlacement[]
  rugRect: { u: number; v: number; w: number; h: number }
}

export interface LayoutAudit {
  valid: boolean
  errors: string[]
  overlapCount: number
  doorBlocked: boolean
  minSuiteChebyshev: number
  maxAisleWidth: number
  wallAttachOk: boolean
  lineOfSightOk: boolean
}

export const ROOM_TOPOLOGY_TEMPLATES: readonly RoomTopologyTemplate[] = [
  { id: 'rect-16x12', cols: ROOM_COLS, rows: ROOM_ROWS, doorWall: 'left', doorAt: 9, doorSpan: 2 },
]

export const isoToScreen = (u: number, v: number) => ({
  x: FLOOR_ORIGIN_X + (u - v) * (TILE_W / 2),
  y: FLOOR_ORIGIN_Y + (u + v) * (TILE_H / 2),
})

export const tileCenterScreen = (u: number, v: number) => isoToScreen(u + 0.5, v + 0.5)
export const tileFootScreen = (u: number, v: number) => isoToScreen(u + 1, v + 1)

export function screenToIso(nx: number, ny: number): GridPoint {
  const dx = (nx - FLOOR_ORIGIN_X) / (TILE_W / 2)
  const dy = (ny - FLOOR_ORIGIN_Y) / (TILE_H / 2)
  return { u: Math.floor((dx + dy) / 2), v: Math.floor((dy - dx) / 2) }
}

function rectFootprint(u: number, v: number, w: number, h: number): GridPoint[] {
  const cells: GridPoint[] = []
  for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) cells.push({ u: u + du, v: v + dv })
  return cells
}

function hashSeed(workspaceId: string, workspaceOrder: number, seed: number): number {
  let h = 2166136261 ^ (workspaceOrder * 374761393) ^ (seed * 668265263)
  for (let i = 0; i < workspaceId.length; i++) h = Math.imul(h ^ workspaceId.charCodeAt(i), 16777619)
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function chebyshevSetDist(a: readonly GridPoint[], b: readonly GridPoint[]): number {
  let best = Infinity
  for (const pa of a) for (const pb of b) {
    const d = Math.max(Math.abs(pa.u - pb.u), Math.abs(pa.v - pb.v))
    if (d < best) best = d
  }
  return best
}

function buildSuite(
  id: string, suiteKind: SuiteKind, furnitureKind: FurnitureKind,
  u: number, v: number, w: number, h: number, facing: Facing, wallTouch?: WallSide | 'right',
): SuiteInstance {
  return {
    id, suiteKind, furnitureKind, anchor: { u, v }, size: [w, h], facing,
    mirrorX: facing === 'NW' || facing === 'SW', wallTouch, footprint: rectFootprint(u, v, w, h),
  }
}

function hasLineOfSight(occ: Set<string>, from: GridPoint, to: GridPoint): boolean {
  const steps = Math.max(Math.abs(to.u - from.u), Math.abs(to.v - from.v)) * 2
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const u = Math.round(from.u + (to.u - from.u) * t)
    const v = Math.round(from.v + (to.v - from.v) * t)
    if (occ.has(`${u},${v}`)) return false
  }
  return true
}

function measureMainAisleWidth(occ: Set<string>, cols: number, rows: number, doorCells: readonly GridPoint[]): number {
  const start = doorCells[0]
  if (!start) return 0
  const can2x2 = (u: number, v: number) => u >= 0 && v >= 0 && u + 1 < cols && v + 1 < rows
    && !occ.has(`${u},${v}`) && !occ.has(`${u + 1},${v}`) && !occ.has(`${u},${v + 1}`) && !occ.has(`${u + 1},${v + 1}`)
  if (!can2x2(start.u, start.v)) return 1
  const queue: GridPoint[] = [{ u: start.u, v: start.v }]
  const seen = new Set<string>([`${start.u},${start.v}`])
  let maxDepthU = 0
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur.u > maxDepthU) maxDepthU = cur.u
    for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nu = cur.u + du, nv = cur.v + dv, k = `${nu},${nv}`
      if (!seen.has(k) && can2x2(nu, nv)) { seen.add(k); queue.push({ u: nu, v: nv }) }
    }
  }
  return maxDepthU >= 6 ? 2 : 1
}

export function validateRoomLayout(plan: RoomPlan): LayoutAudit {
  const errors: string[] = []
  const allItems = [...plan.suites, ...plan.shared]
  const occ = new Map<string, string>()
  let overlapCount = 0

  for (const item of allItems) {
    for (const c of item.footprint) {
      if (c.u < 0 || c.v < 0 || c.u >= plan.cols || c.v >= plan.rows) errors.push(`${item.id} out of bounds`)
      const key = `${c.u},${c.v}`
      if (occ.has(key)) { overlapCount++; errors.push(`overlap at ${key}`) } else occ.set(key, item.id)
    }
  }

  let doorBlocked = false
  for (const dc of plan.doorCells) {
    if (occ.has(`${dc.u},${dc.v}`)) { doorBlocked = true; errors.push(`door tile (${dc.u},${dc.v}) blocked`) }
  }

  let minSuiteChebyshev = Infinity
  for (let i = 0; i < plan.suites.length; i++) {
    for (let j = i + 1; j < plan.suites.length; j++) {
      const d = chebyshevSetDist(plan.suites[i]!.footprint, plan.suites[j]!.footprint)
      if (d < minSuiteChebyshev) minSuiteChebyshev = d
      if (d < 2) errors.push(`suites ${plan.suites[i]!.id}&${plan.suites[j]!.id} Chebyshev=${d}<2`)
    }
  }

  let wallAttachOk = true
  for (const item of allItems) {
    if (!item.wallTouch) continue
    const attached = item.footprint.some((c) =>
      (item.wallTouch === 'back' && c.v === 0) || (item.wallTouch === 'left' && c.u === 0) || (item.wallTouch === 'right' && c.u === plan.cols - 1))
    if (!attached) { wallAttachOk = false; errors.push(`${item.id} detached from ${item.wallTouch}`) }
  }

  const furnitureOnly = new Set(occ.keys())
  let lineOfSightOk = true
  for (const s of plan.suites) {
    const suiteOcc = new Set(furnitureOnly)
    for (const c of s.footprint) suiteOcc.delete(`${c.u},${c.v}`)
    const center = { u: Math.floor(s.anchor.u + s.size[0] / 2), v: Math.floor(s.anchor.v + s.size[1] / 2) }
    if (!hasLineOfSight(suiteOcc, center, { u: 0, v: 9 })) { lineOfSightOk = false; errors.push(`${s.id} blocked LoS`) }
  }

  const maxAisleWidth = measureMainAisleWidth(furnitureOnly, plan.cols, plan.rows, plan.doorCells)
  if (maxAisleWidth < 2) errors.push(`aisle ${maxAisleWidth} < 2`)

  return {
    valid: errors.length === 0, errors, overlapCount, doorBlocked,
    minSuiteChebyshev: Number.isFinite(minSuiteChebyshev) ? minSuiteChebyshev : 0,
    maxAisleWidth, wallAttachOk, lineOfSightOk,
  }
}

export function generateRoomLayout(input: { workspaceId: string; workspaceOrder: number; seed: number }): RoomPlan {
  const tpl = ROOM_TOPOLOGY_TEMPLATES[0]!
  const rng = mulberry32(hashSeed(input.workspaceId, input.workspaceOrder, input.seed))
  const execShift = input.seed <= 1 ? 0 : Math.floor(rng() * 2) - 1
  const ws3Shift = input.seed <= 1 ? 0 : Math.floor(rng() * 2)
  const candidate = buildCandidatePlan(tpl, input, execShift, ws3Shift)
  return validateRoomLayout(candidate).valid ? candidate : buildCandidatePlan(tpl, input, 0, 0)
}

function buildCandidatePlan(
  tpl: RoomTopologyTemplate,
  input: { workspaceId: string; workspaceOrder: number; seed: number },
  execShift: number, ws3Shift: number,
): RoomPlan {
  const execU = Math.max(7, Math.min(11, 8 + execShift))
  const ws3U = Math.max(4, Math.min(6, 5 + ws3Shift))
  return {
    topologyId: tpl.id, workspaceId: input.workspaceId, workspaceOrder: input.workspaceOrder, seed: input.seed,
    cols: tpl.cols, rows: tpl.rows,
    doorCells: [{ u: 0, v: tpl.doorAt }, { u: 0, v: tpl.doorAt + 1 }, { u: 1, v: tpl.doorAt }, { u: 1, v: tpl.doorAt + 1 }],
    suites: [
      buildSuite('reception', 'reception', 'reception-desk', 0, 5, 3, 2, 'SE', 'left'),
      buildSuite('executive', 'executive', 'exec-desk', execU, 0, 4, 2, 'SW', 'back'),
      buildSuite('ws-1', 'workstation', 'workstation', 14, 3, 2, 2, 'SW', 'right'),
      buildSuite('ws-2', 'workstation', 'workstation', 14, 7, 2, 2, 'SW', 'right'),
      buildSuite('ws-3', 'workstation', 'workstation', ws3U, 10, 2, 2, 'NE'),
    ],
    shared: [
      buildSuite('bookshelf', 'shared', 'bookshelf', 3, 0, 2, 1, 'SE', 'back'),
      buildSuite('water-cooler', 'shared', 'water-cooler', 0, 1, 1, 1, 'SE', 'left'),
      buildSuite('floor-plant', 'shared', 'floor-plant', 14, 0, 1, 1, 'SW', 'back'),
      buildSuite('wastebin', 'shared', 'wastebin', 12, 10, 1, 1, 'NW'),
    ],
    wallMounts: [
      { id: 'entry-door', kind: 'door', wall: 'left', at: tpl.doorAt, h: 0, span: 2 },
      { id: 'back-window', kind: 'window', wall: 'back', at: 9, h: 20, span: 3 },
      { id: 'back-clock', kind: 'clock', wall: 'back', at: 6, h: 30, span: 1 },
      { id: 'left-corkboard', kind: 'corkboard', wall: 'left', at: 2, h: 20, span: 2 },
    ],
    actors: [
      { id: 'secretary', role: 'secretary', u: 1, v: 6, facing: 'SE', pose: 'sit', suiteId: 'reception' },
      { id: 'lead', role: 'lead', u: execU + 1, v: 1, facing: 'SW', pose: 'sit', suiteId: 'executive' },
      { id: 'worker-1', role: 'worker', u: 13, v: 4, facing: 'SE', pose: 'type', suiteId: 'ws-1' },
    ],
    rugRect: { u: 6, v: 4, w: 3, h: 3 },
  }
}
