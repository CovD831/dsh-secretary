/** V2 非对称紧凑微缩沙盘平面布局求解器（零 node: 依赖）。 */
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import { CANVAS_H, CANVAS_W, TILE_H, TILE_W, type Facing, type GridPoint, type RoomEntity, type RoomWallMount, type SuiteKind, type WallSide } from './layout-solver.ts'
import type { FacadeSegmentSpec, InteriorDoorSpec, LightSourceSpec, OfficeCamera, OfficeWorldPlan, PartitionWallSegment, WorkspaceWingSpec, WorldWingPlan } from './world-types.ts'

export const WORLD_BUILDING_COLS = 22
export const WORLD_BUILDING_ROWS = 18
export const WORLD_BASE_ORIGIN = { x: 660, y: 168 } as const

function rectFootprint(u: number, v: number, w: number, h: number): GridPoint[] {
  const cells: GridPoint[] = []
  for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) cells.push({ u: u + du, v: v + dv })
  return cells
}

function makeEntity(id: string, assetId: string, suiteKind: SuiteKind, u: number, v: number, facing: Facing, seatCell?: GridPoint, wallTouch?: WallSide | 'right'): RoomEntity {
  const meta = WORLD_ASSET_CATALOG[assetId]!
  const [w, h] = meta.footprint
  return { id, assetId, suiteKind, anchor: { u, v }, size: [w, h], facing, mirrorX: facing === 'NW' || facing === 'SW', wallTouch, footprint: rectFootprint(u, v, w, h), seatCell, propKind: meta.propKind }
}

function normalizeWorkspaces(workspaces: readonly WorkspaceWingSpec[]): WorkspaceWingSpec[] {
  const seen = new Set<string>(), deduped: WorkspaceWingSpec[] = []
  for (const ws of workspaces) if (!seen.has(ws.id)) { seen.add(ws.id); deduped.push(ws) }
  const defIdx = deduped.findIndex((w) => w.id === 'default')
  return defIdx === -1 ? [{ id: 'default', title: 'default' }, ...deduped] : [deduped[defIdx]!, ...deduped.filter((_, i) => i !== defIdx)]
}

function buildLobby(buildingRows: number): WorldWingPlan {
  return {
    id: 'lobby', title: '中央迎宾前厅', kind: 'lobby',
    rect: { u: 9, v: 0, w: 4, h: buildingRows }, focusPoint: { u: 11, v: 8 }, doorway: { u: 11, v: buildingRows - 1 },
    floorStyle: 'warm_parquet', themeHex: '#6B4A32',
    suites: [makeEntity('lobby-reception', 'reception_desk', 'reception', 10, 4, 'SE', { u: 9, v: 5 })],
    shared: [
      makeEntity('lobby-bookshelf', 'bookshelf', 'shared', 9, 0, 'SE', undefined, 'back'),
      makeEntity('lobby-cabinet', 'file_cabinet', 'shared', 11, 0, 'SE', undefined, 'back'),
      makeEntity('lobby-plant-1', 'plant_pot', 'shared', 9, 9, 'SW'),
      makeEntity('lobby-plant-2', 'plant_pot', 'shared', 12, 13, 'SW'),
    ],
    wallMounts: [
      { id: 'lobby-clock', assetId: 'clock_wall', wall: 'back', at: 9.6, h: 30, span: 1 },
      { id: 'lobby-corkboard', assetId: 'corkboard', wall: 'back', at: 11.4, h: 8, span: 2, propKind: 'corkboard' },
      { id: 'lobby-sconce-back', assetId: 'wall_sconce', wall: 'back', at: 10.4, h: 20, span: 1 },
    ],
  }
}

