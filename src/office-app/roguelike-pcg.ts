/** 受约束肉鸽过程生成引擎（Roguelike Constrained PCG）：为任意 1..999999 种子生成建筑骨架与室内家居组合。 */
import type { Facing } from './layout-solver.ts'
import type { WingSlotPos } from './procedural-rooms.ts'
import type { FurnitureComboKind, PrefabShapeKind, WingFloorStyle, WingRugStyle } from './world-types.ts'

export type RecipeZone = 'focal' | 'row' | 'backWall' | 'sideWall' | 'corner'
export interface BlueprintItem {
  readonly role: string; readonly assetId: string; readonly kind: 'workstation' | 'shared'; readonly zone: RecipeZone
  readonly pref: readonly [number, number]; readonly facing: Facing; readonly seatOff: readonly [number, number] | null
  readonly pairWith?: string; readonly alignRowWith?: string; readonly alignColWith?: string
}

export interface BuildingSeedPlan {
  readonly skeleton: {
    readonly lobbyTopV: number; readonly leftV: number; readonly leftEndV: number; readonly rightTopV: number
    readonly splitV: number; readonly receptionV: number; readonly bookshelfV: number; readonly lampV: number; readonly plantV: number
  }
  readonly doors: readonly [leftV: number, upperV: number, lowerV: number]
  readonly rightLinkPrefs: readonly number[]
  readonly shapes: readonly [PrefabShapeKind, PrefabShapeKind, PrefabShapeKind]
  readonly combos: readonly [FurnitureComboKind, FurnitureComboKind, FurnitureComboKind]
  readonly floors: readonly [WingFloorStyle, WingFloorStyle, WingFloorStyle]
  readonly rugs: readonly [WingRugStyle, WingRugStyle, WingRugStyle]
  readonly chamferSE?: number
}

const SHAPES: readonly PrefabShapeKind[] = ['l-alcove', 'stepped-zigzag', 'bay-window', 'chamfer-octagon', 't-studio', 'courtyard-nook']
const COMBOS: readonly FurnitureComboKind[] = ['paired-dev-pod', 'war-room-collab', 'exec-library-lounge', 'atelier-split', 'agile-scrum-bay']
const RUGS_HIGHRES: readonly WingRugStyle[] = ['sage', 'indigo', 'persian']
const RUGS_ALL: readonly WingRugStyle[] = ['sage', 'indigo', 'persian', 'woven']

function pcgRng(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const pick = <T,>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!
const randInt = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (Math.max(0, hi - lo) + 1))

