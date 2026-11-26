/** V2.6 规整肉鸽预制房型、5 套家居组合、MST+环路走廊路网与 68px 全高连续墙体生成器。 */
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import type { Facing, GridPoint, RoomEntity, SuiteKind, WallSide } from './layout-solver.ts'
import type { CorridorBranchSpec, CorridorNetworkMetrics, FurnitureComboKind, InteriorDoorSpec, PrefabShapeKind, WallSegment3D, WallTier, WorldWingPlan } from './world-types.ts'

export type WingSlotPos = 'left' | 'topRight' | 'bottomRight'

export const PREFAB_SHAPE_KINDS: readonly PrefabShapeKind[] = ['l-alcove', 'stepped-zigzag', 'bay-window', 'chamfer-octagon', 't-studio', 'courtyard-nook']
export const FURNITURE_COMBO_KINDS: readonly FurnitureComboKind[] = ['paired-dev-pod', 'war-room-collab', 'exec-library-lounge', 'atelier-split', 'agile-scrum-bay']

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

type ShapePredicate = (du: number, dv: number, w: number, h: number, slot: WingSlotPos) => boolean

export const ROOM_SHAPE_PREFABS: Record<PrefabShapeKind, ShapePredicate> = {
  'l-alcove': (du, dv, w, h, slot) =>
    slot === 'left' ? !(du < 3 && dv < 4) : slot === 'topRight' ? !(du >= w - 3 && dv < 3) : !(du >= w - 3 && dv >= h - 3),
  'stepped-zigzag': (du, dv, w, h, slot) =>
    slot === 'left' ? !(du < 4 && dv < 3) : slot === 'topRight' ? !(du >= w - 4 && dv < 3) : !(du >= w - 4 && dv >= h - 3),
  'bay-window': (du, dv, w, h, slot) =>
    slot === 'left' ? (du >= 3 || (dv >= 3 && dv < h - 3)) : slot === 'topRight' ? du < w - 3 : !(du >= w - 3 && dv >= h - 4),
  'chamfer-octagon': (du, dv, w, h, slot) =>
    slot === 'left' ? !(du < 3 && dv < 3) : slot === 'topRight' ? !(du >= w - 3 && dv < 4) : (w - 1 - du) + (h - 1 - dv) >= 3,
  't-studio': (du, dv, w, h, slot) =>
    slot === 'left' ? !(du < 4 && dv >= h - 4) : slot === 'topRight' ? !(du >= w - 3 && dv < 4) : !(du >= w - 4 && dv >= h - 4),
  'courtyard-nook': (du, dv, w, h, slot) =>
    slot === 'left' ? !(du < 5 && dv < 3) : slot === 'topRight' ? !(du >= w - 4 && dv < 4) : !(du >= w - 3 && dv >= 3),
}

export function buildShapeCells(
  rect: { u: number; v: number; w: number; h: number }, shape: PrefabShapeKind, slotOrLeft: WingSlotPos | boolean, doorway: GridPoint,
): GridPoint[] {
  const slot: WingSlotPos = typeof slotOrLeft === 'boolean' ? (slotOrLeft ? 'left' : 'topRight') : slotOrLeft
  const pred = ROOM_SHAPE_PREFABS[shape], out: GridPoint[] = []
  for (let dv = 0; dv < rect.h; dv++) for (let du = 0; du < rect.w; du++) {
    const u = rect.u + du, v = rect.v + dv
    if (pred(du, dv, rect.w, rect.h, slot) || (u === doorway.u && Math.abs(v - doorway.v) <= 1)) out.push({ u, v })
  }
  return out
}

type ComboTuple = readonly [role: 'exec' | 'ws1' | 'ws2' | 'ws3' | 'shared', assetId: string, suiteKind: SuiteKind, du: number, dv: number, facing: Facing, seatOffset: readonly [number, number] | null]