function buildLeftPrimaryStudio(ws: WorkspaceWingSpec): WorldWingPlan {
  return {
    id: `wing-${ws.id}`, workspaceId: ws.id, title: ws.title, repository: ws.repository, kind: 'studio',
    rect: { u: 0, v: 0, w: 9, h: 15 }, focusPoint: { u: 4.5, v: 7.5 }, doorway: { u: 8, v: 6 },
    floorStyle: 'honey_oak', rugStyle: 'sage', themeHex: '#4A6A50', rugRect: { u: 2, v: 4, w: 6, h: 8 },
    suites: [
      makeEntity(`exec-${ws.id}`, 'exec_desk', 'executive', 2, 1, 'SW', { u: 3, v: 0 }, 'back'),
      makeEntity(`ws-${ws.id}-1`, 'desk_cluster', 'workstation', 3, 5, 'SW', { u: 4, v: 4 }),
      makeEntity(`ws-${ws.id}-2`, 'worker_desk', 'workstation', 6, 10, 'SW', { u: 7, v: 9 }),
      makeEntity(`ws-${ws.id}-3`, 'worker_desk', 'workstation', 2, 10, 'SE', { u: 1, v: 10 }),
    ],
    shared: [
      makeEntity(`bookshelf-${ws.id}`, 'bookshelf', 'shared', 6, 0, 'SE', undefined, 'back'),
      makeEntity(`cooler-${ws.id}`, 'water_cooler', 'shared', 0, 3, 'SE', undefined, 'left'),
      makeEntity(`printer-${ws.id}`, 'printer_copier', 'shared', 0, 12, 'SE', undefined, 'left'),
      makeEntity(`plant-${ws.id}`, 'plant_pot', 'shared', 7, 1, 'SW'),
    ],
    wallMounts: [
      { id: `wb-${ws.id}`, assetId: 'whiteboard_wall', wall: 'left', at: 6.5, h: 10, span: 3 },
      { id: `art-${ws.id}`, assetId: 'wall_painting', wall: 'back', at: 4.5, h: 14, span: 2 },
      { id: `doorplate-${ws.id}`, assetId: 'doorplate', wall: 'left', at: 5.2, h: 24, span: 1, propKind: 'doorplate' },
    ],
  }
}

function buildUpperRightWing(ws?: WorkspaceWingSpec): WorldWingPlan {
  const id = ws ? `wing-${ws.id}` : 'wing-reserve'
  const suites = ws ? [
    makeEntity(`exec-${ws.id}`, 'exec_desk', 'executive', 14, 1, 'SW', { u: 15, v: 0 }, 'back'),
    makeEntity(`ws-${ws.id}-1`, 'worker_desk', 'workstation', 19, 3, 'SW', { u: 20, v: 2 }),
    makeEntity(`ws-${ws.id}-2`, 'worker_desk', 'workstation', 19, 6, 'SW', { u: 20, v: 5 }),
    makeEntity(`ws-${ws.id}-3`, 'worker_desk', 'workstation', 15, 6, 'SE', { u: 14, v: 6 }),
  ] : []
  const shared = [
    ...(ws ? [] : [makeEntity('reserve-collab', 'collab_table', 'shared', 16, 3, 'SE')]),
    makeEntity(`bookshelf-${id}`, 'bookshelf', 'shared', 18, 0, 'SE', undefined, 'back'),
    makeEntity(`plant-${id}`, 'plant_pot', 'shared', 20, 1, 'SW'),
  ]
  const wallMounts: RoomWallMount[] = [
    { id: `idea-${id}`, assetId: 'idea_board', wall: 'back', at: 16.2, h: 8, span: 3 },
    { id: `win-${id}`, assetId: 'window_wide', wall: 'back', at: 20.2, h: 10, span: 3 },
    { id: `clk-${id}`, assetId: 'clock_wall', wall: 'back', at: 14.4, h: 28, span: 1 },
  ]
  if (ws) wallMounts.push({ id: `doorplate-${ws.id}`, assetId: 'doorplate', wall: 'back', at: 13.5, h: 24, span: 1, propKind: 'doorplate' })
  return {
    id, workspaceId: ws?.id, title: ws?.title ?? '预备研发工坊', repository: ws?.repository, kind: 'studio',
    rect: { u: 13, v: 0, w: 9, h: 9 }, focusPoint: { u: 17.5, v: 4.5 }, doorway: { u: 13, v: 5 },
    floorStyle: 'warm_parquet', rugStyle: 'indigo', themeHex: '#3F5A78', rugRect: { u: 15, v: 2, w: 5, h: 5 },
    suites, shared, wallMounts,
  }
}

