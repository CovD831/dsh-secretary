import {
  HIGHLIGHT_GOLD, OFFICE_CATALOG, PROP_LABELS, STATUS_GLOW_COLORS,
  type PropKind, type StatusKind,
} from './catalog.ts'
import { TILE_H, TILE_W, type Facing, type GridPoint, type OfficeRoomPlan, type RoomEntity } from './layout-solver.ts'

export type ActorRole = 'secretary' | 'lead' | 'worker'
export type ActorPose = 'idle' | 'walkA' | 'walkB' | 'sit'
export type ActorLifecycle = 'resident' | 'entering' | 'working' | 'leaving' | 'removed'

export interface OfficeActor {
  id: string; role: ActorRole; u: number; v: number; facing: Facing; pose: ActorPose
  lifecycle: ActorLifecycle; ticketId?: string; assignedSuiteId?: string; path: GridPoint[]; animMs: number
}
export interface OfficeSprites { images: Record<string, CanvasImageSource> }
export interface OfficeSceneState {
  plan: OfficeRoomPlan; actors: OfficeActor[]; screenStates: Record<string, StatusKind | 'off'>
  gateIntercept?: { targetActorId: string; frame: number }; hoverTarget?: ScenePickResult | null
  secretaryThinking?: boolean; elapsedMs: number
}
export type ScenePickResult =
  | { type: 'prop'; prop: PropKind; label: string; bounds: { x: number; y: number; w: number; h: number } }
  | { type: 'actor'; actorId: string; role: ActorRole; ticketId?: string; bounds: { x: number; y: number; w: number; h: number } }
export interface L2RenderItem { id: string; kind: 'entity' | 'actor'; footScreenY: number; entity?: RoomEntity; actor?: OfficeActor }

export function isoToScreen(u: number, v: number, origin: { x: number; y: number }, scale = 2): { x: number; y: number } {
  return { x: origin.x + (u - v) * ((TILE_W * scale) / 2), y: origin.y + (u + v) * ((TILE_H * scale) / 2) }
}

export function screenToIso(px: number, py: number, origin: { x: number; y: number }, scale = 2): GridPoint {
  const dx = (px - origin.x) / ((TILE_W * scale) / 2), dy = (py - origin.y) / ((TILE_H * scale) / 2)
  return { u: Math.floor((dx + dy) / 2), v: Math.floor((dy - dx) / 2) }
}

function findOrthogonalPath(plan: OfficeRoomPlan, from: GridPoint, to: GridPoint): GridPoint[] {
  const blocked = new Set<string>()
  for (const item of [...plan.suites, ...plan.shared]) for (const c of item.footprint) blocked.add(`${c.u},${c.v}`)
  const su = Math.round(from.u), sv = Math.round(from.v), tu = Math.round(to.u), tv = Math.round(to.v)
  const startKey = `${su},${sv}`, goalKey = `${tu},${tv}`
  if (startKey === goalKey) return []
  const queue: GridPoint[] = [{ u: su, v: sv }], parent = new Map<string, GridPoint | null>([[startKey, null]])
  while (queue.length > 0) {
    const cur = queue.shift()!; if (`${cur.u},${cur.v}` === goalKey) break
    for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nu = cur.u + du, nv = cur.v + dv, nk = `${nu},${nv}`
      if (nu < 0 || nv < 0 || nu >= plan.cols || nv >= plan.rows || parent.has(nk) || (blocked.has(nk) && nk !== goalKey)) continue
      parent.set(nk, cur); queue.push({ u: nu, v: nv })
    }
  }
  if (!parent.has(goalKey)) return [{ u: tu, v: tv }]
  const out: GridPoint[] = []; let cur: GridPoint | null = { u: tu, v: tv }
  while (cur && `${cur.u},${cur.v}` !== startKey) { out.push(cur); cur = parent.get(`${cur.u},${cur.v}`) ?? null }
  return out.reverse()
}

export function createInitialActors(plan: OfficeRoomPlan): OfficeActor[] {
  const rec = plan.suites.find((s) => s.id === 'reception'), exec = plan.suites.find((s) => s.id === 'executive')
  return [
    { id: 'secretary', role: 'secretary', u: (rec?.anchor.u ?? 1) - 0.55, v: (rec?.anchor.v ?? 4) + 1.0, facing: 'SE', pose: 'sit', lifecycle: 'resident', assignedSuiteId: 'reception', path: [], animMs: 0 },
    { id: 'lead', role: 'lead', u: (exec?.anchor.u ?? 8) + 0.9, v: (exec?.anchor.v ?? 1) - 0.85, facing: 'SW', pose: 'sit', lifecycle: 'resident', assignedSuiteId: 'executive', path: [], animMs: 0 },
  ]
}

