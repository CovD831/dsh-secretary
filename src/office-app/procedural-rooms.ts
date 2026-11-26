/** V2.5 肉鸽异形预制房型、5 套模块化家居组合、MST+环路走廊路网与三阶立体墙体生成器。 */
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import type { Facing, GridPoint, RoomEntity, RoomWallMount, SuiteKind, WallSide } from './layout-solver.ts'
import type { CorridorBranchSpec, CorridorNetworkMetrics, FurnitureComboKind, InteriorDoorSpec, PrefabShapeKind, WallSegment3D, WallTier, WorldWingPlan } from './world-types.ts'

export const PREFAB_SHAPE_KINDS: readonly PrefabShapeKind[] = [
  'l-alcove', 'stepped-zigzag', 'bay-window', 'chamfer-octagon', 't-studio', 'courtyard-nook',
]

export const FURNITURE_COMBO_KINDS: readonly FurnitureComboKind[] = [
  'paired-dev-pod', 'war-room-collab', 'exec-library-lounge', 'atelier-split', 'agile-scrum-bay',
]

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const cellKey = (u: number, v: number): string => `${u},${v}`

function rectFootprint(u: number, v: number, w: number, h: number): GridPoint[] {
  const cells: GridPoint[] = []
  for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) cells.push({ u: u + du, v: v + dv })
  return cells
}

export function makeWorldEntity(
  id: string, assetId: string, suiteKind: SuiteKind, u: number, v: number, facing: Facing, seatCell?: GridPoint, wallTouch?: WallSide | 'right',
): RoomEntity {
  const meta = WORLD_ASSET_CATALOG[assetId]!
  const [w, h] = meta.footprint
  return {
    id, assetId, suiteKind, anchor: { u, v }, size: [w, h], facing,
    mirrorX: facing === 'NW' || facing === 'SW', wallTouch, footprint: rectFootprint(u, v, w, h), seatCell, propKind: meta.propKind,
  }
}

type ShapePredicate = (du: number, dv: number, w: number, h: number, isLeft: boolean) => boolean

export const ROOM_SHAPE_PREFABS: Record<PrefabShapeKind, ShapePredicate> = {
  'l-alcove': (du, dv, w, h, isLeft) => isLeft ? !(du < 2 && dv >= h - 3) : !(du >= w - 2 && dv < 2),
  'stepped-zigzag': (du, dv, w, h, isLeft) => isLeft ? !(du < 2 && dv < 2) && !(du < 1 && dv >= h - 2) : !(du >= w - 2 && dv >= h - 2) && !(du >= w - 1 && dv < 2),
  'bay-window': (du, dv, w, h, isLeft) => { const m = Math.floor(h / 2); return isLeft ? du >= 1 || Math.abs(dv - m) <= 1 : du < w - 1 || Math.abs(dv - m) <= 1 },
  'chamfer-octagon': (du, dv, w, h, isLeft) => isLeft ? du + dv >= 1 && (w - 1 - du) + dv >= 0 && du + (h - 1 - dv) >= 2 : (w - 1 - du) + (h - 1 - dv) >= 2 && (w - 1 - du) + dv >= 1,
  't-studio': (du, dv, w, h, isLeft) => (dv >= 2 && dv < h - 2) || (isLeft ? du >= 2 : du < w - 2),
  'courtyard-nook': (du, dv, w, h, isLeft) => !(dv >= h - 2 && (isLeft ? du >= 2 && du <= 4 : Math.abs(du - Math.floor(w / 2)) <= 1)),
}

export function buildShapeCells(
  rect: { u: number; v: number; w: number; h: number }, shape: PrefabShapeKind, isLeft: boolean, doorway: GridPoint,
): GridPoint[] {
  const pred = ROOM_SHAPE_PREFABS[shape], out: GridPoint[] = []
  for (let dv = 0; dv < rect.h; dv++) for (let du = 0; du < rect.w; du++) {
    const u = rect.u + du, v = rect.v + dv
    if (pred(du, dv, rect.w, rect.h, isLeft) || (u === doorway.u && Math.abs(v - doorway.v) <= 1)) out.push({ u, v })
  }
  return out
}

