/** PixiJS v8 七层微缩沙盘 WebGL 渲染引擎（纯浏览器端无服务端依赖）。 */
import { Application, Container, Graphics, ImageSource, Rectangle, Sprite, Text, TextStyle, Texture } from 'pixi.js'
import { HIGHLIGHT_GOLD, STATUS_GLOW_COLORS } from './catalog.ts'
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import type { OfficeActor } from './iso-engine.ts'
import type { RoomEntity, RoomWallMount } from './layout-solver.ts'
import { worldIsoToScreen } from './world-renderer.ts'
import type { OfficeCamera, OfficeWorldPlan, WorldSceneState, WorldWingPlan } from './world-types.ts'

export const DIORAMA_LAYER_NAMES = [
  'stageVignette', 'baseAndFloors', 'aoShadows', 'cutawayWalls', 'ySortedEntities', 'warmLighting',
] as const

export const createDioramaLayerNames = (): readonly string[] => [...DIORAMA_LAYER_NAMES]

export interface PixiDioramaSourceState {
  readonly scene: WorldSceneState
  readonly camera: OfficeCamera
  readonly images: Record<string, CanvasImageSource>
}

export interface PixiDioramaHandle {
  resize: (w: number, h: number) => void
  destroy: () => void
}

function inWing(u: number, v: number, w: WorldWingPlan): boolean {
  if (u < w.rect.u || u >= w.rect.u + w.rect.w || v < w.rect.v || v >= w.rect.v + w.rect.h) return false
  return !w.chamferSE || (u - w.rect.u) + (v - w.rect.v) < w.rect.w + w.rect.h - 1 - w.chamferSE
}

function tileAt(u: number, v: number, world: OfficeWorldPlan): string | null {
  const c = world.corridorRect
  if (u >= c.u && u < c.u + c.w && v >= c.v && v < c.v + c.h) return 'corridor_tile'
  for (const w of world.wings) if (inWing(u, v, w)) return w.floorStyle === 'warm_parquet' ? 'corridor_tile' : w.kind === 'studio' ? 'floor_wood' : 'stone_tile'
  const inApron = u >= -1 && u <= world.buildingCols && v >= -1 && v <= world.buildingRows + 1
  return inApron || (u >= 9 && u <= 12 && v >= world.buildingRows && v <= world.buildingRows + 2) ? 'stone_tile' : null
}

function makeChairs(suite: RoomEntity): RoomEntity[] {
  if (suite.assetId === 'desk_cluster') {
    return [
      { id: `chair-${suite.id}-a`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u: suite.anchor.u + 1.8, v: suite.anchor.v - 0.6 }, size: [1, 1], facing: 'SW', mirrorX: true, footprint: [] },
      { id: `chair-${suite.id}-b`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u: suite.anchor.u - 0.5, v: suite.anchor.v + 1.5 }, size: [1, 1], facing: 'SE', mirrorX: false, footprint: [] },
    ]
  }
  const isRec = suite.suiteKind === 'reception', isExec = suite.suiteKind === 'executive', faceSE = isRec || suite.facing === 'SE'
  const u = isRec ? suite.anchor.u - 0.7 : isExec ? suite.anchor.u + 0.95 : faceSE ? suite.anchor.u - 0.7 : suite.anchor.u + 0.55
  const v = isRec ? suite.anchor.v + 0.9 : isExec ? suite.anchor.v - 0.95 : faceSE ? suite.anchor.v + 0.55 : suite.anchor.v - 0.7
  return [{ id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u, v }, size: [1, 1], facing: faceSE ? 'SE' : 'SW', mirrorX: !faceSE, footprint: [] }]
}

const hexNum = (hex: string): number => Number.parseInt(hex.slice(1), 16)