export const FURNITURE_COMBO_TEMPLATES: Record<FurnitureComboKind, readonly ComboTuple[]> = {
  'paired-dev-pod': [
    ['exec', 'exec_desk', 'executive', 3, 1, 'SW', [1, -1]], ['ws1', 'desk_cluster', 'workstation', 2, 4, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 4, 8, 'SW', [1, -1]], ['ws3', 'worker_desk', 'workstation', 1, 8, 'SE', [-1, 0]],
    ['shared', 'bookshelf', 'shared', 6, 0, 'SE', null], ['shared', 'printer_copier', 'shared', 1, 6, 'SE', null],
    ['shared', 'water_cooler', 'shared', 0, 4, 'SE', null], ['shared', 'plant_pot', 'shared', 6, 2, 'SW', null],
  ],
  'war-room-collab': [
    ['exec', 'exec_desk', 'executive', 1, 1, 'SW', [1, -1]], ['ws1', 'worker_desk', 'workstation', 4, 2, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 4, 6, 'SW', [1, -1]], ['ws3', 'worker_desk', 'workstation', 1, 6, 'SE', [-1, 0]],
    ['shared', 'collab_table', 'shared', 2, 3, 'SE', null], ['shared', 'water_cooler', 'shared', 0, 2, 'SE', null],
    ['shared', 'bookshelf', 'shared', 4, 0, 'SE', null], ['shared', 'plant_pot', 'shared', 5, 1, 'SW', null],
  ],
  'exec-library-lounge': [
    ['exec', 'exec_desk', 'executive', 3, 1, 'SW', [1, -1]], ['ws1', 'worker_desk', 'workstation', 5, 3, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 4, 6, 'SW', [1, -1]], ['ws3', 'worker_desk', 'workstation', 1, 5, 'SE', [-1, 0]],
    ['shared', 'bookshelf', 'shared', 2, 0, 'SE', null], ['shared', 'armchair_green', 'shared', 1, 3, 'SE', null],
    ['shared', 'armchair_green', 'shared', 3, 5, 'SW', null], ['shared', 'lamp_table', 'shared', 5, 1, 'SW', null],
    ['shared', 'lamp_table', 'shared', 5, 5, 'SW', null], ['shared', 'plant_pot', 'shared', 1, 2, 'SW', null],
  ],
  'atelier-split': [
    ['exec', 'exec_desk', 'executive', 3, 1, 'SW', [1, -1]], ['ws1', 'worker_desk', 'workstation', 5, 3, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 4, 7, 'SW', [1, -1]], ['ws3', 'worker_desk', 'workstation', 1, 6, 'SE', [-1, 0]],
    ['shared', 'file_cabinet', 'shared', 6, 0, 'SE', null], ['shared', 'armchair_green', 'shared', 3, 4, 'SW', null],
    ['shared', 'lamp_table', 'shared', 1, 4, 'SE', null], ['shared', 'plant_pot', 'shared', 6, 2, 'SW', null],
  ],
  'agile-scrum-bay': [
    ['exec', 'exec_desk', 'executive', 3, 1, 'SW', [1, -1]], ['ws1', 'desk_cluster', 'workstation', 2, 4, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 4, 7, 'SW', [1, -1]], ['ws3', 'worker_desk', 'workstation', 1, 7, 'SE', [-1, 0]],
    ['shared', 'bookshelf', 'shared', 6, 0, 'SE', null], ['shared', 'printer_copier', 'shared', 1, 5, 'SE', null],
    ['shared', 'water_cooler', 'shared', 0, 3, 'SE', null], ['shared', 'plant_pot', 'shared', 6, 2, 'SW', null],
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
  const centerU = rect.u + rect.w * 0.42, centerV = rect.v + rect.h * 0.56
  const orderedCells = [...cells].sort((a, b) => (Math.abs(a.u - centerU) + Math.abs(a.v - centerV)) - (Math.abs(b.u - centerU) + Math.abs(b.v - centerV)))

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
  FURNITURE_COMBO_TEMPLATES[combo].forEach(([role, assetId, suiteKind, du, dv, facing, seatOffset], idx) => {
    const asSharedConsole = !wsId && role === 'exec' && combo === 'exec-library-lounge'
    if (!wsId && suiteKind !== 'shared' && !asSharedConsole) return
    const effKind: SuiteKind = asSharedConsole ? 'shared' : suiteKind, effSeat = asSharedConsole ? null : seatOffset
    const [mw, mh] = WORLD_ASSET_CATALOG[assetId]!.footprint
    const prefU = rect.u + Math.min(du, Math.max(0, rect.w - mw)), prefV = rect.v + Math.min(dv, Math.max(0, rect.h - mh))
    for (const cand of [{ u: prefU, v: prefV }, ...orderedCells]) {
      if (!canPlace(cand.u, cand.v, mw, mh, effSeat)) continue
      const added: string[] = []
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) { const k = cellKey(cand.u + x, cand.v + y); occupied.add(k); added.push(k) }
      const seat = effSeat ? { u: cand.u + effSeat[0], v: cand.v + effSeat[1] } : undefined
      if (!isReachable(seat ? [...placedSeats, seat] : placedSeats)) { for (const k of added) occupied.delete(k); continue }
      if (seat) { occupied.add(cellKey(seat.u, seat.v)); placedSeats.push(seat) }
      const id = asSharedConsole ? `console-pub-${idx}` : role === 'exec' ? `exec-${wsId}` : role.startsWith('ws') ? `ws-${wsId}-${role.slice(2)}` : `${combo}-${wsId ?? 'pub'}-${idx}`
      const ent = makeWorldEntity(id, assetId, effKind, cand.u, cand.v, facing, seat)
      if (effKind === 'shared') shared.push(ent); else suites.push(ent)
      return
    }
  })

  let rugRect: { u: number; v: number; w: number; h: number } | undefined
  for (const sz of [4, 3]) {
    for (const c of orderedCells) {
      let ok = true
      for (let dv = 0; dv < sz && ok; dv++) for (let du = 0; du < sz && ok; du++) {
        if (!valid.has(cellKey(c.u + du, c.v + dv)) || !valid.has(cellKey(c.u + du, Math.min(rect.v + rect.h - 1, c.v + dv + 1)))) ok = false
      }
      if (ok && c.u >= rect.u + 1 && c.v >= rect.v + 1 && c.u + sz <= rect.u + rect.w - 1 && c.v + sz <= rect.v + rect.h - 1) {
        rugRect = { u: c.u, v: c.v, w: sz, h: sz }; break
      }
    }
    if (rugRect) break
  }
  return { suites, shared, rugRect }
}

