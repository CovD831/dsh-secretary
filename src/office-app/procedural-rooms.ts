/** 双档等距剖面墙（后/隔断 56px，前外墙 34px）、肉鸽预制房型与室内规范纯函数工具。 */
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import type { Facing, GridPoint, RoomEntity, SuiteKind, WallSide } from './layout-solver.ts'
import { populateCuratedWing } from './room-blueprints.ts'
import type { CorridorBranchSpec, CorridorNetworkMetrics, FurnitureComboKind, InteriorDoorSpec, PrefabShapeKind, WallSegment3D, WallTier, WorldWingPlan } from './world-types.ts'

export type WingSlotPos = 'left' | 'topRight' | 'bottomRight'
export type RoomDoorSpec = { readonly u: number; readonly v: number; readonly axis: 'u' | 'v'; readonly inDir: 1 | -1 }
export const UNIFIED_WALL_H = 56
export const CUTAWAY_WALL_H = 34
export const PREFAB_SHAPE_KINDS: readonly PrefabShapeKind[] = ['l-alcove', 'stepped-zigzag', 'bay-window', 'chamfer-octagon', 't-studio', 'courtyard-nook']
export const FURNITURE_COMBO_KINDS: readonly FurnitureComboKind[] = ['paired-dev-pod', 'war-room-collab', 'exec-library-lounge', 'atelier-split', 'agile-scrum-bay']

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
export const cellKey = (u: number, v: number): string => `${u},${v}`
export function isChamferEdgeCell(u: number, v: number, cellSet: ReadonlySet<string>): boolean {
  return !cellSet.has(cellKey(u + 1, v)) && !cellSet.has(cellKey(u, v + 1)) && (cellSet.has(cellKey(u + 1, v - 1)) || cellSet.has(cellKey(u - 1, v + 1)))
}
export function buildDoorEntryZones(doors: readonly RoomDoorSpec[]): Set<string> {
  const out = new Set<string>()
  for (const d of doors) for (let step = 0; step < 3; step++) {
    if (d.axis === 'u') { out.add(cellKey(d.u + d.inDir * step, d.v)); out.add(cellKey(d.u + d.inDir * step, d.v + 1)) }
    else { out.add(cellKey(d.u, d.v + d.inDir * step)); out.add(cellKey(d.u + 1, d.v + d.inDir * step)) }
  }
  return out
}
export function isSeatFacingDoor(u: number, v: number, mw: number, mh: number, facing: Facing, doors: readonly RoomDoorSpec[]): boolean {
  return doors.some((d) => {
    if (d.axis === 'u') {
      const vHit = d.v <= v + mh && d.v + 1 >= v - 1
      return (facing === 'SE' && vHit && d.u >= u + mw - 1) || (facing === 'NW' && vHit && d.u <= u)
    }
    const uHit = d.u <= u + mw && d.u + 1 >= u - 1
    return (facing === 'SW' && uHit && d.v >= v + mh - 1) || (facing === 'NE' && uHit && d.v <= v)
  })
}
export function armrestCellsFor(host: { u: number; v: number; mw: number; mh: number; facing: Facing }): GridPoint[] {
  return host.facing === 'SW' || host.facing === 'NE'
    ? [{ u: host.u - 1, v: host.v }, { u: host.u + host.mw, v: host.v }]
    : [{ u: host.u, v: host.v - 1 }, { u: host.u, v: host.v + host.mh }]
}
export function isDeskWallClear(u: number, v: number, mw: number, mh: number, assetId: string, valid: ReadonlySet<string>): boolean {
  for (let du = 0; du < mw; du++) {
    if (!valid.has(cellKey(u + du, v - 1)) || !valid.has(cellKey(u + du, v + mh))) return false
    if (!valid.has(cellKey(u + du, v - 2))) return false
    if ((assetId === 'desk_cluster' || assetId === 'collab_table') && !valid.has(cellKey(u + du, v + mh + 1))) return false
  }
  for (let dv = 0; dv < mh; dv++) {
    if (!valid.has(cellKey(u - 1, v + dv)) || !valid.has(cellKey(u + mw, v + dv))) return false
    if (assetId === 'collab_table' && (!valid.has(cellKey(u - 2, v + dv)) || !valid.has(cellKey(u + mw + 1, v + dv)))) return false
  }
  return true
}
function rectFootprint(u: number, v: number, w: number, h: number): GridPoint[] {
  const cells: GridPoint[] = []; for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) cells.push({ u: u + du, v: v + dv }); return cells
}
export function makeWorldChairs(suite: RoomEntity): (RoomEntity & { zOff?: number })[] {
  if (suite.assetId === 'collab_table') return []
  if (suite.assetId === 'desk_cluster') return [
    { id: `chair-${suite.id}-ne`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u: suite.anchor.u + 0.72, v: suite.anchor.v - 2.22 }, size: [1, 1], facing: 'SW', mirrorX: true, footprint: [], zOff: -6 },
    { id: `chair-${suite.id}-sw`, assetId: 'back_chair', suiteKind: 'shared', anchor: { u: suite.anchor.u + 1.15, v: suite.anchor.v + 2.45 }, size: [1, 1], facing: 'NE', mirrorX: false, footprint: [], zOff: 6 },
  ]
  const isRec = suite.suiteKind === 'reception', isExec = suite.assetId === 'exec_desk', faceSE = isRec || suite.facing === 'SE'
  const u = isRec ? suite.anchor.u - 0.88 : isExec ? suite.anchor.u + 1.14 : faceSE ? suite.anchor.u - 0.73 : suite.anchor.u + 0.60
  const v = isRec ? suite.anchor.v + 1.05 : isExec ? suite.anchor.v - 1.32 : faceSE ? suite.anchor.v + 0.60 : suite.anchor.v - 0.73
  return [{ id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u, v }, size: [1, 1], facing: faceSE ? 'SE' : 'SW', mirrorX: !faceSE, footprint: [], zOff: -6 }]
}
export function extractWallCorners(segs: readonly WallSegment3D[]): { u: number; v: number; h: number; fg: boolean }[] {
  const m = new Map<string, { u: number; v: number; h: number; hasU: boolean; hasV: boolean; fg: boolean }>()
  const add = (u: number, v: number, h: number, isU: boolean, fg: boolean) => {
    const k = cellKey(u, v), c = m.get(k) ?? { u, v, h, hasU: false, hasV: false, fg: false }
    if (isU) c.hasU = true; else c.hasV = true; if (fg) c.fg = true; m.set(k, c)
  }
  for (const s of segs) if (s.from.v === s.to.v || s.from.u === s.to.u) {
    const isU = s.from.v === s.to.v, fg = s.tier !== 'back'
    add(s.from.u, s.from.v, s.startH, isU, fg); add(s.to.u, s.to.v, s.endH, isU, fg)
  }
  return [...m.values()].filter((c) => c.hasU && c.hasV)
}
export function makeWorldEntity(id: string, assetId: string, suiteKind: SuiteKind, u: number, v: number, facing: Facing, seatCell?: GridPoint, wallTouch?: WallSide | 'right'): RoomEntity {
  const meta = WORLD_ASSET_CATALOG[assetId]!, isBackCab = assetId === 'bookshelf' || assetId === 'file_cabinet'
  const isSwNative = isBackCab || assetId === 'sofa_lounge'
  const [w, h] = isBackCab && facing === 'SE' ? [meta.footprint[1], meta.footprint[0]] : meta.footprint
  const mirrorX = isSwNative ? facing === 'SE' || facing === 'NE' : facing === 'NW' || facing === 'SW'
  return { id, assetId, suiteKind, anchor: { u, v }, size: [w, h], facing, mirrorX, wallTouch, footprint: rectFootprint(u, v, w, h), seatCell, propKind: meta.propKind }
}

