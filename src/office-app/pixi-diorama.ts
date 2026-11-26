/** PixiJS v8 七层微缩沙盘 WebGL 渲染引擎（100% 实心墙体与零遮挡阶梯剖面，纯浏览器端）。 */
import { Application, Container, Graphics, ImageSource, Rectangle, Sprite, Text, TextStyle, Texture } from 'pixi.js'
import { HIGHLIGHT_GOLD, STATUS_GLOW_COLORS } from './catalog.ts'
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import type { OfficeActor } from './iso-engine.ts'
import type { RoomEntity, RoomWallMount } from './layout-solver.ts'
import { worldIsoToScreen } from './world-renderer.ts'
import type { OfficeCamera, OfficeWorldPlan, WallSegment3D, WorldSceneState } from './world-types.ts'

export const DIORAMA_LAYER_NAMES = ['stageVignette', 'baseAndFloors', 'aoShadows', 'cutawayWalls', 'ySortedEntities', 'warmLighting'] as const
export const createDioramaLayerNames = (): readonly string[] => [...DIORAMA_LAYER_NAMES]
export interface PixiDioramaSourceState { readonly scene: WorldSceneState; readonly camera: OfficeCamera; readonly images: Record<string, CanvasImageSource> }
export interface PixiDioramaHandle { resize: (w: number, h: number) => void; destroy: () => void }

const hexNum = (hex: string): number => Number.parseInt(hex.slice(1), 16)

function buildTileLookup(world: OfficeWorldPlan): Map<string, string> {
  const map = new Map<string, string>()
  for (const c of [...(world.corridorCells ?? []), ...(world.lobby.cells ?? [])]) map.set(`${c.u},${c.v}`, 'corridor_tile')
  for (const w of world.wings) {
    const style = w.floorStyle === 'warm_parquet' ? 'corridor_tile' : w.kind === 'studio' ? 'floor_wood' : 'stone_tile'
    if (w.cells) { for (const c of w.cells) map.set(`${c.u},${c.v}`, style); continue }
    for (let dv = 0; dv < w.rect.h; dv++) for (let du = 0; du < w.rect.w; du++) {
      if (!w.chamferSE || du + dv < w.rect.w + w.rect.h - 1 - w.chamferSE) map.set(`${w.rect.u + du},${w.rect.v + dv}`, style)
    }
  }
  return map
}

function makeChairs(suite: RoomEntity): RoomEntity[] {
  if (suite.assetId === 'desk_cluster') return [
    { id: `chair-${suite.id}-a`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u: suite.anchor.u + 1.8, v: suite.anchor.v - 0.6 }, size: [1, 1], facing: 'SW', mirrorX: true, footprint: [] },
    { id: `chair-${suite.id}-b`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u: suite.anchor.u - 0.5, v: suite.anchor.v + 1.5 }, size: [1, 1], facing: 'SE', mirrorX: false, footprint: [] },
  ]
  const isRec = suite.suiteKind === 'reception', isExec = suite.suiteKind === 'executive', faceSE = isRec || suite.facing === 'SE'
  const u = isRec ? suite.anchor.u - 0.7 : isExec ? suite.anchor.u + 0.95 : faceSE ? suite.anchor.u - 0.7 : suite.anchor.u + 0.55
  const v = isRec ? suite.anchor.v + 0.9 : isExec ? suite.anchor.v - 0.95 : faceSE ? suite.anchor.v + 0.55 : suite.anchor.v - 0.7
  return [{ id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u, v }, size: [1, 1], facing: faceSE ? 'SE' : 'SW', mirrorX: !faceSE, footprint: [] }]
}