export function buildCorridorNetwork(
  buildingRows: number, wings: readonly WorldWingPlan[], rng: () => number, lobbyTopV = 0,
): { corridorCells: GridPoint[]; corridorBranches: CorridorBranchSpec[]; networkMetrics: CorridorNetworkMetrics } {
  const cellMap = new Map<string, GridPoint>()
  for (let v = lobbyTopV; v < buildingRows; v++) for (let u = 9; u < 13; u++) cellMap.set(cellKey(u, v), { u, v })
  const branches: CorridorBranchSpec[] = [
    { from: { u: 10, v: lobbyTopV + 2 }, to: { u: 10, v: buildingRows - 1 }, width: 2 + Math.floor(rng() * 2), hasRunner: true },
    { from: { u: 13, v: 9 }, to: { u: 19, v: 9 }, width: 2, hasRunner: false },
  ]
  const studios = wings.filter((w) => w.kind === 'studio'), roomCount = studios.length + 1
  const edgeCount = Math.max(0, roomCount - 1) + 1 + (studios.length >= 4 ? 1 : 0)
  return { corridorCells: [...cellMap.values()], corridorBranches: branches, networkMetrics: { roomCount, edgeCount, loopCount: edgeCount - roomCount + 1 } }
}

export function extractWallSegments3D(
  lobby: WorldWingPlan, wings: readonly WorldWingPlan[], corridorCells: readonly GridPoint[],
  _interiorDoors: readonly InteriorDoorSpec[], _mainEntrance: GridPoint, buildingRows: number,
): WallSegment3D[] {
  const zoneOf = new Map<string, string>()
  for (const c of corridorCells) zoneOf.set(cellKey(c.u, c.v), 'corridor')
  for (const c of lobby.cells ?? []) zoneOf.set(cellKey(c.u, c.v), 'corridor')
  for (const w of wings) if (w.kind === 'studio') for (const c of w.cells ?? []) zoneOf.set(cellKey(c.u, c.v), w.id)

  const raw: WallSegment3D[] = []
  const pushEdge = (from: GridPoint, to: GridPoint, tier: WallTier, shade: 'sunlit' | 'shaded' | 'exterior', startH: number, endH: number, hasWindow?: boolean) =>
    raw.push({ from, to, startH, endH, tier, shade, hasWindow })
  const hasFrontInCol = (col: number, afterV: number) => {
    for (let vv = afterV + 1; vv < buildingRows; vv++) if (zoneOf.has(cellKey(col, vv))) return true
    return false
  }
  const hasUpLeft = (u: number, v: number) => {
    for (let uu = 0; uu < u; uu++) for (let vv = 0; vv < v; vv++) if (zoneOf.has(cellKey(uu, vv))) return true
    return false
  }

  for (const [k, zId] of zoneOf.entries()) {
    const [u, v] = k.split(',').map(Number) as [number, number]
    const nNW = zoneOf.get(cellKey(u - 1, v)), nNE = zoneOf.get(cellKey(u, v - 1)), nSE = zoneOf.get(cellKey(u + 1, v)), nSW = zoneOf.get(cellKey(u, v + 1))
    if (!nNW) {
      if (u === 9 || u === 13) pushEdge({ u, v }, { u, v: v + 1 }, 'partition', 'shaded', 68, 68)
      else if (u > 0 && u < 9 && hasUpLeft(u, v)) pushEdge({ u, v }, { u, v: v + 1 }, 'cutaway', 'shaded', 34, 34)
      else pushEdge({ u, v }, { u, v: v + 1 }, 'back', 'shaded', 68, 68)
    }
    if (!nNE) pushEdge({ u, v }, { u: u + 1, v }, v === 9 && u >= 13 ? 'partition' : 'back', 'sunlit', 68, 68)
    if (nSE && nSE !== zId) pushEdge({ u: u + 1, v }, { u: u + 1, v: v + 1 }, 'partition', 'shaded', 68, 68)
    if (nSW && nSW !== zId) pushEdge({ u, v: v + 1 }, { u: u + 1, v: v + 1 }, 'partition', 'sunlit', 68, 68)

    if (!nSE && hasFrontInCol(u + 1, v)) {
      pushEdge({ u: u + 1, v }, { u: u + 1, v: v + 1 }, u + 1 === 9 || u + 1 === 13 ? 'partition' : 'back', 'shaded', 68, 68)
      if (!nSW) {
        const isPortal = v === buildingRows - 1 && u >= 9 && u <= 12
        pushEdge({ u, v: v + 1 }, { u: u + 1, v: v + 1 }, isPortal ? 'portal' : 'cutaway', 'sunlit', isPortal ? 54 : 34, isPortal ? 54 : 34)
      }
    } else if (!nSE && !nSW && (zoneOf.has(cellKey(u + 1, v - 1)) || zoneOf.has(cellKey(u - 1, v + 1)))) {
      pushEdge({ u: u + 1, v }, { u, v: v + 1 }, 'cutaway', 'exterior', 34, 34)
    } else {
      if (!nSE) pushEdge({ u: u + 1, v }, { u: u + 1, v: v + 1 }, 'cutaway', 'shaded', 34, 34)
      if (!nSW) {
        const isPortal = v === buildingRows - 1 && u >= 9 && u <= 12
        const hasWin = !isPortal && v === buildingRows - 1 && u === 15
        pushEdge({ u, v: v + 1 }, { u: u + 1, v: v + 1 }, isPortal ? 'portal' : 'cutaway', 'sunlit', isPortal ? 54 : 34, isPortal ? 54 : 34, hasWin)
      }
    }
  }
  return slopePartitionFrontEnds(mergeCollinearWalls(raw))
}

