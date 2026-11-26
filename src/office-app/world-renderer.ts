/** 同屏多房间大楼 + 室外草坪步道 4 层等距渲染与跨走廊寻路引擎。 */
import { HIGHLIGHT_GOLD, OFFICE_CATALOG, PROP_LABELS, STATUS_GLOW_COLORS } from './catalog.ts'
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
  const actors: OfficeActor[] = [{ id: 'secretary', role: 'secretary', u: (rec?.anchor.u ?? 15) - 0.55, v: (rec?.anchor.v ?? 8) + 1.0, facing: 'SE', pose: 'sit', lifecycle: 'resident', assignedSuiteId: 'lobby-reception', path: [], animMs: 0 }]
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
  const meta = OFFICE_CATALOG[e.assetId]!, pos = worldIsoToScreen(e.anchor.u + e.size[0] / 2, e.anchor.v + e.size[1] / 2, world, cam)
  return { x: Math.round(pos.x - meta.anchor[0] * cam.zoom), y: Math.round(pos.y - meta.anchor[1] * cam.zoom), w: meta.nativeSize[0] * cam.zoom, h: meta.nativeSize[1] * cam.zoom }
}

function getActorBox(a: OfficeActor, world: OfficeWorldPlan, cam: OfficeCamera): Box {
  const pos = worldIsoToScreen(a.u + 0.5, a.v + 0.5, world, cam)
  return { x: Math.round(pos.x - 16 * cam.zoom), y: Math.round(pos.y - 44 * cam.zoom), w: 32 * cam.zoom, h: 48 * cam.zoom }
}

function getMountBox(m: RoomWallMount, world: OfficeWorldPlan, cam: OfficeCamera): Box {
  const meta = OFFICE_CATALOG[m.assetId]!, pos = m.wall === 'back' ? worldIsoToScreen(m.at, 0, world, cam) : worldIsoToScreen(0, m.at, world, cam)
  const w = meta.nativeSize[0] * cam.zoom, h = meta.nativeSize[1] * cam.zoom
  return { x: Math.round(pos.x - w / 2), y: Math.round(pos.y - h - m.h * cam.zoom), w, h }
}

function getDoorplateBox(wing: WorldWingPlan, world: OfficeWorldPlan, cam: OfficeCamera): Box {
  const pos = worldIsoToScreen(wing.rect.u === 0 ? 12.8 : 19.2, wing.doorway.v - 0.8, world, cam)
  return { x: Math.round(pos.x - 12 * cam.zoom), y: Math.round(pos.y - 34 * cam.zoom), w: 24 * cam.zoom, h: 16 * cam.zoom }
}

function getWingSignBox(wing: WorldWingPlan, world: OfficeWorldPlan, cam: OfficeCamera): Box {
  const pos = worldIsoToScreen(wing.rect.u + wing.rect.w / 2, wing.rect.v + 5.6, world, cam)
  const w = Math.max(76, wing.title.length * 10 + 16) * cam.zoom
  return { x: Math.round(pos.x - w / 2), y: Math.round(pos.y - 16 * cam.zoom), w, h: 16 * cam.zoom }
}

function tileKindAt(u: number, v: number, world: OfficeWorldPlan): 'corridor_tile' | 'floor_wood' | 'stone_tile' | 'grass_tile' {
  const c = world.corridorRect
  if (u >= c.u && u < c.u + c.w && v >= c.v && v < c.v + c.h) return 'corridor_tile'
  for (const w of world.wings) {
    if (u >= w.rect.u && u < w.rect.u + w.rect.w && v >= w.rect.v && v < w.rect.v + w.rect.h) {
      if (w.kind === 'studio') return 'floor_wood'
      const minU = Math.min(w.doorway.u, w.focusPoint.u), maxU = Math.max(w.doorway.u, w.focusPoint.u)
      return Math.abs(v - w.doorway.v) <= 1 && u >= minU && u <= maxU ? 'stone_tile' : 'grass_tile'
    }
  }
  const inPlaza = u >= 13 && u <= 18 && v >= world.buildingRows && v < world.buildingRows + 5
  const inRing = u >= -2 && u < world.buildingCols + 2 && v >= -2 && v < world.buildingRows + 2
  return inPlaza || inRing ? 'stone_tile' : 'grass_tile'
}

