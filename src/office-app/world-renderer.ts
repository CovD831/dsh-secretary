/** V2 微缩沙盘 7 层等距渲染与跨走廊寻路引擎。 */
import { HIGHLIGHT_GOLD, PROP_LABELS, STATUS_GLOW_COLORS } from './catalog.ts'
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import type { OfficeActor, OfficeSprites } from './iso-engine.ts'
import { TILE_H, TILE_W, type Facing, type GridPoint, type RoomEntity, type RoomWallMount } from './layout-solver.ts'
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
  const isRec = suite.suiteKind === 'reception', isExec = suite.suiteKind === 'executive', faceSE = isRec || suite.facing === 'SE'
  const u = isRec ? suite.anchor.u - 0.7 : isExec ? suite.anchor.u + 0.95 : faceSE ? suite.anchor.u - 0.7 : suite.anchor.u + 0.55
  const v = isRec ? suite.anchor.v + 0.9 : isExec ? suite.anchor.v - 0.95 : faceSE ? suite.anchor.v + 0.55 : suite.anchor.v - 0.7
  const facing: Facing = faceSE ? 'SE' : 'SW'
  return { id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u, v }, size: [1, 1], facing, mirrorX: facing === 'SW', footprint: [] }
}

function isWallBlocked(world: OfficeWorldPlan, u1: number, v1: number, u2: number, v2: number): boolean {
  for (const w of world.partitionWalls) {
    if (w.axis === 'u' && v1 === v2 && v1 >= w.start && v1 < w.end && ((u1 === w.fixed - 1 && u2 === w.fixed) || (u2 === w.fixed - 1 && u1 === w.fixed))) return true
    if (w.axis === 'v' && u1 === u2 && u1 >= w.start && u1 < w.end && ((v1 === w.fixed - 1 && v2 === w.fixed) || (v2 === w.fixed - 1 && v1 === w.fixed))) return true
  }
  return false
}

function findWorldPath(world: OfficeWorldPlan, from: GridPoint, to: GridPoint): GridPoint[] {
  const blocked = new Set<string>()
  for (const e of [...world.lobby.suites, ...world.lobby.shared, ...world.wings.flatMap((w) => [...w.suites, ...w.shared])]) {
    for (const c of e.footprint) blocked.add(`${c.u},${c.v}`)
  }
  const su = Math.round(from.u), sv = Math.round(from.v), tu = Math.round(to.u), tv = Math.round(to.v)
  const startKey = `${su},${sv}`, goalKey = `${tu},${tv}`
  if (startKey === goalKey) return []
  const queue: GridPoint[] = [{ u: su, v: sv }], parent = new Map<string, GridPoint | null>([[startKey, null]])
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (`${cur.u},${cur.v}` === goalKey) break
    for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nu = cur.u + du, nv = cur.v + dv, nk = `${nu},${nv}`
      if (nu < 0 || nv < 0 || nu >= world.buildingCols || nv >= world.buildingRows || parent.has(nk)) continue
      if (isWallBlocked(world, cur.u, cur.v, nu, nv) || (blocked.has(nk) && nk !== goalKey)) continue
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
  const actors: OfficeActor[] = [{ id: 'secretary', role: 'secretary', u: (rec?.anchor.u ?? 10) - 0.55, v: (rec?.anchor.v ?? 4) + 1.0, facing: 'SE', pose: 'sit', lifecycle: 'resident', assignedSuiteId: 'lobby-reception', path: [], animMs: 0 }]
  for (const wing of world.wings) {
    if (wing.kind !== 'studio' || !wing.workspaceId) continue
    const exec = wing.suites.find((s) => s.suiteKind === 'executive')
    if (exec) actors.push({ id: `lead-${wing.workspaceId}`, role: 'lead', u: exec.anchor.u + 0.9, v: exec.anchor.v - 0.85, facing: 'SW', pose: 'sit', lifecycle: 'resident', assignedSuiteId: exec.id, path: [], animMs: 0 })
  }
  return actors
}

