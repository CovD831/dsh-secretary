/** V2.5 微缩沙盘 7 层等距渲染与跨走廊 BFS 寻路引擎。 */
import { HIGHLIGHT_GOLD, PROP_LABELS, STATUS_GLOW_COLORS } from './catalog.ts'
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import type { OfficeActor, OfficeSprites } from './iso-engine.ts'
import { TILE_H, TILE_W, type Facing, type GridPoint, type RoomEntity, type RoomWallMount } from './layout-solver.ts'
import { isChamferEdgeCell } from './procedural-rooms.ts'
import type { OfficeCamera, OfficeWorldPlan, WorldPickResult, WorldSceneState, WorldWingPlan } from './world-types.ts'

interface L2Item { id: string; kind: 'entity' | 'actor'; footScreenY: number; entity?: RoomEntity; actor?: OfficeActor }
interface Box { x: number; y: number; w: number; h: number }

export function worldIsoToScreen(u: number, v: number, world: OfficeWorldPlan, camera: OfficeCamera): { x: number; y: number } {
  const ox = world.baseOrigin.x + camera.panX, oy = world.baseOrigin.y + camera.panY
  return { x: ox + (u - v) * ((TILE_W * camera.zoom) / 2), y: oy + (u + v) * ((TILE_H * camera.zoom) / 2) }
}

export function screenToWorldIso(px: number, py: number, world: OfficeWorldPlan, camera: OfficeCamera): GridPoint {
  const ox = world.baseOrigin.x + camera.panX, oy = world.baseOrigin.y + camera.panY
  const dx = (px - ox) / ((TILE_W * camera.zoom) / 2), dy = (py - oy) / ((TILE_H * camera.zoom) / 2)
  return { u: Math.floor((dx + dy) / 2), v: Math.floor((dy - dx) / 2) }
}

const allSuites = (w: OfficeWorldPlan): RoomEntity[] => [...w.lobby.suites, ...w.wings.flatMap((x) => x.suites)]

function makeWorldChair(suite: RoomEntity): RoomEntity {
  if (suite.assetId === 'desk_cluster') {
    return { id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u: suite.anchor.u + 0.55, v: suite.anchor.v - 1.85 }, size: [1, 1], facing: 'SW', mirrorX: true, footprint: [] }
  }
  if (suite.assetId === 'collab_table') {
    return { id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u: suite.anchor.u + 1.1, v: suite.anchor.v - 0.15 }, size: [1, 1], facing: 'SW', mirrorX: true, footprint: [] }
  }
  const isRec = suite.suiteKind === 'reception', isExec = suite.assetId === 'exec_desk', faceSE = isRec || suite.facing === 'SE'
  const u = isRec ? suite.anchor.u - 0.7 : isExec ? suite.anchor.u + 0.95 : faceSE ? suite.anchor.u - 0.55 : suite.anchor.u + 0.45
  const v = isRec ? suite.anchor.v + 0.9 : isExec ? suite.anchor.v - 0.95 : faceSE ? suite.anchor.v + 0.45 : suite.anchor.v - 0.55
  const facing: Facing = faceSE ? 'SE' : 'SW'
  return { id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u, v }, size: [1, 1], facing, mirrorX: facing === 'SW', footprint: [] }
}

function isWallBlocked(world: OfficeWorldPlan, u1: number, v1: number, u2: number, v2: number): boolean {
  for (const d of world.interiorDoors ?? []) {
    if ((d.axis === 'u' && v1 === v2 && Math.max(u1, u2) === d.u && (v1 === d.v || v1 === d.v + 1))
      || (d.axis === 'v' && u1 === u2 && Math.max(v1, v2) === d.v && (u1 === d.u || u1 === d.u + 1))) return false
  }
  for (const s of world.wallSegments ?? []) {
    if ((v1 === v2 && s.from.u === s.to.u && s.from.u === Math.max(u1, u2) && v1 >= Math.min(s.from.v, s.to.v) && v1 < Math.max(s.from.v, s.to.v))
      || (u1 === u2 && s.from.v === s.to.v && s.from.v === Math.max(v1, v2) && u1 >= Math.min(s.from.u, s.to.u) && u1 < Math.max(s.from.u, s.to.u))) return true
  }
  return false
}