export function generateBuildingSeedPlan(seed: number): BuildingSeedPlan {
  const s = Math.max(1, Math.min(999999, Math.floor(seed) || 1))
  if (s === 1) {
    return {
      skeleton: { lobbyTopV: 1, leftV: 1, leftEndV: 17, rightTopV: 0, splitV: 10, receptionV: 11, bookshelfV: 14, lampV: 13, plantV: 10 },
      doors: [6, 5, 13], rightLinkPrefs: [19, 18, 20],
      shapes: ['l-alcove', 'bay-window', 'chamfer-octagon'], chamferSE: 2,
      combos: ['paired-dev-pod', 'war-room-collab', 'exec-library-lounge'],
      floors: ['honey_oak', 'warm_parquet', 'honey_oak'], rugs: ['sage', 'indigo', 'persian'],
    }
  }
  const rng = pcgRng(Math.imul(s, 0x9e3779b1) >>> 0)
  const splitV = rng() < 0.42 ? 9 : 10
  const rightTopV = splitV === 9 ? 0 : (rng() < 0.45 ? 1 : 0)
  const leftV = pick(rng, [0, 1, 2]), leftEndV = pick(rng, [15, 16, 17]), lobbyTopV = pick(rng, [0, 1, 2])
  const leftDoorV = randInt(rng, Math.max(leftV + 2, lobbyTopV + 2), leftEndV === 15 ? 5 : 6)
  let receptionV = 11, bookshelfV = 14, lampV = 13, plantV = 10
  if (leftEndV === 17) { receptionV = rng() < 0.5 ? 11 : 10; bookshelfV = receptionV + 3; lampV = receptionV + 2; plantV = receptionV - 1 }
  else if (leftEndV === 16) { receptionV = 10; bookshelfV = 13; lampV = 12; plantV = 9 }
  else { receptionV = 11; bookshelfV = 8; lampV = 13; plantV = 10 }

  const upLo = Math.max(rightTopV + 2, lobbyTopV + 2), upHi = splitV - 4
  const upOpts: number[] = []
  for (let v = upLo; v <= upHi; v++) if (v !== leftDoorV) upOpts.push(v)
  const upperDoorV = upOpts.length > 0 ? pick(rng, upOpts) : upLo
  const lowerDoorV = randInt(rng, splitV + 2, 15)
  const rightLinkPrefs = [19, 20, 21, 22, 18]
  for (let i = rightLinkPrefs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rightLinkPrefs[i], rightLinkPrefs[j]] = [rightLinkPrefs[j]!, rightLinkPrefs[i]!] }

  const chamferSE = pick(rng, [undefined, 2, 3] as const)
  const shape2: PrefabShapeKind = chamferSE === 3 ? 'bay-window' : chamferSE === 2 ? 'chamfer-octagon' : 'l-alcove'
  const f0: WingFloorStyle = rng() < 0.5 ? 'honey_oak' : 'warm_parquet'
  const f1: WingFloorStyle = rng() < 0.5 ? 'honey_oak' : 'warm_parquet'
  const f2: WingFloorStyle = f0 === f1 ? (f0 === 'honey_oak' ? 'warm_parquet' : 'honey_oak') : (rng() < 0.5 ? 'honey_oak' : 'warm_parquet')
  const cs = [...COMBOS]
  for (let i = cs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cs[i], cs[j]] = [cs[j]!, cs[i]!] }
  const r0 = pick(rng, RUGS_HIGHRES)
  const r1 = pick(rng, RUGS_ALL.filter((r) => r !== r0))
  const r2 = pick(rng, RUGS_ALL.filter((r) => r !== r1))
  return {
    skeleton: { lobbyTopV, leftV, leftEndV, rightTopV, splitV, receptionV, bookshelfV, lampV, plantV },
    doors: [leftDoorV, upperDoorV, lowerDoorV], rightLinkPrefs,
    shapes: [pick(rng, SHAPES), pick(rng, SHAPES), shape2], chamferSE,
    combos: [cs[0]!, cs[1]!, cs[2]!],
    floors: [f0, f1, f2], rugs: [r0, r1, r2],
  }
}