type ComboTuple = readonly [role: 'exec' | 'ws1' | 'ws2' | 'ws3' | 'shared', assetId: string, suiteKind: SuiteKind, du: number, dv: number, facing: Facing, seatOffset: readonly [number, number] | null]

export const FURNITURE_COMBO_TEMPLATES: Record<FurnitureComboKind, readonly ComboTuple[]> = {
  'paired-dev-pod': [
    ['exec', 'exec_desk', 'executive', 2, 1, 'SW', [1, -1]],
    ['ws1', 'desk_cluster', 'workstation', 3, 5, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 6, 5, 'SW', [1, -1]],
    ['ws3', 'worker_desk', 'workstation', 2, 5, 'SE', [-1, 0]],
    ['shared', 'bookshelf', 'shared', 6, 0, 'SE', null],
    ['shared', 'printer_copier', 'shared', 1, 5, 'SE', null],
    ['shared', 'water_cooler', 'shared', 1, 2, 'SE', null],
    ['shared', 'plant_pot', 'shared', 7, 1, 'SW', null],
  ],
  'war-room-collab': [
    ['exec', 'exec_desk', 'executive', 1, 1, 'SW', [1, -1]],
    ['ws1', 'worker_desk', 'workstation', 4, 2, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 5, 5, 'SW', [1, -1]],
    ['ws3', 'worker_desk', 'workstation', 1, 5, 'SE', [-1, 0]],
    ['shared', 'collab_table', 'shared', 3, 3, 'SE', null],
    ['shared', 'bookshelf', 'shared', 5, 0, 'SE', null],
    ['shared', 'plant_pot', 'shared', 7, 1, 'SW', null],
  ],
  'exec-library-lounge': [
    ['exec', 'exec_desk', 'executive', 1, 1, 'SW', [1, -1]],
    ['ws1', 'worker_desk', 'workstation', 5, 2, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 5, 5, 'SW', [1, -1]],
    ['ws3', 'worker_desk', 'workstation', 1, 5, 'SE', [-1, 0]],
    ['shared', 'bookshelf', 'shared', 5, 0, 'SE', null],
    ['shared', 'armchair_green', 'shared', 2, 4, 'SE', null],
    ['shared', 'lamp_table', 'shared', 7, 1, 'SW', null],
  ],
  'atelier-split': [
    ['exec', 'exec_desk', 'executive', 2, 1, 'SW', [1, -1]],
    ['ws1', 'worker_desk', 'workstation', 6, 2, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 6, 5, 'SW', [1, -1]],
    ['ws3', 'worker_desk', 'workstation', 2, 4, 'SE', [-1, 0]],
    ['shared', 'file_cabinet', 'shared', 4, 0, 'SE', null],
    ['shared', 'plant_pot', 'shared', 7, 1, 'SW', null],
  ],
  'agile-scrum-bay': [
    ['exec', 'exec_desk', 'executive', 2, 1, 'SW', [1, -1]],
    ['ws1', 'desk_cluster', 'workstation', 2, 4, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 6, 4, 'SW', [1, -1]],
    ['ws3', 'worker_desk', 'workstation', 1, 4, 'SE', [-1, 0]],
    ['shared', 'bookshelf', 'shared', 6, 0, 'SE', null],
    ['shared', 'water_cooler', 'shared', 1, 2, 'SE', null],
  ],
}

