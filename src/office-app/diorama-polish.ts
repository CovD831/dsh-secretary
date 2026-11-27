/** 像素风微调层：时段氛围、护墙板/抖动纹理墙、编织走廊毯、窗光浮尘与贴体轮廓高亮。 */
import { type Container, type Graphics, type Sprite, type Text, type Texture } from 'pixi.js'
import { HIGHLIGHT_GOLD, type StatusKind } from './catalog.ts'
import { assignActorVariants, buildVariantCanvas } from './char-variants.ts'
import { type SpriteFrame, getSilhouetteOutlineTexture } from './contact-shadow.ts'
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import type { OfficeActor } from './iso-engine.ts'
import { worldIsoToScreen } from './world-renderer.ts'
import type { OfficeCamera, OfficeWorldPlan, WallSegment3D, WorldPickResult } from './world-types.ts'

export interface TimeOfDayProfile {
  readonly pipCount: 1 | 2 | 3 | 4 | 5 | 6
  readonly label: string
  readonly ambientColor: number
  readonly ambientAlpha: number
  readonly warmBoost: number
  readonly windowBeamColor: number
  readonly windowBeamAlpha: number
}

const HEX_NUM = (hex: string): number => Number.parseInt(hex.slice(1), 16)

export function getTimeOfDayProfile(date = new Date()): TimeOfDayProfile {
  const h = date.getHours()
  if (h >= 5 && h <= 7) return { pipCount: 1, label: '拂晓', ambientColor: 0x2a3048, ambientAlpha: 0.07, warmBoost: 1.0, windowBeamColor: 0xe8dccb, windowBeamAlpha: 0.11 }
  if (h >= 8 && h <= 11) return { pipCount: 2, label: '晨光', ambientColor: 0x243040, ambientAlpha: 0.03, warmBoost: 0.85, windowBeamColor: 0xfff0cc, windowBeamAlpha: 0.13 }
  if (h >= 12 && h <= 15) return { pipCount: 3, label: '午后', ambientColor: 0x282420, ambientAlpha: 0.04, warmBoost: 0.9, windowBeamColor: 0xf8e2b0, windowBeamAlpha: 0.14 }
  if (h >= 16 && h <= 18) return { pipCount: 4, label: '暮色', ambientColor: 0x1e2238, ambientAlpha: 0.09, warmBoost: 1.18, windowBeamColor: 0xf2a93b, windowBeamAlpha: 0.13 }
  if (h >= 19 && h <= 21) return { pipCount: 5, label: '华灯', ambientColor: 0x181c32, ambientAlpha: 0.13, warmBoost: 1.32, windowBeamColor: 0x7c96b8, windowBeamAlpha: 0.08 }
  return { pipCount: 6, label: '深夜', ambientColor: 0x14182c, ambientAlpha: 0.16, warmBoost: 1.4, windowBeamColor: 0x6b7f96, windowBeamAlpha: 0.07 }
}

export function stepCameraTowards(cur: OfficeCamera, target: OfficeCamera, dtMs: number): OfficeCamera {
  if (cur.zoom !== target.zoom) return target
  const dx = target.panX - cur.panX, dy = target.panY - cur.panY
  if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return target
  const t = Math.min(1, 1 - Math.exp(-Math.max(1, dtMs) / 55))
  return { panX: Math.round(cur.panX + dx * t), panY: Math.round(cur.panY + dy * t), zoom: target.zoom }
}