function buildWalkableSet(world: OfficeWorldPlan): Set<string> {
  const walkable = new Set<string>()
  for (const c of [...(world.corridorCells ?? []), ...(world.lobby.cells ?? []), ...world.wings.filter((w) => w.kind === 'studio').flatMap((w) => w.cells ?? [])]) walkable.add(`${c.u},${c.v}`)
  return walkable
}

function findWorldPath(world: OfficeWorldPlan, from: GridPoint, to: GridPoint): GridPoint[] {
  const walkable = buildWalkableSet(world), blocked = new Set<string>()
  for (const e of [...world.lobby.suites, ...world.lobby.shared, ...world.wings.flatMap((w) => [...w.suites, ...w.shared])]) for (const c of e.footprint) blocked.add(`${c.u},${c.v}`)
  const su = Math.round(from.u), sv = Math.round(from.v), tu = Math.round(to.u), tv = Math.round(to.v), startKey = `${su},${sv}`, goalKey = `${tu},${tv}`
  if (startKey === goalKey) return []
  const queue: GridPoint[] = [{ u: su, v: sv }], parent = new Map<string, GridPoint | null>([[startKey, null]])
  while (queue.length > 0) {
    const cur = queue.shift()!; if (`${cur.u},${cur.v}` === goalKey) break
    for (const [du, dv] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
      const nu = cur.u + du, nv = cur.v + dv, nk = `${nu},${nv}`
      if (parent.has(nk) || (!walkable.has(nk) && nk !== goalKey) || isWallBlocked(world, cur.u, cur.v, nu, nv) || (blocked.has(nk) && nk !== goalKey)) continue
      parent.set(nk, cur); queue.push({ u: nu, v: nv })
    }
  }
  if (!parent.has(goalKey)) return [{ u: tu, v: tv }]
  const out: GridPoint[] = []; let cur: GridPoint | null = { u: tu, v: tv }
  while (cur && `${cur.u},${cur.v}` !== startKey) { out.push(cur); cur = parent.get(`${cur.u},${cur.v}`) ?? null }
  return out.reverse()
}

export function createInitialWorldActors(world: OfficeWorldPlan): OfficeActor[] {
  const rec = world.lobby.suites.find((s) => s.id === 'lobby-reception')
  return [{ id: 'secretary', role: 'secretary', u: (rec?.anchor.u ?? 10) - 0.55, v: (rec?.anchor.v ?? 4) + 1.0, facing: 'SE', pose: 'sit', lifecycle: 'resident', assignedSuiteId: 'lobby-reception', path: [], animMs: 0 }]
}

export function spawnWorldWorker(world: OfficeWorldPlan, actorId: string, workspaceId: string, ticketId: string, suiteId: string): OfficeActor {
  const wing = world.wings.find((w) => w.workspaceId === workspaceId) ?? world.wings.find((w) => w.suites.some((s) => s.id === suiteId))
  const seat = wing?.suites.find((s) => s.id === suiteId)?.seatCell ?? wing?.doorway ?? world.mainEntrance
  return { id: actorId, role: 'worker', u: world.mainEntrance.u, v: world.mainEntrance.v, facing: 'NW', pose: 'idle', lifecycle: 'entering', ticketId, assignedSuiteId: suiteId, path: findWorldPath(world, world.mainEntrance, seat), animMs: 0 }
}