export function spawnWorldWorker(world: OfficeWorldPlan, actorId: string, workspaceId: string, ticketId: string, suiteId: string): OfficeActor {
  const wing = world.wings.find((w) => w.workspaceId === workspaceId) ?? world.wings.find((w) => w.suites.some((s) => s.id === suiteId))
  const seat = wing?.suites.find((s) => s.id === suiteId)?.seatCell ?? wing?.doorway ?? world.mainEntrance
  return { id: actorId, role: 'worker', u: world.mainEntrance.u, v: world.mainEntrance.v, facing: 'NW', pose: 'idle', lifecycle: 'entering', ticketId, assignedSuiteId: suiteId, path: findWorldPath(world, world.mainEntrance, seat), animMs: 0 }
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
  const meta = WORLD_ASSET_CATALOG[e.assetId]!, pos = worldIsoToScreen(e.anchor.u + e.size[0] / 2, e.anchor.v + e.size[1] / 2, world, cam)
  return { x: Math.round(pos.x - meta.anchor[0] * cam.zoom), y: Math.round(pos.y - meta.anchor[1] * cam.zoom), w: meta.nativeSize[0] * cam.zoom, h: meta.nativeSize[1] * cam.zoom }
}
function getActorBox(a: OfficeActor, world: OfficeWorldPlan, cam: OfficeCamera): Box {
  const pos = worldIsoToScreen(a.u + 0.5, a.v + 0.5, world, cam)
  return { x: Math.round(pos.x - 16 * cam.zoom), y: Math.round(pos.y - 44 * cam.zoom), w: 32 * cam.zoom, h: 48 * cam.zoom }
}
function getMountBox(m: RoomWallMount, world: OfficeWorldPlan, cam: OfficeCamera, baseU = 0, baseV = 0): Box {
  const meta = WORLD_ASSET_CATALOG[m.assetId]!, pos = m.wall === 'back' ? worldIsoToScreen(m.at, baseV, world, cam) : worldIsoToScreen(baseU, m.at, world, cam)
  const w = meta.nativeSize[0] * cam.zoom, h = meta.nativeSize[1] * cam.zoom
  return { x: Math.round(pos.x - w / 2), y: Math.round(pos.y - h - m.h * cam.zoom), w, h }
}
function getDoorplateBox(wing: WorldWingPlan, world: OfficeWorldPlan, cam: OfficeCamera): Box {
  const pos = worldIsoToScreen(wing.rect.u === 0 ? wing.doorway.u + 0.8 : wing.doorway.u + 0.2, wing.doorway.v - 0.8, world, cam)
  return { x: Math.round(pos.x - 12 * cam.zoom), y: Math.round(pos.y - 34 * cam.zoom), w: 24 * cam.zoom, h: 16 * cam.zoom }
}
function getWingSignBox(wing: WorldWingPlan, world: OfficeWorldPlan, cam: OfficeCamera): Box {
  const pos = worldIsoToScreen(wing.rect.u + wing.rect.w / 2, wing.rect.v + Math.min(4.2, wing.rect.h / 2), world, cam)
  const w = Math.max(72, wing.title.length * 10 + 14) * cam.zoom
  return { x: Math.round(pos.x - w / 2), y: Math.round(pos.y - 16 * cam.zoom), w, h: 16 * cam.zoom }
}
function tileKindAt(u: number, v: number, world: OfficeWorldPlan): 'corridor_tile' | 'floor_wood' | 'stone_tile' | null {
  const c = world.corridorRect
  if (u >= c.u && u < c.u + c.w && v >= c.v && v < c.v + c.h) return 'corridor_tile'
  for (const w of world.wings) if (u >= w.rect.u && u < w.rect.u + w.rect.w && v >= w.rect.v && v < w.rect.v + w.rect.h) {
    if (w.chamferSE && (u - w.rect.u) + (v - w.rect.v) >= w.rect.w + w.rect.h - 1 - w.chamferSE) continue
    return w.kind === 'studio' ? 'floor_wood' : 'stone_tile'
  }
  const inApron = u >= -1 && u <= world.buildingCols && v >= -1 && v <= world.buildingRows + 1
  return inApron || (u >= 9 && u <= 12 && v >= world.buildingRows && v <= world.buildingRows + 2) ? 'stone_tile' : null
}
function computeL2List(world: OfficeWorldPlan, actors: readonly OfficeActor[], cam: OfficeCamera): L2Item[] {
  const items: L2Item[] = [], suites = allSuites(world)
  for (const entity of [...suites, ...world.lobby.shared, ...world.wings.flatMap((w) => w.shared), ...world.exteriorProps]) {
    const deskY = Math.round(worldIsoToScreen(entity.anchor.u + entity.size[0], entity.anchor.v + entity.size[1], world, cam).y)
    items.push({ id: entity.id, kind: 'entity', footScreenY: deskY, entity })
    if (entity.suiteKind !== 'shared') items.push({ id: `chair-${entity.id}`, kind: 'entity', footScreenY: deskY - 6, entity: makeWorldChair(entity) })
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
  ctx.fillStyle = '#2B221E'; ctx.fillRect(Math.round(cw * 0.08), Math.round(ch * 0.08), Math.round(cw * 0.84), Math.round(ch * 0.84))
  for (let v = -1; v <= world.buildingRows + 2; v++) for (let u = -1; u <= world.buildingCols; u++) {
    const kind = tileKindAt(u, v, world), img = kind ? sprites.images[kind] : undefined; if (!img) continue
    const p = worldIsoToScreen(u + 0.5, v + 0.5, world, cam); ctx.drawImage(img, Math.round(p.x - 16 * z), Math.round(p.y - 8 * z), 32 * z, 16 * z)
  }
  const runnerImg = sprites.images.runner_navy ?? sprites.images.corridor_runner
  if (runnerImg) for (let v = 2; v < world.buildingRows - 1; v += 2) { const p = worldIsoToScreen(11, v + 1, world, cam); ctx.drawImage(runnerImg, Math.round(p.x - 32 * z), Math.round(p.y - 16 * z), 64 * z, 32 * z) }
  if (sprites.images.welcome_mat) { const mp = worldIsoToScreen(11, world.buildingRows + 1, world, cam); ctx.drawImage(sprites.images.welcome_mat, Math.round(mp.x - 32 * z), Math.round(mp.y - 16 * z), 64 * z, 32 * z) }
  for (const w of world.wings) if (w.kind === 'studio' && w.rugRect) {
    const rugImg = sprites.images[`rug_${w.rugStyle ?? 'woven'}`] ?? sprites.images.rug_woven
    if (rugImg) { const p = worldIsoToScreen(w.rugRect.u + w.rugRect.w / 2, w.rugRect.v + w.rugRect.h / 2, world, cam); ctx.drawImage(rugImg, Math.round(p.x - 64 * z), Math.round(p.y - 32 * z), 128 * z, 64 * z) }
  }
  ctx.fillStyle = 'rgba(20, 14, 12, 0.30)'
  for (const it of l2) {
    const b = it.entity ? getEntityBox(it.entity, world, cam) : it.actor ? getActorBox(it.actor, world, cam) : null
    if (b) ctx.fillRect(Math.round(b.x + 2 * z), Math.round(b.y + b.h - 4 * z), Math.round(b.w * 0.85), Math.max(3, 5 * z))
  }
  const wallImg = sprites.images.wall_segment
  if (wallImg) {
    for (let u = 0; u < world.buildingCols; u += 2) { const p = worldIsoToScreen(u + 1, 0, world, cam); ctx.save(); ctx.translate(Math.round(p.x + 16 * z), Math.round(p.y - 72 * z)); ctx.scale(-1, 1); ctx.drawImage(wallImg, 0, 0, 32 * z, 80 * z); ctx.restore() }
    for (let v = 0; v < 15; v += 2) { const p = worldIsoToScreen(0, v + 1, world, cam); ctx.drawImage(wallImg, Math.round(p.x - 16 * z), Math.round(p.y - 72 * z), 32 * z, 80 * z) }
  }
  for (const pw of world.partitionWalls) {
    const p1 = pw.axis === 'u' ? worldIsoToScreen(pw.fixed, pw.start, world, cam) : worldIsoToScreen(pw.start, pw.fixed, world, cam)
    const p2 = pw.axis === 'u' ? worldIsoToScreen(pw.fixed, pw.end, world, cam) : worldIsoToScreen(pw.end, pw.fixed, world, cam)
    const steps = Math.max(1, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y) / (2 * z)))
    for (let i = 0; i <= steps; i++) {
      const wx = Math.round(p1.x + (p2.x - p1.x) * (i / steps) - 2 * z), wy = Math.round(p1.y + (p2.y - p1.y) * (i / steps) - 20 * z)
      ctx.fillStyle = '#1A1412'; ctx.fillRect(wx - z, wy - z, 5 * z, 21 * z)
      ctx.fillStyle = '#6B4A32'; ctx.fillRect(wx, wy, 3 * z, 4 * z)
      ctx.fillStyle = pw.axis === 'u' ? '#BFA48C' : '#D9C4A8'; ctx.fillRect(wx, wy + 4 * z, 3 * z, 10 * z)
      ctx.fillStyle = '#4A3428'; ctx.fillRect(wx, wy + 14 * z, 3 * z, 5 * z)
    }
  }
  for (const d of world.interiorDoors ?? []) if (sprites.images.door_wood) {
    const dp = worldIsoToScreen(d.u, d.v + 1, world, cam); ctx.drawImage(sprites.images.door_wood, Math.round(dp.x - 20 * z), Math.round(dp.y - 58 * z), 40 * z, 64 * z)
  }
  for (const f of world.frontFacade ?? []) {
    const p1 = worldIsoToScreen(f.from.u, f.from.v, world, cam), p2 = worldIsoToScreen(f.to.u, f.to.v, world, cam)
    const steps = Math.max(1, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y) / (2 * z))), fh = f.heightPx * z
    for (let i = 0; i <= steps; i++) {
      const fx = Math.round(p1.x + (p2.x - p1.x) * (i / steps) - z), fy = Math.round(p1.y + (p2.y - p1.y) * (i / steps) - fh)
      ctx.fillStyle = '#1A1412'; ctx.fillRect(fx - z, fy - z, 4 * z, fh + 2 * z); ctx.fillStyle = '#4A3428'; ctx.fillRect(fx, fy, 3 * z, 4 * z); ctx.fillStyle = '#8C6D56'; ctx.fillRect(fx, fy + 4 * z, 3 * z, fh - 4 * z)
    }
    if (f.hasWindow && sprites.images.facade_window) { const wp = worldIsoToScreen((f.from.u + f.to.u) / 2, (f.from.v + f.to.v) / 2, world, cam); ctx.drawImage(sprites.images.facade_window, Math.round(wp.x - 32 * z), Math.round(wp.y - 36 * z), 64 * z, 40 * z) }
  }
  if (sprites.images.door_glass) { const dp = worldIsoToScreen(11, world.buildingRows, world, cam); ctx.drawImage(sprites.images.door_glass, Math.round(dp.x - 40 * z), Math.round(dp.y - 52 * z), 80 * z, 56 * z) }
  for (const m of world.lobby.wallMounts) { const img = sprites.images[m.assetId]; if (img) { const b = getMountBox(m, world, cam, 0, 0); ctx.drawImage(img, b.x, b.y, b.w, b.h) } }
  for (const w of world.wings) {
    for (const m of w.wallMounts.filter((wm) => wm.propKind !== 'doorplate')) { const img = sprites.images[m.assetId]; if (img) { const b = getMountBox(m, world, cam, w.rect.u, w.rect.v); ctx.drawImage(img, b.x, b.y, b.w, b.h) } }
    if (w.kind === 'studio' && w.workspaceId && sprites.images.doorplate) { const db = getDoorplateBox(w, world, cam); ctx.drawImage(sprites.images.doorplate, db.x, db.y, db.w, db.h) }
  }
}

