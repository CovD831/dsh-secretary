/** 可水平东向扩建的单平面园区等距建筑求解器：1-3房保持 28x20 沙盘，4+房扩宽东西画廊走廊、差异化房型并一屏全览。 */
import { type FloorSlotEntry, getSlotEntry, hashWorkspaceSeed, normalizeWorkspaceSpecs, reconcileSlotRegistry } from './floor-slots.ts'
import { CANVAS_H, CANVAS_W, TILE_H, TILE_W, type GridPoint, type RoomEntity, type RoomWallMount } from './layout-solver.ts'
import { type RoomDoorSpec, type WingSlotPos, buildCorridorNetwork, buildShapeCells, cellKey, extractWallSegments3D, makeWorldEntity, mulberry32, populateWingFurniture } from './procedural-rooms.ts'
import { type BuildingSeedPlan, generateBuildingSeedPlan } from './roguelike-pcg.ts'
import { TALL_WALL_BLOCKERS } from './room-blueprints.ts'
import type { FacadeSegmentSpec, FurnitureComboKind, InteriorDoorSpec, LightSourceSpec, OfficeCamera, OfficeWorldPlan, PartitionWallSegment, PrefabShapeKind, WingFloorStyle, WingRugStyle, WorkspaceWingSpec, WorldWingPlan } from './world-types.ts'

export const WORLD_BUILDING_COLS = 28
export const WORLD_BUILDING_ROWS = 20
export const WORLD_BASE_ORIGIN = { x: 636, y: 168 } as const
export interface SolveFloorplanOpts { readonly floor?: number; readonly slotEntries?: readonly FloorSlotEntry[] }
const ANNEX_THEMES = ['#4A6A50', '#3F5A78', '#8A6242', '#3F645B', '#6B4A32'] as const
const ANNEX_COMBOS: readonly FurnitureComboKind[] = ['agile-scrum-bay', 'atelier-split', 'exec-library-lounge', 'paired-dev-pod', 'war-room-collab']
const ANNEX_FLOORS: readonly WingFloorStyle[] = ['honey_oak', 'dark_walnut', 'warm_parquet']
const ANNEX_RUGS: readonly WingRugStyle[] = ['woven', 'sage', 'persian', 'indigo']

function rectCells(u0: number, v0: number, w: number, h: number): GridPoint[] {
  const out: GridPoint[] = []; for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) out.push({ u: u0 + du, v: v0 + dv }); return out
}

function buildLobby(buildingRows: number, sk: BuildingSeedPlan['skeleton'], hasLeft: boolean, hasTopRight: boolean, annexCount: number): WorldWingPlan {
  const cells: GridPoint[] = []
  for (let v = sk.lobbyTopV; v < buildingRows; v++) {
    const uEnd = hasTopRight && v < sk.splitV ? 16 : 17
    for (let u = 10; u < uEnd; u++) cells.push({ u, v })
  }
  const rect = { u: 10, v: sk.lobbyTopV, w: 7, h: buildingRows - sk.lobbyTopV }
  const galleryPlants = Array.from({ length: annexCount }, (_, bi) => makeWorldEntity(`corr-plant-${bi}`, 'plant_pot', 'shared', 27 + bi * 12, 9, 'SW'))
  return {
    id: 'lobby', title: '中央迎宾前厅', kind: 'lobby', rect, cells,
    focusPoint: { u: 13, v: sk.receptionV + 1 }, doorway: { u: 13, v: buildingRows - 1 }, floorStyle: 'warm_parquet', themeHex: '#6B4A32',
    suites: [makeWorldEntity('lobby-reception', 'reception_desk', 'reception', 11, sk.receptionV, 'SE', { u: 10, v: sk.receptionV + 1 })],
    shared: [
      makeWorldEntity('lobby-cabinet', 'file_cabinet', 'shared', 10, sk.lobbyTopV, 'SW', undefined, 'back'),
      ...galleryPlants,
      ...(hasLeft ? [
        makeWorldEntity('lobby-bookshelf', 'bookshelf', 'shared', 10, sk.bookshelfV, 'SE', undefined, 'left'),
        makeWorldEntity('lobby-lamp', 'lamp_table', 'shared', 10, sk.lampV, 'SE'),
        makeWorldEntity('lobby-plant-1', 'plant_pot', 'shared', 10, sk.plantV, 'SW'),
      ] : []),
    ],
    wallMounts: [
      { id: 'lobby-clock', assetId: 'clock_wall', wall: 'back', at: 12.6, h: 24, span: 1 },
      { id: 'lobby-corkboard', assetId: 'corkboard', wall: 'back', at: 14.2, h: 10, span: 2, propKind: 'corkboard' },
    ],
  }
}

