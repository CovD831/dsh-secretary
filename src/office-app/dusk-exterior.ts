/** 档位一纹理化暗调黄昏街角（支持东向单平面动态延展）、待入驻搬家纸箱与街景道具（零新 PNG）。 */
import { type Container, type Graphics, Sprite, type Texture } from 'pixi.js'
import { SHADOW_PAD, getContactShadowTexture } from './contact-shadow.ts'
import { type StreetSpriteMeta, getStreetSpriteAtlas } from './street-sprites.ts'
import { worldIsoToScreen } from './world-renderer.ts'
import type { OfficeCamera, OfficeWorldPlan, WorldWingPlan } from './world-types.ts'

const groundPool: Sprite[] = [], propPool: Sprite[] = [], propShadowPool: Sprite[] = []

function isoQuad(gfx: Graphics, world: OfficeWorldPlan, cam: OfficeCamera, u0: number, v0: number, u1: number, v1: number, color: number, alpha = 1, strokeCol?: number, strokeW = 1): void {
  const p0 = worldIsoToScreen(u0, v0, world, cam), p1 = worldIsoToScreen(u1, v0, world, cam)
  const p2 = worldIsoToScreen(u1, v1, world, cam), p3 = worldIsoToScreen(u0, v1, world, cam)
  gfx.poly([p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y]).fill({ color, alpha })
  if (strokeCol !== undefined) gfx.stroke({ color: strokeCol, width: strokeW })
}

function drawEdgeStrip(gfx: Graphics, world: OfficeWorldPlan, cam: OfficeCamera, u0: number, v0: number, u1: number, v1: number, h: number, topCol: number, faceCol: number): void {
  const z = cam.zoom, a = worldIsoToScreen(u0, v0, world, cam), b = worldIsoToScreen(u1, v1, world, cam)
  gfx.poly([a.x, a.y - h * z, b.x, b.y - h * z, b.x, b.y, a.x, a.y]).fill(faceCol).stroke({ color: 0x1a1412, width: Math.max(1, z) })
  gfx.moveTo(a.x, a.y - h * z).lineTo(b.x, b.y - h * z).stroke({ color: topCol, width: Math.max(1, z) })
}

function vacantBoxPoint(w: WorldWingPlan): { u: number; v: number } {
  if (!w.cells?.length) return w.focusPoint
  let best = w.cells[0]!, bestD = Infinity
  for (const c of w.cells) {
    const d = Math.hypot(c.u + 0.5 - w.focusPoint.u, c.v + 0.5 - w.focusPoint.v)
    if (d < bestD) { bestD = d; best = c }
  }
  return { u: best.u + 0.5, v: best.v + 0.5 }
}

