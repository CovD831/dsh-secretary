/** V2.6 规整建筑级肉鸽沙盘平面布局求解器（纯浏览器端无服务端依赖）。 */
import { CANVAS_H, CANVAS_W, TILE_H, TILE_W, type GridPoint, type RoomWallMount } from './layout-solver.ts'
import {
  FURNITURE_COMBO_KINDS,
  PREFAB_SHAPE_KINDS,
  type WingSlotPos,
  buildCorridorNetwork,
  buildShapeCells,
  cellKey,
  extractWallSegments3D,
  makeWorldEntity,
  mulberry32,
  populateWingFurniture,
} from './procedural-rooms.ts'
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

export const WORLD_BUILDING_COLS = 22
export const WORLD_BUILDING_ROWS = 18
export const WORLD_BASE_ORIGIN = { x: 660, y: 168 } as const

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

function buildLobby(buildingRows: number, lobbyTopV: number): WorldWingPlan {
  const rect = { u: 9, v: lobbyTopV, w: 4, h: buildingRows - lobbyTopV }
  const recV = Math.max(lobbyTopV + 2, 4)
  return {
    id: 'lobby', title: '中央迎宾前厅', kind: 'lobby', rect,
    cells: rectCells(rect.u, rect.v, rect.w, rect.h),
    focusPoint: { u: 11, v: Math.max(lobbyTopV + 4, 8) }, doorway: { u: 11, v: buildingRows - 1 },
    floorStyle: 'warm_parquet', themeHex: '#6B4A32',
    suites: [makeWorldEntity('lobby-reception', 'reception_desk', 'reception', 10, recV, 'SE', { u: 9, v: recV + 1 })],
    shared: [
      makeWorldEntity('lobby-bookshelf', 'bookshelf', 'shared', 11, lobbyTopV, 'SE', undefined, 'back'),
      makeWorldEntity('lobby-cabinet', 'file_cabinet', 'shared', 9, lobbyTopV, 'SE', undefined, 'left'),
      makeWorldEntity('lobby-lamp', 'lamp_table', 'shared', 9, 11, 'SE'),
      makeWorldEntity('lobby-plant-1', 'plant_pot', 'shared', 9, 8, 'SW'),
      makeWorldEntity('lobby-plant-2', 'plant_pot', 'shared', 12, buildingRows - 3, 'SW'),
    ],
    wallMounts: [
      { id: 'lobby-clock', assetId: 'clock_wall', wall: 'back', at: 10.1, h: 22, span: 1 },
      { id: 'lobby-corkboard', assetId: 'corkboard', wall: 'back', at: 11.6, h: 8, span: 2, propKind: 'corkboard' },
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
  doorway: GridPoint, wsId: string | undefined, isLeft: boolean, seedIdx: number,
): RoomWallMount[] {
  const cellSet = new Set(cells.map((c) => cellKey(c.u, c.v))), mounts: RoomWallMount[] = [], isOuterBack = rect.v <= 2
  const hasBackAt = (u: number) => isOuterBack && cellSet.has(cellKey(u, rect.v)) && !cellSet.has(cellKey(u, rect.v - 1))
  const hasLeftAt = (v: number) => isLeft && cellSet.has(cellKey(rect.u, v)) && !cellSet.has(cellKey(rect.u - 1, v))
  if (hasBackAt(rect.u + 3) && hasBackAt(rect.u + 4)) mounts.push({ id: `art-${wingId}`, assetId: seedIdx % 2 === 0 ? 'wall_painting' : 'idea_board', wall: 'back', at: rect.u + 3.8, h: 6, span: 2 })
  if (hasBackAt(rect.u + 4) && hasBackAt(rect.u + 5)) mounts.push({ id: `win-${wingId}`, assetId: 'window_wide', wall: 'back', at: rect.u + 5.0, h: 6, span: 2 })
  if (hasLeftAt(rect.v + 4) && hasLeftAt(rect.v + 5)) mounts.push({ id: `wb-${wingId}`, assetId: 'whiteboard_wall', wall: 'left', at: rect.v + 4.8, h: 6, span: 3 })
  if (hasLeftAt(rect.v + 8) && hasLeftAt(rect.v + 9)) mounts.push({ id: `winL-${wingId}`, assetId: 'window_wide', wall: 'left', at: rect.v + 8.8, h: 6, span: 2 })
  if (wsId) mounts.push({ id: `doorplate-${wsId}`, assetId: 'doorplate', wall: isLeft ? 'left' : 'back', at: isLeft ? doorway.v - 0.8 : doorway.u + 0.5, h: 20, span: 1, propKind: 'doorplate' })
  return mounts
}

function buildProceduralStudio(o: StudioBuildOpts): WorldWingPlan {
  const isLeft = o.slot === 'left'
  const cells = buildShapeCells(o.rect, o.shapeKind, o.slot, o.doorway)
  const { suites, shared, rugRect } = populateWingFurniture(o.rect, cells, o.doorway, o.comboKind, o.ws?.id)
  const wallMounts: RoomWallMount[] = buildWallMountsForWing(o.id, o.rect, cells, o.doorway, o.ws?.id, isLeft, o.seedIdx)
  return {
    id: o.id, workspaceId: o.ws?.id, title: o.title, repository: o.ws?.repository, kind: 'studio',
    rect: o.rect, cells, shapeKind: o.shapeKind, comboKind: o.comboKind,
    focusPoint: { u: o.rect.u + o.rect.w / 2, v: o.rect.v + o.rect.h / 2 },
    doorway: o.doorway, floorStyle: o.floorStyle, rugStyle: o.rugStyle, themeHex: o.themeHex,
    chamferSE: o.chamferSE, rugRect, suites, shared, wallMounts,
  }
}

function buildCourtyardSlot(): WorldWingPlan {
  const rect = { u: 2, v: 15, w: 7, h: 3 }
  return {
    id: 'courtyard-3', title: '待扩建庭院地块', kind: 'courtyard', rect,
    cells: rectCells(rect.u, rect.v, rect.w, rect.h),
    focusPoint: { u: 5.5, v: 16.5 }, doorway: { u: 8, v: 16 },
    floorStyle: 'courtyard', themeHex: '#4A6A50', suites: [], wallMounts: [],
    shared: [
      makeWorldEntity('cy-tree-a', 'tree_shrub', 'shared', 2, 16, 'SE'),
      makeWorldEntity('cy-tree-b', 'tree_shrub', 'shared', 5, 16, 'SW'),
      makeWorldEntity('cy-plant', 'plant_pot', 'shared', 7, 17, 'SW'),
    ],
  }
}

export function cameraForGridPoint(pt: GridPoint, world: OfficeWorldPlan, zoom: 1 | 2, canvasW = CANVAS_W, canvasH = CANVAS_H): OfficeCamera {
  const sx = (pt.u - pt.v) * ((TILE_W * zoom) / 2), sy = (pt.u + pt.v) * ((TILE_H * zoom) / 2)
  return { panX: Math.round(canvasW / 2 - (world.baseOrigin.x + sx)), panY: Math.round(canvasH / 2 - (world.baseOrigin.y + sy)), zoom }
}

const BUILDING_SKELETONS = [
  { lobbyTopV: 2, leftV: 1, leftH: 14, rightTopV: 0, rightTopW: 9, rightBotW: 9 },
  { lobbyTopV: 0, leftV: 0, leftH: 15, rightTopV: 1, rightTopW: 9, rightBotW: 9 },
  { lobbyTopV: 1, leftV: 2, leftH: 13, rightTopV: 0, rightTopW: 9, rightBotW: 9 },
  { lobbyTopV: 2, leftV: 0, leftH: 15, rightTopV: 2, rightTopW: 9, rightBotW: 9 },
] as const

export function solveWorldFloorplan(workspaces: readonly WorkspaceWingSpec[], seed = 1): OfficeWorldPlan {
  const rng = mulberry32(seed)
  const list = normalizeWorkspaces(workspaces)
  const extraPairs = Math.max(0, Math.ceil((list.length - 3) / 2))
  const buildingRows = WORLD_BUILDING_ROWS + extraPairs * 10
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!
  const rugs: readonly WingRugStyle[] = ['sage', 'indigo', 'persian', 'woven']
  const floors: readonly WingFloorStyle[] = ['honey_oak', 'warm_parquet']
  const isBaseSeed = seed === 1
  const sk = BUILDING_SKELETONS[Math.abs(seed - 1) % BUILDING_SKELETONS.length]!

  const leftDoorV = isBaseSeed ? 6 : Math.max(sk.leftV + 3, 4 + Math.floor(rng() * 6))
  const upperDoorV = isBaseSeed ? 5 : (leftDoorV === 5 ? 4 : 5)
  const lowerDoorV = isBaseSeed ? 13 : 12 + Math.floor(rng() * 3)

  const wings: WorldWingPlan[] = [
    buildProceduralStudio({
      ws: list[0]!, id: `wing-${list[0]!.id}`, title: list[0]!.title,
      rect: { u: 0, v: sk.leftV, w: 9, h: sk.leftH }, doorway: { u: 8, v: leftDoorV }, slot: 'left',
      floorStyle: isBaseSeed ? 'honey_oak' : pick(floors), rugStyle: isBaseSeed ? 'sage' : pick(rugs), themeHex: '#4A6A50',
      shapeKind: isBaseSeed ? 'l-alcove' : pick(PREFAB_SHAPE_KINDS),
      comboKind: isBaseSeed ? 'paired-dev-pod' : pick(FURNITURE_COMBO_KINDS), seedIdx: seed,
    }),
    buildProceduralStudio({
      ws: list[1], id: list[1] ? `wing-${list[1].id}` : 'wing-reserve', title: list[1]?.title ?? '预备研发工坊',
      rect: { u: 13, v: sk.rightTopV, w: sk.rightTopW, h: 9 - sk.rightTopV }, doorway: { u: 13, v: upperDoorV }, slot: 'topRight',
      floorStyle: isBaseSeed ? 'warm_parquet' : pick(floors), rugStyle: isBaseSeed ? 'indigo' : pick(rugs), themeHex: '#3F5A78',
      shapeKind: isBaseSeed ? 'bay-window' : pick(PREFAB_SHAPE_KINDS),
      comboKind: isBaseSeed ? 'war-room-collab' : pick(FURNITURE_COMBO_KINDS), seedIdx: seed + 1,
    }),
    buildProceduralStudio({
      ws: list[2], id: list[2] ? `wing-${list[2].id}` : 'wing-lounge', title: list[2]?.title ?? '茶歇与阅览室',
      rect: { u: 13, v: 9, w: sk.rightBotW, h: 9 }, doorway: { u: 13, v: lowerDoorV }, slot: 'bottomRight',
      floorStyle: isBaseSeed ? 'honey_oak' : pick(floors), rugStyle: isBaseSeed ? 'persian' : pick(rugs), themeHex: '#8A6242',
      shapeKind: isBaseSeed ? 'chamfer-octagon' : pick(PREFAB_SHAPE_KINDS),
      comboKind: isBaseSeed ? 'exec-library-lounge' : pick(FURNITURE_COMBO_KINDS), seedIdx: seed + 2, chamferSE: 2,
    }),
    buildCourtyardSlot(),
  ]

  for (let i = 3; i < list.length; i++) {
    const idx = i - 3, isLeft = idx % 2 === 0, rowV = 18 + Math.floor(idx / 2) * 10
    wings.push(buildProceduralStudio({
      ws: list[i]!, id: `wing-${list[i]!.id}`, title: list[i]!.title,
      rect: { u: isLeft ? 0 : 13, v: rowV, w: 9, h: 10 }, doorway: { u: isLeft ? 8 : 13, v: rowV + 5 }, slot: isLeft ? 'left' : 'bottomRight',
      floorStyle: isLeft ? 'honey_oak' : 'warm_parquet', rugStyle: pick(rugs), themeHex: isLeft ? '#4A6A50' : '#3F5A78',
      shapeKind: pick(PREFAB_SHAPE_KINDS), comboKind: pick(FURNITURE_COMBO_KINDS), seedIdx: seed + i + 1,
    }))
  }

  const lobby = buildLobby(buildingRows, sk.lobbyTopV)
  const mainEntrance: GridPoint = { u: 11, v: buildingRows - 1 }
  const { corridorCells, corridorBranches, networkMetrics } = buildCorridorNetwork(buildingRows, wings, rng, sk.lobbyTopV)
  const hasWingCell = (w: WorldWingPlan, u: number, v: number) => Boolean(w.cells?.some((c) => c.u === u && c.v === v))
  const rightLinkU = (isBaseSeed ? [16, 15, 17, 14] : [15, 16, 17, 14]).find(
    (u) => hasWingCell(wings[1]!, u, 8) && hasWingCell(wings[1]!, u + 1, 8)
      && hasWingCell(wings[2]!, u, 9) && hasWingCell(wings[2]!, u + 1, 9)
      && (hasWingCell(wings[1]!, u + 2, 8) || hasWingCell(wings[2]!, u + 2, 9)),
  )
  const interiorDoors: InteriorDoorSpec[] = [
    ...wings.filter((w) => w.kind === 'studio').map((w) => ({
      id: `door-${w.id}`, u: w.rect.u === 0 ? 9 : 13, v: w.doorway.v, axis: 'u' as const, wingId: w.id,
    })),
    ...(rightLinkU !== undefined ? [{ id: 'door-right-link', u: rightLinkU, v: 9, axis: 'v' as const, wingId: wings[2]!.id }] : []),
  ]
  const wallSegments = extractWallSegments3D(lobby, wings, corridorCells, interiorDoors, mainEntrance, buildingRows)
  const partitionWalls: PartitionWallSegment[] = wallSegments
    .filter((s) => s.tier === 'partition' && (s.from.u === s.to.u || s.from.v === s.to.v))
    .map((s) => s.from.u === s.to.u
      ? { axis: 'u', fixed: s.from.u, start: Math.min(s.from.v, s.to.v), end: Math.max(s.from.v, s.to.v) }
      : { axis: 'v', fixed: s.from.v, start: Math.min(s.from.u, s.to.u), end: Math.max(s.from.u, s.to.u) })

  const frontFacade: FacadeSegmentSpec[] = wallSegments
    .filter((s) => s.tier === 'cutaway' || s.tier === 'portal')
    .map((s) => ({ from: s.from, to: s.to, heightPx: s.startH, hasWindow: s.hasWindow, isEntrance: s.tier === 'portal' }))

  const lightSources: LightSourceSpec[] = [
    { id: 'sc-1', kind: 'sconce', u: 9, v: 3.5, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-2', kind: 'sconce', u: 13, v: 2.2, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-3', kind: 'sconce', u: 9.6, v: buildingRows, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-4', kind: 'sconce', u: 12.4, v: buildingRows, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'lp-1', kind: 'lamp', u: 3.2, v: sk.leftV + 1.2, radiusTiles: 2.0, intensity: 0.22 },
    { id: 'lp-2', kind: 'lamp', u: 19.5, v: 11.5, radiusTiles: 2.0, intensity: 0.22 },
    { id: 'wn-1', kind: 'window', u: 19.8, v: 1.5, radiusTiles: 3.2, intensity: 0.26 },
    { id: 'wn-2', kind: 'window', u: 16.5, v: 11.5, radiusTiles: 3.2, intensity: 0.26 },
  ]
  const exteriorProps = [
    makeWorldEntity('ext-tree-1', 'courtyard_tree', 'shared', -1, 14, 'SE'),
    makeWorldEntity('ext-shrub-1', 'tree_shrub', 'shared', 2, buildingRows + 1, 'SE'),
    makeWorldEntity('ext-shrub-2', 'tree_shrub', 'shared', 5, buildingRows + 1, 'SE'),
    makeWorldEntity('ext-tree-2', 'courtyard_tree', 'shared', 7, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-pot-l', 'plant_pot', 'shared', 8, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-pot-r', 'plant_pot', 'shared', 13, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-shrub-3', 'tree_shrub', 'shared', 15, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-shrub-4', 'tree_shrub', 'shared', 18, buildingRows + 1, 'SW'),
    makeWorldEntity('ext-shrub-5', 'tree_shrub', 'shared', 21, 9, 'SW'),
  ]
  return {
    seed, buildingCols: WORLD_BUILDING_COLS, buildingRows, baseOrigin: { ...WORLD_BASE_ORIGIN },
    mainEntrance, corridorRect: { u: 9, v: sk.lobbyTopV, w: 4, h: buildingRows - sk.lobbyTopV },
    corridorCells, corridorBranches, wallSegments, networkMetrics,
    lobby, wings, partitionWalls, exteriorProps, interiorDoors, frontFacade, lightSources,
  }
}