function computeL2List(world: OfficeWorldPlan, actors: readonly OfficeActor[], cam: OfficeCamera): L2Item[] {
  const items: L2Item[] = [], suites = allSuites(world)
  for (const entity of [...suites, ...world.lobby.shared, ...world.wings.flatMap((w) => w.shared), ...world.exteriorProps]) {
    const deskY = Math.round(worldIsoToScreen(entity.anchor.u + entity.size[0], entity.anchor.v + entity.size[1], world, cam).y)
    items.push({ id: entity.id, kind: 'entity', footScreenY: deskY, entity })
    if (entity.suiteKind !== 'shared') items.push({ id: `chair-${entity.id}`, kind: 'entity', footScreenY: deskY - 6, entity: makeWorldChair(entity) })
  }
  for (const actor of actors) {
    if (actor.lifecycle === 'removed') continue
    const suite = actor.pose === 'sit' && actor.assignedSuiteId ? suites.find((s) => s.id === actor.assignedSuiteId) : undefined
    const footY = suite ? Math.round(worldIsoToScreen(suite.anchor.u + suite.size[0], suite.anchor.v + suite.size[1], world, cam).y) - 3 : Math.round(worldIsoToScreen(actor.u + 0.5, actor.v + 0.5, world, cam).y) + 1
    items.push({ id: actor.id, kind: 'actor', footScreenY: footY, actor })
  }
  return items.sort((a, b) => a.footScreenY - b.footScreenY || a.id.localeCompare(b.id))
}