function mergeCollinearWalls(segs: readonly WallSegment3D[]): WallSegment3D[] {
  const out: WallSegment3D[] = [], used = new Uint8Array(segs.length)
  const canMerge = (a: WallSegment3D, b: WallSegment3D) => {
    if (a.tier !== b.tier || a.shade !== b.shade || a.startH !== a.endH || b.startH !== b.endH || a.startH !== b.startH) return false
    const duA = a.to.u - a.from.u, dvA = a.to.v - a.from.v, duB = b.to.u - b.from.u, dvB = b.to.v - b.from.v
    return duA * dvB === dvA * duB && duA * duB + dvA * dvB > 0
  }
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    let cur = segs[i]!; used[i] = 1
    let ext = true
    while (ext) {
      ext = false
      for (let j = 0; j < segs.length; j++) {
        const nxt = segs[j]!
        if (used[j] || !canMerge(cur, nxt)) continue
        const hw = cur.hasWindow || nxt.hasWindow ? true : undefined
        if (cur.to.u === nxt.from.u && cur.to.v === nxt.from.v) { cur = { ...cur, to: nxt.to, hasWindow: hw }; used[j] = 1; ext = true }
        else if (nxt.to.u === cur.from.u && nxt.to.v === cur.from.v) { cur = { ...cur, from: nxt.from, hasWindow: hw }; used[j] = 1; ext = true }
      }
    }
    out.push(cur)
  }
  return out
}