function drawWallSeg3D(gfx: Graphics, seg: WallSegment3D, world: OfficeWorldPlan, camera: OfficeCamera, startPost = true, endPost = true): void {
  const z = camera.zoom, p1 = worldIsoToScreen(seg.from.u, seg.from.v, world, camera), p2 = worldIsoToScreen(seg.to.u, seg.to.v, world, camera)
  const h1 = seg.startH * z, h2 = seg.endH * z, capH = Math.min(5 * z, h1 * 0.25), bev = 4 * z
  const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.max(1, Math.hypot(dx, dy))
  let nx = dy / len, ny = -dx / len; if (ny > 0) { nx = -nx; ny = -ny }
  const tx1 = p1.x + nx * bev, ty1 = p1.y - h1 + ny * bev, tx2 = p2.x + nx * bev, ty2 = p2.y - h2 + ny * bev
  const wainH = (seg.tier === 'back' ? 14 : seg.tier === 'partition' ? 12 : 9) * z
  const plaster = seg.tier === 'cutaway' || seg.tier === 'portal'
    ? (seg.shade === 'shaded' ? 0x7a6150 : 0x9c8069)
    : (seg.shade === 'shaded' ? 0xbfa48c : 0xd9c4a8)
  const wain = seg.tier === 'back' ? 0x4a3428 : 0x6b4a32
  gfx.poly([tx1, ty1, tx2, ty2, p2.x, p2.y - h2, p1.x, p1.y - h1]).fill(0x5a463a)
  gfx.poly([p1.x, p1.y - h1, p2.x, p2.y - h2, p2.x, p2.y - h2 + capH, p1.x, p1.y - h1 + capH]).fill(0x4a3428)
  gfx.poly([p1.x, p1.y - h1 + capH, p2.x, p2.y - h2 + capH, p2.x, p2.y - wainH, p1.x, p1.y - wainH]).fill(plaster)
  gfx.poly([p1.x, p1.y - wainH, p2.x, p2.y - wainH, p2.x, p2.y, p1.x, p1.y]).fill(wain)
  gfx.moveTo(tx1, ty1).lineTo(tx2, ty2).moveTo(p1.x, p1.y - h1).lineTo(p2.x, p2.y - h2).moveTo(p1.x, p1.y).lineTo(p2.x, p2.y).stroke({ color: 0x1a1412, width: z })
  if (startPost) gfx.rect(Math.round(p1.x - 1.5 * z), Math.round(p1.y - h1), Math.round(3 * z), Math.round(h1)).fill(0x4a3428).stroke({ color: 0x1a1412, width: z })
  if (endPost) gfx.rect(Math.round(p2.x - 1.5 * z), Math.round(p2.y - h2), Math.round(3 * z), Math.round(h2)).fill(0x4a3428).stroke({ color: 0x1a1412, width: z })
}