function renderL5LightingAndUi(ctx: CanvasRenderingContext2D, state: WorldSceneState, cam: OfficeCamera): void {
  const { world, actors, screenStates, gateIntercept, hoverTarget, elapsedMs } = state, z = cam.zoom
  for (const ls of world.lightSources ?? []) {
    const p = worldIsoToScreen(ls.u, ls.v, world, cam), r = Math.round(ls.radiusTiles * 14 * z)
    ctx.fillStyle = ls.kind === 'window' ? 'rgba(255, 232, 178, 0.16)' : 'rgba(242, 169, 59, 0.18)'
    ctx.fillRect(Math.round(p.x - r), Math.round(p.y - r * 0.6), r * 2, Math.round(r * 1.2))
  }
  for (const w of world.wings) {
    const sb = getWingSignBox(w, world, cam)
    ctx.fillStyle = '#201A18'; ctx.fillRect(sb.x, sb.y, sb.w, sb.h)
    ctx.strokeStyle = w.workspaceId && w.workspaceId === state.activeWorkspaceId ? HIGHLIGHT_GOLD : '#6B4A32'; ctx.lineWidth = z; ctx.strokeRect(sb.x, sb.y, sb.w, sb.h)
    ctx.fillStyle = '#E8DCCB'; ctx.font = `${10 * z}px monospace`; ctx.fillText(w.title, sb.x + 6 * z, sb.y + 12 * z)
  }
  for (const suite of allSuites(world)) {
    const meta = WORLD_ASSET_CATALOG[suite.assetId], st = screenStates[suite.id]
    if (!meta?.screenGlowAnchors || !st || st === 'off') continue
    const b = getEntityBox(suite, world, cam), { bright, dark } = STATUS_GLOW_COLORS[st]
    const blinkOn = st === 'stuck' ? Math.floor(elapsedMs / 600) % 2 === 0 : st === 'needsDecision' ? Math.floor(elapsedMs / 300) % 2 === 0 : true
    for (const a of meta.screenGlowAnchors) {
      const gx = b.x + b.w / 2 + (suite.mirrorX ? -a.dx : a.dx) * z, gy = b.y + b.h + a.dy * z
      ctx.fillStyle = dark; ctx.fillRect(Math.round(gx - 6 * z), Math.round(gy - 4 * z), 12 * z, 8 * z)
      if (!blinkOn) continue
      ctx.fillStyle = bright; ctx.fillRect(Math.round(gx - 4 * z), Math.round(gy - 2 * z), 8 * z, 3 * z)
    }
  }
  if (gateIntercept) {
    const t = actors.find((a) => a.id === gateIntercept.targetActorId)
    if (t) { const b = getActorBox(t, world, cam); ctx.fillStyle = STATUS_GLOW_COLORS.needsDecision.bright; ctx.fillRect(b.x + 6 * z, b.y - 14 * z, 20 * z, 12 * z); ctx.fillRect(b.x, b.y + b.h - 4 * z, b.w, 3 * z) }
  }
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
  ctx.imageSmoothingEnabled = false
  const l2 = computeL2List(state.world, state.actors, camera)
  renderL0ToL3(ctx, state, sprites, camera, l2)
  for (const item of l2) {
    if (item.kind === 'entity' && item.entity) {
      const img = sprites.images[item.entity.assetId]; if (!img) continue
      const b = getEntityBox(item.entity, state.world, camera)
      if (item.entity.mirrorX) { ctx.save(); ctx.translate(b.x + b.w, b.y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, b.w, b.h); ctx.restore() }
      else ctx.drawImage(img, b.x, b.y, b.w, b.h)
    } else if (item.kind === 'actor' && item.actor) {
      const img = sprites.images[`char_${item.actor.role}`]; if (!img) continue
      const sitBob = item.actor.pose === 'sit' && Math.floor(state.elapsedMs / 500) % 2 === 1 ? 1 : 0
      const col = item.actor.pose === 'idle' ? 0 : item.actor.pose === 'walkA' ? 1 : item.actor.pose === 'walkB' ? 2 : 3
      const b = getActorBox(item.actor, state.world, camera)
      ctx.drawImage(img, col * 32, item.actor.facing === 'SW' || item.actor.facing === 'NW' ? 48 : 0, 32, 48, b.x, b.y + sitBob, b.w, b.h)
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
    const it = l2[i]!; if (it.kind !== 'entity' || !it.entity) continue
    const b = getEntityBox(it.entity, world, camera)
    if (it.entity.assetId === 'reception_desk') {
      const hy = b.y + Math.round(b.h * 0.36), hh = Math.round(b.h * 0.56), hw = Math.round(b.w * 0.45)
      const lb = { x: b.x + 6, y: hy, w: hw, h: hh }, nb = { x: b.x + b.w - hw - 6, y: hy, w: hw, h: hh }
      if (hitBox(px, py, lb)) return { type: 'prop', prop: 'ledger', label: PROP_LABELS.ledger.zh, bounds: lb }
      if (hitBox(px, py, nb)) return { type: 'prop', prop: 'notebook', label: PROP_LABELS.notebook.zh, bounds: nb }
    } else if (it.entity.propKind && hitBox(px, py, b)) return { type: 'prop', prop: it.entity.propKind, label: PROP_LABELS[it.entity.propKind].zh, workspaceId: wingOf(it.entity.id), bounds: b }
  }
  for (const m of world.lobby.wallMounts) if (m.propKind) { const b = getMountBox(m, world, camera, 0, 0); if (hitBox(px, py, b)) return { type: 'prop', prop: m.propKind, label: PROP_LABELS[m.propKind].zh, bounds: b } }
  for (const w of world.wings) {
    if (w.kind === 'studio' && w.workspaceId) { const db = getDoorplateBox(w, world, camera); if (hitBox(px, py, db)) return { type: 'prop', prop: 'doorplate', label: PROP_LABELS.doorplate.zh, workspaceId: w.workspaceId, bounds: db } }
    const sb = getWingSignBox(w, world, camera); if (hitBox(px, py, sb)) return { type: 'wing', wingId: w.id, workspaceId: w.workspaceId, kind: w.kind, label: w.title, bounds: sb }
  }
  return null
}