interface StudioBuildOpts {
  readonly ws?: WorkspaceWingSpec; readonly id: string; readonly title: string; readonly vacant?: boolean
  readonly rect: { u: number; v: number; w: number; h: number }; readonly doorway: GridPoint; readonly slot: WingSlotPos
  readonly floorStyle: WingFloorStyle; readonly rugStyle: WingRugStyle; readonly themeHex: string
  readonly shapeKind: PrefabShapeKind; readonly comboKind: FurnitureComboKind; readonly seedIdx: number; readonly chamferSE?: number
  readonly doorAxis?: 'u' | 'v'; readonly doorInDir?: 1 | -1; readonly allowLeftMount?: boolean
}

function buildWallMountsForWing(
  wingId: string, rect: { u: number; v: number; w: number; h: number }, cells: readonly GridPoint[],
  doorway: GridPoint, wsId: string | undefined, isLeft: boolean, seedIdx: number, entities: readonly RoomEntity[],
): RoomWallMount[] {
  const cellSet = new Set(cells.map((c) => cellKey(c.u, c.v))), tall = new Set<string>()
  for (const e of entities) if (TALL_WALL_BLOCKERS.has(e.assetId)) for (const fc of e.footprint) tall.add(cellKey(fc.u, fc.v))
  const isOuterBack = rect.v <= 2, mounts: RoomWallMount[] = [], usedBack = new Set<number>(), usedLeft = new Set<number>()
  const clearBack = (u: number) => isOuterBack && cellSet.has(cellKey(u, rect.v)) && !cellSet.has(cellKey(u, rect.v - 1)) && !tall.has(cellKey(u, rect.v))
  const clearLeft = (v: number) => isLeft && cellSet.has(cellKey(rect.u, v)) && !cellSet.has(cellKey(rect.u - 1, v)) && !tall.has(cellKey(rect.u, v))
  const findSpan = (lo: number, hi: number, check: (n: number) => boolean, used: Set<number>) => {
    for (let c = lo; c <= hi; c++) if (!used.has(c) && !used.has(c + 1) && check(c) && check(c + 1)) { used.add(c); used.add(c + 1); used.add(c + 2); return c + 1 }
    return null
  }
  const artAt = rect.w >= 11 ? findSpan(rect.u + 1, rect.u + rect.w - 3, clearBack, usedBack) : null
  if (artAt !== null) mounts.push({ id: `art-${wingId}`, assetId: seedIdx % 2 === 0 ? 'wall_painting' : 'idea_board', wall: 'back', at: artAt, h: 9, span: 2 })
  const winAt = findSpan(rect.u + 2, rect.u + rect.w - 3, clearBack, usedBack)
  if (winAt !== null) mounts.push({ id: `win-${wingId}`, assetId: 'window_wide', wall: 'back', at: winAt, h: 9, span: 2 })
  const wbAt = findSpan(rect.v + 1, rect.v + rect.h - 4, clearLeft, usedLeft)
  if (wbAt !== null) mounts.push({ id: `wb-${wingId}`, assetId: 'whiteboard_wall', wall: 'left', at: wbAt, h: 7, span: 2 })
  const winLAt = findSpan(rect.v + 3, rect.v + rect.h - 4, clearLeft, usedLeft)
  if (winLAt !== null) mounts.push({ id: `winL-${wingId}`, assetId: 'window_wide', wall: 'left', at: winLAt, h: 9, span: 2 })
  if (wsId) mounts.push({ id: `doorplate-${wsId}`, assetId: 'doorplate', wall: isLeft ? 'left' : 'back', at: isLeft ? doorway.v - 0.8 : doorway.u + 0.5, h: 16, span: 1, propKind: 'doorplate' })
  return mounts
}

