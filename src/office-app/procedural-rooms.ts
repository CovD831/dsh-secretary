/** V2.7 零遮挡肉鸽预制房型、2 格净空走道家居组合、L 形中庭路网与全实心阶梯剖面墙生成器。 */
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
  const meta = WORLD_ASSET_CATALOG[assetId]!, [w, h] = meta.footprint
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
    slot === 'left' ? (du >= 3 || (dv >= 3 && dv < h - 3)) : slot === 'topRight' ? !(du >= w - 3 && dv < 4) : !(du >= w - 3 && dv >= h - 4),
  'chamfer-octagon': (du, dv, w, h, slot) =>
    slot === 'left' ? !(du < 3 && dv < 3) : slot === 'topRight' ? !(du >= w - 4 && dv < 4) : (w - 1 - du) + (h - 1 - dv) >= 3,
  't-studio': (du, dv, w, h, slot) =>
    slot === 'left' ? !(du < 4 && dv >= h - 4) : slot === 'topRight' ? !(du >= w - 3 && dv < (h >= 8 ? 5 : 4)) : !(du >= w - 4 && dv >= h - 4),
  'courtyard-nook': (du, dv, w, h, slot) =>
    slot === 'left' ? !(du < 5 && dv < 3) : slot === 'topRight' ? !(du >= w - 5 && dv < 3) : !(du >= w - 3 && dv >= 3),
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
    ['exec', 'exec_desk', 'executive', 3, 1, 'SW', [1, -1]], ['ws1', 'desk_cluster', 'workstation', 1, 5, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 4, 9, 'SW', [1, -1]], ['ws3', 'worker_desk', 'workstation', 1, 9, 'SE', [-1, 0]],
    ['shared', 'bookshelf', 'shared', 4, 0, 'SE', null], ['shared', 'printer_copier', 'shared', 1, 7, 'SE', null],
    ['shared', 'water_cooler', 'shared', 0, 4, 'SE', null], ['shared', 'plant_pot', 'shared', 5, 2, 'SW', null],
  ],
  'war-room-collab': [
    ['exec', 'exec_desk', 'executive', 1, 1, 'SW', [1, -1]], ['ws1', 'worker_desk', 'workstation', 5, 1, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 5, 4, 'SW', [1, -1]], ['ws3', 'worker_desk', 'workstation', 1, 4, 'SE', [-1, 0]],
    ['shared', 'collab_table', 'shared', 2, 3, 'SE', null], ['shared', 'water_cooler', 'shared', 0, 2, 'SE', null],
    ['shared', 'bookshelf', 'shared', 4, 0, 'SE', null], ['shared', 'plant_pot', 'shared', 6, 1, 'SW', null],
  ],
  'exec-library-lounge': [
    ['exec', 'exec_desk', 'executive', 2, 2, 'SW', [1, -1]], ['ws1', 'worker_desk', 'workstation', 4, 0, 'SE', [-1, 0]],
    ['ws2', 'worker_desk', 'workstation', 0, 5, 'SW', [1, -1]], ['ws3', 'worker_desk', 'workstation', 2, 5, 'SW', [1, -1]],
    ['shared', 'bookshelf', 'shared', 1, 0, 'SE', null], ['shared', 'armchair_green', 'shared', 0, 3, 'SE', null],
    ['shared', 'armchair_green', 'shared', 5, 3, 'SW', null], ['shared', 'lamp_table', 'shared', 6, 1, 'SW', null],
    ['shared', 'lamp_table', 'shared', 5, 5, 'SW', null], ['shared', 'plant_pot', 'shared', 5, 2, 'SW', null],
  ],
  'atelier-split': [
    ['exec', 'exec_desk', 'executive', 3, 1, 'SW', [1, -1]], ['ws1', 'worker_desk', 'workstation', 4, 3, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 4, 6, 'SW', [1, -1]], ['ws3', 'worker_desk', 'workstation', 1, 5, 'SE', [-1, 0]],
    ['shared', 'file_cabinet', 'shared', 5, 0, 'SE', null], ['shared', 'armchair_green', 'shared', 2, 4, 'SW', null],
    ['shared', 'lamp_table', 'shared', 1, 3, 'SE', null], ['shared', 'plant_pot', 'shared', 5, 2, 'SW', null],
  ],
  'agile-scrum-bay': [
    ['exec', 'exec_desk', 'executive', 3, 1, 'SW', [1, -1]], ['ws1', 'desk_cluster', 'workstation', 1, 4, 'SW', [1, -1]],
    ['ws2', 'worker_desk', 'workstation', 4, 7, 'SW', [1, -1]], ['ws3', 'worker_desk', 'workstation', 1, 7, 'SE', [-1, 0]],
    ['shared', 'bookshelf', 'shared', 4, 0, 'SE', null], ['shared', 'printer_copier', 'shared', 1, 5, 'SE', null],
    ['shared', 'water_cooler', 'shared', 0, 3, 'SE', null], ['shared', 'plant_pot', 'shared', 5, 2, 'SW', null],
  ],
}