function renderL0AndL1(ctx: CanvasRenderingContext2D, state: WorldSceneState, sprites: OfficeSprites, cam: OfficeCamera): void {
  const { world } = state, z = cam.zoom, cw = ctx.canvas?.width || 1440, ch = ctx.canvas?.height || 900
  ctx.fillStyle = '#3E4A44'; ctx.fillRect(0, 0, cw, ch)
  const corners = [screenToWorldIso(0, 0, world, cam), screenToWorldIso(cw, 0, world, cam), screenToWorldIso(0, ch, world, cam), screenToWorldIso(cw, ch, world, cam)]
  for (let v = Math.min(...corners.map((p) => p.v)) - 2; v <= Math.max(...corners.map((p) => p.v)) + 2; v++) for (let u = Math.min(...corners.map((p) => p.u)) - 2; u <= Math.max(...corners.map((p) => p.u)) + 2; u++) {
    const img = sprites.images[tileKindAt(u, v, world)]; if (!img) continue
    const p = worldIsoToScreen(u + 0.5, v + 0.5, world, cam); ctx.drawImage(img, Math.round(p.x - 16 * z), Math.round(p.y - 8 * z), 32 * z, 16 * z)
  }
  if (sprites.images.corridor_runner) for (let v = 2; v < world.buildingRows - 2; v += 2) {
    const p = worldIsoToScreen(15.5, v + 1, world, cam); ctx.drawImage(sprites.images.corridor_runner, Math.round(p.x - 32 * z), Math.round(p.y - 16 * z), 64 * z, 32 * z)
  }
  if (sprites.images.rug_woven) for (const w of world.wings) if (w.kind === 'studio' && w.rugRect) {
    const p = worldIsoToScreen(w.rugRect.u + w.rugRect.w / 2, w.rugRect.v + w.rugRect.h / 2, world, cam); ctx.drawImage(sprites.images.rug_woven, Math.round(p.x - 64 * z), Math.round(p.y - 32 * z), 128 * z, 64 * z)
  }
  const leftC = worldIsoToScreen(0, world.buildingRows, world, cam), rightC = worldIsoToScreen(world.buildingCols, 0, world, cam)
  for (let s = 0; s < world.buildingCols * 8; s++) { ctx.fillStyle = s / 8 >= 14 && s / 8 <= 17 ? '#8C8478' : '#4A3428'; ctx.fillRect(Math.round(leftC.x + s * 2 * z), Math.round(leftC.y + s * z), 2 * z, 5 * z) }
  ctx.fillStyle = '#3B2A22'; for (let s = 0; s < world.buildingRows * 8; s++) ctx.fillRect(Math.round(rightC.x - (s + 1) * 2 * z), Math.round(rightC.y + s * z), 2 * z, 5 * z)
  const wallImg = sprites.images.wall_segment
  if (wallImg) {
    for (let u = 0; u < world.buildingCols; u += 2) if (!world.wings.some((w) => w.kind === 'courtyard' && w.rect.v === 0 && u >= w.rect.u && u < w.rect.u + w.rect.w)) {
      const p = worldIsoToScreen(u + 1, 0, world, cam); ctx.save(); ctx.translate(Math.round(p.x + 16 * z), Math.round(p.y - 72 * z)); ctx.scale(-1, 1); ctx.drawImage(wallImg, 0, 0, 32 * z, 80 * z); ctx.restore()
    }
    for (let v = 0; v < world.buildingRows; v += 2) if (!world.wings.some((w) => w.kind === 'courtyard' && w.rect.u === 0 && v >= w.rect.v && v < w.rect.v + w.rect.h)) {
      const p = worldIsoToScreen(0, v + 1, world, cam); ctx.drawImage(wallImg, Math.round(p.x - 16 * z), Math.round(p.y - 72 * z), 32 * z, 80 * z)
    }
  }
  for (const pw of world.partitionWalls) {
    const p1 = pw.axis === 'u' ? worldIsoToScreen(pw.fixed, pw.start, world, cam) : worldIsoToScreen(pw.start, pw.fixed, world, cam)
    const p2 = pw.axis === 'u' ? worldIsoToScreen(pw.fixed, pw.end, world, cam) : worldIsoToScreen(pw.end, pw.fixed, world, cam)
    const steps = Math.max(1, Math.round(Math.abs(p2.x - p1.x) / (2 * z)))
    ctx.fillStyle = '#1A1412'
    for (let i = 0; i <= steps; i++) ctx.fillRect(Math.round(p1.x + (p2.x - p1.x) * (i / steps) - 3 * z), Math.round(p1.y + (p2.y - p1.y) * (i / steps) - 21 * z), 5 * z, 21 * z)
    for (let i = 0; i <= steps; i++) {
      const wx = Math.round(p1.x + (p2.x - p1.x) * (i / steps) - 2 * z), wy = Math.round(p1.y + (p2.y - p1.y) * (i / steps) - 20 * z)
      ctx.fillStyle = '#6B4A32'; ctx.fillRect(wx, wy, 3 * z, 3 * z); ctx.fillStyle = '#BFA48C'; ctx.fillRect(wx, wy + 3 * z, 3 * z, 10 * z); ctx.fillStyle = '#4A3428'; ctx.fillRect(wx, wy + 13 * z, 3 * z, 6 * z)
    }
  }
  if (sprites.images.door_glass) {
    const dp = worldIsoToScreen(15.5, world.buildingRows, world, cam), dx = Math.round(dp.x - 40 * z), dy = Math.round(dp.y - 52 * z)
    ctx.save(); ctx.translate(dx + 80 * z, dy); ctx.scale(-1, 1); ctx.drawImage(sprites.images.door_glass, 0, 0, 80 * z, 56 * z); ctx.restore()
  }
  for (const m of [...world.lobby.wallMounts, ...world.wings.flatMap((w) => w.wallMounts.filter((wm) => wm.propKind !== 'doorplate'))]) {
    const img = sprites.images[m.assetId]; if (!img) continue
    const b = getMountBox(m, world, cam)
    if (m.wall === 'back') { ctx.save(); ctx.translate(b.x + b.w, b.y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, b.w, b.h); ctx.restore() }
    else ctx.drawImage(img, b.x, b.y, b.w, b.h)
  }
  for (const w of world.wings) {
    if (w.kind === 'studio' && w.workspaceId && sprites.images.doorplate) { const db = getDoorplateBox(w, world, cam); ctx.drawImage(sprites.images.doorplate, db.x, db.y, db.w, db.h) }
  }
}