function buildLowerRightWing(ws?: WorkspaceWingSpec): WorldWingPlan {
  const id = ws ? `wing-${ws.id}` : 'wing-lounge'
  const suites = ws ? [
    makeEntity(`exec-${ws.id}`, 'exec_desk', 'executive', 14, 10, 'SW', { u: 15, v: 9 }, 'back'),
    makeEntity(`ws-${ws.id}-1`, 'worker_desk', 'workstation', 19, 11, 'SW', { u: 20, v: 10 }),
    makeEntity(`ws-${ws.id}-2`, 'worker_desk', 'workstation', 18, 14, 'SW', { u: 19, v: 13 }),
    makeEntity(`ws-${ws.id}-3`, 'worker_desk', 'workstation', 14, 14, 'SE', { u: 13, v: 14 }),
  ] : []
  const shared = ws
    ? [makeEntity(`bookshelf-${ws.id}`, 'bookshelf', 'shared', 18, 9, 'SE', undefined, 'back'), makeEntity(`plant-${ws.id}`, 'plant_pot', 'shared', 14, 16, 'SW')]
    : [
        makeEntity('lounge-desk', 'exec_desk', 'shared', 18, 11, 'SW'),
        makeEntity('lounge-armchair', 'armchair_green', 'shared', 15, 14, 'SE'),
        makeEntity('lounge-lamp-1', 'lamp_table', 'shared', 20, 10, 'SW'),
        makeEntity('lounge-lamp-2', 'lamp_table', 'shared', 19, 15, 'SW'),
        makeEntity('lounge-bookshelf', 'bookshelf', 'shared', 17, 9, 'SE', undefined, 'back'),
        makeEntity('lounge-plant', 'plant_pot', 'shared', 14, 16, 'SW'),
      ]
  const wallMounts: RoomWallMount[] = [{ id: `win-${id}`, assetId: 'window_wide', wall: 'back', at: 16.5, h: 10, span: 3 }]
  if (ws) wallMounts.push({ id: `doorplate-${ws.id}`, assetId: 'doorplate', wall: 'back', at: 13.5, h: 24, span: 1, propKind: 'doorplate' })
  return {
    id, workspaceId: ws?.id, title: ws?.title ?? '茶歇与阅览室', repository: ws?.repository, kind: 'studio',
    rect: { u: 13, v: 9, w: 9, h: 9 }, focusPoint: { u: 17.5, v: 13.5 }, doorway: { u: 13, v: 13 },
    floorStyle: 'honey_oak', rugStyle: 'persian', themeHex: '#8A6242', chamferSE: 2, rugRect: { u: 15, v: 11, w: 5, h: 5 },
    suites, shared, wallMounts,
  }
}

function buildCourtyardSlot(): WorldWingPlan {
  return {
    id: 'courtyard-3', title: '待扩建庭院地块', kind: 'courtyard',
    rect: { u: 0, v: 15, w: 9, h: 3 }, focusPoint: { u: 4.5, v: 16.5 }, doorway: { u: 8, v: 16 },
    floorStyle: 'courtyard', themeHex: '#5A7848', suites: [], wallMounts: [],
    shared: [
      makeEntity('cy-tree-a', 'courtyard_tree', 'shared', 1, 15, 'SE'),
      makeEntity('cy-tree-b', 'courtyard_tree', 'shared', 6, 15, 'SW'),
      makeEntity('cy-armchair', 'armchair_green', 'shared', 3, 15, 'SE'),
      makeEntity('cy-plant', 'plant_pot', 'shared', 8, 17, 'SW'),
    ],
  }
}