export function spawnWorkerForTicket(plan: OfficeRoomPlan, actorId: string, ticketId: string, suiteId: string): OfficeActor {
  const door = plan.doorCells[0] ?? { u: 0, v: 9 }, seat = plan.suites.find((s) => s.id === suiteId)?.seatCell ?? { u: 13, v: 4 }
  return { id: actorId, role: 'worker', u: door.u, v: door.v, facing: 'SE', pose: 'idle', lifecycle: 'entering', ticketId, assignedSuiteId: suiteId, path: findOrthogonalPath(plan, door, seat), animMs: 0 }
}

export function stepActors(actors: OfficeActor[], plan: OfficeRoomPlan, dtMs: number): OfficeActor[] {
  const stepDist = (3.2 * dtMs) / 1000, door = plan.doorCells[0] ?? { u: 0, v: 9 }
  return actors.map((actor) => {
    if (actor.lifecycle === 'resident' || actor.lifecycle === 'removed') return { ...actor, animMs: actor.animMs + dtMs }
    const next: OfficeActor = { ...actor, animMs: actor.animMs + dtMs, path: [...actor.path] }
    if (next.lifecycle === 'leaving' && next.path.length === 0 && (Math.abs(next.u - door.u) > 0.05 || Math.abs(next.v - door.v) > 0.05)) {
      next.path = findOrthogonalPath(plan, { u: next.u, v: next.v }, door)
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
      const suite = plan.suites.find((s) => s.id === next.assignedSuiteId)
      if (suite) {
        const chair = makeSuiteChair(suite)
        next.u = chair.anchor.u + 0.1; next.v = chair.anchor.v + 0.1
        next.facing = chair.facing
      }
    } else if (next.lifecycle === 'leaving') { next.lifecycle = 'removed'; next.pose = 'idle' }
    return next
  })
}

function makeSuiteChair(suite: RoomEntity): RoomEntity {
  const isRec = suite.id === 'reception', isExec = suite.id === 'executive', faceSE = isRec || suite.facing === 'SE'
  const u = isRec ? suite.anchor.u - 0.7 : isExec ? suite.anchor.u + 0.95 : faceSE ? suite.anchor.u - 0.7 : suite.anchor.u + 0.55
  const v = isRec ? suite.anchor.v + 0.9 : isExec ? suite.anchor.v - 0.95 : faceSE ? suite.anchor.v + 0.55 : suite.anchor.v - 0.7
  const facing: Facing = faceSE ? 'SE' : 'SW'
  return { id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u, v }, size: [1, 1], facing, mirrorX: facing === 'SW', footprint: [] }
}

export function computeL2RenderList(plan: OfficeRoomPlan, actors: readonly OfficeActor[], origin: { x: number; y: number }, scale = 2): L2RenderItem[] {
  const items: L2RenderItem[] = []
  for (const entity of [...plan.suites, ...plan.shared]) {
    const foot = isoToScreen(entity.anchor.u + entity.size[0], entity.anchor.v + entity.size[1], origin, scale)
    const deskY = Math.round(foot.y)
    items.push({ id: entity.id, kind: 'entity', footScreenY: deskY, entity })
    if (entity.suiteKind !== 'shared') {
      const chair = makeSuiteChair(entity)
      items.push({ id: chair.id, kind: 'entity', footScreenY: deskY - 6, entity: chair })
    }
  }
  for (const actor of actors) {
    if (actor.lifecycle === 'removed') continue
    const suite = actor.pose === 'sit' && actor.assignedSuiteId ? plan.suites.find((s) => s.id === actor.assignedSuiteId) : undefined
    const suiteFoot = suite ? Math.round(isoToScreen(suite.anchor.u + suite.size[0], suite.anchor.v + suite.size[1], origin, scale).y) : undefined
    const footY = suite && suiteFoot !== undefined
      ? suiteFoot - 3
      : Math.round(isoToScreen(actor.u + 0.5, actor.v + 0.5, origin, scale).y) + 1
    items.push({ id: actor.id, kind: 'actor', footScreenY: footY, actor })
  }
  return items.sort((a, b) => a.footScreenY - b.footScreenY || a.id.localeCompare(b.id))
}