export function mountPixiDioramaStage(
  canvas: HTMLCanvasElement, getState: () => PixiDioramaSourceState, initialW = 1440, initialH = 900,
): PixiDioramaHandle {
  let destroyed = false, initialized = false
  let pendingW = initialW || canvas.clientWidth || 1440, pendingH = initialH || canvas.clientHeight || 900
  const app = new Application()
  const sources = new Map<HTMLImageElement, ImageSource>(), baseTextures = new Map<string, Texture>()
  const charTextures = new Map<string, Texture>(), wingLabels = new Map<string, Text>()

  const getSrc = (img: CanvasImageSource | undefined) => {
    if (!(img instanceof HTMLImageElement) || !img.complete || img.naturalWidth === 0) return null
    let src = sources.get(img); if (!src) { src = new ImageSource({ resource: img, scaleMode: 'nearest' }); sources.set(img, src) }
    return src
  }
  const getTex = (id: string, images: Record<string, CanvasImageSource>): Texture | null => {
    const src = getSrc(images[id]); if (!src) return null
    let tex = baseTextures.get(id); if (!tex) { tex = new Texture({ source: src }); baseTextures.set(id, tex) }
    return tex
  }
  const getCharTex = (role: string, col: number, row: number, images: Record<string, CanvasImageSource>): Texture | null => {
    const src = getSrc(images[`char_${role}`]); if (!src) return null
    const key = `${role}:${col}:${row}`; let tex = charTextures.get(key)
    if (!tex) { tex = new Texture({ source: src, frame: new Rectangle(col * 32, row * 48, 32, 48) }); charTextures.set(key, tex) }
    return tex
  }

  const stageVignette = new Graphics(), baseAndFloors = new Container(), runnerGfx = new Graphics()
  const aoShadows = new Graphics(); aoShadows.blendMode = 'multiply'
  const cutawayWalls = new Container(), wallGfx = new Graphics(), fgPool: Graphics[] = []
  const ySortedEntities = new Container(); ySortedEntities.sortableChildren = true
  const warmLighting = new Container(), lightGfx = new Graphics()

  const addSp = (parent: Container, tex: Texture, x: number, y: number, w: number, h: number, mirrorX = false, zIndex = 0) => {
    const sp = new Sprite(tex); sp.width = w; sp.height = h; sp.x = mirrorX ? x + w : x; sp.y = y
    if (mirrorX) sp.scale.x = -Math.abs(sp.scale.x)
    sp.zIndex = zIndex; parent.addChild(sp)
  }

  const drawFrame = () => {
    if (destroyed || !initialized) return
    const targetW = canvas.clientWidth || pendingW, targetH = canvas.clientHeight || pendingH
    if (targetW > 0 && targetH > 0 && (app.screen.width !== targetW || app.screen.height !== targetH)) {
      pendingW = targetW; pendingH = targetH; app.renderer.resize(targetW, targetH)
    }
    const { scene, camera, images } = getState()
    const { world, actors, screenStates, gateIntercept, hoverTarget, elapsedMs } = scene
    const z = camera.zoom, cw = app.screen.width, ch = app.screen.height

    stageVignette.clear()
    stageVignette.rect(0, 0, cw, ch).fill(0x201a18)
    stageVignette.ellipse(Math.round(cw * 0.52), Math.round(ch * 0.48), Math.round(cw * 0.46), Math.round(ch * 0.44)).fill({ color: 0x302722, alpha: 0.72 })

    baseAndFloors.removeChildren(); runnerGfx.clear()
    const tileMap = buildTileLookup(world)
    const nearBuilding = (u: number, v: number) => {
      if (u >= 11 && u <= 15 && v >= world.buildingRows && v <= world.buildingRows + 2) return true
      for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) if (tileMap.has(`${u + du},${v + dv}`)) return true
      return false
    }
    for (let v = -1; v <= world.buildingRows + 2; v++) for (let u = -1; u <= world.buildingCols + 1; u++) {
      const id = tileMap.get(`${u},${v}`) ?? (nearBuilding(u, v) ? 'stone_tile' : null), tex = id ? getTex(id, images) : null
      if (tex) { const p = worldIsoToScreen(u + 0.5, v + 0.5, world, camera); addSp(baseAndFloors, tex, Math.round(p.x - 16 * z), Math.round(p.y - 8 * z), 32 * z, 16 * z) }
    }
    for (const br of world.corridorBranches ?? []) {
      if (!br.hasRunner) continue
      const horiz = br.from.v === br.to.v, u0 = horiz ? br.from.u : br.from.u + 0.5, v0 = horiz ? br.from.v + 0.35 : Math.max(br.from.v, 9.4)
      const u1 = horiz ? br.to.u : br.to.u + 1.9, v1 = horiz ? br.to.v + 1.65 : br.to.v - 0.5
      const r0 = worldIsoToScreen(u0, v0, world, camera), r1 = worldIsoToScreen(u1, v0, world, camera), r2 = worldIsoToScreen(u1, v1, world, camera), r3 = worldIsoToScreen(u0, v1, world, camera)
      runnerGfx.poly([r0.x, r0.y, r1.x, r1.y, r2.x, r2.y, r3.x, r3.y]).fill(0x3f5a78).stroke({ color: 0x1a1412, width: z })
      const i0 = worldIsoToScreen(u0 + 0.15, v0 + 0.15, world, camera), i1 = worldIsoToScreen(u1 - 0.15, v0 + 0.15, world, camera), i2 = worldIsoToScreen(u1 - 0.15, v1 - 0.15, world, camera), i3 = worldIsoToScreen(u0 + 0.15, v1 - 0.15, world, camera)
      runnerGfx.poly([i0.x, i0.y, i1.x, i1.y, i2.x, i2.y, i3.x, i3.y]).stroke({ color: 0xc9a46a, width: z })
    }
    baseAndFloors.addChild(runnerGfx)
    const wmat = getTex('welcome_mat', images)
    if (wmat) { const p = worldIsoToScreen(13.5, world.buildingRows + 1, world, camera); addSp(baseAndFloors, wmat, Math.round(p.x - 32 * z), Math.round(p.y - 16 * z), 64 * z, 32 * z) }
    for (const w of world.wings) if (w.kind === 'studio' && w.rugRect) {
      const rug = getTex(`rug_${w.rugStyle ?? 'woven'}`, images) ?? getTex('rug_woven', images)
      if (!rug) continue
      const rw = Math.round(((w.rugRect.w + w.rugRect.h) / 2) * 32 * z), rh = Math.round(rw / 2), p = worldIsoToScreen(w.rugRect.u + w.rugRect.w / 2, w.rugRect.v + w.rugRect.h / 2, world, camera)
      addSp(baseAndFloors, rug, Math.round(p.x - rw / 2), Math.round(p.y - rh / 2), rw, rh)
    }

    aoShadows.clear()
    for (const seg of world.wallSegments ?? []) {
      if (seg.tier !== 'back') continue
      const mp = worldIsoToScreen((seg.from.u + seg.to.u) / 2, (seg.from.v + seg.to.v) / 2, world, camera)
      aoShadows.ellipse(mp.x, mp.y + 3 * z, Math.max(12, Math.hypot(seg.to.u - seg.from.u, seg.to.v - seg.from.v) * 10) * z, 5 * z).fill({ color: 0x1a1412, alpha: 0.28 })
    }
    const suites = [...world.lobby.suites, ...world.wings.flatMap((w) => w.suites)]
    const allEntities = [...suites, ...world.lobby.shared, ...world.wings.flatMap((w) => w.shared), ...world.exteriorProps]
    for (const e of allEntities) {
      const meta = WORLD_ASSET_CATALOG[e.assetId]; if (!meta) continue
      const p = worldIsoToScreen(e.anchor.u + e.size[0] / 2, e.anchor.v + e.size[1] / 2, world, camera)
      aoShadows.ellipse(Math.round(p.x + 2 * z), Math.round(p.y + 3 * z), Math.round(meta.nativeSize[0] * 0.36 * z), Math.round(meta.nativeSize[1] * 0.14 * z)).fill({ color: 0x1a1412, alpha: 0.35 })
    }
    for (const a of actors) if (a.lifecycle !== 'removed') {
      const p = worldIsoToScreen(a.u + 0.5, a.v + 0.5, world, camera)
      aoShadows.ellipse(Math.round(p.x + 2 * z), Math.round(p.y + 2 * z), 9 * z, 4 * z).fill({ color: 0x1a1412, alpha: 0.35 })
    }

    ySortedEntities.removeChildren()
    cutawayWalls.removeChildren(); wallGfx.clear(); cutawayWalls.addChild(wallGfx)
    const sortedWalls = [...(world.wallSegments ?? [])].sort((a, b) => (a.from.u + a.from.v + a.to.u + a.to.v) - (b.from.u + b.from.v + b.to.u + b.to.v))
    let fgIdx = 0
    for (const seg of sortedWalls) {
      if (seg.tier === 'back') { drawWallSeg3D(wallGfx, seg, world, camera, true, true); continue }
      const steps = Math.max(1, Math.round(Math.max(Math.abs(seg.to.u - seg.from.u), Math.abs(seg.to.v - seg.from.v))))
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps, t1 = (i + 1) / steps
        const sub: WallSegment3D = {
          ...seg,
          from: { u: seg.from.u + (seg.to.u - seg.from.u) * t0, v: seg.from.v + (seg.to.v - seg.from.v) * t0 },
          to: { u: seg.from.u + (seg.to.u - seg.from.u) * t1, v: seg.from.v + (seg.to.v - seg.from.v) * t1 },
          startH: seg.startH + (seg.endH - seg.startH) * t0,
          endH: seg.startH + (seg.endH - seg.startH) * t1,
        }
        const fg = fgPool[fgIdx] ?? (fgPool[fgIdx] = new Graphics()); fgIdx++; fg.clear()
        drawWallSeg3D(fg, sub, world, camera, i === 0 && seg.startH === seg.endH, i === steps - 1)
        const p1 = worldIsoToScreen(sub.from.u, sub.from.v, world, camera), p2 = worldIsoToScreen(sub.to.u, sub.to.v, world, camera)
        fg.zIndex = Math.round((p1.y + p2.y) / 2); ySortedEntities.addChild(fg)
      }
      const fwin = seg.hasWindow ? getTex('facade_window', images) : null
      if (fwin) {
        const wu = Math.max(Math.min(seg.from.u, seg.to.u) + 1.5, Math.min(Math.max(seg.from.u, seg.to.u) - 1.5, 18.5))
        const wp = worldIsoToScreen(wu, seg.from.v, world, camera)
        addSp(ySortedEntities, fwin, Math.round(wp.x - 27 * z), Math.round(wp.y - 26 * z), 54 * z, 22 * z, true, Math.round(worldIsoToScreen(wu + 1, seg.from.v, world, camera).y) + 4)
      }
    }
    const drawMount = (m: RoomWallMount, bu: number, bv: number) => {
      const meta = WORLD_ASSET_CATALOG[m.assetId], tex = getTex(m.assetId, images); if (!meta || !tex) return
      const p = m.wall === 'back' ? worldIsoToScreen(m.at, bv, world, camera) : worldIsoToScreen(bu, m.at, world, camera)
      const sc = m.assetId === 'clock_wall' || m.assetId === 'doorplate' ? 0.9 : 0.72
      const w = Math.round(meta.nativeSize[0] * sc * z), h = Math.round(meta.nativeSize[1] * sc * z)
      addSp(cutawayWalls, tex, Math.round(p.x - w / 2), Math.round(p.y - h - m.h * z), w, h, m.wall === 'back')
    }
    for (const m of world.lobby.wallMounts) drawMount(m, world.lobby.rect.u, world.lobby.rect.v)
    for (const w of world.wings) {
      for (const m of w.wallMounts.filter((wm) => wm.propKind !== 'doorplate')) drawMount(m, w.rect.u, w.rect.v)
      const dpTex = w.kind === 'studio' && w.workspaceId ? getTex('doorplate', images) : null
      if (dpTex) {
        const dp = worldIsoToScreen(w.rect.u === 0 ? w.doorway.u + 0.8 : w.doorway.u + 0.2, w.doorway.v - 0.8, world, camera)
        addSp(ySortedEntities, dpTex, Math.round(dp.x - 12 * z), Math.round(dp.y - 34 * z), 24 * z, 16 * z, false, Math.round(dp.y) + 4)
      }
    }
    const activeDoors = (world.interiorDoors ?? []).map((d) => {
      const dcU = d.axis === 'u' ? d.u : d.u + 1, dcV = d.axis === 'u' ? d.v + 1 : d.v
      const dp = worldIsoToScreen(dcU, dcV, world, camera)
      const open = actors.some((a) => (a.lifecycle === 'entering' || a.lifecycle === 'leaving') && Math.hypot(a.u + 0.5 - dcU, a.v + 0.5 - dcV) < 1.8)
      return { d, dp, open }
    })
    const doorWood = getTex('door_wood', images)
    if (doorWood) for (const { d, dp, open } of activeDoors) {
      const dz = Math.round(worldIsoToScreen(d.axis === 'u' ? d.u : d.u + 2, d.axis === 'u' ? d.v + 2 : d.v, world, camera).y) + 4
      addSp(ySortedEntities, doorWood, Math.round(dp.x - 18 * z + (open ? (d.axis === 'v' ? 2 : -2) * z : 0)), Math.round(dp.y - 46 * z - (open ? 2 * z : 0)), 36 * z, 46 * z, d.axis === 'v', dz)
    }
    const dglass = getTex('door_glass', images), sconce = getTex('wall_sconce', images)
    if (dglass) {
      const dp = worldIsoToScreen(13.5, world.buildingRows, world, camera)
      addSp(ySortedEntities, dglass, Math.round(dp.x - 36 * z), Math.round(dp.y - 44 * z), 72 * z, 44 * z, true, Math.round(worldIsoToScreen(15, world.buildingRows, world, camera).y) + 4)
    }
    if (sconce) for (const ls of world.lightSources ?? []) if (ls.kind === 'sconce') { const sp = worldIsoToScreen(ls.u, ls.v, world, camera); addSp(ySortedEntities, sconce, Math.round(sp.x - 8 * z), Math.round(sp.y - 34 * z), 16 * z, 22 * z, false, Math.round(sp.y) + 6) }
    for (const e of allEntities) {
      const meta = WORLD_ASSET_CATALOG[e.assetId], tex = getTex(e.assetId, images); if (!meta || !tex) continue
      const p = worldIsoToScreen(e.anchor.u + e.size[0] / 2, e.anchor.v + e.size[1] / 2, world, camera)
      const footY = Math.round(worldIsoToScreen(e.anchor.u + e.size[0], e.anchor.v + e.size[1], world, camera).y)
      addSp(ySortedEntities, tex, Math.round(p.x - meta.anchor[0] * z), Math.round(p.y - meta.anchor[1] * z), meta.nativeSize[0] * z, meta.nativeSize[1] * z, e.mirrorX, footY)
      const ctex = e.suiteKind !== 'shared' ? getTex('office_chair', images) : null, cm = WORLD_ASSET_CATALOG.office_chair
      if (ctex && cm) for (const ch of makeChairs(e)) {
        const cp = worldIsoToScreen(ch.anchor.u + 0.5, ch.anchor.v + 0.5, world, camera)
        addSp(ySortedEntities, ctex, Math.round(cp.x - cm.anchor[0] * z), Math.round(cp.y - cm.anchor[1] * z), cm.nativeSize[0] * z, cm.nativeSize[1] * z, ch.mirrorX, footY - 6)
      }
    }
    for (const a of actors as readonly OfficeActor[]) if (a.lifecycle !== 'removed') {
      const tex = getCharTex(a.role, a.pose === 'idle' ? 0 : a.pose === 'walkA' ? 1 : a.pose === 'walkB' ? 2 : 3, a.facing === 'SW' || a.facing === 'NW' ? 1 : 0, images); if (!tex) continue
      const p = worldIsoToScreen(a.u + 0.5, a.v + 0.5, world, camera), bob = a.pose === 'sit' && Math.floor(elapsedMs / 500) % 2 === 1 ? 1 : 0
      const suite = a.pose === 'sit' && a.assignedSuiteId ? suites.find((s) => s.id === a.assignedSuiteId) : undefined
      addSp(ySortedEntities, tex, Math.round(p.x - 16 * z), Math.round(p.y - 44 * z) + bob, 32 * z, 48 * z, false, suite ? Math.round(worldIsoToScreen(suite.anchor.u + suite.size[0], suite.anchor.v + suite.size[1], world, camera).y) - 3 : Math.round(p.y) + 1)
    }

    warmLighting.removeChildren(); lightGfx.clear(); warmLighting.addChild(lightGfx)
    for (const [li, ls] of (world.lightSources ?? []).entries()) {
      const p = worldIsoToScreen(ls.u, ls.v, world, camera), col = ls.kind === 'window' ? 0xe8dccb : 0xf2a93b
      const pulse = ls.kind === 'window' ? 1 : 1 + 0.08 * Math.sin(elapsedMs * 0.0025 + li * 1.3)
      for (const [k, a] of [[1.0, 0.035], [0.72, 0.045], [0.46, 0.055], [0.24, 0.065]] as const) {
        lightGfx.ellipse(p.x, p.y, ls.radiusTiles * 14 * z * k * pulse, ls.radiusTiles * 8 * z * k * pulse).fill({ color: col, alpha: a })
      }
    }
    for (const { dp, open } of activeDoors) if (open) lightGfx.ellipse(dp.x, dp.y + 2 * z, 18 * z, 9 * z).fill({ color: 0xf2a93b, alpha: 0.18 })
    for (const suite of suites) {
      const meta = WORLD_ASSET_CATALOG[suite.assetId], st = screenStates[suite.id]
      if (!meta?.screenGlowAnchors || !st || st === 'off') continue
      const p = worldIsoToScreen(suite.anchor.u + suite.size[0] / 2, suite.anchor.v + suite.size[1] / 2, world, camera)
      const bx = Math.round(p.x - meta.anchor[0] * z), by = Math.round(p.y - meta.anchor[1] * z), bw = meta.nativeSize[0] * z, bh = meta.nativeSize[1] * z
      for (const a of meta.screenGlowAnchors) {
        const gx = bx + bw / 2 + (suite.mirrorX ? -a.dx : a.dx) * z, gy = by + bh + a.dy * z
        lightGfx.rect(Math.round(gx - 5 * z), Math.round(gy - 3 * z), 10 * z, 6 * z).fill(hexNum(STATUS_GLOW_COLORS[st].bright))
        if (st === 'working') { const ph = Math.floor(elapsedMs / 260 + gx) % 3; lightGfx.rect(Math.round(gx + (ph - 1) * 2 * z), Math.round(gy - z), 2 * z, 2 * z).fill(0xe8dccb) }
      }
    }
    if (z === 1 || hoverTarget?.type === 'wing') {
      for (const w of world.wings) {
        if (z > 1 && hoverTarget?.type === 'wing' && hoverTarget.wingId !== w.id) continue
        const pos = worldIsoToScreen(w.rect.u + w.rect.w / 2, w.rect.v + Math.min(4.2, w.rect.h / 2), world, camera)
        const bw = Math.max(72, w.title.length * 10 + 14) * z, bh = 14 * z, bx = Math.round(pos.x - bw / 2), by = Math.round(pos.y - bh)
        lightGfx.rect(bx, by, bw, bh).fill({ color: 0x201a18, alpha: 0.88 }).stroke({ color: hexNum(w.workspaceId && w.workspaceId === scene.activeWorkspaceId ? HIGHLIGHT_GOLD : '#6B4A32'), width: z })
        let label = wingLabels.get(w.id)
        if (!label) { label = new Text({ text: w.title, style: new TextStyle({ fontFamily: 'monospace', fontSize: 9 * z, fill: 0xe8dccb }) }); wingLabels.set(w.id, label) }
        else { label.text = w.title; label.style.fontSize = 9 * z }
        label.x = bx + 6 * z; label.y = by + 2 * z; warmLighting.addChild(label)
      }
    }
    if (gateIntercept) {
      const t = actors.find((a) => a.id === gateIntercept.targetActorId)
      if (t) { const p = worldIsoToScreen(t.u + 0.5, t.v + 0.5, world, camera); lightGfx.rect(Math.round(p.x - 10 * z), Math.round(p.y - 58 * z), 20 * z, 12 * z).fill(hexNum(STATUS_GLOW_COLORS.needsDecision.bright)) }
    }
    if (scene.secretaryThinking) {
      const sec = actors.find((a) => a.id === 'secretary')
      if (sec) {
        const p = worldIsoToScreen(sec.u + 0.5, sec.v + 0.5, world, camera), bx = Math.round(p.x - 10 * z), by = Math.round(p.y - 58 * z) - (Math.floor(elapsedMs / 350) % 2) * z
        lightGfx.rect(bx - z, by - z, 22 * z, 13 * z).fill(0x1a1412); lightGfx.rect(bx, by, 20 * z, 11 * z).fill(0xe8dccb)
        for (let d = 0; d < 3; d++) lightGfx.rect(bx + (4 + d * 5) * z, by + 4 * z, 2 * z, 3 * z).fill(d === Math.floor(elapsedMs / 280) % 3 ? hexNum(STATUS_GLOW_COLORS.working.bright) : 0x4a3428)
      }
    }
    if (hoverTarget) lightGfx.rect(hoverTarget.bounds.x, hoverTarget.bounds.y, hoverTarget.bounds.w, hoverTarget.bounds.h).stroke({ color: hexNum(HIGHLIGHT_GOLD), width: z })
  }

  void app.init({ canvas, width: pendingW, height: pendingH, backgroundColor: 0x201a18, antialias: false, roundPixels: true, resolution: 1, preference: 'webgl' }).then(() => {
    if (destroyed) { app.destroy(true); return }
    initialized = true; app.renderer.resize(pendingW, pendingH)
    app.stage.addChild(stageVignette, baseAndFloors, aoShadows, cutawayWalls, ySortedEntities, warmLighting)
    app.ticker.add(drawFrame); drawFrame()
  })
  return {
    resize: (w: number, h: number) => { pendingW = w; pendingH = h; if (initialized && !destroyed) app.renderer.resize(w, h) },
    destroy: () => {
      destroyed = true; for (const lbl of wingLabels.values()) lbl.destroy(); wingLabels.clear()
      for (const g of fgPool) g.destroy(); fgPool.length = 0; if (initialized) { app.ticker.remove(drawFrame); app.destroy(true) }
    },
  }
}
