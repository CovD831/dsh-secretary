/** V2.5 肉鸽异形沙盘平面布局求解器（纯浏览器端无服务端依赖）。 */
import { CANVAS_H, CANVAS_W, TILE_H, TILE_W, type GridPoint, type RoomWallMount } from './layout-solver.ts'
import {
  FURNITURE_COMBO_KINDS,
  PREFAB_SHAPE_KINDS,
  buildCorridorNetwork,
  buildShapeCells,
  buildWallMountsForWing,
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

function buildLobby(buildingRows: number): WorldWingPlan {
  const rect = { u: 9, v: 0, w: 4, h: buildingRows }
  return {
    id: 'lobby', title: '中央迎宾前厅', kind: 'lobby', rect,
    cells: rectCells(rect.u, rect.v, rect.w, rect.h),
    focusPoint: { u: 11, v: 8 }, doorway: { u: 11, v: buildingRows - 1 },
    floorStyle: 'warm_parquet', themeHex: '#6B4A32',
    suites: [makeWorldEntity('lobby-reception', 'reception_desk', 'reception', 10, 4, 'SE', { u: 9, v: 5 })],
    shared: [
      makeWorldEntity('lobby-bookshelf', 'bookshelf', 'shared', 11, 0, 'SE', undefined, 'back'),
      makeWorldEntity('lobby-cabinet', 'file_cabinet', 'shared', 9, 0, 'SE', undefined, 'left'),
      makeWorldEntity('lobby-lamp', 'lamp_table', 'shared', 9, 11, 'SE'),
      makeWorldEntity('lobby-plant-1', 'plant_pot', 'shared', 9, 8, 'SW'),
      makeWorldEntity('lobby-plant-2', 'plant_pot', 'shared', 12, buildingRows - 3, 'SW'),
    ],
    wallMounts: [
      { id: 'lobby-clock', assetId: 'clock_wall', wall: 'back', at: 10.1, h: 26, span: 1 },
      { id: 'lobby-corkboard', assetId: 'corkboard', wall: 'back', at: 11.6, h: 16, span: 2, propKind: 'corkboard' },
    ],
  }
}

interface StudioBuildOpts {
  readonly ws?: WorkspaceWingSpec
  readonly id: string
  readonly title: string
  readonly rect: { u: number; v: number; w: number; h: number }
  readonly doorway: GridPoint
  readonly isLeft: boolean
  readonly floorStyle: WingFloorStyle
  readonly rugStyle: WingRugStyle
  readonly themeHex: string
  readonly shapeKind: PrefabShapeKind
  readonly comboKind: FurnitureComboKind
  readonly seedIdx: number
  readonly chamferSE?: number
}

function buildProceduralStudio(o: StudioBuildOpts): WorldWingPlan {
  const cells = buildShapeCells(o.rect, o.shapeKind, o.isLeft, o.doorway)
  const { suites, shared, rugRect } = populateWingFurniture(o.rect, cells, o.doorway, o.comboKind, o.ws?.id)
  const wallMounts: RoomWallMount[] = buildWallMountsForWing(o.id, o.rect, cells, o.doorway, o.ws?.id, o.isLeft, o.seedIdx)
  return {
    id: o.id, workspaceId: o.ws?.id, title: o.title, repository: o.ws?.repository, kind: 'studio',
    rect: o.rect, cells, shapeKind: o.shapeKind, comboKind: o.comboKind,
    focusPoint: { u: o.rect.u + o.rect.w / 2, v: o.rect.v + o.rect.h / 2 },
    doorway: o.doorway, floorStyle: o.floorStyle, rugStyle: o.rugStyle, themeHex: o.themeHex,
    chamferSE: o.chamferSE, rugRect, suites, shared, wallMounts,
  }
}

function buildCourtyardSlot(): WorldWingPlan {
  const rect = { u: 0, v: 15, w: 9, h: 3 }
  return {
    id: 'courtyard-3', title: '待扩建庭院地块', kind: 'courtyard', rect,
    cells: rectCells(rect.u, rect.v, rect.w, rect.h),
    focusPoint: { u: 4.5, v: 16.5 }, doorway: { u: 8, v: 16 },
    floorStyle: 'courtyard', themeHex: '#4A6A50', suites: [], wallMounts: [],
    shared: [
      makeWorldEntity('cy-tree-a', 'tree_shrub', 'shared', 1, 15, 'SE'),
      makeWorldEntity('cy-tree-b', 'tree_shrub', 'shared', 5, 15, 'SW'),
      makeWorldEntity('cy-plant', 'plant_pot', 'shared', 8, 16, 'SW'),
    ],
  }
}

export function cameraForGridPoint(pt: GridPoint, world: OfficeWorldPlan, zoom: 1 | 2, canvasW = CANVAS_W, canvasH = CANVAS_H): OfficeCamera {
  const sx = (pt.u - pt.v) * ((TILE_W * zoom) / 2), sy = (pt.u + pt.v) * ((TILE_H * zoom) / 2)
  return { panX: Math.round(canvasW / 2 - (world.baseOrigin.x + sx)), panY: Math.round(canvasH / 2 - (world.baseOrigin.y + sy)), zoom }
}

export function solveWorldFloorplan(workspaces: readonly WorkspaceWingSpec[], seed = 1): OfficeWorldPlan {
  const rng = mulberry32(seed)
  const list = normalizeWorkspaces(workspaces)
  const extraPairs = Math.max(0, Math.ceil((list.length - 3) / 2))
  const buildingRows = WORLD_BUILDING_ROWS + extraPairs * 10
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!
  const rugs: readonly WingRugStyle[] = ['sage', 'indigo', 'persian', 'woven']
  const floors: readonly WingFloorStyle[] = ['honey_oak', 'warm_parquet']
  const isBaseSeed = seed === 1

  const leftDoorV = isBaseSeed ? 6 : 3 + Math.floor(rng() * 7)
  const upperDoorV = isBaseSeed ? 5 : (leftDoorV === 4 ? 3 : 4)
  const lowerDoorV = isBaseSeed ? 13 : 12 + Math.floor(rng() * 3)

  const wings: WorldWingPlan[] = [
    buildProceduralStudio({
      ws: list[0]!, id: `wing-${list[0]!.id}`, title: list[0]!.title,
      rect: { u: 0, v: 0, w: 9, h: 15 }, doorway: { u: 8, v: leftDoorV }, isLeft: true,
      floorStyle: isBaseSeed ? 'honey_oak' : pick(floors), rugStyle: isBaseSeed ? 'sage' : pick(rugs), themeHex: '#4A6A50',
      shapeKind: isBaseSeed ? 'l-alcove' : pick(PREFAB_SHAPE_KINDS),
      comboKind: isBaseSeed ? 'paired-dev-pod' : pick(FURNITURE_COMBO_KINDS), seedIdx: seed,
    }),
    buildProceduralStudio({
      ws: list[1], id: list[1] ? `wing-${list[1].id}` : 'wing-reserve', title: list[1]?.title ?? '预备研发工坊',
      rect: { u: 13, v: 0, w: 9, h: 8 }, doorway: { u: 13, v: upperDoorV }, isLeft: false,
      floorStyle: isBaseSeed ? 'warm_parquet' : pick(floors), rugStyle: isBaseSeed ? 'indigo' : pick(rugs), themeHex: '#3F5A78',
      shapeKind: isBaseSeed ? 'bay-window' : pick(PREFAB_SHAPE_KINDS),
      comboKind: isBaseSeed ? 'war-room-collab' : pick(FURNITURE_COMBO_KINDS), seedIdx: seed + 1,
    }),
    buildProceduralStudio({
      ws: list[2], id: list[2] ? `wing-${list[2].id}` : 'wing-lounge', title: list[2]?.title ?? '茶歇与阅览室',
      rect: { u: 13, v: 10, w: 9, h: 8 }, doorway: { u: 13, v: lowerDoorV }, isLeft: false,
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
      rect: { u: isLeft ? 0 : 13, v: rowV, w: 9, h: 10 }, doorway: { u: isLeft ? 8 : 13, v: rowV + 5 }, isLeft,
      floorStyle: isLeft ? 'honey_oak' : 'warm_parquet', rugStyle: pick(rugs), themeHex: isLeft ? '#4A6A50' : '#3F5A78',
      shapeKind: pick(PREFAB_SHAPE_KINDS), comboKind: pick(FURNITURE_COMBO_KINDS), seedIdx: seed + i + 1,
    }))
  }

  const lobby = buildLobby(buildingRows)
  const mainEntrance: GridPoint = { u: 11, v: buildingRows - 1 }
  const { corridorCells, corridorBranches, networkMetrics } = buildCorridorNetwork(buildingRows, wings, rng)
  const interiorDoors: InteriorDoorSpec[] = [
    ...wings.filter((w) => w.kind === 'studio').map((w) => ({
      id: `door-${w.id}`, u: w.rect.u === 0 ? 9 : 13, v: w.doorway.v, axis: 'u' as const, wingId: w.id,
    })),
    { id: 'door-loop-upper', u: isBaseSeed ? 19 : 14, v: 8, axis: 'v', wingId: wings[1]!.id },
    { id: 'door-loop-lower', u: 14, v: 10, axis: 'v', wingId: wings[2]!.id },
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
    { id: 'sc-1', kind: 'sconce', u: 9, v: 4.5, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-2', kind: 'sconce', u: 13, v: 9.5, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-3', kind: 'sconce', u: 9.6, v: buildingRows, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-4', kind: 'sconce', u: 12.4, v: buildingRows, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'lp-1', kind: 'lamp', u: 3.2, v: 2.2, radiusTiles: 2.0, intensity: 0.22 },
    { id: 'lp-2', kind: 'lamp', u: 20.5, v: 11.5, radiusTiles: 2.0, intensity: 0.22 },
    { id: 'wn-1', kind: 'window', u: 20.2, v: 1.5, radiusTiles: 3.2, intensity: 0.26 },
    { id: 'wn-2', kind: 'window', u: 16.5, v: 11.5, radiusTiles: 3.2, intensity: 0.26 },
  ]
  const exteriorProps = [
    makeWorldEntity('ext-tree-1', 'courtyard_tree', 'shared', -1, 15, 'SE'),
    makeWorldEntity('ext-shrub-1', 'tree_shrub', 'shared', 1, buildingRows, 'SE'),
    makeWorldEntity('ext-shrub-2', 'tree_shrub', 'shared', 4, buildingRows, 'SE'),
    makeWorldEntity('ext-tree-2', 'courtyard_tree', 'shared', 7, buildingRows, 'SW'),
    makeWorldEntity('ext-pot-l', 'plant_pot', 'shared', 9, buildingRows, 'SW'),
    makeWorldEntity('ext-pot-r', 'plant_pot', 'shared', 13, buildingRows, 'SW'),
    makeWorldEntity('ext-shrub-3', 'tree_shrub', 'shared', 14, buildingRows, 'SW'),
    makeWorldEntity('ext-shrub-4', 'tree_shrub', 'shared', 18, buildingRows, 'SW'),
  ]
  return {
    seed, buildingCols: WORLD_BUILDING_COLS, buildingRows, baseOrigin: { ...WORLD_BASE_ORIGIN },
    mainEntrance, corridorRect: { u: 9, v: 0, w: 4, h: buildingRows },
    corridorCells, corridorBranches, wallSegments, networkMetrics,
    lobby, wings, partitionWalls, exteriorProps, interiorDoors, frontFacade, lightSources,
  }
}