export function drawTexturedWallSeg3D(
  gfx: Graphics, seg: WallSegment3D, world: OfficeWorldPlan, camera: OfficeCamera,
  fold1 = true, fold2 = true, miter0 = 0, miter1 = 1,
): void {
  const z = camera.zoom, p1 = worldIsoToScreen(seg.from.u, seg.from.v, world, camera), p2 = worldIsoToScreen(seg.to.u, seg.to.v, world, camera)
  const h1 = seg.startH * z, h2 = seg.endH * z, isCut = seg.tier === 'cutaway' || seg.tier === 'portal', t = 0.25
  const capH = isCut ? 4 * z : Math.min(5 * z, h1 * 0.25), baseH = Math.min(isCut ? 8 * z : 12 * z, Math.max(0, Math.min(h1, h2) - capH))
  const off = (m: number) => seg.from.v === seg.to.v ? { du: 0, dv: -t } : seg.from.u === seg.to.u ? { du: -t, dv: 0 } : { du: -t * (1 - m), dv: -t * m }
  const o1 = off(miter0), o2 = off(miter1), q1 = worldIsoToScreen(seg.from.u + o1.du, seg.from.v + o1.dv, world, camera), q2 = worldIsoToScreen(seg.to.u + o2.du, seg.to.v + o2.dv, world, camera)
  const tx1 = q1.x, ty1 = q1.y - h1, tx2 = q2.x, ty2 = q2.y - h2
  const plaster = isCut ? (seg.shade === 'shaded' ? 0x7a6150 : seg.shade === 'exterior' ? 0x8a6f5b : 0x9c8069) : (seg.shade === 'shaded' ? 0xbfa48c : 0xd9c4a8)
  const baseCol = isCut ? 0x3a2e28 : seg.tier === 'back' ? 0x4a3428 : 0x6b4a32
  gfx.poly([tx1, ty1, tx2, ty2, p2.x, p2.y - h2, p1.x, p1.y - h1]).fill(0x5a463a)
  gfx.poly([p1.x, p1.y - h1, p2.x, p2.y - h2, p2.x, p2.y - h2 + capH, p1.x, p1.y - h1 + capH]).fill(0x4a3428)
  gfx.poly([p1.x, p1.y - h1 + capH, p2.x, p2.y - h2 + capH, p2.x, p2.y - baseH, p1.x, p1.y - baseH]).fill(plaster)
  gfx.poly([p1.x, p1.y - baseH, p2.x, p2.y - baseH, p2.x, p2.y, p1.x, p1.y]).fill(baseCol)

  const rimCol = isCut ? 0x8a6f5b : seg.shade === 'shaded' ? 0x6b4a32 : 0x8a6f5b
  gfx.moveTo(p1.x, p1.y - h1 + z).lineTo(p2.x, p2.y - h2 + z).stroke({ color: 0x6b5648, width: z })
  gfx.moveTo(p1.x, p1.y - h1 + capH).lineTo(p2.x, p2.y - h2 + capH).stroke({ color: rimCol, width: z, alpha: 0.72 })
  gfx.moveTo(p1.x, p1.y - baseH - z).lineTo(p2.x, p2.y - baseH - z).stroke({ color: isCut ? 0x5a463a : 0xe8dccb, width: z, alpha: 0.48 })
  gfx.moveTo(p1.x, p1.y - baseH).lineTo(p2.x, p2.y - baseH).stroke({ color: 0x3a2e28, width: z, alpha: 0.65 })

  const segSpan = Math.max(Math.abs(seg.to.u - seg.from.u), Math.abs(seg.to.v - seg.from.v))
  if (segSpan >= 1) {
    const steps = Math.min(24, Math.max(2, Math.round(segSpan * 2)))
    for (let i = 1; i < steps; i++) {
      const f = i / steps, px = Math.round(p1.x + (p2.x - p1.x) * f), py = Math.round(p1.y + (p2.y - p1.y) * f), hf = h1 + (h2 - h1) * f
      if (!isCut && i % 2 === 0 && hf > capH + baseH + 8 * z) {
        gfx.moveTo(px, py - hf + capH + 2 * z).lineTo(px, py - baseH - 2 * z).stroke({ color: 0x4a3428, width: z, alpha: 0.14 })
        gfx.moveTo(px + z, py - hf + capH + 2 * z).lineTo(px + z, py - baseH - 2 * z).stroke({ color: 0xe8dccb, width: z, alpha: 0.1 })
      }
      if (hf > capH + baseH + 5 * z) {
        const dy = py - baseH - (i % 2 === 0 ? 3 : 5) * z
        gfx.rect(px, dy, 2 * z, 2 * z).fill({ color: 0x4a3428, alpha: 0.15 })
      }
    }
  }

  gfx.moveTo(tx1, ty1).lineTo(tx2, ty2).moveTo(p1.x, p1.y - h1).lineTo(p2.x, p2.y - h2).moveTo(p1.x, p1.y).lineTo(p2.x, p2.y)
  if (fold1) gfx.moveTo(p1.x, p1.y - h1).lineTo(p1.x, p1.y)
  if (fold2) gfx.moveTo(p2.x, p2.y - h2).lineTo(p2.x, p2.y)
  gfx.stroke({ color: 0x1a1412, width: z })
}

