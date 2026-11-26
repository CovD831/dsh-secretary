/** 通用室内排布硬规（门轴净空、禁直冲门、扶手伴生灯、1 格净空环）与居中偶数倍率大地毯求解器。 */
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import type { Facing, GridPoint, RoomEntity } from './layout-solver.ts'
import { type RoomDoorSpec, type WingSlotPos, armrestCellsFor, boxOcc, buildDoorEntryZones, isChamferEdgeCell, isDeskWallClear, isSeatFacingDoor, makeWorldEntity } from './procedural-rooms.ts'
import { type BlueprintItem, buildProceduralRecipe } from './roguelike-pcg.ts'
import type { FurnitureComboKind, WallSegment3D } from './world-types.ts'

export const TALL_WALL_BLOCKERS = new Set(['bookshelf', 'file_cabinet', 'printer_copier', 'water_cooler', 'plant_pot', 'lamp_table'])

const key = (u: number, v: number) => `${u},${v}`
const iso1 = (u: number, v: number) => ({ x: (u - v) * 16, y: (u + v) * 8 })

export function populateCuratedWing(
  rect: { u: number; v: number; w: number; h: number }, cells: readonly GridPoint[], doorway: GridPoint,
  combo: FurnitureComboKind, wsId: string | undefined, slot: WingSlotPos,
  extraReserved: readonly GridPoint[] = [], segs: readonly WallSegment3D[] = [], doors: readonly RoomDoorSpec[] = [], seed = 1,
): { suites: RoomEntity[]; shared: RoomEntity[]; rugRect?: { u: number; v: number; w: number; h: number } } {
  const valid = new Set(cells.map((c) => key(c.u, c.v))), inDir: 1 | -1 = doorway.u <= rect.u + 1 ? 1 : -1
  const allDoors: RoomDoorSpec[] = doors.length > 0 ? [...doors] : [{ u: doorway.u, v: doorway.v, axis: 'u', inDir }]
  const interior = new Set(cells.filter((c) => !isChamferEdgeCell(c.u, c.v, valid)).map((c) => key(c.u, c.v)))
  const seatBlocked = new Set<string>([...buildDoorEntryZones(allDoors), ...extraReserved.map((r) => key(r.u, r.v))])
  const deskBlocked = new Set<string>(seatBlocked)
  const solid = new Set<string>(), placedSeats: GridPoint[] = [], suites: RoomEntity[] = [], shared: RoomEntity[] = []
  const placed = new Map<string, { u: number; v: number; mw: number; mh: number; facing: Facing }>()
  const isBack = (u: number, v: number) => interior.has(key(u, v)) && !valid.has(key(u, v - 1))
  const isLeft = (u: number, v: number) => interior.has(key(u, v)) && !valid.has(key(u - 1, v))
  const isCorner = (u: number, v: number) => (isBack(u, v) && (isLeft(u, v) || !valid.has(key(u + 1, v)))) || (isLeft(u, v) && !valid.has(key(u, v + 1)))

  const haloClear = (u: number, v: number, mw: number, mh: number, pairWith?: string): boolean => {
    for (const [r, e] of placed.entries()) if (r !== pairWith && u <= e.u + e.mw && u + mw >= e.u && v <= e.v + e.mh && v + mh >= e.v) return false
    return true
  }
  const isReachable = (seats: readonly GridPoint[]): boolean => {
    const q: GridPoint[] = [doorway], seen = new Set<string>([key(doorway.u, doorway.v)])
    while (q.length > 0) {
      const c = q.shift()!
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nu = c.u + du, nv = c.v + dv, nk = key(nu, nv)
        if (!seen.has(nk) && valid.has(nk) && (!solid.has(nk) || seats.some((s) => s.u === nu && s.v === nv))) { seen.add(nk); q.push({ u: nu, v: nv }) }
      }
    }
    return seats.every((s) => seen.has(key(s.u, s.v)))
  }

  const intCells = cells.filter((c) => interior.has(key(c.u, c.v)))
  let wsSeq = 0, usedArea = 0

  const placeItem = (item: BlueprintItem, idx: number, allowSideOpt: boolean): boolean => {
    const m = WORLD_ASSET_CATALOG[item.assetId]!, [bw, bh] = m.footprint
    const prefU = rect.u + item.pref[0], prefV = rect.v + item.pref[1]
    const rowRef = item.alignRowWith ? placed.get(item.alignRowWith) : undefined, colRef = item.alignColWith ? placed.get(item.alignColWith) : undefined
    const host = item.pairWith ? placed.get(item.pairWith) : undefined
    const byDist = [...intCells].sort((a, b) => (Math.abs(a.u - prefU) + Math.abs(a.v - prefV)) - (Math.abs(b.u - prefU) + Math.abs(b.v - prefV)))
    const cands = host && item.pairWith
      ? armrestCellsFor(host).sort((a, b) => (Math.abs(a.u - prefU) + Math.abs(a.v - prefV)) - (Math.abs(b.u - prefU) + Math.abs(b.v - prefV))).map((c) => ({ u: c.u, v: c.v, mw: bw, mh: bh, facing: host.facing, wall: undefined, seatOff: null }))
      : item.zone === 'backWall'
        ? [
            ...byDist.filter((c) => isBack(c.u, c.v) && (bw === 1 || isBack(c.u + 1, c.v))).map((c) => ({ u: c.u, v: c.v, mw: bw, mh: bh, facing: 'SW' as Facing, wall: 'back' as const, seatOff: null })),
            ...byDist.filter((c) => isLeft(c.u, c.v) && (bw === 1 || isLeft(c.u, c.v + 1))).map((c) => ({ u: c.u, v: c.v, mw: bh, mh: bw, facing: 'SE' as Facing, wall: 'left' as const, seatOff: null })),
          ]
        : item.zone === 'sideWall'
          ? byDist.filter((c) => isLeft(c.u, c.v) || isBack(c.u, c.v)).map((c) => {
              const onL = isLeft(c.u, c.v), swap = onL && (item.assetId === 'bookshelf' || item.assetId === 'file_cabinet')
              return { u: c.u, v: c.v, mw: swap ? bh : bw, mh: swap ? bw : bh, facing: (onL ? 'SE' : 'SW') as Facing, wall: (onL ? 'left' : 'back') as 'left' | 'back', seatOff: null }
            })
          : item.zone === 'corner'
            ? [...byDist.filter((c) => isCorner(c.u, c.v)), ...byDist.filter((c) => isLeft(c.u, c.v) || isBack(c.u, c.v))].map((c) => ({ u: c.u, v: c.v, mw: bw, mh: bh, facing: item.facing, wall: undefined, seatOff: null }))
            : [...byDist.map((c) => ({ u: c.u, v: c.v, mw: bw, mh: bh, facing: item.facing, wall: undefined, seatOff: item.seatOff })), ...(item.assetId === 'worker_desk' && allowSideOpt && !rowRef && !colRef ? byDist.map((c) => ({ u: c.u, v: c.v, mw: bw, mh: bh, facing: 'SE' as Facing, wall: undefined, seatOff: [-1, 1] as const })) : [])]
    const maxR = item.kind === 'workstation' || item.zone === 'focal' || item.assetId === 'bookshelf' || item.assetId === 'file_cabinet' ? 0.08 : 0.14
    const isSeat = item.assetId === 'armchair_green' || item.assetId === 'sofa_lounge'
    for (const a of cands) {
      if ((rowRef && a.v !== rowRef.v) || (colRef && a.u !== colRef.u)) continue
      if (item.zone !== 'focal' && item.kind !== 'workstation' && (usedArea + a.mw * a.mh) / cells.length > 0.345) continue
      if (isSeat && isSeatFacingDoor(a.u, a.v, a.mw, a.mh, a.facing, allDoors)) continue
      if ((item.kind === 'workstation' || item.assetId === 'collab_table') && !isDeskWallClear(a.u, a.v, a.mw, a.mh, item.assetId, valid)) continue
      let fit = true
      for (let dv = 0; dv < a.mh; dv++) for (let du = 0; du < a.mw; du++) {
        const k = key(a.u + du, a.v + dv); if (!interior.has(k) || deskBlocked.has(k) || solid.has(k)) fit = false
      }
      if (!fit || !haloClear(a.u, a.v, a.mw, a.mh, item.pairWith)) continue
      if (a.seatOff) { const sk = key(a.u + a.seatOff[0], a.v + a.seatOff[1]); if (!interior.has(sk) || seatBlocked.has(sk) || solid.has(sk)) continue }
      if (segs.length > 0) {
        const cp = iso1(a.u + a.mw / 2, a.v + a.mh / 2), fy = iso1(a.u + a.mw, a.v + a.mh).y
        if (boxOcc(segs, cp.x - m.anchor[0], cp.y - m.anchor[1], m.nativeSize[0], m.nativeSize[1], a.u, a.v, a.u + a.mw, a.v + a.mh, fy) >= maxR) continue
      }
      const added: string[] = []; for (let dv = 0; dv < a.mh; dv++) for (let du = 0; du < a.mw; du++) { const k = key(a.u + du, a.v + dv); solid.add(k); added.push(k) }
      const seat = a.seatOff ? { u: a.u + a.seatOff[0], v: a.v + a.seatOff[1] } : undefined
      if (!isReachable(seat ? [...placedSeats, seat] : placedSeats)) { for (const k of added) solid.delete(k); continue }
      if (seat) { const sk = key(seat.u, seat.v); seatBlocked.add(sk); deskBlocked.add(sk); placedSeats.push(seat) }
      if (item.assetId === 'desk_cluster') {
        for (const ck of [key(a.u + 1, a.v - 2), key(a.u + 1, a.v + a.mh)]) { seatBlocked.add(ck); deskBlocked.add(ck) }
      }
      usedArea += a.mw * a.mh
      placed.set(item.role, { u: a.u, v: a.v, mw: a.mw, mh: a.mh, facing: a.facing })
      const ent = makeWorldEntity(item.kind === 'workstation' ? `ws-${wsId}-${++wsSeq}` : `${combo}-${wsId ?? 'pub'}-${idx}`, item.assetId, item.kind, a.u, a.v, a.facing, seat, a.wall)
      if (item.kind === 'shared') shared.push(ent); else suites.push(ent); return true
    }
    return false
  }

  buildProceduralRecipe(slot, combo, Boolean(wsId), rect, seed).forEach((item, idx) => { placeItem(item, idx, true) })
  if (wsId && suites.length === 0) {
    placeItem({ role: 'ws-fallback', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [Math.floor(rect.w / 2) - 1, Math.floor(rect.h / 2) - 1], facing: 'SW', seatOff: [1, -1] }, 99, true)
  }

  const focal = shared.find((e) => e.assetId === 'collab_table' || e.assetId === 'sofa_lounge' || e.assetId === 'armchair_green')
    ?? suites.find((e) => e.assetId === 'desk_cluster' || e.assetId === 'collab_table' || e.assetId === 'exec_desk') ?? suites[0]
  if (!focal) return { suites, shared }
  const fu = focal.anchor.u + focal.size[0] / 2, fv = focal.anchor.v + focal.size[1] / 2
  const group = suites.length > 0
    ? [...suites, ...shared.filter((e) => e.assetId === 'sofa_lounge' || e.assetId === 'armchair_green')]
    : shared.filter((e) => e.assetId === 'collab_table' || e.assetId === 'sofa_lounge' || e.assetId === 'armchair_green' || e.assetId === 'lamp_table')
  const core = group.length > 0 ? group : [focal]
  const pts = core.map((e) => ({ u: e.anchor.u + e.size[0] / 2, v: e.anchor.v + e.size[1] / 2 }))
  const span = Math.max(Math.max(...core.map((e) => e.anchor.u + e.size[0])) - Math.min(...core.map((e) => e.anchor.u)), Math.max(...core.map((e) => e.anchor.v + e.size[1])) - Math.min(...core.map((e) => e.anchor.v)))
  const tu = (Math.min(...core.map((e) => e.anchor.u)) + Math.max(...core.map((e) => e.anchor.u + e.size[0]))) / 2 * 0.65 + (rect.u + rect.w / 2) * 0.35
  const tv = (Math.min(...core.map((e) => e.anchor.v)) + Math.max(...core.map((e) => e.anchor.v + e.size[1]))) / 2 * 0.65 + (rect.v + rect.h / 2) * 0.35
  const sizes = rect.w >= 10 && rect.h >= 12 && span >= 5 ? [8, 6, 4] : [6, 4]

  let rugRect: { u: number; v: number; w: number; h: number } | undefined
  for (const inset of [1, 0]) {
    for (const sz of sizes) {
      const cand = intCells.filter((c) => {
        if (inset && (c.u <= rect.u || c.v <= rect.v || c.u + sz >= rect.u + rect.w || c.v + sz >= rect.v + rect.h)) return false
        if (fu < c.u || fu > c.u + sz || fv < c.v || fv > c.v + sz) return false
        for (let dv = 0; dv < sz; dv++) for (let du = 0; du < sz; du++) {
          const ru = c.u + du, rv = c.v + dv
          if (!interior.has(key(ru, rv)) || isChamferEdgeCell(ru, rv, valid)) return false
        }
        return true
      }).map((c) => {
        let sc = 0
        for (const p of pts) {
          if (p.u >= c.u + 0.4 && p.u <= c.u + sz - 0.4 && p.v >= c.v + 0.4 && p.v <= c.v + sz - 0.4) sc += 2
          if (p.u >= c.u && p.u <= c.u + sz && p.v >= c.v && p.v <= c.v + sz) sc++
        }
        return { c, sc, d: Math.hypot(c.u + sz / 2 - tu, c.v + sz / 2 - tv) }
      }).sort((a, b) => b.sc - a.sc || a.d - b.d)[0]
      if (cand) { rugRect = { u: cand.c.u, v: cand.c.v, w: sz, h: sz }; break }
    }
    if (rugRect) break
  }
  return { suites, shared, rugRect }
}