export function reSeatWorkerOnWorld(actor: OfficeActor, world: OfficeWorldPlan, roomId?: string): OfficeActor {
  if (actor.pose !== 'sit' || actor.lifecycle === 'leaving') return actor
  const wing = roomId ? world.wings.find((w) => w.workspaceId === roomId) : undefined
  const s = allSuites(world).find((x) => x.id === actor.assignedSuiteId) ?? wing?.suites.find((x) => x.suiteKind === 'workstation')
  if (!s) return actor
  const ch = makeWorldChair(s); return { ...actor, assignedSuiteId: s.id, u: ch.anchor.u + 0.1, v: ch.anchor.v + 0.1, facing: ch.facing }
}

export function stepWorldActors(actors: OfficeActor[], world: OfficeWorldPlan, dtMs: number): OfficeActor[] {
  const stepDist = (3.2 * dtMs) / 1000, entrance = world.mainEntrance, suites = allSuites(world)
  return actors.map((actor) => {
    if (actor.lifecycle === 'resident' || actor.lifecycle === 'removed') return { ...actor, animMs: actor.animMs + dtMs }
    const next: OfficeActor = { ...actor, animMs: actor.animMs + dtMs, path: [...actor.path] }
    if (next.lifecycle === 'leaving' && next.path.length === 0 && (Math.abs(next.u - entrance.u) > 0.05 || Math.abs(next.v - entrance.v) > 0.05)) {
      next.path = findWorldPath(world, { u: next.u, v: next.v }, entrance)
    }
    if (next.path.length > 0) {
      const target = next.path[0]!, du = target.u - next.u, dv = target.v - next.v, dist = Math.hypot(du, dv)
      if (du < -0.01 || dv > 0.01) next.facing = 'SW'; else if (du > 0.01 || dv < -0.01) next.facing = 'SE'
      if (dist <= stepDist) { next.u = target.u; next.v = target.v; next.path.shift() }
      else { next.u += (du / dist) * stepDist; next.v += (dv / dist) * stepDist }
      next.pose = Math.floor(next.animMs / 200) % 2 === 0 ? 'walkA' : 'walkB'
      return next
    }
    if (next.lifecycle === 'entering') {
      next.lifecycle = 'working'; next.pose = 'sit'
      const suite = suites.find((s) => s.id === next.assignedSuiteId)
      if (suite) { const ch = makeWorldChair(suite); next.u = ch.anchor.u + 0.1; next.v = ch.anchor.v + 0.1; next.facing = ch.facing }
    } else if (next.lifecycle === 'leaving') { next.lifecycle = 'removed'; next.pose = 'idle' }
    return next
  })
}

function getEntityBox(e: RoomEntity, world: OfficeWorldPlan, cam: OfficeCamera): Box {
  const m = WORLD_ASSET_CATALOG[e.assetId]!, p = worldIsoToScreen(e.anchor.u + e.size[0] / 2, e.anchor.v + e.size[1] / 2, world, cam)
  return { x: Math.round(p.x - m.anchor[0] * cam.zoom), y: Math.round(p.y - m.anchor[1] * cam.zoom), w: m.nativeSize[0] * cam.zoom, h: m.nativeSize[1] * cam.zoom }
}
function getActorBox(a: OfficeActor, world: OfficeWorldPlan, cam: OfficeCamera): Box {
  const p = worldIsoToScreen(a.u + 0.5, a.v + 0.5, world, cam)
  return { x: Math.round(p.x - 16 * cam.zoom), y: Math.round(p.y - 44 * cam.zoom), w: 32 * cam.zoom, h: 48 * cam.zoom }
}
function getMountBox(m: RoomWallMount, world: OfficeWorldPlan, cam: OfficeCamera, baseU = 0, baseV = 0): Box {
  const meta = WORLD_ASSET_CATALOG[m.assetId]!, pos = m.wall === 'back' ? worldIsoToScreen(m.at, baseV, world, cam) : worldIsoToScreen(baseU, m.at, world, cam)
  const w = meta.nativeSize[0] * cam.zoom, h = meta.nativeSize[1] * cam.zoom
  return { x: Math.round(pos.x - w / 2), y: Math.round(pos.y - h - m.h * cam.zoom), w, h }
}
const getDoorplateBox = (wing: WorldWingPlan, world: OfficeWorldPlan, cam: OfficeCamera): Box => {
  const wu = wing.rect.u === 0 ? 10 : wing.doorway.u, p = worldIsoToScreen(wu, wing.doorway.v - 0.5, world, cam)
  return { x: Math.round(p.x - 14 * cam.zoom), y: Math.round(p.y - 40 * cam.zoom), w: 28 * cam.zoom, h: 18 * cam.zoom }
}
const getWingSignBox = (wing: WorldWingPlan, world: OfficeWorldPlan, cam: OfficeCamera): Box => {
  const p = worldIsoToScreen(wing.rect.u + wing.rect.w / 2, wing.rect.v + Math.min(4.2, wing.rect.h / 2), world, cam), w = Math.max(72, wing.title.length * 10 + 14) * cam.zoom
  return { x: Math.round(p.x - w / 2), y: Math.round(p.y - 16 * cam.zoom), w, h: 16 * cam.zoom }
}

