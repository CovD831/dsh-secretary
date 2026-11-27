/** 逐精灵像素级贴地接触阴影生成器（测量实底脚廓线，消除整格菱形外溢造成的桌椅悬浮感）。 */
import { ImageSource, Texture } from 'pixi.js'

export const SHADOW_PAD = { x: 5, t: 2, b: 5 } as const

export interface SpriteFloorContact {
  readonly minX: number
  readonly maxX: number
  readonly maxY: number
  readonly lMax: number
  readonly rMax: number
  readonly botY: Int16Array
  readonly contactCols: readonly number[]
}

export function analyzeSpriteFloorContact(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): SpriteFloorContact {
  const botY = new Int16Array(w).fill(-1)
  let minX = w, maxX = -1, maxY = -1, lMax = -1e9, rMax = -1e9
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3]! === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (y > botY[x]!) botY[x] = y
      const l = y - 0.5 * x, r = y + 0.5 * x
      if (l > lMax) lMax = l
      if (r > rMax) rMax = r
    }
  }
  const contactCols: number[] = []
  for (let x = 0; x < w; x++) {
    const by = botY[x]!
    if (by < 0) continue
    const env = Math.min(lMax + 0.5 * x, rMax - 0.5 * x)
    const localPeak = by >= (botY[Math.max(0, x - 2)] ?? 0) && by >= (botY[Math.min(w - 1, x + 2)] ?? 0) && by >= env - 12
    if (by >= env - 3.5 || localPeak) contactCols.push(x)
  }
  return { minX, maxX, maxY, lMax, rMax, botY, contactCols }
}

const drawSourceToCanvas = (src: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement | null => {
  const w = src instanceof HTMLImageElement ? src.naturalWidth : src.width
  const h = src instanceof HTMLImageElement ? src.naturalHeight : src.height
  if (w <= 0 || h <= 0) return null
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  const c = cv.getContext('2d'); if (!c) return null
  c.drawImage(src, 0, 0, w, h); return cv
}

export interface SpriteFrame { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export function getSilhouetteOutlineTexture(
  cache: Map<string, Texture>, key: string, src: HTMLImageElement | HTMLCanvasElement | undefined, frame?: SpriteFrame,
): Texture | null {
  if (!src || typeof document === 'undefined') return null
  const hit = cache.get(key); if (hit) return hit
  const nw = src instanceof HTMLImageElement ? src.naturalWidth : src.width
  const nh = src instanceof HTMLImageElement ? src.naturalHeight : src.height
  if (nw <= 0 || nh <= 0) return null
  const sx = frame?.x ?? 0, sy = frame?.y ?? 0, w = frame?.w ?? nw, h = frame?.h ?? nh
  const cv = document.createElement('canvas'); cv.width = w + 2; cv.height = h + 2
  const c = cv.getContext('2d'); if (!c) return null
  c.imageSmoothingEnabled = false; c.drawImage(src, sx, sy, w, h, 1, 1, w, h)
  const cw = w + 2, ch = h + 2, raw = c.getImageData(0, 0, cw, ch).data, out = c.createImageData(cw, ch), d = out.data
  const op = (x: number, y: number) => x >= 0 && y >= 0 && x < cw && y < ch && raw[(y * cw + x) * 4 + 3]! >= 128
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = (y * cw + x) * 4
    if (op(x, y)) { d[i] = 255; d[i + 1] = 244; d[i + 2] = 214; d[i + 3] = 34 }
    else if (op(x - 1, y) || op(x + 1, y) || op(x, y - 1) || op(x, y + 1)) {
      d[i] = 242; d[i + 1] = 169; d[i + 2] = 59; d[i + 3] = 255
    }
  }
  c.putImageData(out, 0, 0)
  const tex = new Texture({ source: new ImageSource({ resource: cv, scaleMode: 'nearest' }) })
  cache.set(key, tex); return tex
}

export function getContactShadowTexture(
  cache: Map<string, Texture>, key: string, src: HTMLImageElement | HTMLCanvasElement | undefined,
): Texture | null {
  if (!src) return null
  const hit = cache.get(key); if (hit) return hit
  const scv = drawSourceToCanvas(src); if (!scv) return null
  const sctx = scv.getContext('2d'); if (!sctx) return null
  const w = scv.width, h = scv.height
  const info = analyzeSpriteFloorContact(sctx.getImageData(0, 0, w, h).data, w, h)
  if (info.maxX < info.minX || info.maxY < 0) return null

  const out = document.createElement('canvas')
  out.width = w + SHADOW_PAD.x * 2; out.height = h + SHADOW_PAD.t + SHADOW_PAD.b
  const ctx = out.getContext('2d')!
  const px = (x: number) => x + SHADOW_PAD.x, py = (y: number) => y + SHADOW_PAD.t
  const spanV = Math.max(6, Math.round((info.maxX - info.minX) * 0.24))

  ctx.fillStyle = 'rgba(26, 20, 18, 0.26)'
  for (let x = info.minX + 1; x <= info.maxX - 1; x++) {
    const yLo = Math.floor(Math.min(info.lMax + 0.5 * x, info.rMax - 0.5 * x)) + 1
    const yHi = Math.ceil(Math.max(info.lMax + 0.5 * x - spanV, info.rMax - 0.5 * x - spanV))
    if (yLo >= yHi) ctx.fillRect(px(x), py(yHi), 1, yLo - yHi + 1)
  }

  ctx.fillStyle = 'rgba(26, 20, 18, 0.22)'
  for (const x of info.contactCols) {
    const y = info.botY[x]!
    ctx.fillRect(px(x) - 1, py(y) + 1, 3, 2)
  }

  ctx.fillStyle = 'rgba(26, 20, 18, 0.58)'
  for (const x of info.contactCols) {
    const y = info.botY[x]!
    ctx.fillRect(px(x), py(y) - 1, 1, 3)
  }

  const tex = new Texture({ source: new ImageSource({ resource: out, scaleMode: 'nearest' }) })
  cache.set(key, tex)
  return tex
}
