/** 同屏多房间大楼与室外庭院平面布局求解器。 */
import { OFFICE_CATALOG } from './catalog.ts'
import {
  CANVAS_H,
  CANVAS_W,
  TILE_H,
  TILE_W,
  type Facing,
  type GridPoint,
  type RoomEntity,
  type RoomWallMount,
  type SuiteKind,
  type WallSide,
} from './layout-solver.ts'
import type {
  OfficeCamera,
  OfficeWorldPlan,
  PartitionWallSegment,
  WorkspaceWingSpec,
  WorldWingPlan,
} from './world-types.ts'

export const WORLD_BUILDING_COLS = 32
export const WORLD_BUILDING_ROWS = 26
export const WORLD_BASE_ORIGIN = { x: 740, y: 120 } as const

function rectFootprint(u: number, v: number, w: number, h: number): GridPoint[] {
  const cells: GridPoint[] = []
  for (let dv = 0; dv < h; dv++) {
    for (let du = 0; du < w; du++) cells.push({ u: u + du, v: v + dv })
  }
  return cells
}

function makeEntity(
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

function normalizeWorkspaces(workspaces: readonly WorkspaceWingSpec[]): WorkspaceWingSpec[] {
  const seen = new Set<string>()
  const deduped: WorkspaceWingSpec[] = []
  for (const ws of workspaces) {
    if (!seen.has(ws.id)) {
      seen.add(ws.id)
      deduped.push(ws)
    }
  }
  const defIdx = deduped.findIndex((w) => w.id === 'default')
  if (defIdx === -1) return [{ id: 'default', title: 'default' }, ...deduped]
  return [deduped[defIdx]!, ...deduped.filter((_, i) => i !== defIdx)]
}

function buildLobby(buildingRows: number): WorldWingPlan {
  return {
    id: 'lobby',
    title: '中央迎宾前厅',
    kind: 'lobby',
    rect: { u: 13, v: 0, w: 6, h: buildingRows },
    focusPoint: { u: 15, v: 9 },
    doorway: { u: 15, v: buildingRows - 1 },
    suites: [
      makeEntity('lobby-reception', 'reception_desk', 'reception', 15, 8, 'SE', { u: 14, v: 9 }),
    ],
    shared: [
      makeEntity('lobby-bookshelf', 'bookshelf', 'shared', 13, 0, 'SE', undefined, 'back'),
      makeEntity('lobby-cabinet', 'file_cabinet', 'shared', 16, 0, 'SE', undefined, 'back'),
      makeEntity('lobby-cooler', 'water_cooler', 'shared', 13, 5, 'SE', undefined, 'left'),
      makeEntity('lobby-plant-1', 'plant_pot', 'shared', 18, 0, 'SW', undefined, 'back'),
      makeEntity('lobby-plant-2', 'plant_pot', 'shared', 13, buildingRows - 3, 'SE', undefined, 'left'),
    ],
    wallMounts: [
      { id: 'lobby-clock', assetId: 'clock_wall', wall: 'back', at: 14.4, h: 32, span: 1 },
      { id: 'lobby-corkboard', assetId: 'corkboard', wall: 'back', at: 16.8, h: 8, span: 2, propKind: 'corkboard' },
    ],
  }
}

function buildStudioWing(ws: WorkspaceWingSpec, rowIdx: number, isLeft: boolean): WorldWingPlan {
  const rowV = rowIdx * 14
  const rect = { u: isLeft ? 0 : 19, v: rowV, w: 13, h: 12 }
  const wallMounts: RoomWallMount[] = [
    { id: `doorplate-${ws.id}`, assetId: 'doorplate', wall: isLeft ? 'left' : 'back', at: isLeft ? rowV + 5.2 : rect.u + 1.2, h: 24, span: 1, propKind: 'doorplate' },
  ]
  if (rowIdx === 0) {
    wallMounts.push({ id: `window-back-${ws.id}`, assetId: 'window_day', wall: 'back', at: rect.u + 8.5, h: 12, span: 2 })
  }
  if (isLeft) {
    wallMounts.push({ id: `window-left-${ws.id}`, assetId: 'window_day', wall: 'left', at: rect.v + 6, h: 12, span: 2 })
  }
  return {
    id: `wing-${ws.id}`,
    workspaceId: ws.id,
    title: ws.title,
    repository: ws.repository,
    kind: 'studio',
    rect,
    focusPoint: { u: rect.u + 6, v: rect.v + 6 },
    doorway: { u: isLeft ? 12 : 19, v: rowV + 6 },
    suites: [
      makeEntity(`exec-${ws.id}`, 'exec_desk', 'executive', rect.u + 5, rect.v + 1, 'SW', { u: rect.u + 6, v: rect.v }, 'back'),
      makeEntity(`ws-${ws.id}-1`, 'worker_desk', 'workstation', rect.u + 9, rect.v + 4, 'SW', { u: rect.u + 10, v: rect.v + 3 }, 'right'),
      makeEntity(`ws-${ws.id}-2`, 'worker_desk', 'workstation', rect.u + 9, rect.v + 8, 'SW', { u: rect.u + 10, v: rect.v + 7 }, 'right'),
      makeEntity(`ws-${ws.id}-3`, 'worker_desk', 'workstation', rect.u + 3, rect.v + 8, 'SE', { u: rect.u + 2, v: rect.v + 8 }),
    ],
    shared: [
      makeEntity(`bookshelf-${ws.id}`, 'bookshelf', 'shared', rect.u + 1, rect.v, 'SE', undefined, 'back'),
      makeEntity(`sofa-${ws.id}`, 'sofa_lounge', 'shared', rect.u + 1, rect.v + 4, 'SE', undefined, 'left'),
      makeEntity(`plant-${ws.id}`, 'plant_pot', 'shared', rect.u + 11, rect.v, 'SW', undefined, 'back'),
    ],
    wallMounts,
    rugRect: { u: rect.u + 4, v: rect.v + 4, w: 4, h: 4 },
  }
}

function buildCourtyardWing(slotIdx: number, rowIdx: number, isLeft: boolean): WorldWingPlan {
  const rowV = rowIdx * 14
  const rect = { u: isLeft ? 0 : 19, v: rowV, w: 13, h: 12 }
  return {
    id: `courtyard-${slotIdx}`,
    title: '待扩建庭院地块',
    kind: 'courtyard',
    rect,
    focusPoint: { u: rect.u + 6, v: rect.v + 6 },
    doorway: { u: isLeft ? 12 : 19, v: rowV + 6 },
    suites: [],
    shared: [
      makeEntity(`cy-shrub-a-${slotIdx}`, 'tree_shrub', 'shared', rect.u + 2, rect.v + 2, 'SE'),
      makeEntity(`cy-shrub-b-${slotIdx}`, 'tree_shrub', 'shared', rect.u + 9, rect.v + 8, 'SW'),
      makeEntity(`cy-sofa-${slotIdx}`, 'sofa_lounge', 'shared', rect.u + 5, rect.v + 5, 'SE'),
      makeEntity(`cy-plant-${slotIdx}`, 'plant_pot', 'shared', rect.u + 10, rect.v + 2, 'SW'),
    ],
    wallMounts: [],
  }
}

function buildPartitionWalls(rowCount: number): PartitionWallSegment[] {
  const walls: PartitionWallSegment[] = []
  for (let r = 0; r < rowCount; r++) {
    const rowV = r * 14
    walls.push({ axis: 'u', fixed: 13, start: rowV, end: rowV + 5 })
    walls.push({ axis: 'u', fixed: 13, start: rowV + 7, end: rowV + 12 })
    walls.push({ axis: 'u', fixed: 19, start: rowV, end: rowV + 5 })
    walls.push({ axis: 'u', fixed: 19, start: rowV + 7, end: rowV + 12 })
    if (r < rowCount - 1) {
      walls.push({ axis: 'v', fixed: rowV + 12, start: 0, end: 13 })
      walls.push({ axis: 'v', fixed: rowV + 12, start: 19, end: 32 })
    }
  }
  return walls
}

function buildExteriorProps(buildingRows: number): RoomEntity[] {
  const frontUs = [3, 8, 12, 18, 22, 27]
  const props: RoomEntity[] = frontUs.map((u, idx) =>
    makeEntity(`ext-shrub-front-${idx}`, 'tree_shrub', 'shared', u, buildingRows + 1, u < 15 ? 'SE' : 'SW'),
  )
  props.push(makeEntity('ext-shrub-west-0', 'tree_shrub', 'shared', -3, 5, 'SE'))
  props.push(makeEntity('ext-shrub-west-1', 'tree_shrub', 'shared', -3, 17, 'SE'))
  return props
}

export function cameraForGridPoint(
  pt: GridPoint,
  world: OfficeWorldPlan,
  zoom: 1 | 2,
  canvasW = CANVAS_W,
  canvasH = CANVAS_H,
): OfficeCamera {
  const sx = (pt.u - pt.v) * ((TILE_W * zoom) / 2)
  const sy = (pt.u + pt.v) * ((TILE_H * zoom) / 2)
  return {
    panX: Math.round(canvasW / 2 - (world.baseOrigin.x + sx)),
    panY: Math.round(canvasH / 2 - (world.baseOrigin.y + sy)),
    zoom,
  }
}

export function solveWorldFloorplan(workspaces: readonly WorkspaceWingSpec[], seed = 1): OfficeWorldPlan {
  const list = normalizeWorkspaces(workspaces)
  const slotCount = Math.max(4, Math.ceil(list.length / 2) * 2)
  const rowCount = slotCount / 2
  const buildingRows = rowCount * 14 - 2
  const wings: WorldWingPlan[] = []
  for (let i = 0; i < slotCount; i++) {
    const rowIdx = Math.floor(i / 2)
    const isLeft = i % 2 === 0
    const ws = list[i]
    wings.push(ws ? buildStudioWing(ws, rowIdx, isLeft) : buildCourtyardWing(i, rowIdx, isLeft))
  }
  return {
    seed,
    buildingCols: WORLD_BUILDING_COLS,
    buildingRows,
    baseOrigin: { ...WORLD_BASE_ORIGIN },
    mainEntrance: { u: 15, v: buildingRows - 1 },
    corridorRect: { u: 13, v: 0, w: 6, h: buildingRows },
    lobby: buildLobby(buildingRows),
    wings,
    partitionWalls: buildPartitionWalls(rowCount),
    exteriorProps: buildExteriorProps(buildingRows),
  }
}
