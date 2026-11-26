/** 28x20 双档剖面沙盘平面求解器（先定房型与门墙，再按 8 条室内规范排布家居）。 */
import { CANVAS_H, CANVAS_W, TILE_H, TILE_W, type GridPoint, type RoomEntity, type RoomWallMount } from './layout-solver.ts'
import {
  FURNITURE_COMBO_KINDS,
  PREFAB_SHAPE_KINDS,
  type RoomDoorSpec,
  type WingSlotPos,
  buildCorridorNetwork,
  buildShapeCells,
  cellKey,
  extractWallSegments3D,
  makeWorldEntity,
  mulberry32,
  populateWingFurniture,
} from './procedural-rooms.ts'
import { type BuildingSeedPlan, generateBuildingSeedPlan } from './roguelike-pcg.ts'
import { TALL_WALL_BLOCKERS } from './room-blueprints.ts'
import type {
  FacadeSegmentSpec,
  FurnitureComboKind,
  InteriorDoorSpec,
  LightSourceSpec,
  OfficeCamera,
  OfficeWorldPlan,
  PartitionWallSegment,
  PrefabShapeKind,
  WingFloorStyle,
  WingRugStyle,
  WorkspaceWingSpec,
  WorldWingPlan,
} from './world-types.ts'

export const WORLD_BUILDING_COLS = 28
export const WORLD_BUILDING_ROWS = 20
export const WORLD_BASE_ORIGIN = { x: 636, y: 168 } as const

function normalizeWorkspaces(workspaces: readonly WorkspaceWingSpec[]): WorkspaceWingSpec[] {
  const seen = new Set<string>(), deduped: WorkspaceWingSpec[] = []
  for (const ws of workspaces) if (!seen.has(ws.id)) { seen.add(ws.id); deduped.push(ws) }
  const defIdx = deduped.findIndex((w) => w.id === 'default')
  return defIdx === -1 ? [{ id: 'default', title: 'default' }, ...deduped] : [deduped[defIdx]!, ...deduped.filter((_, i) => i !== defIdx)]
}

function rectCells(u0: number, v0: number, w: number, h: number): GridPoint[] {
  const out: GridPoint[] = []
  for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) out.push({ u: u0 + du, v: v0 + dv })
  return out
}

function buildLobby(buildingRows: number, sk: BuildingSeedPlan['skeleton']): WorldWingPlan {
  const cells: GridPoint[] = []
  for (let v = sk.lobbyTopV; v < buildingRows; v++) {
    const uEnd = v < sk.splitV ? 16 : 17
    for (let u = 10; u < uEnd; u++) cells.push({ u, v })
  }
  const rect = { u: 10, v: sk.lobbyTopV, w: 7, h: buildingRows - sk.lobbyTopV }
  return {
    id: 'lobby', title: '中央迎宾前厅', kind: 'lobby', rect, cells,
    focusPoint: { u: 13, v: sk.receptionV + 1 }, doorway: { u: 13, v: buildingRows - 1 },
    floorStyle: 'warm_parquet', themeHex: '#6B4A32',
    suites: [makeWorldEntity('lobby-reception', 'reception_desk', 'reception', 11, sk.receptionV, 'SE', { u: 10, v: sk.receptionV + 1 })],
    shared: [
      makeWorldEntity('lobby-cabinet', 'file_cabinet', 'shared', 10, sk.lobbyTopV, 'SW', undefined, 'back'),
      makeWorldEntity('lobby-bookshelf', 'bookshelf', 'shared', 10, sk.bookshelfV, 'SE', undefined, 'left'),
      makeWorldEntity('lobby-lamp', 'lamp_table', 'shared', 10, sk.lampV, 'SE'),
      makeWorldEntity('lobby-plant-1', 'plant_pot', 'shared', 10, sk.plantV, 'SW'),
    ],
    wallMounts: [
      { id: 'lobby-clock', assetId: 'clock_wall', wall: 'back', at: 12.6, h: 24, span: 1 },
      { id: 'lobby-corkboard', assetId: 'corkboard', wall: 'back', at: 14.2, h: 10, span: 2, propKind: 'corkboard' },
    ],
  }
}

interface StudioBuildOpts {
  readonly ws?: WorkspaceWingSpec
  readonly id: string
  readonly title: string
  readonly rect: { u: number; v: number; w: number; h: number }
  readonly doorway: GridPoint
  readonly slot: WingSlotPos
  readonly floorStyle: WingFloorStyle
  readonly rugStyle: WingRugStyle
  readonly themeHex: string
  readonly shapeKind: PrefabShapeKind
  readonly comboKind: FurnitureComboKind
  readonly seedIdx: number
  readonly chamferSE?: number
}