type ShapePredicate = (du: number, dv: number, w: number, h: number, slot: WingSlotPos) => boolean
const cleanSlot = (du: number, dv: number, w: number, h: number, slot: WingSlotPos, chamfer: number) =>
  slot !== 'bottomRight' || chamfer === 0 || (w - 1 - du) + (h - 1 - dv) >= chamfer
export const ROOM_SHAPE_PREFABS: Record<PrefabShapeKind, ShapePredicate> = {
  'l-alcove': (du, dv, w, h, slot) => cleanSlot(du, dv, w, h, slot, 0),
  'stepped-zigzag': (du, dv, w, h, slot) => cleanSlot(du, dv, w, h, slot, 2),
  'bay-window': (du, dv, w, h, slot) => cleanSlot(du, dv, w, h, slot, 3),
  'chamfer-octagon': (du, dv, w, h, slot) => cleanSlot(du, dv, w, h, slot, 2),
  't-studio': (du, dv, w, h, slot) => cleanSlot(du, dv, w, h, slot, 0),
  'courtyard-nook': (du, dv, w, h, slot) => cleanSlot(du, dv, w, h, slot, 0),
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

const iso1 = (u: number, v: number) => ({ x: (u - v) * 16, y: (u + v) * 8 })
function inQuad(px: number, py: number, pts: readonly { x: number; y: number }[]): boolean {
  let c = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!, b = pts[j]!
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) c = !c
  }
  return c
}
export function boxOcc(segs: readonly WallSegment3D[], x0: number, y0: number, bw: number, bh: number, u0: number, v0: number, u1: number, v1: number, footY: number): number {
  let hit = 0, tot = 0
  for (let yy = 0; yy < bh; yy += 4) for (let xx = 0; xx < bw; xx += 4) {
    tot++; const px = x0 + xx, py = y0 + yy
    for (const s of segs) {
      if (s.tier === 'back') continue
      const n = Math.max(1, Math.round(Math.max(Math.abs(s.to.u - s.from.u), Math.abs(s.to.v - s.from.v))))
      let cov = false
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n
        const ua = s.from.u + (s.to.u - s.from.u) * t0, va = s.from.v + (s.to.v - s.from.v) * t0
        const ub = s.from.u + (s.to.u - s.from.u) * t1, vb = s.from.v + (s.to.v - s.from.v) * t1
        const um = (ua + ub) / 2, vm = (va + vb) / 2, a = iso1(ua, va), b = iso1(ub, vb)
        if (!(um <= u0 || vm <= v0) && (um >= u1 || vm >= v1 || (a.y + b.y) / 2 > footY - 3) && inQuad(px, py, [a, b, { x: b.x, y: b.y - s.endH }, { x: a.x, y: a.y - s.startH }])) { cov = true; break }
      }
      if (cov) { hit++; break }
    }
  }
  return tot > 0 ? hit / tot : 0
}
export interface PopulateWingOpts { readonly extraReserved?: readonly GridPoint[]; readonly wallSegments?: readonly WallSegment3D[]; readonly doors?: readonly RoomDoorSpec[]; readonly seed?: number }