function renderL3(ctx: CanvasRenderingContext2D, state: WorldSceneState, cam: OfficeCamera): void {
  const { world, actors, screenStates, gateIntercept, hoverTarget, elapsedMs } = state, z = cam.zoom
  for (const w of world.wings) {
    const sb = getWingSignBox(w, world, cam)
    ctx.fillStyle = '#201A18'; ctx.fillRect(sb.x, sb.y, sb.w, sb.h)
    ctx.strokeStyle = w.workspaceId && w.workspaceId === state.activeWorkspaceId ? HIGHLIGHT_GOLD : '#6B4A32'; ctx.lineWidth = z; ctx.strokeRect(sb.x, sb.y, sb.w, sb.h)
    ctx.fillStyle = '#E8DCCB'; ctx.font = `${10 * z}px monospace`; ctx.fillText(w.title, sb.x + 6 * z, sb.y + 12 * z)
  }
  for (const suite of allSuites(world)) {
    const meta = OFFICE_CATALOG[suite.assetId], st = screenStates[suite.id]
    if (!meta?.screenGlowAnchors || !st || st === 'off') continue
    const b = getEntityBox(suite, world, cam), { bright, dark } = STATUS_GLOW_COLORS[st]
    const blinkOn = st === 'stuck' ? Math.floor(elapsedMs / 600) % 2 === 0 : st === 'needsDecision' ? Math.floor(elapsedMs / 300) % 2 === 0 : true
    for (const a of meta.screenGlowAnchors) {
      const gx = b.x + b.w / 2 + (suite.mirrorX ? -a.dx : a.dx) * z, gy = b.y + b.h + a.dy * z
      ctx.fillStyle = dark; ctx.fillRect(Math.round(gx - 6 * z), Math.round(gy - 4 * z), 12 * z, 8 * z)
      if (!blinkOn) continue
      ctx.fillStyle = bright
      if (st === 'working') ctx.fillRect(Math.round(gx - 4 * z), Math.round(gy - 2 * z), 8 * z, 2 * z)
      else if (st === 'stuck') { ctx.fillRect(Math.round(gx - 4 * z), Math.round(gy - 2 * z), 3 * z, 2 * z); ctx.fillRect(Math.round(gx + z), Math.round(gy - 2 * z), 3 * z, 2 * z) }
      else if (st === 'needsDecision') { ctx.fillRect(Math.round(gx - z), Math.round(gy - 3 * z), 2 * z, 4 * z); ctx.fillRect(Math.round(gx - 3 * z), Math.round(gy), 6 * z, 2 * z) }
      else { ctx.fillRect(Math.round(gx - 3 * z), Math.round(gy), 2 * z, 2 * z); ctx.fillRect(Math.round(gx - z), Math.round(gy - 2 * z), 4 * z, 2 * z) }
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
      ctx.fillStyle = '#1A1412'; ctx.fillRect(bx - z, by - z, 22 * z, 13 * z)
      ctx.fillStyle = '#E8DCCB'; ctx.fillRect(bx, by, 20 * z, 11 * z); ctx.fillRect(bx + 8 * z, by + 11 * z, 3 * z, 2 * z)
      for (let d = 0; d < 3; d++) { ctx.fillStyle = d === Math.floor(elapsedMs / 280) % 3 ? STATUS_GLOW_COLORS.working.bright : '#4A3428'; ctx.fillRect(bx + (4 + d * 5) * z, by + 4 * z, 2 * z, 3 * z) }
    }
  }
  if (hoverTarget) { ctx.strokeStyle = HIGHLIGHT_GOLD; ctx.lineWidth = z; ctx.strokeRect(hoverTarget.bounds.x, hoverTarget.bounds.y, hoverTarget.bounds.w, hoverTarget.bounds.h) }
}

