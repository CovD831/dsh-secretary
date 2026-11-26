/** PixiJS v8 七层微缩沙盘 WebGL 渲染引擎（零 node: 依赖）。 */
import { Application, Container, Graphics, ImageSource, Rectangle, Sprite, Texture } from 'pixi.js'
import { HIGHLIGHT_GOLD, STATUS_GLOW_COLORS } from './catalog.ts'
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import type { OfficeActor } from './iso-engine.ts'
import type { RoomEntity } from './layout-solver.ts'
import { worldIsoToScreen } from './world-renderer.ts'
import type { OfficeCamera, OfficeWorldPlan, WorldSceneState, WorldWingPlan } from './world-types.ts'

export const DIORAMA_LAYER_NAMES = [
  'stageVignette',
  'baseAndFloors',
  'aoShadows',
  'cutawayWalls',
  'ySortedEntities',
  'warmLighting',
] as const

export function createDioramaLayerNames(): readonly string[] {
  return [...DIORAMA_LAYER_NAMES]
}

export interface PixiDioramaSourceState {
  readonly scene: WorldSceneState
  readonly camera: OfficeCamera
  readonly images: Record<string, HTMLImageElement>
}

export interface PixiDioramaHandle {
  resize: (w: number, h: number) => void
  destroy: () => void
}

function inWing(u: number, v: number, w: WorldWingPlan): boolean {
  if (u < w.rect.u || u >= w.rect.u + w.rect.w || v < w.rect.v || v >= w.rect.v + w.rect.h) return false
  if (!w.chamferSE) return true
  return (u - w.rect.u) + (v - w.rect.v) < w.rect.w + w.rect.h - 1 - w.chamferSE
}

function tileAt(u: number, v: number, world: OfficeWorldPlan): string | null {
  const c = world.corridorRect
  if (u >= c.u && u < c.u + c.w && v >= c.v && v < c.v + c.h) return 'corridor_tile'
  for (const w of world.wings) if (inWing(u, v, w)) return w.kind === 'studio' ? 'floor_wood' : 'stone_tile'
  const inApron = u >= -1 && u <= world.buildingCols && v >= -1 && v <= world.buildingRows + 1
  const inEntry = u >= 9 && u <= 12 && v >= world.buildingRows && v <= world.buildingRows + 2
  return inApron || inEntry ? 'stone_tile' : null
}

function makeChair(suite: RoomEntity): RoomEntity {
  const isRec = suite.suiteKind === 'reception', isExec = suite.suiteKind === 'executive', faceSE = isRec || suite.facing === 'SE'
  const u = isRec ? suite.anchor.u - 0.7 : isExec ? suite.anchor.u + 0.95 : faceSE ? suite.anchor.u - 0.7 : suite.anchor.u + 0.55
  const v = isRec ? suite.anchor.v + 0.9 : isExec ? suite.anchor.v - 0.95 : faceSE ? suite.anchor.v + 0.55 : suite.anchor.v - 0.7
  return { id: `chair-${suite.id}`, assetId: 'office_chair', suiteKind: 'shared', anchor: { u, v }, size: [1, 1], facing: faceSE ? 'SE' : 'SW', mirrorX: !faceSE, footprint: [] }
}

const hexNum = (hex: string): number => Number.parseInt(hex.slice(1), 16)