function getEntityBounds(entity: RoomEntity, origin: { x: number; y: number }, scale: number) {
  const meta = OFFICE_CATALOG[entity.assetId]!
  const pos = isoToScreen(entity.anchor.u + entity.size[0] / 2, entity.anchor.v + entity.size[1] / 2, origin, scale)
  return { x: Math.round(pos.x - meta.anchor[0] * scale), y: Math.round(pos.y - meta.anchor[1] * scale), w: meta.nativeSize[0] * scale, h: meta.nativeSize[1] * scale }
}

function getActorBounds(actor: OfficeActor, origin: { x: number; y: number }, scale: number) {
  const pos = isoToScreen(actor.u + 0.5, actor.v + 0.5, origin, scale)
  return { x: Math.round(pos.x - 16 * scale), y: Math.round(pos.y - 44 * scale), w: 32 * scale, h: 48 * scale }
}

function getWallMountBounds(mount: OfficeRoomPlan['wallMounts'][number], origin: { x: number; y: number }, scale: number) {
  const meta = OFFICE_CATALOG[mount.assetId]!
  const pos = mount.wall === 'back' ? isoToScreen(mount.at, 0, origin, scale) : isoToScreen(0, mount.at, origin, scale)
  const w = meta.nativeSize[0] * scale, h = meta.nativeSize[1] * scale
  return { x: Math.round(pos.x - w / 2), y: Math.round(pos.y - h - mount.h * scale), w, h }
}

function renderL0AndL1(ctx: CanvasRenderingContext2D, plan: OfficeRoomPlan, sprites: OfficeSprites, scale: number): void {
  const { origin } = plan, floorImg = sprites.images.floor_wood, rugImg = sprites.images.rug_woven, wallImg = sprites.images.wall_segment
  if (floorImg) {
    for (let v = 0; v < plan.rows; v++) for (let u = 0; u < plan.cols; u++) {
      const p = isoToScreen(u + 0.5, v + 0.5, origin, scale)
      ctx.drawImage(floorImg, Math.round(p.x - 16 * scale), Math.round(p.y - 8 * scale), 32 * scale, 16 * scale)
    }
    const leftCorner = isoToScreen(0, plan.rows, origin, scale), rightCorner = isoToScreen(plan.cols, 0, origin, scale)
    ctx.fillStyle = '#4A3428'
    for (let step = 0; step < plan.cols * 8; step++) {
      ctx.fillRect(Math.round(leftCorner.x + step * 2 * scale), Math.round(leftCorner.y + step * scale), 2 * scale, 5 * scale)
    }
    ctx.fillStyle = '#3B2A22'
    for (let step = 0; step < plan.rows * 8; step++) {
      ctx.fillRect(Math.round(rightCorner.x - (step + 1) * 2 * scale), Math.round(rightCorner.y + step * scale), 2 * scale, 5 * scale)
    }
  }
  if (rugImg) {
    const p = isoToScreen(plan.rugRect.u + plan.rugRect.w / 2, plan.rugRect.v + plan.rugRect.h / 2, origin, scale)
    ctx.drawImage(rugImg, Math.round(p.x - 64 * scale), Math.round(p.y - 32 * scale), 128 * scale, 64 * scale)
  }
  if (wallImg) {
    for (let u = 0; u < plan.cols; u += 2) {
      const p = isoToScreen(u + 1, 0, origin, scale)
      const dx = Math.round(p.x - 16 * scale), dy = Math.round(p.y - 72 * scale)
      ctx.save(); ctx.translate(dx + 32 * scale, dy); ctx.scale(-1, 1)
      ctx.drawImage(wallImg, 0, 0, 32 * scale, 80 * scale); ctx.restore()
    }
    for (let v = 0; v < plan.rows; v += 2) {
      const p = isoToScreen(0, v + 1, origin, scale)
      ctx.drawImage(wallImg, Math.round(p.x - 16 * scale), Math.round(p.y - 72 * scale), 32 * scale, 80 * scale)
    }
  }
  for (const mount of plan.wallMounts) {
    const img = sprites.images[mount.assetId]; if (!img) continue
    const b = getWallMountBounds(mount, origin, scale)
    if (mount.wall === 'back') {
      ctx.save(); ctx.translate(b.x + b.w, b.y); ctx.scale(-1, 1)
      ctx.drawImage(img, 0, 0, b.w, b.h); ctx.restore()
    } else {
      ctx.drawImage(img, b.x, b.y, b.w, b.h)
    }
  }
}