export function populateWingFurniture(
  rect: { u: number; v: number; w: number; h: number }, cells: readonly GridPoint[], doorway: GridPoint,
  combo: FurnitureComboKind, wsId: string | undefined, slot: WingSlotPos = doorway.u <= rect.u + 1 ? 'topRight' : 'left',
): { suites: RoomEntity[]; shared: RoomEntity[]; rugRect?: { u: number; v: number; w: number; h: number } } {
  const valid = new Set(cells.map((c) => cellKey(c.u, c.v))), inDir = doorway.u <= rect.u + 1 ? 1 : -1
  const occupied = new Set<string>([cellKey(doorway.u, doorway.v), cellKey(doorway.u, doorway.v + 1), cellKey(doorway.u + inDir, doorway.v), cellKey(doorway.u + inDir, doorway.v + 1)])
  const suites: RoomEntity[] = [], shared: RoomEntity[] = []
  const maxU = slot === 'left' ? rect.u + rect.w - 2 : rect.u + rect.w - 1
  const maxV = slot === 'topRight' ? rect.v + rect.h - 2 : rect.v + rect.h - 1
  const centerU = rect.u + rect.w * 0.32, centerV = rect.v + rect.h * 0.42
  const orderedCells = [...cells].sort((a, b) => (Math.abs(a.u - centerU) + Math.abs(a.v - centerV)) - (Math.abs(b.u - centerU) + Math.abs(b.v - centerV)))

  const canPlace = (u: number, v: number, w: number, h: number, seatOff: readonly [number, number] | null, fgPad: number): boolean => {
    if (fgPad > 0 && ((slot === 'left' && v < doorway.v + 2 && u + w > rect.u + rect.w - 3) || (slot === 'topRight' && u < rect.u + 6 && v + h > rect.v + rect.h - 3))) return false
    for (let dv = 0; dv < h + fgPad; dv++) for (let du = 0; du < w + fgPad; du++) {
      const k = cellKey(u + du, v + dv)
      if (!valid.has(k) || (dv < h && du < w && occupied.has(k))) return false
    }
    if (!seatOff) return true
    const sk = cellKey(u + seatOff[0], v + seatOff[1]); return valid.has(sk) && !occupied.has(sk)
  }

  const isReachable = (seats: readonly GridPoint[]): boolean => {
    const q: GridPoint[] = [doorway], seen = new Set<string>([cellKey(doorway.u, doorway.v)])
    while (q.length > 0) {
      const c = q.shift()!
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nu = c.u + du, nv = c.v + dv, nk = cellKey(nu, nv)
        if (!seen.has(nk) && valid.has(nk) && (!occupied.has(nk) || seats.some((s) => s.u === nu && s.v === nv))) { seen.add(nk); q.push({ u: nu, v: nv }) }
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
    const prefU = rect.u + Math.min(du, Math.max(0, rect.w - 2 - mw))
    const prefV = rect.v + Math.min(dv, Math.max(0, rect.h - 2 - mh))
    const pads = effKind === 'shared' ? [2, 1, 0] : [2]
    for (const pad of pads) {
      for (const cand of [{ u: prefU, v: prefV }, ...orderedCells]) {
        if (!canPlace(cand.u, cand.v, mw, mh, effSeat, pad)) continue
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
    }
  })

  let rugRect: { u: number; v: number; w: number; h: number } | undefined
  for (const sz of [4, 3]) {
    for (const c of orderedCells) {
      let ok = c.u >= rect.u + 1 && c.v >= rect.v + 1 && c.u + sz <= maxU && c.v + sz <= maxV
      for (let dv = 0; dv < sz && ok; dv++) for (let du = 0; du < sz && ok; du++) {
        if (!valid.has(cellKey(c.u + du, c.v + dv))) ok = false
      }
      if (ok) { rugRect = { u: c.u, v: c.v, w: sz, h: sz }; break }
    }
    if (rugRect) break
  }
  return { suites, shared, rugRect }
}

export function buildCorridorNetwork(
  buildingRows: number, wings: readonly WorldWingPlan[], rng: () => number, lobbyTopV = 0,
): { corridorCells: GridPoint[]; corridorBranches: CorridorBranchSpec[]; networkMetrics: CorridorNetworkMetrics } {
  const cellMap = new Map<string, GridPoint>()
  for (let v = lobbyTopV; v < buildingRows; v++) {
    const uEnd = v < 9 ? 14 : 16
    for (let u = 9; u < uEnd; u++) cellMap.set(cellKey(u, v), { u, v })
  }
  const branches: CorridorBranchSpec[] = [
    { from: { u: 12, v: 9 }, to: { u: 12, v: buildingRows - 1 }, width: 2 + Math.floor(rng() * 2), hasRunner: true },
    { from: { u: 14, v: 9 }, to: { u: 20, v: 9 }, width: 2, hasRunner: false },
  ]
  const studios = wings.filter((w) => w.kind === 'studio'), roomCount = studios.length + 1
  const edgeCount = Math.max(0, roomCount - 1) + 1 + (studios.length >= 4 ? 1 : 0)
  return { corridorCells: [...cellMap.values()], corridorBranches: branches, networkMetrics: { roomCount, edgeCount, loopCount: edgeCount - roomCount + 1 } }
}

export function extractWallSegments3D(
  lobby: WorldWingPlan, wings: readonly WorldWingPlan[], corridorCells: readonly GridPoint[],
  interiorDoors: readonly InteriorDoorSpec[], _mainEntrance: GridPoint, buildingRows: number,
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
      if (u === 9 || u === 14 || u === 16) pushEdge({ u, v }, { u, v: v + 1 }, 'partition', 'shaded', 56, 56)
      else if (u > 0 && u < 9 && hasUpLeft(u, v)) pushEdge({ u, v }, { u, v: v + 1 }, 'cutaway', 'shaded', 32, 32)
      else pushEdge({ u, v }, { u, v: v + 1 }, 'back', 'shaded', 56, 56)
    }
    if (!nNE) pushEdge({ u, v }, { u: u + 1, v }, v === 9 && u >= 14 ? 'partition' : 'back', 'sunlit', 56, 56)
    if (nSE && nSE !== zId) pushEdge({ u: u + 1, v }, { u: u + 1, v: v + 1 }, 'partition', 'shaded', 56, 56)
    if (nSW && nSW !== zId) pushEdge({ u, v: v + 1 }, { u: u + 1, v: v + 1 }, 'partition', 'sunlit', 56, 56)

    if (!nSE && hasFrontInCol(u + 1, v)) {
      pushEdge({ u: u + 1, v }, { u: u + 1, v: v + 1 }, u + 1 === 9 || u + 1 === 14 || u + 1 === 16 ? 'partition' : 'back', 'shaded', 56, 56)
      if (!nSW) {
        const isPortal = v === buildingRows - 1 && u >= 12 && u <= 14
        pushEdge({ u, v: v + 1 }, { u: u + 1, v: v + 1 }, isPortal ? 'portal' : 'cutaway', 'sunlit', isPortal ? 50 : 32, isPortal ? 50 : 32)
      }
    } else if (!nSE && !nSW && (zoneOf.has(cellKey(u + 1, v - 1)) || zoneOf.has(cellKey(u - 1, v + 1)))) {
      pushEdge({ u: u + 1, v }, { u, v: v + 1 }, 'cutaway', 'exterior', 32, 32)
    } else {
      if (!nSE) pushEdge({ u: u + 1, v }, { u: u + 1, v: v + 1 }, 'cutaway', 'shaded', 32, 32)
      if (!nSW) {
        const isPortal = v === buildingRows - 1 && u >= 12 && u <= 14
        const hasWin = !isPortal && v === buildingRows - 1 && u === 18
        pushEdge({ u, v: v + 1 }, { u: u + 1, v: v + 1 }, isPortal ? 'portal' : 'cutaway', 'sunlit', isPortal ? 50 : 32, isPortal ? 50 : 32, hasWin)
      }
    }
  }
  return stepAndSlopePartitions(mergeCollinearWalls(raw), interiorDoors)
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