export function drawTexturedRunner(gfx: Graphics, world: OfficeWorldPlan, camera: OfficeCamera): void {
  const z = camera.zoom
  for (const br of world.corridorBranches ?? []) {
    if (!br.hasRunner) continue
    const horiz = br.from.v === br.to.v, u0 = br.from.u, v0 = horiz ? br.from.v + 0.35 : Math.max(br.from.v, 14.2), u1 = horiz ? br.to.u : br.to.u + 1.4, v1 = horiz ? br.from.v + 1.65 : br.to.v - 0.1
    const poly = (du: number, dv: number) => [worldIsoToScreen(u0 + du, v0 + dv, world, camera), worldIsoToScreen(u1 - du, v0 + dv, world, camera), worldIsoToScreen(u1 - du, v1 - dv, world, camera), worldIsoToScreen(u0 + du, v1 - dv, world, camera)].flatMap((p) => [p.x, p.y])
    gfx.poly(poly(0, 0)).fill(0x3f5a78).stroke({ color: 0x1a1412, width: z })
    gfx.poly(poly(0.25, 0.25)).fill({ color: 0x2f4660, alpha: 0.72 })
    gfx.poly(poly(0.14, 0.14)).stroke({ color: 0xc9a46a, width: z })
    const len = Math.max(2, Math.floor((horiz ? u1 - u0 : v1 - v0) * 3))
    for (let k = 1; k < len; k++) {
      const f = k / len, wp = worldIsoToScreen(horiz ? u0 + (u1 - u0) * f : (u0 + u1) / 2, (horiz ? (v0 + v1) / 2 : v0 + (v1 - v0) * f) + (k % 2 === 0 ? 0.18 : -0.18), world, camera)
      gfx.rect(Math.round(wp.x), Math.round(wp.y), 2 * z, z).fill({ color: k % 2 === 0 ? 0x6b7f96 : 0xc9a46a, alpha: 0.45 })
    }
    for (let k = 0; k < 4; k++) {
      const f = (k + 0.5) / 4, eA = horiz ? worldIsoToScreen(u0, v0 + (v1 - v0) * f, world, camera) : worldIsoToScreen(u0 + (u1 - u0) * f, v0, world, camera), eB = horiz ? worldIsoToScreen(u1, v0 + (v1 - v0) * f, world, camera) : worldIsoToScreen(u0 + (u1 - u0) * f, v1, world, camera)
      const dx = horiz ? -3 * z : 2 * z, dy = horiz ? 1.5 * z : -1.5 * z
      gfx.moveTo(eA.x, eA.y).lineTo(eA.x + dx, eA.y + dy).moveTo(eB.x, eB.y).lineTo(eB.x - dx, eB.y - dy).stroke({ color: 0xe8dccb, width: z, alpha: 0.72 })
    }
  }
}