function build2DTileMap(world: OfficeWorldPlan): Map<string, 'corridor_tile' | 'floor_wood' | 'stone_tile'> {
  const map = new Map<string, 'corridor_tile' | 'floor_wood' | 'stone_tile'>()
  for (const c of [...(world.corridorCells ?? []), ...(world.lobby.cells ?? [])]) map.set(`${c.u},${c.v}`, 'corridor_tile')
  for (const w of world.wings) {
    const k = w.floorStyle === 'warm_parquet' ? 'corridor_tile' : w.kind === 'studio' ? 'floor_wood' : 'stone_tile'
    for (const c of w.cells ?? []) map.set(`${c.u},${c.v}`, k)
  }
  return map
}

function computeL2List(world: OfficeWorldPlan, actors: readonly OfficeActor[], cam: OfficeCamera): L2Item[] {
  const items: L2Item[] = [], suites = allSuites(world)
  for (const entity of [...suites, ...world.lobby.shared, ...world.wings.flatMap((w) => w.shared), ...world.exteriorProps]) {
    const deskY = Math.round(worldIsoToScreen(entity.anchor.u + entity.size[0], entity.anchor.v + entity.size[1], world, cam).y)
    items.push({ id: entity.id, kind: 'entity', footScreenY: deskY, entity })
    if (entity.suiteKind !== 'shared' && entity.assetId !== 'collab_table') items.push({ id: `chair-${entity.id}`, kind: 'entity', footScreenY: deskY - 6, entity: makeWorldChair(entity) })
  }
  for (const actor of actors) if (actor.lifecycle !== 'removed') {
    const suite = actor.pose === 'sit' && actor.assignedSuiteId ? suites.find((s) => s.id === actor.assignedSuiteId) : undefined
    const footY = suite ? Math.round(worldIsoToScreen(suite.anchor.u + suite.size[0], suite.anchor.v + suite.size[1], world, cam).y) - 3 : Math.round(worldIsoToScreen(actor.u + 0.5, actor.v + 0.5, world, cam).y) + 1
    items.push({ id: actor.id, kind: 'actor', footScreenY: footY, actor })
  }
  return items.sort((a, b) => a.footScreenY - b.footScreenY || a.id.localeCompare(b.id))
}