export function populateWingFurniture(
  rect: { u: number; v: number; w: number; h: number }, cells: readonly GridPoint[], doorway: GridPoint,
  combo: FurnitureComboKind, wsId: string | undefined, slot: WingSlotPos = doorway.u <= rect.u + 1 ? 'topRight' : 'left', opts?: PopulateWingOpts,
): { suites: RoomEntity[]; shared: RoomEntity[]; rugRect?: { u: number; v: number; w: number; h: number } } {
  return populateCuratedWing(rect, cells, doorway, combo, wsId, slot, opts?.extraReserved, opts?.wallSegments, opts?.doors, opts?.seed)
}

export function buildCorridorNetwork(
  buildingRows: number, wings: readonly WorldWingPlan[], rng: () => number, lobbyTopV = 0, splitV = 10, hasTopRight = true,
): { corridorCells: GridPoint[]; corridorBranches: CorridorBranchSpec[]; networkMetrics: CorridorNetworkMetrics } {
  const cellMap = new Map<string, GridPoint>()
  for (let v = lobbyTopV; v < buildingRows; v++) {
    const uEnd = hasTopRight && v < splitV ? 16 : 17
    for (let u = 10; u < uEnd; u++) cellMap.set(cellKey(u, v), { u, v })
  }
  const branches: CorridorBranchSpec[] = [
    { from: { u: 13.0, v: Math.max(14, buildingRows - 6) }, to: { u: 13.0, v: buildingRows - 1 }, width: 2 + Math.floor(rng() * 2), hasRunner: true },
    ...(hasTopRight ? [{ from: { u: 16, v: splitV }, to: { u: 22, v: splitV }, width: 2, hasRunner: false }] : []),
  ]
  const studios = wings.filter((w) => w.kind === 'studio'), roomCount = studios.length + 1
  const edgeCount = Math.max(0, roomCount - 1) + 1 + (studios.length >= 4 ? 1 : 0)
  return { corridorCells: [...cellMap.values()], corridorBranches: branches, networkMetrics: { roomCount, edgeCount, loopCount: edgeCount - roomCount + 1 } }
}