export function drawTimeAtmosphereAndRoomGlow(
  aoGfx: Graphics, lightGfx: Graphics, world: OfficeWorldPlan, camera: OfficeCamera,
  screenStates: Record<string, StatusKind | 'off'>, activeWorkspaceId: string, elapsedMs: number, tod: TimeOfDayProfile,
): void {
  const z = camera.zoom, step = Math.floor(elapsedMs / 340), dimAlpha = Math.min(0.22, 0.1 + tod.ambientAlpha * 0.45)
  const fillIso = (g: Graphics, u0: number, v0: number, u1: number, v1: number, col: number, a: number) => {
    const p0 = worldIsoToScreen(u0, v0, world, camera), p1 = worldIsoToScreen(u1, v0, world, camera), p2 = worldIsoToScreen(u1, v1, world, camera), p3 = worldIsoToScreen(u0, v1, world, camera)
    g.poly([p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y]).fill({ color: col, alpha: a })
  }
  for (const w of world.wings) {
    if (w.kind !== 'studio' || w.vacant) continue
    const active = w.workspaceId === activeWorkspaceId || w.suites.some((s) => { const st = screenStates[s.id]; return st === 'working' || st === 'needsDecision' || st === 'stuck' })
    if (!active) {
      if (w.cells?.length) for (const c of w.cells) fillIso(aoGfx, c.u, c.v, c.u + 1, c.v + 1, tod.ambientColor, dimAlpha)
      else fillIso(aoGfx, w.rect.u, w.rect.v, w.rect.u + w.rect.w, w.rect.v + w.rect.h, tod.ambientColor, dimAlpha)
    }
    for (const [mi, m] of w.wallMounts.entries()) {
      if (m.assetId !== 'window_wide') continue
      const u0 = m.wall === 'back' ? m.at - 0.6 : w.rect.u + 0.1, v0 = m.wall === 'back' ? w.rect.v + 0.1 : m.at - 0.6
      const du = m.wall === 'back' ? 1.5 : 2.3, dv = m.wall === 'back' ? 2.3 : 1.5
      for (const [sc, a] of [[1.0, tod.windowBeamAlpha * 0.6], [0.64, tod.windowBeamAlpha * 0.78]] as const) fillIso(lightGfx, u0, v0, u0 + du * sc, v0 + dv * sc, tod.windowBeamColor, a)
      for (let d = 0; d < 2; d++) {
        const mp = worldIsoToScreen(u0 + 0.4 + d * 0.6, v0 + 0.5 + ((step + d + mi) % 4) * 0.25, world, camera)
        lightGfx.rect(Math.round(mp.x + ((step + d) % 3) * z), Math.round(mp.y - 6 * z - ((step + d * 2) % 5) * z), z, z).fill({ color: 0xe8dccb, alpha: 0.42 })
      }
    }
  }
}

const drawBrackets = (g: Graphics, b: { x: number; y: number; w: number; h: number }, z: number, col: number) => {
  const { x, y, w, h } = b, t = 5 * z
  g.moveTo(x, y + t).lineTo(x, y).lineTo(x + t, y).moveTo(x + w - t, y).lineTo(x + w, y).lineTo(x + w, y + t)
    .moveTo(x, y + h - t).lineTo(x, y + h).lineTo(x + t, y + h).moveTo(x + w - t, y + h).lineTo(x + w, y + h).lineTo(x + w, y + h - t).stroke({ color: col, width: z })
}