export function drawDuskStreetBase(
  baseContainer: Container, gfx: Graphics, world: OfficeWorldPlan, cam: OfficeCamera, grassTex: Texture | null, skipIndoor: ReadonlySet<string>,
): void {
  gfx.clear()
  const atlas = getStreetSpriteAtlas(), z = cam.zoom, rows = world.buildingRows, cols = world.buildingCols, maxU = cols + 6
  let gi = 0
  const placeTile = (tex: Texture, u: number, v: number, tint = 0xffffff) => {
    const p = worldIsoToScreen(u + 0.5, v + 0.5, world, cam)
    const sp = groundPool[gi] ?? (groundPool[gi] = new Sprite(tex))
    gi++; sp.texture = tex; sp.tint = tint; sp.width = Math.ceil(32 * z); sp.height = Math.ceil(16 * z)
    sp.x = Math.round(p.x - 16 * z); sp.y = Math.round(p.y - 8 * z); baseContainer.addChild(sp)
  }

  for (let v = -4; v < rows; v++) for (let u = -6; u < maxU; u++) {
    if (skipIndoor.has(`${u},${v}`)) continue
    if (grassTex) placeTile(grassTex, u, v, u >= 0 && u < cols && v >= 0 && v < rows ? 0x809480 : 0x5c6b5e)
    else isoQuad(gfx, world, cam, u, v, u + 1, v + 1, 0x222b23)
  }
  for (let v = rows; v < rows + 2; v++) for (let u = -6; u < maxU; u++) placeTile(atlas.flagstone.tex, u, v, 0xe8dfd4)
  for (let v = rows + 2; v < rows + 6; v++) for (let u = -6; u < maxU; u++) placeTile(atlas.asphalt.tex, u, v, 0xffffff)
  for (let v = rows + 6; v < rows + 8; v++) for (let u = -6; u < maxU; u++) placeTile(atlas.flagstone.tex, u, v, 0xb8afa6)
  for (let v = rows + 8; v < rows + 11; v++) for (let u = -6; u < maxU; u++) if (grassTex) placeTile(grassTex, u, v, 0x4f5c52)

  baseContainer.addChild(gfx)
  for (let v = -3; v < rows; v++) for (let u = -5; u < maxU - 1; u++) {
    if (skipIndoor.has(`${u},${v}`) || (u * 7 + v * 13) % 11 !== 0) continue
    const gp = worldIsoToScreen(u + 0.45, v + 0.55, world, cam)
    gfx.rect(Math.round(gp.x), Math.round(gp.y), Math.max(1, z), Math.max(1, 2 * z)).fill({ color: 0x6f8c60, alpha: 0.72 })
  }
  for (const w of world.wings) {
    if (w.kind !== 'courtyard') continue
    const r = w.rect
    isoQuad(gfx, world, cam, r.u, r.v, r.u + r.w, r.v + r.h, 0x1a1412, 0.14, 0x4a3428, Math.max(1, z))
    if (w.id !== 'courtyard-3') {
      for (let s = 1; s < Math.min(r.w, r.h) - 2; s += 2) isoQuad(gfx, world, cam, r.u + s, r.v + s, r.u + s + 0.85, r.v + s + 0.85, 0x6e665e, 0.72, 0x1a1412, Math.max(1, z))
      for (const [su, sv] of [[r.u + 0.4, r.v + 0.4], [r.u + r.w - 0.75, r.v + 0.4], [r.u + 0.4, r.v + r.h - 0.75], [r.u + r.w - 0.75, r.v + r.h - 0.75]] as const) {
        isoQuad(gfx, world, cam, su, sv, su + 0.32, sv + 0.32, 0xc9a46a, 0.9, 0x1a1412, Math.max(1, z))
      }
    }
  }

  drawEdgeStrip(gfx, world, cam, -6, rows + 2, maxU, rows + 2, 4, 0x6e665e, 0x3a2e28)
  drawEdgeStrip(gfx, world, cam, -6, rows + 6, maxU, rows + 6, 3, 0x5a463a, 0x2e2a2a)
  for (const gu of [7.2, 18.8, ...(cols > 28 ? [31.2] : [])]) isoQuad(gfx, world, cam, gu, rows + 2.02, gu + 1.1, rows + 2.5, 0x1a1412, 0.78, 0x4a4440, Math.max(1, z))
  for (let u = -5; u < maxU - 1; u += 4) isoQuad(gfx, world, cam, u, rows + 3.9, u + 2, rows + 4.1, 0x8c8478, 0.55)
  for (let v = rows + 2.35; v <= rows + 5.35; v += 0.72) isoQuad(gfx, world, cam, 12.2, v, 14.8, v + 0.42, 0xb8ad9f, 0.68, 0x1a1412, Math.max(1, z))

  isoQuad(gfx, world, cam, -6, -4, maxU, -2.2, 0x201a18, 0.65)
  isoQuad(gfx, world, cam, -6, rows + 9, maxU, rows + 11, 0x201a18, 0.7)
  isoQuad(gfx, world, cam, -6, -4, -4.2, rows + 11, 0x201a18, 0.65)
  isoQuad(gfx, world, cam, maxU - 1.8, -4, maxU, rows + 11, 0x201a18, 0.65)
}