export function populateWingFurniture(
  rect: { u: number; v: number; w: number; h: number },
  cells: readonly GridPoint[],
  doorway: GridPoint,
  combo: FurnitureComboKind,
  wsId: string | undefined,
): { suites: RoomEntity[]; shared: RoomEntity[]; rugRect?: { u: number; v: number; w: number; h: number } } {
  const valid = new Set(cells.map((c) => cellKey(c.u, c.v)))
  const inDir = doorway.u <= rect.u + 1 ? 1 : -1
  const occupied = new Set<string>([
    cellKey(doorway.u, doorway.v), cellKey(doorway.u, doorway.v + 1),
    cellKey(doorway.u + inDir, doorway.v), cellKey(doorway.u + inDir, doorway.v + 1),
  ])
  const suites: RoomEntity[] = [], shared: RoomEntity[] = []

  const canPlace = (u: number, v: number, w: number, h: number, seatOff: readonly [number, number] | null): boolean => {
    for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) {
      const k = cellKey(u + du, v + dv)
      if (!valid.has(k) || occupied.has(k)) return false
    }
    if (seatOff) {
      const sk = cellKey(u + seatOff[0], v + seatOff[1])
      if (!valid.has(sk) || occupied.has(sk)) return false
    }
    return true
  }

  const isReachable = (seats: readonly GridPoint[]): boolean => {
    const q: GridPoint[] = [doorway], seen = new Set<string>([cellKey(doorway.u, doorway.v)])
    while (q.length > 0) {
      const c = q.shift()!
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nu = c.u + du, nv = c.v + dv, nk = cellKey(nu, nv)
        if (!seen.has(nk) && valid.has(nk) && (!occupied.has(nk) || seats.some((s) => s.u === nu && s.v === nv))) {
          seen.add(nk); q.push({ u: nu, v: nv })
        }
      }
    }
    return seats.every((s) => seen.has(cellKey(s.u, s.v)))
  }

  const placedSeats: GridPoint[] = []
  const placeSlot = ([role, assetId, suiteKind, du, dv, facing, seatOffset]: ComboTuple, idx: number) => {
    if (!wsId && suiteKind !== 'shared') return
    const [mw, mh] = WORLD_ASSET_CATALOG[assetId]!.footprint
    const prefU = rect.u + Math.min(du, Math.max(0, rect.w - mw)), prefV = rect.v + Math.min(dv, Math.max(0, rect.h - mh))
    for (const cand of [{ u: prefU, v: prefV }, ...cells]) {
      if (!canPlace(cand.u, cand.v, mw, mh, seatOffset)) continue
      const added: string[] = []
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) { const k = cellKey(cand.u + x, cand.v + y); occupied.add(k); added.push(k) }
      const seat = seatOffset ? { u: cand.u + seatOffset[0], v: cand.v + seatOffset[1] } : undefined
      if (!isReachable(seat ? [...placedSeats, seat] : placedSeats)) {
        for (const k of added) occupied.delete(k)
        continue
      }
      if (seat) { occupied.add(cellKey(seat.u, seat.v)); placedSeats.push(seat) }
      const id = role === 'exec' ? `exec-${wsId}` : role.startsWith('ws') ? `ws-${wsId}-${role.slice(2)}` : `${combo}-${wsId ?? 'pub'}-${idx}`
      const ent = makeWorldEntity(id, assetId, suiteKind, cand.u, cand.v, facing, seat)
      if (suiteKind === 'shared') shared.push(ent); else suites.push(ent)
      return
    }
  }

  const slots = FURNITURE_COMBO_TEMPLATES[combo]
  slots.forEach((s, idx) => placeSlot(s, idx))
  const rugU = rect.u + 2, rugV = rect.v + 2, rugW = Math.min(5, rect.w - 3), rugH = Math.min(5, rect.h - 3)
  const rugOk = rugW >= 3 && rugH >= 3 && valid.has(cellKey(rugU + 1, rugV + 1))
  return { suites, shared, rugRect: rugOk ? { u: rugU, v: rugV, w: rugW, h: rugH } : undefined }
}