export function buildProceduralRecipe(
  slot: WingSlotPos, combo: FurnitureComboKind, hasWs: boolean, rect: { w: number; h: number }, seed: number,
): readonly BlueprintItem[] {
  const s = Math.max(1, Math.floor(seed) || 1)
  if (s === 1) {
    if (!hasWs) return slot === 'topRight' ? [
      { role: 'focal', assetId: 'collab_table', kind: 'shared', zone: 'focal', pref: [4, 3], facing: 'SE', seatOff: null },
      { role: 'wall1', assetId: 'bookshelf', kind: 'shared', zone: 'backWall', pref: [9, 0], facing: 'SW', seatOff: null },
      { role: 'wall2', assetId: 'water_cooler', kind: 'shared', zone: 'sideWall', pref: [0, 1], facing: 'SE', seatOff: null },
      { role: 'decor1', assetId: 'plant_pot', kind: 'shared', zone: 'corner', pref: [0, 8], facing: 'SE', seatOff: null },
    ] : [
      { role: 'wall1', assetId: 'bookshelf', kind: 'shared', zone: 'backWall', pref: [5, 0], facing: 'SW', seatOff: null },
      { role: 'focal', assetId: 'sofa_lounge', kind: 'shared', zone: 'focal', pref: [6, 2], facing: 'SW', seatOff: null },
      { role: 'pair1', assetId: 'lamp_table', kind: 'shared', zone: 'focal', pref: [5, 2], facing: 'SW', seatOff: null, pairWith: 'focal' },
      { role: 'lounge2', assetId: 'armchair_green', kind: 'shared', zone: 'focal', pref: [3, 4], facing: 'SE', seatOff: null },
      { role: 'decor1', assetId: 'plant_pot', kind: 'shared', zone: 'corner', pref: [9, 0], facing: 'SW', seatOff: null },
      { role: 'decor2', assetId: 'plant_pot', kind: 'shared', zone: 'corner', pref: [0, 8], facing: 'SE', seatOff: null },
    ]
    if (slot === 'left' && rect.h >= 12) return [
      { role: 'ws1', assetId: 'desk_cluster', kind: 'workstation', zone: 'focal', pref: [3, 4], facing: 'SW', seatOff: [1, -1] },
      { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [2, 11], facing: 'SW', seatOff: [1, -1] },
      { role: 'ws3', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [5, 11], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws2' },
      { role: 'wall1', assetId: 'bookshelf', kind: 'shared', zone: 'backWall', pref: [5, 0], facing: 'SW', seatOff: null },
      { role: 'wall2', assetId: 'printer_copier', kind: 'shared', zone: 'sideWall', pref: [0, 5], facing: 'SE', seatOff: null },
      { role: 'wall3', assetId: 'water_cooler', kind: 'shared', zone: 'sideWall', pref: [0, 12], facing: 'SE', seatOff: null },
      { role: 'decor1', assetId: 'plant_pot', kind: 'shared', zone: 'corner', pref: [0, 0], facing: 'SW', seatOff: null },
    ]
    if (slot === 'topRight') return [
      { role: 'ws1', assetId: 'collab_table', kind: 'workstation', zone: 'focal', pref: [4, 3], facing: 'SE', seatOff: [1, -1] },
      { role: 'wall1', assetId: 'bookshelf', kind: 'shared', zone: 'backWall', pref: [9, 0], facing: 'SW', seatOff: null },
      { role: 'wall2', assetId: 'water_cooler', kind: 'shared', zone: 'sideWall', pref: [0, 1], facing: 'SE', seatOff: null },
      { role: 'decor1', assetId: 'plant_pot', kind: 'shared', zone: 'corner', pref: [0, 8], facing: 'SE', seatOff: null },
    ]
  }

  const slotTag = slot === 'left' ? 17 : slot === 'topRight' ? 53 : 97
  const rng = pcgRng((Math.imul(s, 0x85ebca6b) ^ (slotTag * 31) ^ (hasWs ? 131 : 7)) >>> 0)
  const techPod = combo === 'agile-scrum-bay' || combo === 'atelier-split'
  const storage = techPod ? 'file_cabinet' : rng() < 0.65 ? 'bookshelf' : 'file_cabinet'
  const util = techPod ? 'printer_copier' : rng() < 0.6 ? 'water_cooler' : 'printer_copier'
  const addExtras = (items: BlueprintItem[], backX: number, plantPos: readonly [number, number], extraSideV?: number) => {
    items.push({ role: 'wall1', assetId: storage, kind: 'shared', zone: 'backWall', pref: [backX, 0], facing: 'SW', seatOff: null })
    if (extraSideV !== undefined) items.push({ role: 'wall2', assetId: util, kind: 'shared', zone: 'sideWall', pref: [0, extraSideV], facing: 'SE', seatOff: null })
    items.push({ role: 'decor1', assetId: 'plant_pot', kind: 'shared', zone: 'corner', pref: plantPos, facing: plantPos[0] === 0 ? 'SE' : 'SW', seatOff: null })
    if (rng() < 0.55) items.push({ role: 'decor2', assetId: 'plant_pot', kind: 'shared', zone: 'corner', pref: [plantPos[0] === 0 ? rect.w - 2 : 0, plantPos[1] === 0 ? rect.h - 2 : 0], facing: 'SW', seatOff: null })
    return items
  }

  if (!hasWs) {
    if (slot === 'topRight') {
      const items: BlueprintItem[] = [{ role: 'focal', assetId: 'collab_table', kind: 'shared', zone: 'focal', pref: [pick(rng, [4, 5]), pick(rng, [2, 3])], facing: 'SE', seatOff: null }]
      if (rect.h >= 10 && rng() < 0.35) {
        items.push({ role: 'lounge1', assetId: 'armchair_green', kind: 'shared', zone: 'focal', pref: [2, 6], facing: 'SE', seatOff: null })
        items.push({ role: 'pair1', assetId: 'lamp_table', kind: 'shared', zone: 'focal', pref: [2, 5], facing: 'SE', seatOff: null, pairWith: 'lounge1' })
      }
      return addExtras(items, pick(rng, [2, 8, 9]), [0, rect.h - 2], pick(rng, [1, 3]))
    }
    const items: BlueprintItem[] = [
      { role: 'wall1', assetId: rng() < 0.75 ? 'bookshelf' : 'file_cabinet', kind: 'shared', zone: 'backWall', pref: [pick(rng, [3, 5, 7]), 0], facing: 'SW', seatOff: null },
      { role: 'focal', assetId: 'sofa_lounge', kind: 'shared', zone: 'focal', pref: [pick(rng, [5, 6]), pick(rng, [2, 3])], facing: 'SW', seatOff: null },
      { role: 'pair1', assetId: 'lamp_table', kind: 'shared', zone: 'focal', pref: [4, 2], facing: 'SW', seatOff: null, pairWith: 'focal' },
      { role: 'lounge2', assetId: 'armchair_green', kind: 'shared', zone: 'focal', pref: [pick(rng, [2, 3]), pick(rng, [4, 5])], facing: 'SE', seatOff: null },
    ]
    if (rng() < 0.5) items.push({ role: 'wall2', assetId: 'water_cooler', kind: 'shared', zone: 'sideWall', pref: [0, pick(rng, [1, 7])], facing: 'SE', seatOff: null })
    items.push({ role: 'decor1', assetId: 'plant_pot', kind: 'shared', zone: 'corner', pref: [9, 0], facing: 'SW', seatOff: null })
    items.push({ role: 'decor2', assetId: 'plant_pot', kind: 'shared', zone: 'corner', pref: [0, Math.max(6, rect.h - 2)], facing: 'SE', seatOff: null })
    return items
  }

  if (slot === 'left' && rect.h < 12) return addExtras([
    { role: 'ws1', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [2, 3], facing: 'SW', seatOff: [1, -1] },
    { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [5, 3], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws1' },
    { role: 'ws3', assetId: rng() < 0.5 ? 'worker_desk' : 'exec_desk', kind: 'workstation', zone: 'row', pref: [2, 7], facing: 'SW', seatOff: [1, -1], alignColWith: 'ws1' },
  ], pick(rng, [4, 6]), [0, rect.h - 2], 0)

  if (slot === 'left') {
    const midV = Math.min(10, Math.max(8, rect.h - 5))
    const items: BlueprintItem[] = []
    if (combo === 'paired-dev-pod' && rng() < 0.5) {
      items.push(
        { role: 'ws1', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [2, 3], facing: 'SW', seatOff: [1, -1] },
        { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [5, 3], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws1' },
        { role: 'ws3', assetId: 'desk_cluster', kind: 'workstation', zone: 'focal', pref: [3, Math.min(9, rect.h - 5)], facing: 'SW', seatOff: [1, -1] },
      )
    } else if (combo === 'paired-dev-pod') {
      items.push(
        { role: 'ws1', assetId: 'desk_cluster', kind: 'workstation', zone: 'focal', pref: [3, 4], facing: 'SW', seatOff: [1, -1] },
        { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [2, midV], facing: 'SW', seatOff: [1, -1] },
        { role: 'ws3', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [5, midV], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws2' },
      )
    } else if (combo === 'agile-scrum-bay') {
      const r0 = pick(rng, [3, 4]), r1 = Math.min(rect.h - 4, r0 + pick(rng, [4, 5]))
      items.push(
        { role: 'ws1', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [2, r0], facing: 'SW', seatOff: [1, -1] },
        { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [5, r0], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws1' },
        { role: 'ws3', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [2, r1], facing: 'SW', seatOff: [1, -1], alignColWith: 'ws1' },
        { role: 'ws4', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [5, r1], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws3' },
      )
    } else if (combo === 'war-room-collab') {
      items.push(
        { role: 'ws1', assetId: 'collab_table', kind: 'workstation', zone: 'focal', pref: [3, 4], facing: 'SE', seatOff: [1, -1] },
        { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [2, midV], facing: 'SW', seatOff: [1, -1] },
        { role: 'ws3', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [5, midV], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws2' },
      )
    } else if (combo === 'exec-library-lounge') {
      items.push(
        { role: 'ws1', assetId: 'exec_desk', kind: 'workstation', zone: 'focal', pref: [3, 4], facing: 'SW', seatOff: [1, -1] },
        { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [2, midV], facing: 'SW', seatOff: [1, -1] },
        { role: 'ws3', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [5, midV], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws2' },
      )
    } else {
      items.push(
        { role: 'ws1', assetId: 'desk_cluster', kind: 'workstation', zone: 'focal', pref: [3, 4], facing: 'SW', seatOff: [1, -1] },
        { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [5, midV], facing: 'SW', seatOff: [1, -1] },
        { role: 'lounge', assetId: rng() < 0.5 ? 'armchair_green' : 'sofa_lounge', kind: 'shared', zone: 'focal', pref: [1, midV], facing: 'SE', seatOff: null },
        { role: 'pair1', assetId: 'lamp_table', kind: 'shared', zone: 'focal', pref: [1, midV - 1], facing: 'SE', seatOff: null, pairWith: 'lounge' },
      )
    }
    return addExtras(items, pick(rng, [4, 5, 6]), [0, 0], pick(rng, [5, 10]))
  }

  if (slot === 'topRight') {
    const items: BlueprintItem[] = combo === 'war-room-collab'
      ? [{ role: 'ws1', assetId: 'collab_table', kind: 'workstation', zone: 'focal', pref: [pick(rng, [4, 5]), 3], facing: 'SE', seatOff: [1, -1] }]
      : combo === 'paired-dev-pod'
        ? [
            { role: 'ws1', assetId: 'desk_cluster', kind: 'workstation', zone: 'focal', pref: [pick(rng, [3, 4]), 3], facing: 'SW', seatOff: [1, -1] },
            { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [8, 3], facing: 'SW', seatOff: [1, -1] },
          ]
        : combo === 'exec-library-lounge'
          ? [
              { role: 'ws1', assetId: 'exec_desk', kind: 'workstation', zone: 'focal', pref: [3, 3], facing: 'SW', seatOff: [1, -1] },
              { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [7, 3], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws1' },
              { role: 'lounge', assetId: 'armchair_green', kind: 'shared', zone: 'focal', pref: [8, 6], facing: 'SW', seatOff: null },
            ]
          : combo === 'atelier-split'
            ? [
                { role: 'ws1', assetId: 'desk_cluster', kind: 'workstation', zone: 'focal', pref: [2, 3], facing: 'SW', seatOff: [1, -1] },
                { role: 'lounge', assetId: 'sofa_lounge', kind: 'shared', zone: 'focal', pref: [7, 4], facing: 'SW', seatOff: null },
                { role: 'pair1', assetId: 'lamp_table', kind: 'shared', zone: 'focal', pref: [9, 4], facing: 'SW', seatOff: null, pairWith: 'lounge' },
              ]
            : [
                { role: 'ws1', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [2, 3], facing: 'SW', seatOff: [1, -1] },
                { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [5, 3], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws1' },
                { role: 'ws3', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [8, 3], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws1' },
              ]
    return addExtras(items, pick(rng, [8, 9]), [0, rect.h - 2], pick(rng, [1, 2]))
  }

  const brItems: BlueprintItem[] = combo === 'war-room-collab'
    ? [{ role: 'ws1', assetId: 'collab_table', kind: 'workstation', zone: 'focal', pref: [4, 3], facing: 'SE', seatOff: [1, -1] }]
    : combo === 'paired-dev-pod'
      ? [
          { role: 'ws1', assetId: 'desk_cluster', kind: 'workstation', zone: 'focal', pref: [2, 3], facing: 'SW', seatOff: [1, -1] },
          { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [8, 3], facing: 'SW', seatOff: [1, -1] },
        ]
      : combo === 'agile-scrum-bay'
        ? [
            { role: 'ws1', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [2, 3], facing: 'SW', seatOff: [1, -1] },
            { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [5, 3], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws1' },
            { role: 'ws3', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [8, 3], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws1' },
          ]
        : combo === 'atelier-split'
          ? [
              { role: 'ws1', assetId: 'desk_cluster', kind: 'workstation', zone: 'focal', pref: [2, 3], facing: 'SW', seatOff: [1, -1] },
              { role: 'lounge', assetId: 'sofa_lounge', kind: 'shared', zone: 'focal', pref: [7, 5], facing: 'SW', seatOff: null },
              { role: 'pair1', assetId: 'lamp_table', kind: 'shared', zone: 'focal', pref: [9, 5], facing: 'SW', seatOff: null, pairWith: 'lounge' },
            ]
          : [
              { role: 'ws1', assetId: 'exec_desk', kind: 'workstation', zone: 'focal', pref: [2, 3], facing: 'SW', seatOff: [1, -1] },
              { role: 'ws2', assetId: 'worker_desk', kind: 'workstation', zone: 'row', pref: [6, 3], facing: 'SW', seatOff: [1, -1], alignRowWith: 'ws1' },
              { role: 'lounge', assetId: 'armchair_green', kind: 'shared', zone: 'focal', pref: [7, 6], facing: 'SW', seatOff: null },
            ]
  return addExtras(brItems, pick(rng, [2, 8]), [8, 0], 5)
}