export function drawVacantFloorVeils(gfx: Graphics, world: OfficeWorldPlan, cam: OfficeCamera): void {
  for (const w of world.wings) if (w.vacant) for (const c of w.cells ?? []) isoQuad(gfx, world, cam, c.u, c.v, c.u + 1, c.v + 1, 0x141010, 0.28)
}

export function drawDuskStreetFurniture(
  ySorted: Container, aoShadows: Container, lightGfx: Graphics, world: OfficeWorldPlan, cam: OfficeCamera, elapsedMs: number, shadowCache: Map<string, Texture>, warmBoost = 1,
): void {
  const atlas = getStreetSpriteAtlas(), z = cam.zoom, rows = world.buildingRows, cols = world.buildingCols
  let pi = 0, si = 0
  const placeProp = (id: string, meta: StreetSpriteMeta, u: number, v: number) => {
    const p = worldIsoToScreen(u, v, world, cam), sx = Math.round(p.x - meta.ax * z), sy = Math.round(p.y - meta.ay * z)
    const sp = propPool[pi] ?? (propPool[pi] = new Sprite(meta.tex))
    pi++; sp.texture = meta.tex; sp.width = meta.w * z; sp.height = meta.h * z; sp.x = sx; sp.y = sy; sp.zIndex = Math.round(p.y)
    ySorted.addChild(sp)
    const stex = getContactShadowTexture(shadowCache, `st:${id}`, meta.canvas)
    if (stex) {
      const sh = propShadowPool[si] ?? (propShadowPool[si] = new Sprite(stex))
      si++; sh.texture = stex; sh.width = (meta.w + SHADOW_PAD.x * 2) * z; sh.height = (meta.h + SHADOW_PAD.t + SHADOW_PAD.b) * z
      sh.x = sx - SHADOW_PAD.x * z; sh.y = sy - SHADOW_PAD.t * z; aoShadows.addChild(sh)
    }
  }

  for (const w of world.wings) if (w.vacant) { const pt = vacantBoxPoint(w); placeProp('boxes', atlas.cardboardBoxes, pt.u, pt.v) }
  for (const u of [10.0, 16.9]) placeProp('pillar', atlas.pillar, u, rows + 0.12)
  for (const u of [1.5, 2.5, 3.5, 4.5, 7.5, 8.5]) placeProp('fence', atlas.fence, u, rows + 0.1)
  if (!world.wings.some((w) => w.kind === 'studio' && w.rect.v >= 10 && w.rect.u >= 16)) {
    for (const u of [17.5, 19.5, 21.5, 25.5]) placeProp('fence', atlas.fence, u, rows + 0.1)
  }
  placeProp('shelter', atlas.shelter, 3.9, rows + 1.55)
  placeProp('mailbox', atlas.mailbox, 11.4, rows + 0.85)
  placeProp('bench', atlas.bench, 21.7, rows + 1.38)
  placeProp('bike', atlas.bike, Math.min(cols - 1.8, 26.2), rows + 1.05)

  const lamps = [{ u: 5.0, v: rows + 1.82 }, { u: 20.0, v: rows + 1.82 }, ...(cols > 28 ? [{ u: 32.0, v: rows + 1.82 }] : []), { u: cols + 0.8, v: rows - 4.5 }]
  for (const [li, pt] of lamps.entries()) {
    placeProp('lamp', atlas.lamp, pt.u, pt.v)
    const gp = worldIsoToScreen(pt.u, pt.v + 0.3, world, cam), pulse = 1 + 0.06 * Math.sin(elapsedMs * 0.0022 + li)
    for (const [k, a] of [[1.0, 0.045], [0.62, 0.065], [0.32, 0.085]] as const) {
      lightGfx.ellipse(gp.x, gp.y, 46 * z * k * pulse, 25 * z * k * pulse).fill({ color: 0xf2a93b, alpha: Math.min(0.22, a * warmBoost) })
    }
  }
  const spGlow = worldIsoToScreen(3.9, rows + 1.65, world, cam)
  lightGfx.ellipse(spGlow.x, spGlow.y, 34 * z, 18 * z).fill({ color: 0xf2a93b, alpha: Math.min(0.16, 0.08 * warmBoost) })
}