export function buildCorridorNetwork(
  buildingRows: number, wings: readonly WorldWingPlan[], rng: () => number,
): { corridorCells: GridPoint[]; corridorBranches: CorridorBranchSpec[]; networkMetrics: CorridorNetworkMetrics } {
  const cellMap = new Map<string, GridPoint>()
  const addRect = (u0: number, v0: number, w: number, h: number) => {
    for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) cellMap.set(cellKey(u0 + du, v0 + dv), { u: u0 + du, v: v0 + dv })
  }
  addRect(9, 0, 4, buildingRows)
  const branches: CorridorBranchSpec[] = [
    { from: { u: 10, v: 3 }, to: { u: 10, v: buildingRows - 1 }, width: 2 + Math.floor(rng() * 2), hasRunner: true },
    { from: { u: 12, v: 8 }, to: { u: 20, v: 8 }, width: 2, hasRunner: true },
  ]
  addRect(12, 8, 9, 2)
  const studios = wings.filter((w) => w.kind === 'studio')
  for (let i = 3; i < studios.length; i += 2) {
    const rv = studios[i]!.rect.v
    branches.push({ from: { u: 12, v: rv }, to: { u: 18, v: rv }, width: 2, hasRunner: true })
    addRect(12, rv, 6, 2)
  }
  const roomCount = studios.length + 1
  const mstEdges = Math.max(0, roomCount - 1)
  const extraLoopEdges = 1 + (studios.length >= 4 ? 1 : 0)
  const edgeCount = mstEdges + extraLoopEdges
  return {
    corridorCells: [...cellMap.values()],
    corridorBranches: branches,
    networkMetrics: { roomCount, edgeCount, loopCount: edgeCount - roomCount + 1 },
  }
}

export function extractWallSegments3D(
  lobby: WorldWingPlan, wings: readonly WorldWingPlan[], corridorCells: readonly GridPoint[],
  interiorDoors: readonly InteriorDoorSpec[], mainEntrance: GridPoint, buildingRows: number,
): WallSegment3D[] {
  const zoneOf = new Map<string, string>()
  for (const c of corridorCells) zoneOf.set(cellKey(c.u, c.v), 'corridor')
  for (const c of lobby.cells ?? []) zoneOf.set(cellKey(c.u, c.v), 'corridor')
  for (const w of wings) if (w.kind === 'studio') for (const c of w.cells ?? []) zoneOf.set(cellKey(c.u, c.v), w.id)

  const doorSet = new Set<string>()
  for (const d of interiorDoors) {
    if (d.axis === 'u') { doorSet.add(`u:${d.u},${d.v}`); doorSet.add(`u:${d.u},${d.v + 1}`) }
    else { doorSet.add(`v:${d.u},${d.v}`); doorSet.add(`v:${d.u + 1},${d.v}`) }
  }

  const raw: WallSegment3D[] = []
  const pushEdge = (from: GridPoint, to: GridPoint, tier: WallTier, shade: 'sunlit' | 'shaded' | 'exterior', startH: number, endH: number, hasWindow?: boolean) => {
    raw.push({ from, to, startH, endH, tier, shade, hasWindow })
  }

  for (const [k, zId] of zoneOf.entries()) {
    const [u, v] = k.split(',').map(Number) as [number, number]
    const nNW = zoneOf.get(cellKey(u - 1, v)), nNE = zoneOf.get(cellKey(u, v - 1))
    const nSE = zoneOf.get(cellKey(u + 1, v)), nSW = zoneOf.get(cellKey(u, v + 1))

    if (!nNW) pushEdge({ u, v }, { u, v: v + 1 }, 'back', 'shaded', 64, 64)
    if (!nNE) pushEdge({ u, v }, { u: u + 1, v }, 'back', 'sunlit', 64, 64)

    if (nSE && nSE !== zId && !doorSet.has(`u:${u + 1},${v}`)) {
      const touchesFront = !zoneOf.has(cellKey(u, v + 1)) || !zoneOf.has(cellKey(u + 1, v + 1))
      pushEdge({ u: u + 1, v }, { u: u + 1, v: v + 1 }, 'partition', 'shaded', 56, touchesFront ? 38 : 56)
    }
    if (nSW && nSW !== zId && !doorSet.has(`v:${u},${v + 1}`)) {
      const touchesFront = !zoneOf.has(cellKey(u + 1, v)) || !zoneOf.has(cellKey(u + 1, v + 1))
      pushEdge({ u, v: v + 1 }, { u: u + 1, v: v + 1 }, 'partition', 'sunlit', 56, touchesFront ? 38 : 56)
    }

    if (!nSE && !nSW && (zoneOf.has(cellKey(u + 1, v - 1)) || zoneOf.has(cellKey(u - 1, v + 1)))) {
      pushEdge({ u: u + 1, v }, { u, v: v + 1 }, 'cutaway', 'exterior', 34, 34)
    } else {
      if (!nSE) pushEdge({ u: u + 1, v }, { u: u + 1, v: v + 1 }, 'cutaway', 'shaded', 34, 34)
      if (!nSW) {
        const isPortal = v === buildingRows - 1 && Math.abs(u - mainEntrance.u) <= 2
        const hasWin = !isPortal && v === buildingRows - 1 && (u === 15 || u === 16)
        pushEdge({ u, v: v + 1 }, { u: u + 1, v: v + 1 }, isPortal ? 'portal' : 'cutaway', 'sunlit', isPortal ? 54 : 34, isPortal ? 54 : 34, hasWin)
      }
    }
  }
  return mergeCollinearWalls(raw)
}