export function mountPixiDioramaStage(canvas: HTMLCanvasElement, getState: () => PixiDioramaSourceState): PixiDioramaHandle {
  let destroyed = false, initialized = false
  const app = new Application()
  const sources = new Map<HTMLImageElement, ImageSource>()
  const baseTextures = new Map<string, Texture>()
  const charTextures = new Map<string, Texture>()

  const getTex = (id: string, images: Record<string, CanvasImageSource>): Texture | null => {
    const img = images[id]
    if (!(img instanceof HTMLImageElement) || !img.complete || img.naturalWidth === 0) return null
    let src = sources.get(img)
    if (!src) { src = new ImageSource({ resource: img, scaleMode: 'nearest' }); sources.set(img, src) }
    let tex = baseTextures.get(id)
    if (!tex) { tex = new Texture({ source: src }); baseTextures.set(id, tex) }
    return tex
  }

  const getCharTex = (role: string, col: number, row: number, images: Record<string, CanvasImageSource>): Texture | null => {
    const img = images[`char_${role}`]
    if (!(img instanceof HTMLImageElement) || !img.complete || img.naturalWidth === 0) return null
    let src = sources.get(img)
    if (!src) { src = new ImageSource({ resource: img, scaleMode: 'nearest' }); sources.set(img, src) }
    const key = `${role}:${col}:${row}`
    let tex = charTextures.get(key)
    if (!tex) { tex = new Texture({ source: src, frame: new Rectangle(col * 32, row * 48, 32, 48) }); charTextures.set(key, tex) }
    return tex
  }

  const stageVignette = new Graphics()
  const baseAndFloors = new Container()
  const aoShadows = new Graphics(); aoShadows.blendMode = 'multiply'
  const cutawayWalls = new Container()
  const wallGfx = new Graphics()
  const ySortedEntities = new Container(); ySortedEntities.sortableChildren = true
  const warmLighting = new Container()
  const lightGfx = new Graphics()

  const addSp = (parent: Container, tex: Texture, x: number, y: number, w: number, h: number, mirrorX = false, zIndex = 0) => {
    const sp = new Sprite(tex)
    sp.width = w; sp.height = h; sp.x = mirrorX ? x + w : x; sp.y = y
    if (mirrorX) sp.scale.x = -Math.abs(sp.scale.x)
    sp.zIndex = zIndex
    parent.addChild(sp)
  }

  const drawFrame = () => {
    if (destroyed || !initialized) return
    const { scene, camera, images } = getState()
    const { world, actors, screenStates, gateIntercept, hoverTarget, elapsedMs } = scene
    const z = camera.zoom, cw = app.screen.width, ch = app.screen.height

    stageVignette.clear()
    stageVignette.rect(0, 0, cw, ch).fill(0x201a18)
    stageVignette.ellipse(Math.round(cw * 0.52), Math.round(ch * 0.50), Math.round(cw * 0.44), Math.round(ch * 0.42)).fill({ color: 0x302722, alpha: 0.72 })

    baseAndFloors.removeChildren()
    for (let v = -1; v <= world.buildingRows + 2; v++) for (let u = -1; u <= world.buildingCols; u++) {
      const id = tileAt(u, v, world), tex = id ? getTex(id, images) : null; if (!tex) continue
      const p = worldIsoToScreen(u + 0.5, v + 0.5, world, camera)
      addSp(baseAndFloors, tex, Math.round(p.x - 16 * z), Math.round(p.y - 8 * z), 32 * z, 16 * z)
    }
    const runner = getTex('runner_navy', images) ?? getTex('corridor_runner', images)
    if (runner) for (let v = 2; v < world.buildingRows - 1; v += 2) {
      const p = worldIsoToScreen(11, v + 1, world, camera); addSp(baseAndFloors, runner, Math.round(p.x - 32 * z), Math.round(p.y - 16 * z), 64 * z, 32 * z)
    }
    const wmat = getTex('welcome_mat', images)
    if (wmat) { const p = worldIsoToScreen(11, world.buildingRows + 1, world, camera); addSp(baseAndFloors, wmat, Math.round(p.x - 32 * z), Math.round(p.y - 16 * z), 64 * z, 32 * z) }
    for (const w of world.wings) if (w.kind === 'studio' && w.rugRect) {
      const rug = getTex(`rug_${w.rugStyle ?? 'woven'}`, images) ?? getTex('rug_woven', images)
      if (rug) { const p = worldIsoToScreen(w.rugRect.u + w.rugRect.w / 2, w.rugRect.v + w.rugRect.h / 2, world, camera); addSp(baseAndFloors, rug, Math.round(p.x - 64 * z), Math.round(p.y - 32 * z), 128 * z, 64 * z) }
    }

    aoShadows.clear()
    for (let u = 0; u < world.buildingCols; u++) { const p = worldIsoToScreen(u + 0.5, 0.35, world, camera); aoShadows.ellipse(p.x, p.y, 16 * z, 6 * z).fill({ color: 0x1a1412, alpha: 0.28 }) }
    for (let v = 0; v < 15; v++) { const p = worldIsoToScreen(0.35, v + 0.5, world, camera); aoShadows.ellipse(p.x, p.y, 16 * z, 6 * z).fill({ color: 0x1a1412, alpha: 0.28 }) }
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

    cutawayWalls.removeChildren(); wallGfx.clear(); cutawayWalls.addChild(wallGfx)
    const wallTex = getTex('wall_segment', images)
    if (wallTex) {
      for (let u = 0; u < world.buildingCols; u += 2) { const p = worldIsoToScreen(u + 1, 0, world, camera); addSp(cutawayWalls, wallTex, Math.round(p.x - 16 * z), Math.round(p.y - 72 * z), 32 * z, 80 * z, true) }
      for (let v = 0; v < 15; v += 2) { const p = worldIsoToScreen(0, v + 1, world, camera); addSp(cutawayWalls, wallTex, Math.round(p.x - 16 * z), Math.round(p.y - 72 * z), 32 * z, 80 * z, false) }
    }
    const drawMount = (m: RoomWallMount, bu: number, bv: number) => {
      const meta = WORLD_ASSET_CATALOG[m.assetId], tex = getTex(m.assetId, images); if (!meta || !tex) return
      const p = m.wall === 'back' ? worldIsoToScreen(m.at, bv, world, camera) : worldIsoToScreen(bu, m.at, world, camera)
      const w = meta.nativeSize[0] * z, h = meta.nativeSize[1] * z
      addSp(cutawayWalls, tex, Math.round(p.x - w / 2), Math.round(p.y - h - m.h * z), w, h, m.wall === 'back')
    }
    for (const m of world.lobby.wallMounts) drawMount(m, 0, 0)
    for (const w of world.wings) {
      for (const m of w.wallMounts.filter((wm) => wm.propKind !== 'doorplate')) drawMount(m, w.rect.u, w.rect.v)
      const dpTex = w.kind === 'studio' && w.workspaceId ? getTex('doorplate', images) : null
      if (dpTex) {
        const dp = worldIsoToScreen(w.rect.u === 0 ? w.doorway.u + 0.8 : w.doorway.u + 0.2, w.doorway.v - 0.8, world, camera)
        addSp(cutawayWalls, dpTex, Math.round(dp.x - 12 * z), Math.round(dp.y - 34 * z), 24 * z, 16 * z)
      }
    }
    for (const pw of world.partitionWalls) {
      const p1 = pw.axis === 'u' ? worldIsoToScreen(pw.fixed, pw.start, world, camera) : worldIsoToScreen(pw.start, pw.fixed, world, camera)
      const p2 = pw.axis === 'u' ? worldIsoToScreen(pw.fixed, pw.end, world, camera) : worldIsoToScreen(pw.end, pw.fixed, world, camera)
      const steps = Math.max(1, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y) / (2 * z)))
      for (let i = 0; i <= steps; i++) {
        const wx = Math.round(p1.x + (p2.x - p1.x) * (i / steps) - 2 * z), wy = Math.round(p1.y + (p2.y - p1.y) * (i / steps) - 22 * z)
        wallGfx.rect(wx - z, wy - z, 5 * z, 23 * z).fill(0x1a1412)
      }
      for (let i = 0; i <= steps; i++) {
        const wx = Math.round(p1.x + (p2.x - p1.x) * (i / steps) - 2 * z), wy = Math.round(p1.y + (p2.y - p1.y) * (i / steps) - 22 * z)
        wallGfx.rect(wx, wy, 4 * z, 4 * z).fill(0x4a3428)
        wallGfx.rect(wx, wy + 4 * z, 4 * z, 12 * z).fill(pw.axis === 'u' ? 0xbfa48c : 0xd9c4a8)
        wallGfx.rect(wx, wy + 16 * z, 4 * z, 5 * z).fill(0x6b4a32)
      }
    }
    const doorWood = getTex('door_wood', images)
    if (doorWood) for (const d of world.interiorDoors ?? []) {
      const dp = worldIsoToScreen(d.u, d.v + 1, world, camera)
      addSp(cutawayWalls, doorWood, Math.round(dp.x - 20 * z), Math.round(dp.y - 58 * z), 40 * z, 64 * z, d.axis === 'v')
    }
    for (const f of world.frontFacade ?? []) {
      const p1 = worldIsoToScreen(f.from.u, f.from.v, world, camera), p2 = worldIsoToScreen(f.to.u, f.to.v, world, camera)
      const steps = Math.max(1, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y) / (2 * z))), fh = f.heightPx * z
      for (let i = 0; i <= steps; i++) {
        const fx = Math.round(p1.x + (p2.x - p1.x) * (i / steps) - z), fy = Math.round(p1.y + (p2.y - p1.y) * (i / steps) - fh)
        wallGfx.rect(fx - z, fy - z, 4 * z, fh + 2 * z).fill(0x1a1412)
        wallGfx.rect(fx, fy, 3 * z, 4 * z).fill(0x4a3428)
        wallGfx.rect(fx, fy + 4 * z, 3 * z, fh - 4 * z).fill(0x7a6150)
      }
      const fwin = f.hasWindow ? getTex('facade_window', images) : null
      if (fwin) { const wp = worldIsoToScreen((f.from.u + f.to.u) / 2, (f.from.v + f.to.v) / 2, world, camera); addSp(cutawayWalls, fwin, Math.round(wp.x - 32 * z), Math.round(wp.y - 36 * z), 64 * z, 40 * z, true) }
    }
    const dglass = getTex('door_glass', images)
    if (dglass) { const dp = worldIsoToScreen(11, world.buildingRows, world, camera); addSp(cutawayWalls, dglass, Math.round(dp.x - 40 * z), Math.round(dp.y - 52 * z), 80 * z, 56 * z, true) }

    ySortedEntities.removeChildren()
    for (const e of allEntities) {
      const meta = WORLD_ASSET_CATALOG[e.assetId], tex = getTex(e.assetId, images); if (!meta || !tex) continue
      const p = worldIsoToScreen(e.anchor.u + e.size[0] / 2, e.anchor.v + e.size[1] / 2, world, camera)
      const footY = Math.round(worldIsoToScreen(e.anchor.u + e.size[0], e.anchor.v + e.size[1], world, camera).y)
      addSp(ySortedEntities, tex, Math.round(p.x - meta.anchor[0] * z), Math.round(p.y - meta.anchor[1] * z), meta.nativeSize[0] * z, meta.nativeSize[1] * z, e.mirrorX, footY)
      if (e.suiteKind !== 'shared') {
        const ctex = getTex('office_chair', images), cm = WORLD_ASSET_CATALOG.office_chair
        if (ctex && cm) for (const ch of makeChairs(e)) {
          const cp = worldIsoToScreen(ch.anchor.u + 0.5, ch.anchor.v + 0.5, world, camera)
          addSp(ySortedEntities, ctex, Math.round(cp.x - cm.anchor[0] * z), Math.round(cp.y - cm.anchor[1] * z), cm.nativeSize[0] * z, cm.nativeSize[1] * z, ch.mirrorX, footY - 6)
        }
      }
    }
    for (const a of actors as readonly OfficeActor[]) {
      if (a.lifecycle === 'removed') continue
      const col = a.pose === 'idle' ? 0 : a.pose === 'walkA' ? 1 : a.pose === 'walkB' ? 2 : 3
      const tex = getCharTex(a.role, col, a.facing === 'SW' || a.facing === 'NW' ? 1 : 0, images); if (!tex) continue
      const p = worldIsoToScreen(a.u + 0.5, a.v + 0.5, world, camera)
      const bob = a.pose === 'sit' && Math.floor(elapsedMs / 500) % 2 === 1 ? 1 : 0
      const suite = a.pose === 'sit' && a.assignedSuiteId ? suites.find((s) => s.id === a.assignedSuiteId) : undefined
      const zY = suite ? Math.round(worldIsoToScreen(suite.anchor.u + suite.size[0], suite.anchor.v + suite.size[1], world, camera).y) - 3 : Math.round(p.y) + 1
      addSp(ySortedEntities, tex, Math.round(p.x - 16 * z), Math.round(p.y - 44 * z) + bob, 32 * z, 48 * z, false, zY)
    }

    warmLighting.removeChildren(); lightGfx.clear(); warmLighting.addChild(lightGfx)
    for (const ls of world.lightSources ?? []) {
      const p = worldIsoToScreen(ls.u, ls.v, world, camera)
      lightGfx.ellipse(p.x, p.y, ls.radiusTiles * 14 * z, ls.radiusTiles * 8 * z).fill({ color: ls.kind === 'window' ? 0xe8dccb : 0xf2a93b, alpha: ls.intensity * 0.75 })
    }
    for (const suite of suites) {
      const meta = WORLD_ASSET_CATALOG[suite.assetId], st = screenStates[suite.id]
      if (!meta?.screenGlowAnchors || !st || st === 'off') continue
      const p = worldIsoToScreen(suite.anchor.u + suite.size[0] / 2, suite.anchor.v + suite.size[1] / 2, world, camera)
      const bx = Math.round(p.x - meta.anchor[0] * z), by = Math.round(p.y - meta.anchor[1] * z), bw = meta.nativeSize[0] * z, bh = meta.nativeSize[1] * z
      for (const a of meta.screenGlowAnchors) {
        const gx = bx + bw / 2 + (suite.mirrorX ? -a.dx : a.dx) * z, gy = by + bh + a.dy * z
        lightGfx.rect(Math.round(gx - 5 * z), Math.round(gy - 3 * z), 10 * z, 6 * z).fill(hexNum(STATUS_GLOW_COLORS[st].bright))
      }
    }
    for (const w of world.wings) {
      const pos = worldIsoToScreen(w.rect.u + w.rect.w / 2, w.rect.v + Math.min(4.2, w.rect.h / 2), world, camera)
      const bw = Math.max(72, w.title.length * 10 + 14) * z, bh = 16 * z, bx = Math.round(pos.x - bw / 2), by = Math.round(pos.y - bh)
      lightGfx.rect(bx, by, bw, bh).fill({ color: 0x201a18, alpha: 0.88 }).stroke({ color: hexNum(w.workspaceId && w.workspaceId === scene.activeWorkspaceId ? HIGHLIGHT_GOLD : '#6B4A32'), width: z })
      const label = new Text({ text: w.title, style: new TextStyle({ fontFamily: 'monospace', fontSize: 10 * z, fill: 0xe8dccb }) })
      label.x = bx + 6 * z; label.y = by + 2 * z; warmLighting.addChild(label)
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

  void app.init({ canvas, width: canvas.width || 1440, height: canvas.height || 900, backgroundColor: 0x201a18, antialias: false, roundPixels: true, resolution: 1, preference: 'webgl' })
    .then(() => {
      if (destroyed) { app.destroy(true); return }
      initialized = true
      app.stage.addChild(stageVignette, baseAndFloors, aoShadows, cutawayWalls, ySortedEntities, warmLighting)
      app.ticker.add(drawFrame)
      drawFrame()
    })

  return {
    resize: (w: number, h: number) => { if (initialized && !destroyed) app.renderer.resize(w, h) },
    destroy: () => { destroyed = true; if (initialized) { app.ticker.remove(drawFrame); app.destroy(true) } },
  }
}