function renderL0ToL3(ctx: CanvasRenderingContext2D, state: WorldSceneState, sprites: OfficeSprites, cam: OfficeCamera, l2: L2Item[]): void {
  const { world } = state, z = cam.zoom, cw = ctx.canvas?.width || 1440, ch = ctx.canvas?.height || 900
  ctx.fillStyle = '#201A18'; ctx.fillRect(0, 0, cw, ch)
  ctx.fillStyle = '#302722'; ctx.fillRect(Math.round(cw * 0.08), Math.round(ch * 0.08), Math.round(cw * 0.84), Math.round(ch * 0.84))
  const tileMap = build2DTileMap(world), studioCells = new Set<string>()
  for (const w of world.wings) if (w.kind === 'studio') for (const c of w.cells ?? []) studioCells.add(`${c.u},${c.v}`)
  const nearBld = (u: number, v: number) => (u >= 10 && u <= 16 && v >= world.buildingRows && v <= world.buildingRows + 2)
    || [-1, 0, 1].some((dv) => [-1, 0, 1].some((du) => tileMap.has(`${u + du},${v + dv}`)))
  for (let v = -1; v <= world.buildingRows + 2; v++) for (let u = -1; u <= world.buildingCols + 1; u++) {
    const kind = tileMap.get(`${u},${v}`) ?? (nearBld(u, v) ? 'stone_tile' : null), img = kind ? sprites.images[kind] : undefined; if (!img) continue
    const p = worldIsoToScreen(u + 0.5, v + 0.5, world, cam), sx = Math.round(p.x - 16 * z), sy = Math.round(p.y - 8 * z)
    if (kind !== 'stone_tile' && studioCells.has(`${u},${v}`) && isChamferEdgeCell(u, v, studioCells)) {
      if (sprites.images.stone_tile) ctx.drawImage(sprites.images.stone_tile, sx, sy, 32 * z, 16 * z)
      ctx.drawImage(img, 0, 0, 32, 8, sx, sy, 32 * z, 8 * z)
    } else ctx.drawImage(img, sx, sy, 32 * z, 16 * z)
  }
  const runnerImg = sprites.images.runner_navy ?? sprites.images.corridor_runner
  if (runnerImg) for (let v = 14; v < world.buildingRows - 1; v += 2) { const p = worldIsoToScreen(13.5, v + 1, world, cam); ctx.drawImage(runnerImg, Math.round(p.x - 32 * z), Math.round(p.y - 16 * z), 64 * z, 32 * z) }
  if (sprites.images.welcome_mat) { const mp = worldIsoToScreen(13.5, world.buildingRows + 1, world, cam); ctx.drawImage(sprites.images.welcome_mat, Math.round(mp.x - 32 * z), Math.round(mp.y - 16 * z), 64 * z, 32 * z) }
  for (const w of world.wings) if (w.kind === 'studio' && w.rugRect) {
    const rugImg = sprites.images[`rug_${w.rugStyle ?? 'woven'}`] ?? sprites.images.rug_woven
    if (rugImg) { const rw = Math.round(((w.rugRect.w + w.rugRect.h) / 2) * 32 * z), rh = Math.round(rw / 2), p = worldIsoToScreen(w.rugRect.u + w.rugRect.w / 2, w.rugRect.v + w.rugRect.h / 2, world, cam); ctx.drawImage(rugImg, Math.round(p.x - rw / 2), Math.round(p.y - rh / 2), rw, rh) }
  }
  ctx.fillStyle = 'rgba(26, 20, 18, 0.30)'
  for (const it of l2) { const b = it.entity ? getEntityBox(it.entity, world, cam) : it.actor ? getActorBox(it.actor, world, cam) : null; if (b) ctx.fillRect(Math.round(b.x + 2 * z), Math.round(b.y + b.h - 4 * z), Math.round(b.w * 0.85), Math.max(3, 5 * z)) }
  const sortedWalls = [...(world.wallSegments ?? [])].sort((a, b) => (a.from.u + a.from.v + a.to.u + a.to.v) - (b.from.u + b.from.v + b.to.u + b.to.v))
  for (const seg of sortedWalls) {
    const p1 = worldIsoToScreen(seg.from.u, seg.from.v, world, cam), p2 = worldIsoToScreen(seg.to.u, seg.to.v, world, cam), steps = Math.max(1, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y) / (2 * z))), isCut = seg.tier === 'cutaway' || seg.tier === 'portal', baseH = (isCut ? 8 : 12) * z
    for (let i = 0; i <= steps; i++) { const t = i / steps, h = (seg.startH + (seg.endH - seg.startH) * t) * z; ctx.fillStyle = '#1A1412'; ctx.fillRect(Math.round(p1.x + (p2.x - p1.x) * t - 3 * z), Math.round(p1.y + (p2.y - p1.y) * t - h - z), 5 * z, h + 2 * z) }
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, h = (seg.startH + (seg.endH - seg.startH) * t) * z, wx = Math.round(p1.x + (p2.x - p1.x) * t - 2 * z), wy = Math.round(p1.y + (p2.y - p1.y) * t - h)
      ctx.fillStyle = '#4A3428'; ctx.fillRect(wx, wy, 4 * z, 4 * z); ctx.fillStyle = isCut ? '#7A6150' : seg.shade === 'shaded' ? '#BFA48C' : '#D9C4A8'
      ctx.fillRect(wx, wy + 4 * z, 4 * z, Math.max(1, h - 4 * z - baseH)); ctx.fillStyle = isCut ? '#3A2E28' : '#6B4A32'; ctx.fillRect(wx, wy + h - baseH, 4 * z, baseH)
    }
  }
  for (const seg of sortedWalls) if (seg.hasWindow && sprites.images.facade_window) { const wu = (seg.from.u + seg.to.u) / 2, wp = worldIsoToScreen(wu, seg.from.v, world, cam); ctx.drawImage(sprites.images.facade_window, Math.round(wp.x - 21 * z), Math.round(wp.y - 31 * z), 42 * z, 26 * z) }
  for (const d of world.interiorDoors ?? []) if (sprites.images.door_wood) { const dp = worldIsoToScreen(d.axis === 'u' ? d.u : d.u + 1, d.axis === 'u' ? d.v + 1 : d.v, world, cam); ctx.drawImage(sprites.images.door_wood, Math.round(dp.x - 16 * z), Math.round(dp.y - 47 * z), 31 * z, 50 * z) }
  if (sprites.images.door_glass) { const dp = worldIsoToScreen(13.5, world.buildingRows, world, cam); ctx.drawImage(sprites.images.door_glass, Math.round(dp.x - 26 * z), Math.round(dp.y - 32 * z), 52 * z, 34 * z) }
  const drawMount = (m: RoomWallMount, bu: number, bv: number) => {
    const img = sprites.images[m.assetId]; if (!img) return; const b = getMountBox(m, world, cam, bu, bv)
    if (m.wall === 'back') { ctx.save(); ctx.translate(b.x + b.w, b.y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, b.w, b.h); ctx.restore() } else ctx.drawImage(img, b.x, b.y, b.w, b.h)
  }
  for (const m of world.lobby.wallMounts) drawMount(m, world.lobby.rect.u, world.lobby.rect.v)
  for (const w of world.wings) {
    for (const m of w.wallMounts.filter((wm) => wm.propKind !== 'doorplate')) drawMount(m, w.rect.u, w.rect.v)
    if (w.kind === 'studio' && w.workspaceId && sprites.images.doorplate) { const db = getDoorplateBox(w, world, cam); ctx.drawImage(sprites.images.doorplate, db.x, db.y, db.w, db.h) }
  }
}

