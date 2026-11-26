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
export type WingFloorStyle = 'honey_oak' | 'warm_parquet' | 'dark_walnut' | 'courtyard'
export type WingRugStyle = 'sage' | 'indigo' | 'persian' | 'woven'
export type PrefabShapeKind = 'l-alcove' | 'stepped-zigzag' | 'bay-window' | 'chamfer-octagon' | 't-studio' | 'courtyard-nook'
export type FurnitureComboKind = 'paired-dev-pod' | 'war-room-collab' | 'exec-library-lounge' | 'atelier-split' | 'agile-scrum-bay'
export type WallTier = 'back' | 'partition' | 'cutaway' | 'portal'

export interface WallSegment3D {
  readonly from: GridPoint
  readonly to: GridPoint
  readonly startH: number
  readonly endH: number
  readonly tier: WallTier
  readonly shade: 'sunlit' | 'shaded' | 'exterior'
  readonly hasWindow?: boolean
}

export interface CorridorBranchSpec {
  readonly from: GridPoint
  readonly to: GridPoint
  readonly width: number
  readonly hasRunner?: boolean
}

export interface CorridorNetworkMetrics {
  readonly roomCount: number
  readonly edgeCount: number
  readonly loopCount: number
}

export interface InteriorDoorSpec {
  readonly id: string
  readonly u: number
  readonly v: number
  readonly axis: 'u' | 'v'
  readonly wingId?: string
}

export interface FacadeSegmentSpec {
  readonly from: GridPoint
  readonly to: GridPoint
  readonly heightPx: number
  readonly hasWindow?: boolean
  readonly isEntrance?: boolean
}

export interface LightSourceSpec {
  readonly id: string
  readonly kind: 'sconce' | 'lamp' | 'window'
  readonly u: number
  readonly v: number
  readonly radiusTiles: number
  readonly intensity: number
}

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
  readonly floorStyle?: WingFloorStyle
  readonly rugStyle?: WingRugStyle
  readonly chamferSE?: number
  readonly themeHex?: string
  readonly cells?: readonly GridPoint[]
  readonly shapeKind?: PrefabShapeKind
  readonly comboKind?: FurnitureComboKind
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
  readonly interiorDoors?: InteriorDoorSpec[]
  readonly frontFacade?: FacadeSegmentSpec[]
  readonly lightSources?: LightSourceSpec[]
  readonly corridorCells?: readonly GridPoint[]
  readonly corridorBranches?: readonly CorridorBranchSpec[]
  readonly wallSegments?: readonly WallSegment3D[]
  readonly networkMetrics?: CorridorNetworkMetrics
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