function buildWallMountsForWing(
  wingId: string, rect: { u: number; v: number; w: number; h: number }, cells: readonly GridPoint[],
  doorway: GridPoint, wsId: string | undefined, isLeft: boolean, seedIdx: number, entities: readonly RoomEntity[],
): RoomWallMount[] {
  const cellSet = new Set(cells.map((c) => cellKey(c.u, c.v))), tall = new Set<string>()
  for (const e of entities) if (TALL_WALL_BLOCKERS.has(e.assetId)) {
    for (const fc of e.footprint) tall.add(cellKey(fc.u, fc.v))
  }
  const isOuterBack = rect.v <= 2, mounts: RoomWallMount[] = [], usedBack = new Set<number>(), usedLeft = new Set<number>()
  const clearBack = (u: number) => isOuterBack && cellSet.has(cellKey(u, rect.v)) && !cellSet.has(cellKey(u, rect.v - 1)) && !tall.has(cellKey(u, rect.v))
  const clearLeft = (v: number) => isLeft && cellSet.has(cellKey(rect.u, v)) && !cellSet.has(cellKey(rect.u - 1, v)) && !tall.has(cellKey(rect.u, v))
  const findSpan = (lo: number, hi: number, check: (n: number) => boolean, used: Set<number>) => {
    for (let c = lo; c <= hi; c++) if (!used.has(c) && !used.has(c + 1) && check(c) && check(c + 1)) {
      used.add(c); used.add(c + 1); used.add(c + 2); return c + 1
    }
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
      id: o.id, workspaceId: o.ws?.id, title: o.title, repository: o.ws?.repository, kind: 'studio',
      rect: o.rect, cells, shapeKind: o.shapeKind, comboKind: o.comboKind,
      focusPoint: { u: o.rect.u + o.rect.w / 2, v: o.rect.v + o.rect.h / 2 },
      doorway: o.doorway, floorStyle: o.floorStyle, rugStyle: o.rugStyle, themeHex: o.themeHex,
      chamferSE: o.chamferSE, suites: [], shared: [], wallMounts: [],
    },
  }
}

function buildCourtyardSlot(leftEndV: number): WorldWingPlan {
  const rect = { u: 2, v: leftEndV, w: 8, h: WORLD_BUILDING_ROWS - leftEndV }
  return {
    id: 'courtyard-3', title: '待扩建庭院地块', kind: 'courtyard', rect,
    cells: rectCells(rect.u, rect.v, rect.w, rect.h),
    focusPoint: { u: 6, v: leftEndV + 1.5 }, doorway: { u: 9, v: leftEndV + 1 },
    floorStyle: 'courtyard', themeHex: '#4A6A50', suites: [], wallMounts: [],
    shared: [
      makeWorldEntity('cy-tree-a', 'tree_shrub', 'shared', 2, leftEndV + 1, 'SE'),
      makeWorldEntity('cy-tree-b', 'tree_shrub', 'shared', 5, leftEndV + 1, 'SW'),
      makeWorldEntity('cy-plant', 'plant_pot', 'shared', 8, 19, 'SW'),
    ],
  }
}

export function cameraForGridPoint(pt: GridPoint, world: OfficeWorldPlan, zoom: 1 | 2, canvasW = CANVAS_W, canvasH = CANVAS_H): OfficeCamera {
  const sx = (pt.u - pt.v) * ((TILE_W * zoom) / 2), sy = (pt.u + pt.v) * ((TILE_H * zoom) / 2)
  return { panX: Math.round(canvasW / 2 - (world.baseOrigin.x + sx)), panY: Math.round(canvasH / 2 - (world.baseOrigin.y + sy)), zoom }
}