export function drawIsometricHoverAndTooltip(
  lightGfx: Graphics, layer: Container, hoverTarget: WorldPickResult | null | undefined, world: OfficeWorldPlan, camera: OfficeCamera, elapsedMs: number, tipText: Text,
  actors: readonly OfficeActor[], images: Record<string, CanvasImageSource>, outlineCache: Map<string, Texture>, hoverSprite: Sprite,
): void {
  hoverSprite.visible = false
  if (!hoverTarget) { tipText.visible = false; return }
  const z = camera.zoom, gold = HEX_NUM(HIGHLIGHT_GOLD)
  if (hoverTarget.type === 'wing') {
    tipText.visible = false
    const wing = world.wings.find((w) => w.id === hoverTarget.wingId), pulseA = 0.07 + 0.025 * Math.sin(elapsedMs * 0.005)
    for (const c of wing?.cells ?? []) {
      const p0 = worldIsoToScreen(c.u, c.v, world, camera), p1 = worldIsoToScreen(c.u + 1, c.v, world, camera), p2 = worldIsoToScreen(c.u + 1, c.v + 1, world, camera), p3 = worldIsoToScreen(c.u, c.v + 1, world, camera)
      lightGfx.poly([p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y]).fill({ color: 0xf2a93b, alpha: pulseA })
    }
    drawBrackets(lightGfx, hoverTarget.bounds, z, gold); return
  }

  let tipX = Math.round(hoverTarget.bounds.x + hoverTarget.bounds.w / 2), tipY = hoverTarget.bounds.y, outlined = false
  const placeOutline = (key: string, src: CanvasImageSource | undefined, ox: number, oy: number, ow: number, oh: number, mirrorX = false, frame?: SpriteFrame) => {
    if (!(src instanceof HTMLImageElement || src instanceof HTMLCanvasElement)) return false
    const tex = getSilhouetteOutlineTexture(outlineCache, key, src, frame); if (!tex) return false
    hoverSprite.texture = tex; hoverSprite.scale.set(1, 1); hoverSprite.width = ow; hoverSprite.height = oh
    hoverSprite.x = mirrorX ? ox + ow : ox; hoverSprite.y = oy
    if (mirrorX) hoverSprite.scale.x = -Math.abs(hoverSprite.scale.x)
    hoverSprite.visible = true; layer.addChild(hoverSprite); return true
  }
  const drawPolyObj = (pts: readonly [number, number][]) => {
    lightGfx.poly(pts.flat()).fill({ color: 0xf2a93b, alpha: 0.24 }).stroke({ color: gold, width: z })
    tipX = Math.round(pts.reduce((s, p) => s + p[0], 0) / pts.length); tipY = Math.min(...pts.map((p) => p[1])); outlined = true
  }

  if (hoverTarget.type === 'prop' && (hoverTarget.prop === 'ledger' || hoverTarget.prop === 'notebook')) {
    const rec = world.lobby.suites.find((s) => s.assetId === 'reception_desk'), meta = WORLD_ASSET_CATALOG.reception_desk
    if (rec && meta) {
      const rp = worldIsoToScreen(rec.anchor.u + rec.size[0] / 2, rec.anchor.v + rec.size[1] / 2, world, camera)
      const rx = Math.round(rp.x - meta.anchor[0] * z), ry = Math.round(rp.y - meta.anchor[1] * z)
      const raw = hoverTarget.prop === 'ledger' ? ([[38, 28], [49, 34], [36, 43], [25, 36]] as const) : ([[60, 17], [70, 23], [61, 29], [52, 23]] as const)
      drawPolyObj(raw.map(([nx, ny]) => [rx + (rec.mirrorX ? 96 - nx : nx) * z, ry + ny * z]))
    }
  } else if (hoverTarget.type === 'prop' && hoverTarget.prop === 'doorplate') {
    const wg = world.wings.find((w) => w.workspaceId === hoverTarget.workspaceId), dr = wg ? world.interiorDoors?.find((d) => d.wingId === wg.id) : undefined
    if (wg) {
      const p0 = dr?.axis === 'v' ? worldIsoToScreen(dr.u - 0.85, dr.v, world, camera) : worldIsoToScreen(wg.rect.u === 0 ? 10 : wg.doorway.u, wg.doorway.v - 0.85, world, camera)
      const p1 = dr?.axis === 'v' ? worldIsoToScreen(dr.u - 0.15, dr.v, world, camera) : worldIsoToScreen(wg.rect.u === 0 ? 10 : wg.doorway.u, wg.doorway.v - 0.15, world, camera)
      drawPolyObj([[p0.x, p0.y - 39 * z], [p1.x, p1.y - 39 * z], [p1.x, p1.y - 27 * z], [p0.x, p0.y - 27 * z]])
    }
  } else if (hoverTarget.type === 'prop' && hoverTarget.prop === 'corkboard') {
    const m = world.lobby.wallMounts.find((x) => x.propKind === 'corkboard'), meta = m ? WORLD_ASSET_CATALOG[m.assetId] : undefined
    if (m && meta) {
      const p = m.wall === 'back' ? worldIsoToScreen(m.at, world.lobby.rect.v, world, camera) : worldIsoToScreen(world.lobby.rect.u, m.at, world, camera)
      const sc = 0.68, w = Math.round(meta.nativeSize[0] * sc * z), h = Math.round(meta.nativeSize[1] * sc * z), bx = Math.round(p.x - w / 2), by = Math.round(p.y - h - m.h * z), pad = sc * z
      if (placeOutline(`prop:${m.assetId}`, images[m.assetId], bx - pad, by - pad, w + pad * 2, h + pad * 2, m.wall === 'back')) { tipX = Math.round(bx + w / 2); tipY = by; outlined = true }
    }
  } else if (hoverTarget.type === 'prop' && hoverTarget.prop === 'cabinet') {
    const cab = [...world.lobby.shared, ...world.wings.flatMap((w) => w.shared)].find((e) => e.assetId === 'file_cabinet' || e.propKind === 'cabinet'), meta = cab ? WORLD_ASSET_CATALOG[cab.assetId] : undefined
    if (cab && meta) {
      const p = worldIsoToScreen(cab.anchor.u + cab.size[0] / 2, cab.anchor.v + cab.size[1] / 2, world, camera)
      const bx = Math.round(p.x - meta.anchor[0] * z), by = Math.round(p.y - meta.anchor[1] * z), w = meta.nativeSize[0] * z, h = meta.nativeSize[1] * z
      if (placeOutline(`prop:${cab.assetId}`, images[cab.assetId], bx - z, by - z, w + 2 * z, h + 2 * z, Boolean(cab.mirrorX))) { tipX = Math.round(bx + w / 2); tipY = by; outlined = true }
    }
  } else if (hoverTarget.type === 'actor') {
    const a = actors.find((x) => x.id === hoverTarget.actorId)
    if (a) {
      const col = a.pose === 'idle' ? 0 : a.pose === 'walkA' ? 1 : a.pose === 'walkB' ? 2 : 3, row = a.facing === 'SW' || a.facing === 'NW' ? 1 : 0
      const bob = a.pose === 'sit' && Math.floor(elapsedMs / 500) % 2 === 1 ? 1 : 0, p = worldIsoToScreen(a.u + 0.5, a.v + 0.5, world, camera)
      const bx = Math.round(p.x - 16 * z), by = Math.round(p.y - 44 * z) + bob
      const vIdx = a.role === 'worker' ? assignActorVariants(actors).get(a.id) : undefined
      const src = vIdx !== undefined ? (buildVariantCanvas(vIdx, images) ?? images.char_worker) : images[`char_${a.role}`]
      if (placeOutline(`act:${vIdx ?? a.role}:${col}:${row}`, src, bx - z, by - z, 34 * z, 50 * z, false, { x: col * 32, y: row * 48, w: 32, h: 48 })) { tipX = Math.round(p.x); tipY = by; outlined = true }
    }
  }
  if (!outlined) drawBrackets(lightGfx, hoverTarget.bounds, z, gold)

  tipText.text = hoverTarget.type === 'prop' ? hoverTarget.label : hoverTarget.role === 'secretary' ? '秘书总台' : hoverTarget.workspaceId ? `${hoverTarget.workspaceId} 员工` : '工作员工'
  tipText.style.fontSize = 10 * z
  const tw = Math.max(44 * z, Math.round(tipText.width + 12 * z)), th = 16 * z, bx = Math.round(tipX - tw / 2), by = Math.max(6, Math.round(tipY - th - 4 * z))
  lightGfx.rect(bx, by, tw, th).fill({ color: 0x201a18, alpha: 0.94 }).stroke({ color: gold, width: z })
  tipText.x = bx + Math.round((tw - tipText.width) / 2); tipText.y = by + Math.round((th - tipText.height) / 2)
  tipText.visible = true; layer.addChild(tipText)
}