function stepAndSlopePartitions(segs: readonly WallSegment3D[], doors: readonly InteriorDoorSpec[]): WallSegment3D[] {
  const touchCut = (pt: GridPoint) => segs.some((c) => c.tier === 'cutaway' && (
    c.from.u === c.to.u && c.from.u === pt.u ? pt.v >= Math.min(c.from.v, c.to.v) && pt.v <= Math.max(c.from.v, c.to.v)
      : c.from.v === c.to.v && c.from.v === pt.v ? pt.u >= Math.min(c.from.u, c.to.u) && pt.u <= Math.max(c.from.u, c.to.u)
        : (c.from.u === pt.u && c.from.v === pt.v) || (c.to.u === pt.u && c.to.v === pt.v)
  ))
  const out: WallSegment3D[] = []
  for (const s of segs) {
    if (s.tier !== 'partition' || !touchCut(s.to)) { out.push(s); continue }
    const isVert = s.from.u === s.to.u
    const c0 = isVert ? s.from.v : s.from.u, c1 = isVert ? s.to.v : s.to.u
    const doorEnds = doors.filter((d) => isVert ? d.axis === 'u' && d.u === s.from.u && d.v >= c0 && d.v < c1 : d.axis === 'v' && d.v === s.from.v && d.u >= c0 && d.u < c1)
      .map((d) => (isVert ? d.v : d.u) + 2)
    const cutAt = Math.max(c0 + 3, ...doorEnds)
    const pt = (c: number): GridPoint => isVert ? { u: s.from.u, v: c } : { u: c, v: s.from.v }
    if (c1 - cutAt >= 4) {
      out.push(
        { ...s, to: pt(cutAt), startH: 56, endH: 56 },
        { ...s, from: pt(cutAt), to: pt(cutAt + 1), startH: 56, endH: 38 },
        { ...s, from: pt(cutAt + 1), to: pt(c1 - 1), startH: 38, endH: 38 },
        { ...s, from: pt(c1 - 1), to: pt(c1), startH: 38, endH: 32 },
      )
    } else {
      out.push({ ...s, to: pt(c1 - 1), startH: 56, endH: 56 }, { ...s, from: pt(c1 - 1), to: pt(c1), startH: 56, endH: 32 })
    }
  }
  return out
}