export function solveWorldFloorplan(workspaces: readonly WorkspaceWingSpec[], seed = 1): OfficeWorldPlan {
  const rng = mulberry32(seed), list = normalizeWorkspaces(workspaces)
  const extraPairs = Math.max(0, Math.ceil((list.length - 3) / 2)), buildingRows = WORLD_BUILDING_ROWS + extraPairs * 10
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!
  const rugs: readonly WingRugStyle[] = ['sage', 'indigo', 'persian', 'woven']
  const cur = generateBuildingSeedPlan(seed), sk = cur.skeleton
  const [leftDoorV, upperDoorV, lowerDoorV] = cur.doors, [c0, c1, c2] = cur.combos

  const drafts = [
    makeDraftStudio({
      ws: list[0]!, id: `wing-${list[0]!.id}`, title: list[0]!.title,
      rect: { u: 0, v: sk.leftV, w: 10, h: sk.leftEndV - sk.leftV }, doorway: { u: 9, v: leftDoorV }, slot: 'left',
      floorStyle: cur.floors[0], rugStyle: cur.rugs[0], themeHex: '#4A6A50',
      shapeKind: cur.shapes[0], comboKind: c0, seedIdx: seed,
    }),
    makeDraftStudio({
      ws: list[1], id: list[1] ? `wing-${list[1].id}` : 'wing-reserve', title: list[1]?.title ?? '研讨会议室',
      rect: { u: 16, v: sk.rightTopV, w: 12, h: sk.splitV - sk.rightTopV }, doorway: { u: 16, v: upperDoorV }, slot: 'topRight',
      floorStyle: cur.floors[1], rugStyle: cur.rugs[1], themeHex: '#3F5A78',
      shapeKind: cur.shapes[1], comboKind: c1, seedIdx: seed + 1,
    }),
    makeDraftStudio({
      ws: list[2], id: list[2] ? `wing-${list[2].id}` : 'wing-lounge', title: list[2]?.title ?? '茶歇阅览室',
      rect: { u: 17, v: sk.splitV, w: 11, h: 20 - sk.splitV }, doorway: { u: 17, v: lowerDoorV }, slot: 'bottomRight',
      floorStyle: cur.floors[2], rugStyle: cur.rugs[2], themeHex: '#8A6242',
      shapeKind: cur.shapes[2], comboKind: c2, seedIdx: seed + 2, chamferSE: cur.chamferSE,
    }),
  ]
  for (let i = 3; i < list.length; i++) {
    const idx = i - 3, isLeft = idx % 2 === 0, rowV = 20 + Math.floor(idx / 2) * 10
    drafts.push(makeDraftStudio({
      ws: list[i]!, id: `wing-${list[i]!.id}`, title: list[i]!.title,
      rect: { u: isLeft ? 0 : 17, v: rowV, w: isLeft ? 10 : 11, h: 10 }, doorway: { u: isLeft ? 9 : 17, v: rowV + 3 }, slot: isLeft ? 'left' : 'bottomRight',
      floorStyle: isLeft ? 'honey_oak' : 'warm_parquet', rugStyle: pick(rugs), themeHex: isLeft ? '#4A6A50' : '#3F5A78',
      shapeKind: pick(PREFAB_SHAPE_KINDS), comboKind: pick(FURNITURE_COMBO_KINDS), seedIdx: seed + i + 1,
    }))
  }

  const draftWings = [...drafts.slice(0, 3).map((d) => d.plan), buildCourtyardSlot(sk.leftEndV), ...drafts.slice(3).map((d) => d.plan)]
  const lobby = buildLobby(buildingRows, sk), mainEntrance: GridPoint = { u: 13, v: buildingRows - 1 }
  const { corridorCells, corridorBranches, networkMetrics } = buildCorridorNetwork(buildingRows, draftWings, rng, sk.lobbyTopV, sk.splitV)
  const hasWingCell = (w: WorldWingPlan, u: number, v: number) => Boolean(w.cells?.some((c) => c.u === u && c.v === v))
  const rightLinkU = cur.rightLinkPrefs.find(
    (u) => hasWingCell(draftWings[1]!, u, sk.splitV - 1) && hasWingCell(draftWings[1]!, u + 1, sk.splitV - 1) && hasWingCell(draftWings[2]!, u, sk.splitV) && hasWingCell(draftWings[2]!, u + 1, sk.splitV),
  )
  const interiorDoors: InteriorDoorSpec[] = [
    ...draftWings.filter((w) => w.kind === 'studio').map((w) => ({
      id: `door-${w.id}`, u: w.rect.u === 0 ? 10 : w.doorway.u, v: w.doorway.v, axis: 'u' as const, wingId: w.id,
    })),
    ...(rightLinkU !== undefined ? [{ id: 'door-right-link', u: rightLinkU, v: sk.splitV, axis: 'v' as const, wingId: draftWings[2]!.id }] : []),
  ]
  const wallSegments = extractWallSegments3D(lobby, draftWings, corridorCells, interiorDoors, mainEntrance, buildingRows)

  const populatedStudios = drafts.map(({ plan, opt, cells }, dIdx) => {
    const inDir: 1 | -1 = opt.slot === 'left' ? -1 : 1
    const doors: RoomDoorSpec[] = [{ u: opt.doorway.u, v: opt.doorway.v, axis: 'u', inDir }]
    if (rightLinkU !== undefined && dIdx === 1) doors.push({ u: rightLinkU, v: sk.splitV - 1, axis: 'v', inDir: -1 })
    if (rightLinkU !== undefined && dIdx === 2) doors.push({ u: rightLinkU, v: sk.splitV, axis: 'v', inDir: 1 })
    const { suites, shared, rugRect } = populateWingFurniture(
      opt.rect, cells, opt.doorway, opt.comboKind, opt.ws?.id, opt.slot, { wallSegments, doors, seed },
    )
    const wallMounts = buildWallMountsForWing(opt.id, opt.rect, cells, opt.doorway, opt.ws?.id, opt.slot === 'left', opt.seedIdx, [...suites, ...shared])
    return { ...plan, suites, shared, rugRect, wallMounts }
  })
  const wings: WorldWingPlan[] = [...populatedStudios.slice(0, 3), draftWings[3]!, ...populatedStudios.slice(3)]

  const partitionWalls: PartitionWallSegment[] = wallSegments
    .filter((s) => s.tier === 'partition' && (s.from.u === s.to.u || s.from.v === s.to.v))
    .map((s) => s.from.u === s.to.u
      ? { axis: 'u', fixed: s.from.u, start: Math.min(s.from.v, s.to.v), end: Math.max(s.from.v, s.to.v) }
      : { axis: 'v', fixed: s.from.v, start: Math.min(s.from.u, s.to.u), end: Math.max(s.from.u, s.to.u) })
  const frontFacade: FacadeSegmentSpec[] = wallSegments
    .filter((s) => s.tier === 'cutaway' || s.tier === 'portal')
    .map((s) => ({ from: s.from, to: s.to, heightPx: s.startH, hasWindow: s.hasWindow, isEntrance: s.tier === 'portal' }))
  const safeSconceV = (doorV: number, lo: number, hi: number) =>
    [doorV - 2.1, doorV + 2.8].find((v) => v >= lo && v <= hi && (v <= doorV - 1.4 || v >= doorV + 2.4)) ?? Math.min(hi, doorV + 2.5)
  const sc1V = safeSconceV(leftDoorV, sk.lobbyTopV + 1.8, Math.min(sk.plantV - 1.1, sk.leftEndV - 2))
  const sc2V = safeSconceV(upperDoorV, Math.max(sk.lobbyTopV, sk.rightTopV) + 1.6, sk.splitV - 1.5)
  const lightSources: LightSourceSpec[] = [
    { id: 'sc-1', kind: 'sconce', u: 10, v: sc1V, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-2', kind: 'sconce', u: 16, v: sc2V, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-3', kind: 'sconce', u: 12.2, v: buildingRows, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-4', kind: 'sconce', u: 14.8, v: buildingRows, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'lp-1', kind: 'lamp', u: 4.5, v: sk.leftV + 2.5, radiusTiles: 2.0, intensity: 0.22 },
    { id: 'lp-2', kind: 'lamp', u: 22.5, v: sk.splitV + 2.5, radiusTiles: 2.0, intensity: 0.22 },
    { id: 'wn-1', kind: 'window', u: 21.5, v: sk.rightTopV + 1.5, radiusTiles: 3.2, intensity: 0.26 },
    { id: 'wn-2', kind: 'window', u: 21.5, v: 17.5, radiusTiles: 3.2, intensity: 0.26 },
  ]
  const exteriorProps = [
    makeWorldEntity('ext-tree-1', 'courtyard_tree', 'shared', -1, 15, 'SE'),
    makeWorldEntity('ext-shrub-1', 'tree_shrub', 'shared', 2, buildingRows + 1, 'SE'),
    makeWorldEntity('ext-shrub-2', 'tree_shrub', 'shared', 6, buildingRows + 1, 'SE'),
    makeWorldEntity('ext-tree-2', 'courtyard_tree', 'shared', 9, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-pot-l', 'plant_pot', 'shared', 10, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-pot-r', 'plant_pot', 'shared', 16, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-shrub-3', 'tree_shrub', 'shared', 18, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-shrub-4', 'tree_shrub', 'shared', 23, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-shrub-5', 'tree_shrub', 'shared', 28, 10, 'SW'),
  ]
  return {
    seed, buildingCols: WORLD_BUILDING_COLS, buildingRows, baseOrigin: { ...WORLD_BASE_ORIGIN },
    mainEntrance, corridorRect: { u: 10, v: sk.lobbyTopV, w: 7, h: buildingRows - sk.lobbyTopV },
    corridorCells, corridorBranches, wallSegments, networkMetrics,
    lobby, wings, partitionWalls, exteriorProps, interiorDoors, frontFacade, lightSources,
  }
}