function renderL5LightingAndUi(ctx: CanvasRenderingContext2D, state: WorldSceneState, cam: OfficeCamera): void {
  const { world, actors, screenStates, gateIntercept, hoverTarget, elapsedMs } = state, z = cam.zoom
  for (const ls of world.lightSources ?? []) { const p = worldIsoToScreen(ls.u, ls.v, world, cam), r = Math.round(ls.radiusTiles * 14 * z); ctx.fillStyle = ls.kind === 'window' ? 'rgba(232, 220, 203, 0.16)' : 'rgba(242, 169, 59, 0.18)'; ctx.fillRect(Math.round(p.x - r), Math.round(p.y - r * 0.6), r * 2, Math.round(r * 1.2)) }
  for (const w of world.wings) { const sb = getWingSignBox(w, world, cam); ctx.fillStyle = '#201A18'; ctx.fillRect(sb.x, sb.y, sb.w, sb.h); ctx.fillStyle = '#E8DCCB'; ctx.font = `${10 * z}px monospace`; ctx.fillText(w.title, sb.x + 6 * z, sb.y + 12 * z); ctx.strokeStyle = w.workspaceId && w.workspaceId === state.activeWorkspaceId ? HIGHLIGHT_GOLD : '#6B4A32'; ctx.lineWidth = z; ctx.strokeRect(sb.x, sb.y, sb.w, sb.h) }
  for (const suite of allSuites(world)) {
    const meta = WORLD_ASSET_CATALOG[suite.assetId], st = screenStates[suite.id]; if (!meta?.screenGlowAnchors || !st || st === 'off') continue
    const b = getEntityBox(suite, world, cam), { bright, dark } = STATUS_GLOW_COLORS[st], blinkOn = st === 'stuck' ? Math.floor(elapsedMs / 600) % 2 === 0 : st === 'needsDecision' ? Math.floor(elapsedMs / 300) % 2 === 0 : true
    for (const a of meta.screenGlowAnchors) { const gx = b.x + b.w / 2 + (suite.mirrorX ? -a.dx : a.dx) * z, gy = b.y + b.h + a.dy * z; ctx.fillStyle = dark; ctx.fillRect(Math.round(gx - 6 * z), Math.round(gy - 4 * z), 12 * z, 8 * z); if (blinkOn) { ctx.fillStyle = bright; ctx.fillRect(Math.round(gx - 4 * z), Math.round(gy - 2 * z), 8 * z, 3 * z) } }
  }
  if (gateIntercept) { const t = actors.find((a) => a.id === gateIntercept.targetActorId); if (t) { const b = getActorBox(t, world, cam); ctx.fillStyle = STATUS_GLOW_COLORS.needsDecision.bright; ctx.fillRect(b.x + 6 * z, b.y - 14 * z, 20 * z, 12 * z); ctx.fillRect(b.x, b.y + b.h - 4 * z, b.w, 3 * z) } }
  if (state.secretaryThinking) {
    const sec = actors.find((a) => a.id === 'secretary')
    if (sec) {
      const b = getActorBox(sec, world, cam), bx = b.x + 6 * z, by = b.y - 14 * z - (Math.floor(elapsedMs / 350) % 2) * z
      ctx.fillStyle = '#1A1412'; ctx.fillRect(bx - z, by - z, 22 * z, 13 * z); ctx.fillStyle = '#E8DCCB'; ctx.fillRect(bx, by, 20 * z, 11 * z); ctx.fillRect(bx + 8 * z, by + 11 * z, 3 * z, 2 * z)
      for (let d = 0; d < 3; d++) { ctx.fillStyle = d === Math.floor(elapsedMs / 280) % 3 ? STATUS_GLOW_COLORS.working.bright : '#4A3428'; ctx.fillRect(bx + (4 + d * 5) * z, by + 4 * z, 2 * z, 3 * z) }
    }
  }
  if (hoverTarget) { ctx.strokeStyle = HIGHLIGHT_GOLD; ctx.lineWidth = z; ctx.strokeRect(hoverTarget.bounds.x, hoverTarget.bounds.y, hoverTarget.bounds.w, hoverTarget.bounds.h) }
}