function buildExpandedStudio(ws: WorkspaceWingSpec, pairIdx: number, isLeft: boolean): WorldWingPlan {
  const rowV = 18 + pairIdx * 10
  const rect = { u: isLeft ? 0 : 13, v: rowV, w: 9, h: 10 }
  return {
    id: `wing-${ws.id}`, workspaceId: ws.id, title: ws.title, repository: ws.repository, kind: 'studio',
    rect, focusPoint: { u: rect.u + 4.5, v: rowV + 5 }, doorway: { u: isLeft ? 8 : 13, v: rowV + 5 },
    floorStyle: isLeft ? 'honey_oak' : 'warm_parquet', rugStyle: isLeft ? 'sage' : 'indigo',
    themeHex: isLeft ? '#4A6A50' : '#3F5A78', rugRect: { u: rect.u + 2, v: rowV + 3, w: 5, h: 5 },
    suites: [
      makeEntity(`exec-${ws.id}`, 'exec_desk', 'executive', rect.u + 2, rowV + 1, 'SW', { u: rect.u + 3, v: rowV }, 'back'),
      makeEntity(`ws-${ws.id}-1`, 'worker_desk', 'workstation', rect.u + 6, rowV + 2, 'SW', { u: rect.u + 7, v: rowV + 1 }),
      makeEntity(`ws-${ws.id}-2`, 'worker_desk', 'workstation', rect.u + 6, rowV + 6, 'SW', { u: rect.u + 7, v: rowV + 5 }),
      makeEntity(`ws-${ws.id}-3`, 'worker_desk', 'workstation', rect.u + 1, rowV + 6, 'SE', { u: rect.u, v: rowV + 6 }),
    ],
    shared: [makeEntity(`bookshelf-${ws.id}`, 'bookshelf', 'shared', rect.u + 6, rowV, 'SE', undefined, 'back')],
    wallMounts: [{ id: `doorplate-${ws.id}`, assetId: 'doorplate', wall: isLeft ? 'left' : 'back', at: isLeft ? rowV + 4.2 : rect.u + 0.5, h: 24, span: 1, propKind: 'doorplate' }],
  }
}

export function cameraForGridPoint(pt: GridPoint, world: OfficeWorldPlan, zoom: 1 | 2, canvasW = CANVAS_W, canvasH = CANVAS_H): OfficeCamera {
  const sx = (pt.u - pt.v) * ((TILE_W * zoom) / 2), sy = (pt.u + pt.v) * ((TILE_H * zoom) / 2)
  return { panX: Math.round(canvasW / 2 - (world.baseOrigin.x + sx)), panY: Math.round(canvasH / 2 - (world.baseOrigin.y + sy)), zoom }
}