function renderL3Overlays(ctx: CanvasRenderingContext2D, state: OfficeSceneState, scale: number): void {
  const { plan, actors, screenStates, gateIntercept, hoverTarget, elapsedMs } = state, { origin } = plan
  for (const suite of plan.suites) {
    const meta = OFFICE_CATALOG[suite.assetId], st = screenStates[suite.id]
    if (!meta?.screenGlowAnchors || !st || st === 'off') continue
    const b = getEntityBounds(suite, origin, scale), { bright, dark } = STATUS_GLOW_COLORS[st]
    const blinkOn = st === 'stuck' ? Math.floor(elapsedMs / 600) % 2 === 0 : st === 'needsDecision' ? Math.floor(elapsedMs / 300) % 2 === 0 : true
    for (const a of meta.screenGlowAnchors) {
      const gx = b.x + b.w / 2 + (suite.mirrorX ? -a.dx : a.dx) * scale, gy = b.y + b.h + a.dy * scale
      ctx.fillStyle = dark; ctx.fillRect(Math.round(gx - 6 * scale), Math.round(gy - 4 * scale), 12 * scale, 8 * scale)
      if (!blinkOn) continue
      ctx.fillStyle = bright
      if (st === 'working') ctx.fillRect(Math.round(gx - 4 * scale), Math.round(gy - 2 * scale), 8 * scale, 2 * scale)
      else if (st === 'stuck') {
        ctx.fillRect(Math.round(gx - 4 * scale), Math.round(gy - 2 * scale), 3 * scale, 2 * scale)
        ctx.fillRect(Math.round(gx + 1 * scale), Math.round(gy - 2 * scale), 3 * scale, 2 * scale)
      } else if (st === 'needsDecision') {
        ctx.fillRect(Math.round(gx - 1 * scale), Math.round(gy - 3 * scale), 2 * scale, 4 * scale)
        ctx.fillRect(Math.round(gx - 3 * scale), Math.round(gy), 6 * scale, 2 * scale)
      } else {
        ctx.fillRect(Math.round(gx - 3 * scale), Math.round(gy), 2 * scale, 2 * scale)
        ctx.fillRect(Math.round(gx - 1 * scale), Math.round(gy - 2 * scale), 4 * scale, 2 * scale)
      }
    }
  }
  if (gateIntercept) {
    const target = actors.find((a) => a.id === gateIntercept.targetActorId)
    if (target) {
      const b = getActorBounds(target, origin, scale)
      ctx.fillStyle = STATUS_GLOW_COLORS.needsDecision.bright
      ctx.fillRect(b.x + 6 * scale, b.y - 14 * scale, 20 * scale, 12 * scale)
      ctx.fillRect(b.x, b.y + b.h - 4 * scale, b.w, 3 * scale)
    }
  }
  if (state.secretaryThinking) {
    const sec = actors.find((a) => a.id === 'secretary')
    if (sec) {
      const b = getActorBounds(sec, origin, scale), bob = (Math.floor(elapsedMs / 350) % 2) * scale
      const bx = b.x + 6 * scale, by = b.y - 14 * scale - bob, bw = 20 * scale, bh = 11 * scale
      ctx.fillStyle = '#1A1412'; ctx.fillRect(bx - scale, by - scale, bw + 2 * scale, bh + 2 * scale)
      ctx.fillStyle = '#E8DCCB'; ctx.fillRect(bx, by, bw, bh); ctx.fillRect(bx + 8 * scale, by + bh, 3 * scale, 2 * scale)
      const activeDot = Math.floor(elapsedMs / 280) % 3
      for (let d = 0; d < 3; d++) {
        ctx.fillStyle = d === activeDot ? STATUS_GLOW_COLORS.working.bright : '#4A3428'
        ctx.fillRect(bx + (4 + d * 5) * scale, by + 4 * scale, 2 * scale, 3 * scale)
      }
    }
  }
  if (hoverTarget) {
    const hb = hoverTarget.bounds
    ctx.strokeStyle = HIGHLIGHT_GOLD; ctx.lineWidth = scale; ctx.strokeRect(hb.x, hb.y, hb.w, hb.h)
    if (hoverTarget.type === 'prop') {
      const tagW = hoverTarget.label.length * 12 + 12
      ctx.fillStyle = '#201A18'; ctx.fillRect(hb.x, Math.max(0, hb.y - 22), tagW, 18)
      ctx.strokeRect(hb.x, Math.max(0, hb.y - 22), tagW, 18)
      ctx.fillStyle = '#E8DCCB'; ctx.font = '12px monospace'; ctx.fillText(hoverTarget.label, hb.x + 6, Math.max(13, hb.y - 9))
    }
  }
}