export function renderWorldFrame(ctx: CanvasRenderingContext2D, state: WorldSceneState, sprites: OfficeSprites, camera: OfficeCamera): void {
  ctx.imageSmoothingEnabled = false; const l2 = computeL2List(state.world, state.actors, camera)
  renderL0ToL3(ctx, state, sprites, camera, l2)
  for (const item of l2) {
    if (item.kind === 'entity' && item.entity) {
      const img = sprites.images[item.entity.assetId]; if (!img) continue; const b = getEntityBox(item.entity, state.world, camera)
      if (item.entity.mirrorX) { ctx.save(); ctx.translate(b.x + b.w, b.y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, b.w, b.h); ctx.restore() } else ctx.drawImage(img, b.x, b.y, b.w, b.h)
    } else if (item.kind === 'actor' && item.actor) {
      const img = sprites.images[`char_${item.actor.role}`]; if (!img) continue
      const sitBob = item.actor.pose === 'sit' && Math.floor(state.elapsedMs / 500) % 2 === 1 ? 1 : 0, col = item.actor.pose === 'idle' ? 0 : item.actor.pose === 'walkA' ? 1 : item.actor.pose === 'walkB' ? 2 : 3
      const b = getActorBox(item.actor, state.world, camera); ctx.drawImage(img, col * 32, item.actor.facing === 'SW' || item.actor.facing === 'NW' ? 48 : 0, 32, 48, b.x, b.y + sitBob, b.w, b.h)
    }
  }
  renderL5LightingAndUi(ctx, state, camera)
}