function mergeCollinearWalls(segs: readonly WallSegment3D[]): WallSegment3D[] {
  const out: WallSegment3D[] = []
  const used = new Uint8Array(segs.length)
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    let cur = segs[i]!
    used[i] = 1
    if (cur.startH === cur.endH && (cur.from.u === cur.to.u || cur.from.v === cur.to.v)) {
      let extended = true
      while (extended) {
        extended = false
        for (let j = 0; j < segs.length; j++) {
          if (used[j]) continue
          const nxt = segs[j]!
          if (nxt.tier === cur.tier && nxt.shade === cur.shade && nxt.startH === cur.startH && nxt.endH === cur.endH
            && cur.to.u === nxt.from.u && cur.to.v === nxt.from.v && ((cur.from.u === cur.to.u && nxt.from.u === nxt.to.u) || (cur.from.v === cur.to.v && nxt.from.v === nxt.to.v))) {
            cur = { ...cur, to: nxt.to, hasWindow: cur.hasWindow || nxt.hasWindow }
            used[j] = 1
            extended = true
          }
        }
      }
    }
    out.push(cur)
  }
  return out
}

export function buildWallMountsForWing(
  wingId: string, rect: { u: number; v: number; w: number; h: number }, cells: readonly GridPoint[],
  doorway: GridPoint, wsId: string | undefined, isLeft: boolean, seedIdx: number,
): RoomWallMount[] {
  const cellSet = new Set(cells.map((c) => cellKey(c.u, c.v)))
  const mounts: RoomWallMount[] = []
  const hasBackAt = (u: number) => cellSet.has(cellKey(u, rect.v)) && !cellSet.has(cellKey(u, rect.v - 1))
  if (hasBackAt(rect.u + 4)) mounts.push({ id: `art-${wingId}`, assetId: seedIdx % 2 === 0 ? 'wall_painting' : 'idea_board', wall: 'back', at: rect.u + 4.5, h: 14, span: 2 })
  if (hasBackAt(rect.u + 6)) mounts.push({ id: `win-${wingId}`, assetId: 'window_wide', wall: 'back', at: rect.u + 6.5, h: 12, span: 3 })
  if (wsId) mounts.push({ id: `doorplate-${wsId}`, assetId: 'doorplate', wall: isLeft ? 'left' : 'back', at: isLeft ? doorway.v - 0.8 : doorway.u + 0.5, h: 24, span: 1, propKind: 'doorplate' })
  return mounts
}