export function extractWallSegments3D(
  lobby: WorldWingPlan, wings: readonly WorldWingPlan[], corridorCells: readonly GridPoint[],
  _interiorDoors: readonly InteriorDoorSpec[], _mainEntrance: GridPoint, buildingRows: number,
): WallSegment3D[] {
  const zoneOf = new Map<string, string>(), raw: WallSegment3D[] = []
  for (const c of [...corridorCells, ...(lobby.cells ?? [])]) zoneOf.set(cellKey(c.u, c.v), 'corridor')
  for (const w of wings) if (w.kind === 'studio') for (const c of w.cells ?? []) zoneOf.set(cellKey(c.u, c.v), w.id)
  const pushEdge = (from: GridPoint, to: GridPoint, tier: WallTier, shade: 'sunlit' | 'shaded' | 'exterior', hasWindow?: boolean) => {
    const h = tier === 'cutaway' || tier === 'portal' ? CUTAWAY_WALL_H : UNIFIED_WALL_H
    raw.push({ from, to, startH: h, endH: h, tier, shade, hasWindow })
  }
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
    if (!nNW) pushEdge({ u, v }, { u, v: v + 1 }, u === 10 && hasUpLeft(u, v) ? 'cutaway' : 'back', 'shaded')
    if (!nNE) pushEdge({ u, v }, { u: u + 1, v }, 'back', 'sunlit')
    if (nSE && nSE !== zId) pushEdge({ u: u + 1, v }, { u: u + 1, v: v + 1 }, 'partition', 'shaded')
    if (nSW && nSW !== zId) pushEdge({ u, v: v + 1 }, { u: u + 1, v: v + 1 }, 'partition', 'sunlit')
    if (!nSE && hasFrontInCol(u + 1, v)) {
      pushEdge({ u: u + 1, v }, { u: u + 1, v: v + 1 }, 'back', 'shaded')
      if (!nSW) pushEdge({ u, v: v + 1 }, { u: u + 1, v: v + 1 }, v === buildingRows - 1 && u >= 10 && u <= 16 ? 'portal' : 'cutaway', 'sunlit')
    } else if (!nSE && !nSW && (zoneOf.has(cellKey(u + 1, v - 1)) || zoneOf.has(cellKey(u - 1, v + 1)))) {
      pushEdge({ u: u + 1, v }, { u, v: v + 1 }, 'cutaway', 'exterior')
    } else {
      if (!nSE) pushEdge({ u: u + 1, v }, { u: u + 1, v: v + 1 }, 'cutaway', 'shaded')
      if (!nSW) {
        const isPortal = v === buildingRows - 1 && u >= 10 && u <= 16
        pushEdge({ u, v: v + 1 }, { u: u + 1, v: v + 1 }, isPortal ? 'portal' : 'cutaway', 'sunlit', !isPortal && v === buildingRows - 1 && u === 21)
      }
    }
  }
  const vH = new Map<string, number>()
  for (const e of raw) if (e.tier === 'cutaway' || e.tier === 'portal') {
    vH.set(cellKey(e.from.u, e.from.v), CUTAWAY_WALL_H); vH.set(cellKey(e.to.u, e.to.v), CUTAWAY_WALL_H)
  }
  const cont = raw.map((e) => ({
    ...e, startH: vH.get(cellKey(e.from.u, e.from.v)) ?? UNIFIED_WALL_H, endH: vH.get(cellKey(e.to.u, e.to.v)) ?? UNIFIED_WALL_H,
  }))
  return mergeCollinearWalls(cont)
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
    let cur = segs[i]!, ext = true; used[i] = 1
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