function makeDraftStudio(o: StudioBuildOpts): { plan: WorldWingPlan; opt: StudioBuildOpts; cells: GridPoint[] } {
  const cells = buildShapeCells(o.rect, o.shapeKind, o.slot, o.doorway)
  return {
    opt: o, cells,
    plan: {
      id: o.id, workspaceId: o.ws?.id, title: o.title, repository: o.ws?.repository, kind: 'studio', vacant: o.vacant,
      rect: o.rect, cells, shapeKind: o.shapeKind, comboKind: o.comboKind,
      focusPoint: { u: o.rect.u + o.rect.w / 2, v: o.rect.v + o.rect.h / 2 },
      doorway: o.doorway, floorStyle: o.floorStyle, rugStyle: o.rugStyle, themeHex: o.themeHex,
      chamferSE: o.chamferSE, suites: [], shared: [], wallMounts: [],
    },
  }
}

function buildGardenSlot(id: string, rect: { u: number; v: number; w: number; h: number }): WorldWingPlan {
  const u0 = rect.u + 2, v0 = rect.v + 2, u1 = Math.max(u0 + 2, rect.u + rect.w - 4), v1 = Math.max(v0 + 2, rect.v + rect.h - 4)
  return {
    id, title: '待扩建花园地块', kind: 'courtyard', rect, cells: rectCells(rect.u, rect.v, rect.w, rect.h),
    focusPoint: { u: rect.u + rect.w / 2, v: rect.v + rect.h / 2 }, doorway: { u: rect.u, v: rect.v },
    floorStyle: 'courtyard', themeHex: '#2F4232', suites: [], wallMounts: [],
    shared: [makeWorldEntity(`${id}-tree`, 'courtyard_tree', 'shared', u0, v0, 'SE'), makeWorldEntity(`${id}-shrub`, 'tree_shrub', 'shared', u1, v1, 'SW'), makeWorldEntity(`${id}-pot`, 'plant_pot', 'shared', u1, v0 + 1, 'SW')],
  }
}

function buildCourtyardSlot(leftEndV: number, buildingRows: number): WorldWingPlan {
  const rect = { u: 2, v: leftEndV, w: 8, h: buildingRows - leftEndV }
  return {
    id: 'courtyard-3', title: '街角绿化庭院', kind: 'courtyard', rect, cells: rectCells(rect.u, rect.v, rect.w, rect.h),
    focusPoint: { u: 6, v: leftEndV + 1.5 }, doorway: { u: 9, v: leftEndV + 1 }, floorStyle: 'courtyard', themeHex: '#2F4232', suites: [], wallMounts: [],
    shared: [makeWorldEntity('cy-tree-a', 'tree_shrub', 'shared', 2, leftEndV + 1, 'SE'), makeWorldEntity('cy-tree-b', 'tree_shrub', 'shared', 5, leftEndV + 1, 'SW'), makeWorldEntity('cy-plant', 'plant_pot', 'shared', 8, buildingRows - 1, 'SW')],
  }
}

export function cameraForGridPoint(pt: GridPoint, world: OfficeWorldPlan, zoom: number, canvasW = CANVAS_W, canvasH = CANVAS_H): OfficeCamera {
  const sx = (pt.u - pt.v) * ((TILE_W * zoom) / 2), sy = (pt.u + pt.v) * ((TILE_H * zoom) / 2)
  return { panX: Math.round(canvasW / 2 - (world.baseOrigin.x + sx)), panY: Math.round(canvasH / 2 - (world.baseOrigin.y + sy)), zoom }
}

export function cameraForWorldFit(world: OfficeWorldPlan, canvasW = CANVAS_W, canvasH = CANVAS_H): OfficeCamera {
  const c0 = world.buildingCols, r0 = world.buildingRows
  const xMin = -(r0 + 2) * (TILE_W / 2) - 24, xMax = c0 * (TILE_W / 2) + 24
  const yMin = -68, yMax = (c0 + r0 + 2) * (TILE_H / 2) + 28
  const availW = Math.max(320, canvasW - 128), availH = Math.max(240, canvasH - 132)
  const raw = Math.min(availW / (xMax - xMin), availH / (yMax - yMin))
  const zoom = raw >= 0.98 ? 1 : Math.max(0.5, Math.round(raw * 20) / 20)
  const cx = (xMin + xMax) / 2 * zoom + world.baseOrigin.x, cy = (yMin + yMax) / 2 * zoom + world.baseOrigin.y
  return { panX: Math.round(92 + availW / 2 - cx), panY: Math.round(52 + availH / 2 - cy), zoom }
}

