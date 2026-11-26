/** 同屏多房间像素游戏世界（大楼走廊 + 多工作区独立房间 + 庭院地块 + 整数相机）共用契约类型。 */
import type { PropKind, StatusKind } from './catalog.ts'
import type { ActorRole, OfficeActor, OfficeSprites } from './iso-engine.ts'
import type { GridPoint, RoomEntity, RoomWallMount } from './layout-solver.ts'

export interface WorkspaceWingSpec {
  readonly id: string
  readonly title: string
  readonly repository?: string
}

export type WingKind = 'lobby' | 'studio' | 'courtyard'

export interface WorldWingPlan {
  readonly id: string
  readonly workspaceId?: string
  readonly title: string
  readonly repository?: string
  readonly kind: WingKind
  readonly rect: { readonly u: number; readonly v: number; readonly w: number; readonly h: number }
  readonly focusPoint: GridPoint
  readonly doorway: GridPoint
  readonly suites: RoomEntity[]
  readonly shared: RoomEntity[]
  readonly wallMounts: RoomWallMount[]
  readonly rugRect?: { readonly u: number; readonly v: number; readonly w: number; readonly h: number }
}

export interface OfficeCamera {
  readonly panX: number
  readonly panY: number
  readonly zoom: 1 | 2
}

export interface PartitionWallSegment {
  readonly axis: 'u' | 'v'
  readonly fixed: number
  readonly start: number
  readonly end: number
}

export interface OfficeWorldPlan {
  readonly seed: number
  readonly buildingCols: number
  readonly buildingRows: number
  readonly baseOrigin: { readonly x: number; readonly y: number }
  readonly mainEntrance: GridPoint
  readonly corridorRect: { readonly u: number; readonly v: number; readonly w: number; readonly h: number }
  readonly lobby: WorldWingPlan
  readonly wings: WorldWingPlan[]
  readonly partitionWalls: PartitionWallSegment[]
  readonly exteriorProps: RoomEntity[]
}

export type WorldPickResult =
  | { type: 'prop'; prop: PropKind; label: string; workspaceId?: string; bounds: { x: number; y: number; w: number; h: number } }
  | { type: 'actor'; actorId: string; role: ActorRole; workspaceId?: string; ticketId?: string; bounds: { x: number; y: number; w: number; h: number } }
  | { type: 'wing'; wingId: string; workspaceId?: string; kind: WingKind; label: string; bounds: { x: number; y: number; w: number; h: number } }

export interface WorldSceneState {
  readonly world: OfficeWorldPlan
  readonly actors: OfficeActor[]
  readonly screenStates: Record<string, StatusKind | 'off'>
  readonly activeWorkspaceId: string
  readonly gateIntercept?: { targetActorId: string; frame: number }
  readonly hoverTarget?: WorldPickResult | null
  readonly secretaryThinking?: boolean
  readonly elapsedMs: number
}

export type WorldSprites = OfficeSprites