export function renderOfficeFrame(ctx: CanvasRenderingContext2D, state: OfficeSceneState, sprites: OfficeSprites, scale = 2): void {
  ctx.imageSmoothingEnabled = false
  renderL0AndL1(ctx, state.plan, sprites, scale)
  for (const item of computeL2RenderList(state.plan, state.actors, state.plan.origin, scale)) {
    if (item.kind === 'entity' && item.entity) {
      const img = sprites.images[item.entity.assetId]; if (!img) continue
      const b = getEntityBounds(item.entity, state.plan.origin, scale)
      ctx.save()
      if (item.entity.mirrorX) { ctx.translate(b.x + b.w, b.y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, b.w, b.h) }
      else ctx.drawImage(img, b.x, b.y, b.w, b.h)
      ctx.restore()
    } else if (item.kind === 'actor' && item.actor) {
      const img = sprites.images[`char_${item.actor.role}`]; if (!img) continue
      const col = item.actor.pose === 'idle' ? 0 : item.actor.pose === 'walkA' ? 1 : item.actor.pose === 'walkB' ? 2 : 3
      const row = item.actor.facing === 'SW' || item.actor.facing === 'NW' ? 1 : 0
      const b = getActorBounds(item.actor, state.plan.origin, scale)
      ctx.drawImage(img, col * 32, row * 48, 32, 48, b.x, b.y, b.w, b.h)
    }
  }
  renderL3Overlays(ctx, state, scale)
}

function hitRect(px: number, py: number, b: { x: number; y: number; w: number; h: number }): boolean {
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h
}

export function pickSceneTarget(px: number, py: number, state: OfficeSceneState, plan: OfficeRoomPlan, scale = 2): ScenePickResult | null {
  const origin = plan.origin, l2 = computeL2RenderList(plan, state.actors, origin, scale)
  for (let i = l2.length - 1; i >= 0; i--) {
    const item = l2[i]!
    if (item.kind === 'actor' && item.actor) {
      const fullB = getActorBounds(item.actor, origin, scale)
      const behindReception = item.actor.pose === 'sit' && item.actor.assignedSuiteId === 'reception'
      const pickB = behindReception ? { ...fullB, h: 30 * scale } : fullB
      if (hitRect(px, py, pickB)) return { type: 'actor', actorId: item.actor.id, role: item.actor.role, ticketId: item.actor.ticketId, bounds: pickB }
    }
  }
  for (let i = l2.length - 1; i >= 0; i--) {
    const item = l2[i]!
    if (item.kind === 'entity' && item.entity) {
      const b = getEntityBounds(item.entity, origin, scale)
      if (item.entity.assetId === 'reception_desk') {
        const hy = b.y + Math.round(b.h * 0.36), hh = Math.round(b.h * 0.56), hw = Math.round(b.w * 0.45)
        const ledgerBounds = { x: b.x + 6, y: hy, w: hw, h: hh }
        const notebookBounds = { x: b.x + b.w - hw - 6, y: hy, w: hw, h: hh }
        if (hitRect(px, py, ledgerBounds)) return { type: 'prop', prop: 'ledger', label: PROP_LABELS.ledger.zh, bounds: ledgerBounds }
        if (hitRect(px, py, notebookBounds)) return { type: 'prop', prop: 'notebook', label: PROP_LABELS.notebook.zh, bounds: notebookBounds }
      } else if (item.entity.propKind && hitRect(px, py, b)) {
        return { type: 'prop', prop: item.entity.propKind, label: PROP_LABELS[item.entity.propKind].zh, bounds: b }
      }
    }
  }
  for (let i = plan.wallMounts.length - 1; i >= 0; i--) {
    const mount = plan.wallMounts[i]!; if (!mount.propKind) continue
    const b = getWallMountBounds(mount, origin, scale)
    if (hitRect(px, py, b)) return { type: 'prop', prop: mount.propKind, label: PROP_LABELS[mount.propKind].zh, bounds: b }
  }
  return null
}
