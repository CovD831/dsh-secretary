/** 同屏多房间大楼 + 室外草坪步道 4 层等距渲染与跨走廊寻路引擎契约骨架（由 h-world-engine 完整实现）。 */
import type { OfficeActor, OfficeSprites } from './iso-engine.ts'
import { TILE_H, TILE_W, type GridPoint } from './layout-solver.ts'
import type { OfficeCamera, OfficeWorldPlan, WorldPickResult, WorldSceneState } from './world-types.ts'

export function worldIsoToScreen(u: number, v: number, world: OfficeWorldPlan, camera: OfficeCamera): { x: number; y: number } {
  const ox = world.baseOrigin.x + camera.panX
  const oy = world.baseOrigin.y + camera.panY
  return {
    x: ox + (u - v) * ((TILE_W * camera.zoom) / 2),
    y: oy + (u + v) * ((TILE_H * camera.zoom) / 2),
  }
}

export function screenToWorldIso(px: number, py: number, world: OfficeWorldPlan, camera: OfficeCamera): GridPoint {
  const ox = world.baseOrigin.x + camera.panX
  const oy = world.baseOrigin.y + camera.panY
  const dx = (px - ox) / ((TILE_W * camera.zoom) / 2)
  const dy = (py - oy) / ((TILE_H * camera.zoom) / 2)
  return { u: Math.floor((dx + dy) / 2), v: Math.floor((dy - dx) / 2) }
}

export function createInitialWorldActors(world: OfficeWorldPlan): OfficeActor[] {
  return [{
    id: 'secretary', role: 'secretary', u: world.lobby.focusPoint.u, v: world.lobby.focusPoint.v,
    facing: 'SE', pose: 'sit', lifecycle: 'resident', assignedSuiteId: 'lobby-reception', path: [], animMs: 0,
  }]
}

export function spawnWorldWorker(
  world: OfficeWorldPlan,
  actorId: string,
  _workspaceId: string,
  ticketId: string,
  suiteId: string,
): OfficeActor {
  return {
    id: actorId, role: 'worker', u: world.mainEntrance.u, v: world.mainEntrance.v,
    facing: 'NW', pose: 'idle', lifecycle: 'entering', ticketId, assignedSuiteId: suiteId, path: [], animMs: 0,
  }
}

export function stepWorldActors(actors: OfficeActor[], _world: OfficeWorldPlan, dtMs: number): OfficeActor[] {
  return actors.map(a => ({ ...a, animMs: a.animMs + dtMs }))
}

export function renderWorldFrame(
  ctx: CanvasRenderingContext2D,
  _state: WorldSceneState,
  _sprites: OfficeSprites,
  _camera: OfficeCamera,
): void {
  ctx.imageSmoothingEnabled = false
}

export function pickWorldTarget(
  _px: number,
  _py: number,
  _state: WorldSceneState,
  _camera: OfficeCamera,
): WorldPickResult | null {
  return null
}