function slopePartitionFrontEnds(segs: readonly WallSegment3D[]): WallSegment3D[] {
  const touchSeg = (pt: GridPoint, c: WallSegment3D) => {
    if (c.from.u === c.to.u && c.from.u === pt.u) return pt.v >= Math.min(c.from.v, c.to.v) && pt.v <= Math.max(c.from.v, c.to.v)
    if (c.from.v === c.to.v && c.from.v === pt.v) return pt.u >= Math.min(c.from.u, c.to.u) && pt.u <= Math.max(c.from.u, c.to.u)
    return (c.from.u === pt.u && c.from.v === pt.v) || (c.to.u === pt.u && c.to.v === pt.v)
  }
  const continuesTall = (s: WallSegment3D) => segs.some((o) => o !== s && o.startH === 68
    && (o.to.u - o.from.u) * (s.to.v - s.from.v) === (o.to.v - o.from.v) * (s.to.u - s.from.u)
    && ((o.from.u === s.to.u && o.from.v === s.to.v) || (o.to.u === s.to.u && o.to.v === s.to.v)))
  const out: WallSegment3D[] = []
  for (const s of segs) {
    const hitPortal = segs.some((c) => c.tier === 'portal' && touchSeg(s.to, c))
    const hitCut = segs.some((c) => c.tier === 'cutaway' && touchSeg(s.to, c))
    if (s.tier !== 'partition' || continuesTall(s) || (!hitPortal && !hitCut)) { out.push(s); continue }
    const endH = hitPortal ? 54 : 34
    const isVert = s.from.u === s.to.u, len = isVert ? s.to.v - s.from.v : s.to.u - s.from.u
    if (len <= 1) { out.push({ ...s, startH: 68, endH }); continue }
    const mid: GridPoint = isVert ? { u: s.to.u, v: s.to.v - 1 } : { u: s.to.u - 1, v: s.to.v }
    out.push({ ...s, to: mid }, { ...s, from: mid, startH: 68, endH })
  }
  return out
}