export function solveWorldFloorplan(workspaces: readonly WorkspaceWingSpec[], seed = 1): OfficeWorldPlan {
  const list = normalizeWorkspaces(workspaces)
  const extraPairs = Math.max(0, Math.ceil((list.length - 3) / 2))
  const buildingRows = WORLD_BUILDING_ROWS + extraPairs * 10
  const wings: WorldWingPlan[] = [
    buildLeftPrimaryStudio(list[0]!), buildUpperRightWing(list[1]), buildLowerRightWing(list[2]), buildCourtyardSlot(),
  ]
  for (let i = 3; i < list.length; i++) {
    const idx = i - 3
    wings.push(buildExpandedStudio(list[i]!, Math.floor(idx / 2), idx % 2 === 0))
  }
  const partitionWalls: PartitionWallSegment[] = [
    { axis: 'u', fixed: 9, start: 0, end: 6 }, { axis: 'u', fixed: 9, start: 8, end: 15 },
    { axis: 'v', fixed: 15, start: 0, end: 9 }, { axis: 'u', fixed: 13, start: 0, end: 5 },
    { axis: 'u', fixed: 13, start: 7, end: 9 }, { axis: 'u', fixed: 13, start: 9, end: 13 },
    { axis: 'u', fixed: 13, start: 15, end: 18 }, { axis: 'v', fixed: 9, start: 13, end: 22 },
  ]
  for (let p = 0; p < extraPairs; p++) {
    const rv = 18 + p * 10
    partitionWalls.push(
      { axis: 'v', fixed: rv, start: 0, end: 9 }, { axis: 'v', fixed: rv, start: 13, end: 22 },
      { axis: 'u', fixed: 9, start: rv, end: rv + 5 }, { axis: 'u', fixed: 9, start: rv + 7, end: rv + 10 },
      { axis: 'u', fixed: 13, start: rv, end: rv + 5 }, { axis: 'u', fixed: 13, start: rv + 7, end: rv + 10 },
    )
  }
  const interiorDoors: InteriorDoorSpec[] = wings.filter((w) => w.kind === 'studio')
    .map((w) => ({ id: `door-${w.id}`, u: w.rect.u === 0 ? 9 : 13, v: w.doorway.v, axis: 'u', wingId: w.id }))
  const frontFacade: FacadeSegmentSpec[] = [
    { from: { u: 9, v: buildingRows }, to: { u: 13, v: buildingRows }, heightPx: 18, isEntrance: true },
    { from: { u: 13, v: 18 }, to: { u: 20, v: 18 }, heightPx: 18, hasWindow: true },
    { from: { u: 20, v: 18 }, to: { u: 22, v: 16 }, heightPx: 18 },
    { from: { u: 22, v: 16 }, to: { u: 22, v: 0 }, heightPx: 18 },
  ]
  const lightSources: LightSourceSpec[] = [
    { id: 'sc-1', kind: 'sconce', u: 9.4, v: 3.5, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-2', kind: 'sconce', u: 12.6, v: 3.5, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-3', kind: 'sconce', u: 9.4, v: 11.5, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'sc-4', kind: 'sconce', u: 12.6, v: 11.5, radiusTiles: 2.2, intensity: 0.24 },
    { id: 'lp-1', kind: 'lamp', u: 3.2, v: 2.2, radiusTiles: 2.0, intensity: 0.22 },
    { id: 'lp-2', kind: 'lamp', u: 20.5, v: 10.5, radiusTiles: 2.0, intensity: 0.22 },
    { id: 'lp-3', kind: 'lamp', u: 19.5, v: 15.5, radiusTiles: 2.0, intensity: 0.22 },
    { id: 'wn-1', kind: 'window', u: 20.2, v: 1.5, radiusTiles: 3.2, intensity: 0.26 },
    { id: 'wn-2', kind: 'window', u: 16.5, v: 10.5, radiusTiles: 3.2, intensity: 0.26 },
  ]
  const exteriorProps: RoomEntity[] = [
    makeEntity('ext-tree-1', 'courtyard_tree', 'shared', -1, 15, 'SE'),
    makeEntity('ext-shrub-1', 'tree_shrub', 'shared', 1, 18, 'SE'),
    makeEntity('ext-shrub-2', 'tree_shrub', 'shared', 4, 18, 'SE'),
    makeEntity('ext-tree-2', 'courtyard_tree', 'shared', 7, 18, 'SW'),
    makeEntity('ext-shrub-3', 'tree_shrub', 'shared', 14, 18, 'SW'),
    makeEntity('ext-shrub-4', 'tree_shrub', 'shared', 18, 18, 'SW'),
  ]
  return {
    seed, buildingCols: WORLD_BUILDING_COLS, buildingRows, baseOrigin: { ...WORLD_BASE_ORIGIN },
    mainEntrance: { u: 11, v: buildingRows - 1 }, corridorRect: { u: 9, v: 0, w: 4, h: buildingRows },
    lobby: buildLobby(buildingRows), wings, partitionWalls, exteriorProps, interiorDoors, frontFacade, lightSources,
  }
}
