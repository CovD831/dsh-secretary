/** 同屏多房间大楼平面布局求解器契约骨架（由 h-world-engine 完整实现）。 */
import { CANVAS_H, CANVAS_W, TILE_H, TILE_W, type GridPoint } from './layout-solver.ts'
import type { OfficeCamera, OfficeWorldPlan, WorkspaceWingSpec } from './world-types.ts'

export const WORLD_BUILDING_COLS = 32
export const WORLD_BUILDING_ROWS = 26
export const WORLD_BASE_ORIGIN = { x: 740, y: 176 } as const

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
  const list = workspaces.length > 0 ? workspaces : [{ id: 'default', title: 'default' }]
  return {
    seed,
    buildingCols: WORLD_BUILDING_COLS,
    buildingRows: WORLD_BUILDING_ROWS,
    baseOrigin: { ...WORLD_BASE_ORIGIN },
    mainEntrance: { u: 15, v: 25 },
    corridorRect: { u: 13, v: 0, w: 6, h: 26 },
    lobby: {
      id: 'lobby',
      title: '中央迎宾前厅',
      kind: 'lobby',
      rect: { u: 13, v: 0, w: 6, h: 26 },
      focusPoint: { u: 15, v: 10 },
      doorway: { u: 15, v: 25 },
      suites: [],
      shared: [],
      wallMounts: [],
    },
    wings: list.map((ws, i) => ({
      id: `wing-${ws.id}`,
      workspaceId: ws.id,
      title: ws.title,
      repository: ws.repository,
      kind: 'studio',
      rect: { u: i % 2 === 0 ? 0 : 19, v: i < 2 ? 0 : 14, w: 13, h: 12 },
      focusPoint: { u: i % 2 === 0 ? 6 : 25, v: i < 2 ? 6 : 20 },
      doorway: { u: i % 2 === 0 ? 12 : 19, v: i < 2 ? 6 : 20 },
      suites: [],
      shared: [],
      wallMounts: [],
    })),
    partitionWalls: [],
    exteriorProps: [],
  }
}