export function solveWorldFloorplan(workspaces: readonly WorkspaceWingSpec[], seed = 1, opts?: SolveFloorplanOpts): OfficeWorldPlan {
  const list = normalizeWorkspaceSpecs(workspaces), wsById = new Map(list.map((w) => [w.id, w]))
  const entries = opts?.slotEntries ?? reconcileSlotRegistry([], list, seed)
  const maxSlot = entries.reduce((m, e) => Math.max(m, e.slot), -1), annexCount = maxSlot >= 3 ? Math.ceil((maxSlot - 2) / 2) : 0
  const buildingCols = WORLD_BUILDING_COLS + annexCount * 12, buildingRows = WORLD_BUILDING_ROWS + (annexCount > 0 ? 4 : 0)
  const rng = mulberry32(seed), cur = generateBuildingSeedPlan(seed)
  const sk = annexCount > 0 ? { ...cur.skeleton, rightTopV: 0, splitV: 9, leftEndV: cur.skeleton.leftEndV + 3, receptionV: cur.skeleton.receptionV + 4, bookshelfV: cur.skeleton.bookshelfV + 4, lampV: cur.skeleton.lampV + 4, plantV: cur.skeleton.plantV + 4 } : cur.skeleton
  const leftDoorV = cur.doors[0], lowerRowV = annexCount > 0 ? 15 : sk.splitV
  const upperDoorV = annexCount > 0 ? (Math.min(cur.doors[1], 5) === leftDoorV ? (leftDoorV === 5 ? 4 : 5) : Math.min(cur.doors[1], 5)) : cur.doors[1]
  const lowerDoorV = annexCount > 0 ? Math.max(17, Math.min(cur.doors[2] + 4, 20)) : cur.doors[2]
  const [c0, c1, c2] = cur.combos, remCombos = ANNEX_COMBOS.filter((c) => c !== c0 && c !== c1 && c !== c2)
  const [s0, s1, s2] = [getSlotEntry(entries, 0), getSlotEntry(entries, 1), getSlotEntry(entries, 2)]
  const rects = [
    { u: 0, v: sk.leftV, w: 10, h: sk.leftEndV - sk.leftV },
    { u: 16, v: sk.rightTopV, w: 12, h: sk.splitV - sk.rightTopV },
    { u: 17, v: lowerRowV, w: 11, h: buildingRows - lowerRowV },
  ] as const
  const slotDefs: readonly { slot: WingSlotPos; door: GridPoint; combo: FurnitureComboKind; shape: PrefabShapeKind; floorStyle: WingFloorStyle; rugStyle: WingRugStyle; themeHex: string; chamferSE?: number }[] = [
    { slot: 'left', door: { u: 9, v: leftDoorV }, combo: c0, shape: cur.shapes[0], floorStyle: cur.floors[0], rugStyle: cur.rugs[0], themeHex: '#4A6A50' },
    { slot: 'topRight', door: { u: 16, v: upperDoorV }, combo: c1, shape: cur.shapes[1], floorStyle: cur.floors[1], rugStyle: cur.rugs[1], themeHex: '#3F5A78' },
    { slot: 'bottomRight', door: { u: 17, v: lowerDoorV }, combo: c2, shape: annexCount > 0 ? 'l-alcove' : cur.shapes[2], floorStyle: annexCount > 0 ? 'dark_walnut' : cur.floors[2], rugStyle: cur.rugs[2], themeHex: '#8A6242', chamferSE: annexCount > 0 ? undefined : cur.chamferSE },
  ]

  const studioDrafts: { plan: WorldWingPlan; opt: StudioBuildOpts; cells: GridPoint[]; roomSeed: number; slotIdx: number }[] = []
  const gardenWings: WorldWingPlan[] = [], slotResults: WorldWingPlan[] = []
  for (const idx of [0, 1, 2] as const) {
    const entry = [s0, s1, s2][idx], def = slotDefs[idx]!, rect = rects[idx]!
    if (!entry) { const g = buildGardenSlot(`garden-s${idx}`, rect); gardenWings.push(g); slotResults.push(g); continue }
    const isVac = entry.status === 'vacant' || !entry.workspaceId, ws = !isVac && entry.workspaceId ? wsById.get(entry.workspaceId) : undefined
    const d = makeDraftStudio({ ws, id: isVac ? `vacant-s${idx}` : `wing-${entry.workspaceId}`, title: isVac ? '待入驻空房' : (ws?.title ?? entry.workspaceId!), vacant: isVac, rect, doorway: def.door, slot: def.slot, floorStyle: def.floorStyle, rugStyle: def.rugStyle, themeHex: isVac ? '#4A403A' : def.themeHex, shapeKind: def.shape, comboKind: def.combo, seedIdx: entry.roomSeed, chamferSE: def.chamferSE, allowLeftMount: idx === 0 })
    studioDrafts.push({ ...d, roomSeed: entry.roomSeed, slotIdx: idx }); slotResults.push(d.plan)
  }
  const annexDoors: InteriorDoorSpec[] = []
  for (let b = 1; b <= annexCount; b++) {
    const baseU = 28 + (b - 1) * 12
    for (const isUp of [true, false]) {
      const slotIdx = 3 + (b - 1) * 2 + (isUp ? 0 : 1), entry = getSlotEntry(entries, slotIdx)
      const isVac = !entry || entry.status === 'vacant' || !entry.workspaceId, ws = !isVac && entry.workspaceId ? wsById.get(entry.workspaceId) : undefined
      const id = isVac ? `vacant-s${slotIdx}` : `wing-${entry.workspaceId}`, rect = { u: baseU, v: isUp ? 0 : 15, w: 12, h: 9 }, doorU = baseU + (isUp ? 4 : 6)
      const doorway = { u: doorU, v: isUp ? 8 : 15 }, chSE = !isUp && b === annexCount ? cur.chamferSE : undefined
      const axSeed = Math.max(2, hashWorkspaceSeed(seed + 17 + slotIdx * 31, entry?.workspaceId ?? `s${slotIdx}`)), idx3 = slotIdx - 3
      const axCombo = remCombos.length >= 2 && idx3 < remCombos.length ? remCombos[(idx3 + seed) % remCombos.length]! : ANNEX_COMBOS[(idx3 + seed) % ANNEX_COMBOS.length]!
      const d = makeDraftStudio({ ws, id, title: isVac ? '待入驻空房' : (ws?.title ?? entry.workspaceId!), vacant: isVac, rect, doorway, slot: isUp ? 'topRight' : 'bottomRight', floorStyle: isUp ? ANNEX_FLOORS[(slotIdx + seed + 2) % 3]! : 'dark_walnut', rugStyle: ANNEX_RUGS[(slotIdx + seed) % ANNEX_RUGS.length]!, themeHex: isVac ? '#4A403A' : ANNEX_THEMES[slotIdx % ANNEX_THEMES.length]!, shapeKind: chSE === 3 ? 'bay-window' : chSE === 2 ? 'chamfer-octagon' : 'l-alcove', comboKind: axCombo, seedIdx: axSeed, chamferSE: chSE, doorAxis: 'v', doorInDir: isUp ? -1 : 1, allowLeftMount: false })
      studioDrafts.push({ ...d, roomSeed: axSeed, slotIdx }); slotResults.push(d.plan)
      annexDoors.push({ id: `door-${id}`, u: doorU, v: isUp ? 9 : 15, axis: 'v', wingId: id })
    }
  }

  const hasLeft = Boolean(s0), hasTopRight = Boolean(s1), hasBottomRight = Boolean(s2), swYard = buildCourtyardSlot(sk.leftEndV, buildingRows)
  const lobby = buildLobby(buildingRows, sk, hasLeft, hasTopRight, annexCount), mainEntrance: GridPoint = { u: 13, v: buildingRows - 1 }
  const corr = buildCorridorNetwork(buildingRows, [...slotResults, swYard], rng, sk.lobbyTopV, sk.splitV, hasTopRight)
  if (annexCount > 0) {
    for (let u = 17; u < buildingCols; u++) for (let v = 9; v <= 14; v++) corr.corridorCells.push({ u, v })
    corr.corridorBranches.push({ from: { u: 16, v: 9.4 }, to: { u: buildingCols - 1, v: 9.4 }, width: 2, hasRunner: true })
  }
  const hasWingCell = (w: WorldWingPlan, u: number, v: number) => Boolean(w.cells?.some((c) => c.u === u && c.v === v))
  const rightLinkU = annexCount === 0 && hasTopRight && hasBottomRight
    ? cur.rightLinkPrefs.find((u) => hasWingCell(slotResults[1]!, u, sk.splitV - 1) && hasWingCell(slotResults[1]!, u + 1, sk.splitV - 1) && hasWingCell(slotResults[2]!, u, sk.splitV) && hasWingCell(slotResults[2]!, u + 1, sk.splitV))
    : undefined
  const interiorDoors: InteriorDoorSpec[] = [
    ...studioDrafts.slice(0, 3 - gardenWings.length).map(({ plan }) => ({ id: `door-${plan.id}`, u: plan.rect.u === 0 ? 10 : plan.doorway.u, v: plan.doorway.v, axis: 'u' as const, wingId: plan.id })),
    ...(rightLinkU !== undefined ? [{ id: 'door-right-link', u: rightLinkU, v: sk.splitV, axis: 'v' as const, wingId: slotResults[2]!.id }] : []),
    ...annexDoors,
  ]
  const wallSegments = extractWallSegments3D(lobby, [...studioDrafts.map((d) => d.plan), swYard], corr.corridorCells, interiorDoors, mainEntrance, buildingRows)

  const populatedStudios = studioDrafts.map(({ plan, opt, cells, roomSeed, slotIdx }) => {
    if (opt.vacant || !opt.ws) return plan
    const doors: RoomDoorSpec[] = opt.doorAxis === 'v' ? [{ u: opt.doorway.u, v: opt.doorway.v, axis: 'v', inDir: opt.doorInDir ?? 1 }] : [{ u: opt.doorway.u, v: opt.doorway.v, axis: 'u', inDir: opt.slot === 'left' ? -1 : 1 }]
    if (rightLinkU !== undefined && slotIdx === 1) doors.push({ u: rightLinkU, v: sk.splitV - 1, axis: 'v', inDir: -1 })
    if (rightLinkU !== undefined && slotIdx === 2) doors.push({ u: rightLinkU, v: sk.splitV, axis: 'v', inDir: 1 })
    const { suites, shared, rugRect } = populateWingFurniture(opt.rect, cells, opt.doorway, opt.comboKind, opt.ws.id, opt.slot, { wallSegments, doors, seed: roomSeed })
    const wallMounts = buildWallMountsForWing(opt.id, opt.rect, cells, opt.doorway, opt.ws.id, Boolean(opt.allowLeftMount), opt.seedIdx, [...suites, ...shared])
    return { ...plan, suites, shared, rugRect, wallMounts }
  })
  const safeSconceV = (doorV: number, lo: number, hi: number) => [doorV - 2.1, doorV + 2.8].find((v) => v >= lo && v <= hi && (v <= doorV - 1.4 || v >= doorV + 2.4)) ?? Math.min(hi, doorV + 2.5)
  const lightSources: LightSourceSpec[] = [
    ...(hasLeft ? [{ id: 'sc-1', kind: 'sconce' as const, u: 10, v: safeSconceV(leftDoorV, sk.lobbyTopV + 1.8, Math.min(sk.plantV - 1.1, sk.leftEndV - 2)), radiusTiles: 2.2, intensity: 0.24 }] : []),
    ...(hasTopRight ? [{ id: 'sc-2', kind: 'sconce' as const, u: 16, v: safeSconceV(upperDoorV, Math.max(sk.lobbyTopV, sk.rightTopV) + 1.6, sk.splitV - 1.5), radiusTiles: 2.2, intensity: 0.24 }] : []),
    { id: 'sc-3', kind: 'sconce', u: 12.2, v: buildingRows, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-4', kind: 'sconce', u: 14.8, v: buildingRows, radiusTiles: 2.2, intensity: 0.24 },
    ...(s0?.status === 'active' ? [{ id: 'lp-1', kind: 'lamp' as const, u: 4.5, v: sk.leftV + 2.5, radiusTiles: 2.0, intensity: 0.22 }] : []),
    ...(s1?.status === 'active' ? [{ id: 'wn-1', kind: 'window' as const, u: 21.5, v: sk.rightTopV + 1.5, radiusTiles: 3.2, intensity: 0.26 }] : []),
    ...(s2?.status === 'active' ? [{ id: 'lp-2', kind: 'lamp' as const, u: 22.5, v: lowerRowV + 2.5, radiusTiles: 2.0, intensity: 0.22 }, { id: 'wn-2', kind: 'window' as const, u: 21.5, v: buildingRows - 2.5, radiusTiles: 3.2, intensity: 0.26 }] : []),
    ...Array.from({ length: annexCount }, (_, bi) => ({ id: `wn-ax-${bi}`, kind: 'window' as const, u: 28 + bi * 12 + 6, v: 2.5, radiusTiles: 3.0, intensity: 0.24 })),
  ]
  const exteriorProps = [
    ...(hasLeft ? [makeWorldEntity('ext-tree-1', 'courtyard_tree', 'shared', -1, buildingRows - 5, 'SE')] : []),
    makeWorldEntity('ext-shrub-1', 'tree_shrub', 'shared', 0, buildingRows + 1, 'SE'), makeWorldEntity('ext-shrub-2', 'tree_shrub', 'shared', 6, buildingRows + 1, 'SE'),
    makeWorldEntity('ext-tree-2', 'courtyard_tree', 'shared', 9, buildingRows + 1, 'SW'), makeWorldEntity('ext-pot-l', 'plant_pot', 'shared', 10, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-pot-r', 'plant_pot', 'shared', 16, buildingRows + 1, 'SW'), makeWorldEntity('ext-shrub-3', 'tree_shrub', 'shared', 18, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-shrub-4', 'tree_shrub', 'shared', 23, buildingRows + 1, 'SW'),
    ...Array.from({ length: annexCount }, (_, bi) => makeWorldEntity(`ext-shrub-ax-${bi}`, 'tree_shrub', 'shared', 31 + bi * 12, buildingRows + 1, 'SW')),
    ...(hasBottomRight || annexCount > 0 ? [makeWorldEntity('ext-shrub-east', 'tree_shrub', 'shared', buildingCols, lowerRowV + 1, 'SW')] : []),
  ]
  return {
    seed, floorIndex: 0, buildingCols, buildingRows, baseOrigin: { ...WORLD_BASE_ORIGIN },
    mainEntrance, streetSpawnPoints: [{ u: 4, v: buildingRows + 1 }, { u: 13, v: buildingRows + 5 }, { u: buildingCols - 5, v: buildingRows + 1 }],
    corridorRect: { u: 10, v: sk.lobbyTopV, w: 7, h: buildingRows - sk.lobbyTopV },
    corridorCells: corr.corridorCells, corridorBranches: corr.corridorBranches, wallSegments, networkMetrics: corr.networkMetrics,
    lobby, wings: [...populatedStudios, ...gardenWings, swYard], partitionWalls: wallSegments.filter((s) => s.tier === 'partition' && (s.from.u === s.to.u || s.from.v === s.to.v)).map((s) => s.from.u === s.to.u ? { axis: 'u', fixed: s.from.u, start: Math.min(s.from.v, s.to.v), end: Math.max(s.from.v, s.to.v) } : { axis: 'v', fixed: s.from.v, start: Math.min(s.from.u, s.to.u), end: Math.max(s.from.u, s.to.u) }),
    exteriorProps, interiorDoors, frontFacade: wallSegments.filter((s) => s.tier === 'cutaway' || s.tier === 'portal').map((s) => ({ from: s.from, to: s.to, heightPx: s.startH, hasWindow: s.hasWindow, isEntrance: s.tier === 'portal' })), lightSources,
  }
}