export function mountPixiDioramaStage(
  canvas: HTMLCanvasElement,
  getState: () => PixiDioramaSourceState,
): PixiDioramaHandle {
  let destroyed = false
  let initialized = false
  const app = new Application()
  const sources = new Map<HTMLImageElement, ImageSource>()
  const baseTextures = new Map<string, Texture>()
  const charTextures = new Map<string, Texture>()

  const getTex = (id: string, images: Record<string, HTMLImageElement>): Texture | null => {
    const img = images[id]
    if (!img || !img.complete || img.naturalWidth === 0) return null
    let src = sources.get(img)
    if (!src) { src = new ImageSource({ resource: img, scaleMode: 'nearest' }); sources.set(img, src) }
    let tex = baseTextures.get(id)
    if (!tex) { tex = new Texture({ source: src }); baseTextures.set(id, tex) }
    return tex
  }

  const getCharTex = (role: string, col: number, row: number, images: Record<string, HTMLImageElement>): Texture | null => {
    const img = images[`char_${role}`]
    if (!img || !img.complete || img.naturalWidth === 0) return null
    let src = sources.get(img)
    if (!src) { src = new ImageSource({ resource: img, scaleMode: 'nearest' }); sources.set(img, src) }
    const key = `${role}:${col}:${row}`
    let tex = charTextures.get(key)
    if (!tex) { tex = new Texture({ source: src, frame: new Rectangle(col * 32, row * 48, 32, 48) }); charTextures.set(key, tex) }
    return tex
  }

  const stageVignette = new Graphics()
  const baseAndFloors = new Container()
  const aoShadows = new Graphics()
  aoShadows.blendMode = 'multiply'
  const cutawayWalls = new Container()
  const wallGfx = new Graphics()
  const ySortedEntities = new Container()
  ySortedEntities.sortableChildren = true
  const warmLighting = new Graphics()

  const addSprite = (parent: Container, tex: Texture, x: number, y: number, w: number, h: number, mirrorX = false, zIndex = 0) => {
    const sp = new Sprite(tex)
    sp.width = w
    sp.height = h
    sp.x = mirrorX ? x + w : x
    sp.y = y
    if (mirrorX) sp.scale.x = -Math.abs(sp.scale.x)
    sp.zIndex = zIndex
    parent.addChild(sp)
  }

  const drawFrame = () => {
    if (destroyed || !initialized) return
    const { scene, camera, images } = getState()
    const { world, actors, screenStates, hoverTarget, elapsedMs } = scene
    const z = camera.zoom, cw = app.screen.width, ch = app.screen.height

    stageVignette.clear()
    stageVignette.rect(0, 0, cw, ch).fill(0x201a18)
    stageVignette.rect(Math.round(cw * 0.08), Math.round(ch * 0.08), Math.round(cw * 0.84), Math.round(ch * 0.84)).fill(0x2b221e)

    baseAndFloors.removeChildren()
    for (let v = -1; v <= world.buildingRows + 2; v++) for (let u = -1; u <= world.buildingCols; u++) {
      const id = tileAt(u, v, world); if (!id) continue
      const tex = getTex(id, images); if (!tex) continue
      const p = worldIsoToScreen(u + 0.5, v + 0.5, world, camera)
      addSprite(baseAndFloors, tex, Math.round(p.x - 16 * z), Math.round(p.y - 8 * z), 32 * z, 16 * z)
    }
    const runner = getTex('runner_navy', images) ?? getTex('corridor_runner', images)
    if (runner) for (let v = 2; v < world.buildingRows - 1; v += 2) {
      const p = worldIsoToScreen(11, v + 1, world, camera)
      addSprite(baseAndFloors, runner, Math.round(p.x - 32 * z), Math.round(p.y - 16 * z), 64 * z, 32 * z)
    }
    const wmat = getTex('welcome_mat', images)
    if (wmat) {
      const p = worldIsoToScreen(11, world.buildingRows + 1, world, camera)
      addSprite(baseAndFloors, wmat, Math.round(p.x - 32 * z), Math.round(p.y - 16 * z), 64 * z, 32 * z)
    }
    for (const w of world.wings) if (w.kind === 'studio' && w.rugRect) {
      const rug = getTex(`rug_${w.rugStyle ?? 'woven'}`, images) ?? getTex('rug_woven', images)
      if (rug) { const p = worldIsoToScreen(w.rugRect.u + w.rugRect.w / 2, w.rugRect.v + w.rugRect.h / 2, world, camera); addSprite(baseAndFloors, rug, Math.round(p.x - 64 * z), Math.round(p.y - 32 * z), 128 * z, 64 * z) }
    }

    aoShadows.clear()
    const suites = [...world.lobby.suites, ...world.wings.flatMap((w) => w.suites)]
    const allEntities = [...suites, ...world.lobby.shared, ...world.wings.flatMap((w) => w.shared), ...world.exteriorProps]
    for (const e of allEntities) {
      const meta = WORLD_ASSET_CATALOG[e.assetId]; if (!meta) continue
      const p = worldIsoToScreen(e.anchor.u + e.size[0] / 2, e.anchor.v + e.size[1] / 2, world, camera)
      aoShadows.ellipse(Math.round(p.x + 2 * z), Math.round(p.y + 2 * z), Math.round(meta.nativeSize[0] * 0.36 * z), Math.round(meta.nativeSize[1] * 0.14 * z)).fill({ color: 0x1a1210, alpha: 0.34 })
    }
    for (const a of actors) if (a.lifecycle !== 'removed') {
      const p = worldIsoToScreen(a.u + 0.5, a.v + 0.5, world, camera)
      aoShadows.ellipse(Math.round(p.x + 2 * z), Math.round(p.y + 2 * z), 9 * z, 4 * z).fill({ color: 0x1a1210, alpha: 0.34 })
    }

    cutawayWalls.removeChildren()
    wallGfx.clear()
    cutawayWalls.addChild(wallGfx)
    const wallTex = getTex('wall_segment', images)
    if (wallTex) {
      for (let u = 0; u < world.buildingCols; u += 2) { const p = worldIsoToScreen(u + 1, 0, world, camera); addSprite(cutawayWalls, wallTex, Math.round(p.x - 16 * z), Math.round(p.y - 72 * z), 32 * z, 80 * z, true) }
      for (let v = 0; v < 15; v += 2) { const p = worldIsoToScreen(0, v + 1, world, camera); addSprite(cutawayWalls, wallTex, Math.round(p.x - 16 * z), Math.round(p.y - 72 * z), 32 * z, 80 * z, false) }
    }
    for (const pw of world.partitionWalls) {
      const p1 = pw.axis === 'u' ? worldIsoToScreen(pw.fixed, pw.start, world, camera) : worldIsoToScreen(pw.start, pw.fixed, world, camera)
      const p2 = pw.axis === 'u' ? worldIsoToScreen(pw.fixed, pw.end, world, camera) : worldIsoToScreen(pw.end, pw.fixed, world, camera)
      const steps = Math.max(1, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y) / (2 * z)))
      for (let i = 0; i <= steps; i++) {
        const wx = Math.round(p1.x + (p2.x - p1.x) * (i / steps) - 2 * z), wy = Math.round(p1.y + (p2.y - p1.y) * (i / steps) - 20 * z)
        wallGfx.rect(wx - z, wy - z, 5 * z, 21 * z).fill(0x1a1412)
        wallGfx.rect(wx, wy, 3 * z, 4 * z).fill(0x6b4a32)
        wallGfx.rect(wx, wy + 4 * z, 3 * z, 10 * z).fill(pw.axis === 'u' ? 0xbfa48c : 0xd9c4a8)
        wallGfx.rect(wx, wy + 14 * z, 3 * z, 5 * z).fill(0x4a3428)
      }
    }
    const doorWood = getTex('door_wood', images)
    if (doorWood) for (const d of world.interiorDoors ?? []) {
      const dp = worldIsoToScreen(d.u, d.v + 1, world, camera)
      addSprite(cutawayWalls, doorWood, Math.round(dp.x - 20 * z), Math.round(dp.y - 58 * z), 40 * z, 64 * z)
    }
    for (const f of world.frontFacade ?? []) {
      const p1 = worldIsoToScreen(f.from.u, f.from.v, world, camera), p2 = worldIsoToScreen(f.to.u, f.to.v, world, camera)
      const steps = Math.max(1, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y) / (2 * z))), fh = f.heightPx * z
      for (let i = 0; i <= steps; i++) {
        const fx = Math.round(p1.x + (p2.x - p1.x) * (i / steps) - z), fy = Math.round(p1.y + (p2.y - p1.y) * (i / steps) - fh)
        wallGfx.rect(fx - z, fy - z, 4 * z, fh + 2 * z).fill(0x1a1412)
        wallGfx.rect(fx, fy, 3 * z, 4 * z).fill(0x4a3428)
        wallGfx.rect(fx, fy + 4 * z, 3 * z, fh - 4 * z).fill(0x8c6d56)
      }
      const fwin = f.hasWindow ? getTex('facade_window', images) : null
      if (fwin) { const wp = worldIsoToScreen((f.from.u + f.to.u) / 2, (f.from.v + f.to.v) / 2, world, camera); addSprite(cutawayWalls, fwin, Math.round(wp.x - 32 * z), Math.round(wp.y - 36 * z), 64 * z, 40 * z) }
    }
    const dglass = getTex('door_glass', images)
    if (dglass) { const dp = worldIsoToScreen(11, world.buildingRows, world, camera); addSprite(cutawayWalls, dglass, Math.round(dp.x - 40 * z), Math.round(dp.y - 52 * z), 80 * z, 56 * z) }

    ySortedEntities.removeChildren()
    for (const e of allEntities) {
      const meta = WORLD_ASSET_CATALOG[e.assetId], tex = getTex(e.assetId, images); if (!meta || !tex) continue
      const p = worldIsoToScreen(e.anchor.u + e.size[0] / 2, e.anchor.v + e.size[1] / 2, world, camera)
      const footY = Math.round(worldIsoToScreen(e.anchor.u + e.size[0], e.anchor.v + e.size[1], world, camera).y)
      addSprite(ySortedEntities, tex, Math.round(p.x - meta.anchor[0] * z), Math.round(p.y - meta.anchor[1] * z), meta.nativeSize[0] * z, meta.nativeSize[1] * z, e.mirrorX, footY)
      if (e.suiteKind !== 'shared') {
        const ch = makeChair(e), ctex = getTex('office_chair', images), cm = WORLD_ASSET_CATALOG.office_chair
        if (ctex && cm) {
          const cp = worldIsoToScreen(ch.anchor.u + 0.5, ch.anchor.v + 0.5, world, camera)
          addSprite(ySortedEntities, ctex, Math.round(cp.x - cm.anchor[0] * z), Math.round(cp.y - cm.anchor[1] * z), cm.nativeSize[0] * z, cm.nativeSize[1] * z, ch.mirrorX, footY - 6)
        }
      }
    }
    for (const a of actors as readonly OfficeActor[]) {
      if (a.lifecycle === 'removed') continue
      const col = a.pose === 'idle' ? 0 : a.pose === 'walkA' ? 1 : a.pose === 'walkB' ? 2 : 3
      const row = a.facing === 'SW' || a.facing === 'NW' ? 1 : 0
      const tex = getCharTex(a.role, col, row, images); if (!tex) continue
      const p = worldIsoToScreen(a.u + 0.5, a.v + 0.5, world, camera)
      const bob = a.pose === 'sit' && Math.floor(elapsedMs / 500) % 2 === 1 ? 1 : 0
      addSprite(ySortedEntities, tex, Math.round(p.x - 16 * z), Math.round(p.y - 44 * z) + bob, 32 * z, 48 * z, false, Math.round(p.y) + 1)
    }

    warmLighting.clear()
    for (const ls of world.lightSources ?? []) {
      const p = worldIsoToScreen(ls.u, ls.v, world, camera)
      warmLighting.ellipse(p.x, p.y, ls.radiusTiles * 14 * z, ls.radiusTiles * 8 * z).fill({ color: ls.kind === 'window' ? 0xffe8b2 : 0xf2a93b, alpha: ls.intensity })
    }
    for (const suite of suites) {
      const meta = WORLD_ASSET_CATALOG[suite.assetId], st = screenStates[suite.id]
      if (!meta?.screenGlowAnchors || !st || st === 'off') continue
      const p = worldIsoToScreen(suite.anchor.u + suite.size[0] / 2, suite.anchor.v + suite.size[1] / 2, world, camera)
      const bx = Math.round(p.x - meta.anchor[0] * z), by = Math.round(p.y - meta.anchor[1] * z), bw = meta.nativeSize[0] * z, bh = meta.nativeSize[1] * z
      for (const a of meta.screenGlowAnchors) {
        const gx = bx + bw / 2 + (suite.mirrorX ? -a.dx : a.dx) * z, gy = by + bh + a.dy * z
        warmLighting.rect(Math.round(gx - 5 * z), Math.round(gy - 3 * z), 10 * z, 6 * z).fill(hexNum(STATUS_GLOW_COLORS[st].bright))
      }
    }
    if (hoverTarget) {
      warmLighting.rect(hoverTarget.bounds.x, hoverTarget.bounds.y, hoverTarget.bounds.w, hoverTarget.bounds.h).stroke({ color: hexNum(HIGHLIGHT_GOLD), width: z })
    }
  }

  void app.init({
    canvas,
    width: canvas.width || 1440,
    height: canvas.height || 900,
    backgroundColor: 0x201a18,
    antialias: false,
    roundPixels: true,
    resolution: 1,
    preference: 'webgl',
  }).then(() => {
    if (destroyed) { app.destroy(true); return }
    initialized = true
    app.stage.addChild(stageVignette, baseAndFloors, aoShadows, cutawayWalls, ySortedEntities, warmLighting)
    app.ticker.add(drawFrame)
    drawFrame()
  })

  return {
    resize: (w: number, h: number) => { if (initialized && !destroyed) app.renderer.resize(w, h) },
    destroy: () => {
      destroyed = true
      if (initialized) {
        app.ticker.remove(drawFrame)
        app.destroy(true)
      }
    },
  }
}