export function renderWorldFrame(ctx: CanvasRenderingContext2D, state: WorldSceneState, sprites: OfficeSprites, camera: OfficeCamera): void {
  ctx.imageSmoothingEnabled = false
  renderL0AndL1(ctx, state, sprites, camera)
  for (const item of computeL2List(state.world, state.actors, camera)) {
    if (item.kind === 'entity' && item.entity) {
      const img = sprites.images[item.entity.assetId]; if (!img) continue
      const b = getEntityBox(item.entity, state.world, camera)
      if (item.entity.mirrorX) { ctx.save(); ctx.translate(b.x + b.w, b.y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, b.w, b.h); ctx.restore() }
      else ctx.drawImage(img, b.x, b.y, b.w, b.h)
    } else if (item.kind === 'actor' && item.actor) {
      const img = sprites.images[`char_${item.actor.role}`]; if (!img) continue
      const col = item.actor.pose === 'idle' ? 0 : item.actor.pose === 'walkA' ? 1 : item.actor.pose === 'walkB' ? 2 : 3
      const b = getActorBox(item.actor, state.world, camera)
      ctx.drawImage(img, col * 32, item.actor.facing === 'SW' || item.actor.facing === 'NW' ? 48 : 0, 32, 48, b.x, b.y, b.w, b.h)
    }
  }
  renderL3(ctx, state, camera)
}

const hitBox = (px: number, py: number, b: Box) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h

export function pickWorldTarget(px: number, py: number, state: WorldSceneState, camera: OfficeCamera): WorldPickResult | null {
  const { world } = state, z = camera.zoom, l2 = computeL2List(world, state.actors, camera)
  const wingOf = (sid?: string) => world.wings.find((w) => w.suites.some((s) => s.id === sid))?.workspaceId
  for (let i = l2.length - 1; i >= 0; i--) {
    const it = l2[i]!; if (it.kind !== 'actor' || !it.actor) continue
    const fullB = getActorBox(it.actor, world, camera), atRec = it.actor.pose === 'sit' && it.actor.assignedSuiteId === 'lobby-reception'
    const b = atRec ? { ...fullB, h: 30 * z } : fullB
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
    } else if (it.entity.propKind && hitBox(px, py, b)) {
      return { type: 'prop', prop: it.entity.propKind, label: PROP_LABELS[it.entity.propKind].zh, workspaceId: wingOf(it.entity.id), bounds: b }
    }
  }
  for (const m of world.lobby.wallMounts) {
    if (!m.propKind) continue
    const b = getMountBox(m, world, camera)
    if (hitBox(px, py, b)) return { type: 'prop', prop: m.propKind, label: PROP_LABELS[m.propKind].zh, bounds: b }
  }
  for (const w of world.wings) {
    if (w.kind === 'studio' && w.workspaceId) { const db = getDoorplateBox(w, world, camera); if (hitBox(px, py, db)) return { type: 'prop', prop: 'doorplate', label: PROP_LABELS.doorplate.zh, workspaceId: w.workspaceId, bounds: db } }
    const sb = getWingSignBox(w, world, camera)
    if (hitBox(px, py, sb)) return { type: 'wing', wingId: w.id, workspaceId: w.workspaceId, kind: w.kind, label: w.title, bounds: sb }
  }
  return null
}
