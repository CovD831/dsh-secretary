import { OFFICE_CATALOG, type PropKind } from './catalog.ts'

export const ROOM_COLS = 16
export const ROOM_ROWS = 12
export const TILE_W = 32
export const TILE_H = 16
export const CANVAS_W = 1440
export const CANVAS_H = 900
export const DEFAULT_ORIGIN = { x: 720, y: 156 } as const

export type Facing = 'NE' | 'NW' | 'SE' | 'SW'
export type WallSide = 'back' | 'left'
export type SuiteKind = 'reception' | 'executive' | 'workstation' | 'shared'

export interface GridPoint { u: number; v: number }

export interface RoomEntity {
  id: string
  assetId: string
  suiteKind: SuiteKind
  anchor: GridPoint
  size: readonly [number, number]
  facing: Facing
  mirrorX: boolean
  wallTouch?: WallSide | 'right'
  footprint: GridPoint[]
  seatCell?: GridPoint
  propKind?: PropKind
}

export interface RoomWallMount {
  id: string
  assetId: string
  wall: WallSide
  at: number
  h: number
  span: number
  propKind?: PropKind
}

export interface OfficeRoomPlan {
  workspaceId: string
  seed: number
  cols: number
  rows: number
  origin: { x: number; y: number }
  doorCells: GridPoint[]
  suites: RoomEntity[]
  shared: RoomEntity[]
  wallMounts: RoomWallMount[]
  rugRect: { u: number; v: number; w: number; h: number }
}

export interface OfficeLayoutAudit {
  valid: boolean
  errors: string[]
  overlapCount: number
  doorBlocked: boolean
  minSuiteChebyshev: number
  maxAisleWidth: number
}

function fnv1aHash(workspaceId: string, seed: number): number {
  let h = 2166136261 ^ (seed * 374761393)
  for (let i = 0; i < workspaceId.length; i++) {
    h = Math.imul(h ^ workspaceId.charCodeAt(i), 16777619)
  }
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

function rectFootprint(u: number, v: number, w: number, h: number): GridPoint[] {
  const cells: GridPoint[] = []
  for (let dv = 0; dv < h; dv++) {
    for (let du = 0; du < w; du++) cells.push({ u: u + du, v: v + dv })
  }
  return cells
}

function chebyshevSetDist(a: readonly GridPoint[], b: readonly GridPoint[]): number {
  let best = Infinity
  for (const pa of a) {
    for (const pb of b) {
      const d = Math.max(Math.abs(pa.u - pb.u), Math.abs(pa.v - pb.v))
      if (d < best) best = d
    }
  }
  return best
}

function buildEntity(
  id: string,
  assetId: string,
  suiteKind: SuiteKind,
  u: number,
  v: number,
  facing: Facing,
  seatCell?: GridPoint,
  wallTouch?: WallSide | 'right',
): RoomEntity {
  const meta = OFFICE_CATALOG[assetId]!
  const [w, h] = meta.footprint
  return {
    id,
    assetId,
    suiteKind,
    anchor: { u, v },
    size: [w, h],
    facing,
    mirrorX: facing === 'NW' || facing === 'SW',
    wallTouch,
    footprint: rectFootprint(u, v, w, h),
    seatCell,
    propKind: meta.propKind,
  }
}

function measureMainAisleWidth(occ: Set<string>, cols: number, rows: number, doorCells: readonly GridPoint[]): number {
  const start = doorCells[0]
  if (!start) return 0
  const can2x2 = (u: number, v: number) =>
    u >= 0 && v >= 0 && u + 1 < cols && v + 1 < rows
    && !occ.has(`${u},${v}`) && !occ.has(`${u + 1},${v}`)
    && !occ.has(`${u},${v + 1}`) && !occ.has(`${u + 1},${v + 1}`)
  if (!can2x2(start.u, start.v)) return 1
  const queue: GridPoint[] = [{ u: start.u, v: start.v }]
  const seen = new Set<string>([`${start.u},${start.v}`])
  let maxU = 0
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur.u > maxU) maxU = cur.u
    for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nu = cur.u + du, nv = cur.v + dv, k = `${nu},${nv}`
      if (!seen.has(k) && can2x2(nu, nv)) {
        seen.add(k)
        queue.push({ u: nu, v: nv })
      }
    }
  }
  return maxU >= 6 ? 2 : 1
}