const hitBox = (px: number, py: number, b: Box) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h

export function pickWorldTarget(px: number, py: number, state: WorldSceneState, camera: OfficeCamera): WorldPickResult | null {
  const { world } = state, z = camera.zoom, l2 = computeL2List(world, state.actors, camera)
  const wingOf = (sid?: string) => world.wings.find((w) => w.suites.some((s) => s.id === sid))?.workspaceId
  for (let i = l2.length - 1; i >= 0; i--) {
    const it = l2[i]!; if (it.kind !== 'actor' || !it.actor) continue
    const fullB = getActorBox(it.actor, world, camera), b = it.actor.pose === 'sit' && it.actor.assignedSuiteId === 'lobby-reception' ? { ...fullB, h: 30 * z } : fullB
    if (hitBox(px, py, b)) return { type: 'actor', actorId: it.actor.id, role: it.actor.role, workspaceId: wingOf(it.actor.assignedSuiteId), ticketId: it.actor.ticketId, bounds: b }
  }
  for (let i = l2.length - 1; i >= 0; i--) {
    const it = l2[i]!; if (it.kind !== 'entity' || !it.entity) continue; const b = getEntityBox(it.entity, world, camera)
    if (it.entity.assetId === 'reception_desk') {
      const hy = b.y + Math.round(b.h * 0.36), hh = Math.round(b.h * 0.56), hw = Math.round(b.w * 0.45)
      const lb = { x: b.x + 6, y: hy, w: hw, h: hh }, nb = { x: b.x + b.w - hw - 6, y: hy, w: hw, h: hh }
      if (hitBox(px, py, lb)) return { type: 'prop', prop: 'ledger', label: PROP_LABELS.ledger.zh, bounds: lb }
      if (hitBox(px, py, nb)) return { type: 'prop', prop: 'notebook', label: PROP_LABELS.notebook.zh, bounds: nb }
    } else if (it.entity.propKind && hitBox(px, py, b)) return { type: 'prop', prop: it.entity.propKind, label: PROP_LABELS[it.entity.propKind].zh, workspaceId: wingOf(it.entity.id), bounds: b }
  }
  for (const m of world.lobby.wallMounts) if (m.propKind) { const b = getMountBox(m, world, camera, world.lobby.rect.u, world.lobby.rect.v); if (hitBox(px, py, b)) return { type: 'prop', prop: m.propKind, label: PROP_LABELS[m.propKind].zh, bounds: b } }
  for (const w of world.wings) {
    if (w.kind === 'studio' && w.workspaceId) { const db = getDoorplateBox(w, world, camOr(camera)); if (hitBox(px, py, db)) return { type: 'prop', prop: 'doorplate', label: PROP_LABELS.doorplate.zh, workspaceId: w.workspaceId, bounds: db } }
    const sb = getWingSignBox(w, world, camera); if (hitBox(px, py, sb)) return { type: 'wing', wingId: w.id, workspaceId: w.workspaceId, kind: w.kind, label: w.title, bounds: sb }
  }
  return null
}
const camOr = (c: OfficeCamera) => c