export function validateOfficeLayout(plan: OfficeRoomPlan): OfficeLayoutAudit {
  const errors: string[] = []
  const all = [...plan.suites, ...plan.shared]
  const occ = new Map<string, string>()
  let overlapCount = 0

  for (const item of all) {
    for (const c of item.footprint) {
      if (c.u < 0 || c.v < 0 || c.u >= plan.cols || c.v >= plan.rows) {
        errors.push(`${item.id} out of bounds`)
      }
      const key = `${c.u},${c.v}`
      if (occ.has(key)) {
        overlapCount++
        errors.push(`overlap at ${key}`)
      } else {
        occ.set(key, item.id)
      }
    }
  }

  let doorBlocked = false
  for (const dc of plan.doorCells) {
    if (occ.has(`${dc.u},${dc.v}`)) {
      doorBlocked = true
      errors.push(`door tile (${dc.u},${dc.v}) blocked`)
    }
  }

  let minSuiteChebyshev = Infinity
  for (let i = 0; i < plan.suites.length; i++) {
    for (let j = i + 1; j < plan.suites.length; j++) {
      const d = chebyshevSetDist(plan.suites[i]!.footprint, plan.suites[j]!.footprint)
      if (d < minSuiteChebyshev) minSuiteChebyshev = d
      if (d < 2) errors.push(`${plan.suites[i]!.id} & ${plan.suites[j]!.id} Chebyshev=${d} < 2`)
    }
  }

  const maxAisleWidth = measureMainAisleWidth(new Set(occ.keys()), plan.cols, plan.rows, plan.doorCells)
  if (maxAisleWidth < 2) errors.push(`main aisle width ${maxAisleWidth} < 2`)

  return {
    valid: errors.length === 0,
    errors,
    overlapCount,
    doorBlocked,
    minSuiteChebyshev: Number.isFinite(minSuiteChebyshev) ? minSuiteChebyshev : 0,
    maxAisleWidth,
  }
}

function buildPlanCandidate(
  workspaceId: string,
  seed: number,
  execU: number,
  ws1V: number,
  ws2V: number,
  ws3U: number,
  coolerV: number,
): OfficeRoomPlan {
  return {
    workspaceId,
    seed,
    cols: ROOM_COLS,
    rows: ROOM_ROWS,
    origin: { ...DEFAULT_ORIGIN },
    doorCells: [{ u: 0, v: 9 }, { u: 0, v: 10 }, { u: 1, v: 9 }, { u: 1, v: 10 }],
    suites: [
      buildEntity('reception', 'reception_desk', 'reception', 0, 5, 'SE', { u: 1, v: 6 }, 'left'),
      buildEntity('executive', 'exec_desk', 'executive', execU, 0, 'SW', { u: execU + 2, v: 1 }, 'back'),
      buildEntity('ws-1', 'worker_desk', 'workstation', 14, ws1V, 'SW', { u: 13, v: ws1V + 1 }, 'right'),
      buildEntity('ws-2', 'worker_desk', 'workstation', 14, ws2V, 'SW', { u: 13, v: ws2V + 1 }, 'right'),
      buildEntity('ws-3', 'worker_desk', 'workstation', ws3U, 10, 'NE', { u: ws3U + 1, v: 9 }),
    ],
    shared: [
      buildEntity('bookshelf', 'bookshelf', 'shared', 3, 0, 'SE', undefined, 'back'),
      buildEntity('file-cabinet', 'file_cabinet', 'shared', 12, 10, 'NW'),
      buildEntity('water-cooler', 'water_cooler', 'shared', 0, coolerV, 'SE', undefined, 'left'),
      buildEntity('plant-pot', 'plant_pot', 'shared', 15, 0, 'SW', undefined, 'back'),
    ],
    wallMounts: [
      { id: 'entry-door', assetId: 'door_glass', wall: 'left', at: 9, h: 0, span: 2 },
      { id: 'doorplate', assetId: 'doorplate', wall: 'left', at: 7.5, h: 20, span: 1, propKind: 'doorplate' },
      { id: 'back-window', assetId: 'window_day', wall: 'back', at: 5, h: 12, span: 2 },
      { id: 'wall-clock', assetId: 'clock_wall', wall: 'back', at: 7.5, h: 24, span: 1 },
      { id: 'corkboard', assetId: 'corkboard', wall: 'back', at: 11.5, h: 10, span: 2, propKind: 'corkboard' },
    ],
    rugRect: { u: 6, v: 4, w: 4, h: 4 },
  }
}

export function solveOfficeLayout(workspaceId: string, seed = 1): OfficeRoomPlan {
  const rng = mulberry32(fnv1aHash(workspaceId, seed))
  const execU = 7 + Math.floor(rng() * 3)
  const ws1V = 2 + Math.floor(rng() * 2)
  const ws2V = 6 + Math.floor(rng() * 2)
  const ws3U = 5 + Math.floor(rng() * 3)
  const coolerV = 1 + Math.floor(rng() * 2)
  const candidate = buildPlanCandidate(workspaceId, seed, execU, ws1V, ws2V, ws3U, coolerV)
  return validateOfficeLayout(candidate).valid
    ? candidate
    : buildPlanCandidate(workspaceId, seed, 8, 3, 7, 6, 1)
}
