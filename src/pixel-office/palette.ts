export type PaletteCategory =
  | 'wall' | 'wood' | 'floor' | 'outline' | 'furniture' | 'skinHair' | 'clothing' | 'ui' | 'status'
export type StatusKind = 'working' | 'stuck' | 'needsDecision' | 'done'
export type SecretaryMood = 'neutral' | 'working' | 'happy' | 'concerned'

export interface PaletteEntry {
  hex: string
  rgb: readonly [number, number, number]
  oklab: readonly [number, number, number]
  category: PaletteCategory
}

export interface AlphaCheckResult { semiTransparentCount: number; cornersTransparent: boolean; ok: boolean }

export interface PaletteAuditResult {
  totalOpaquePixels: number
  uniqueHexes: string[]
  uniqueCount: number
  outOfPaletteCount: number
  outOfPaletteHexes: string[]
  semiTransparentCount: number
  statusPixelsOutsideMask: number
  histogram: Record<string, number>
  categoryCounts: Record<PaletteCategory, number>
}

export const PALETTE_GROUPS: Record<PaletteCategory, readonly string[]> = {
  wall: ['#3A2E28', '#5A463A', '#7A6150', '#9C8069', '#BFA48C', '#D9C4A8'],
  wood: ['#4A3428', '#6B4A32', '#8A6242', '#A87A52'],
  floor: ['#3B2A22', '#5E4130', '#7C5A3E', '#96704C'],
  outline: ['#1A1412', '#2C211B'],
  furniture: ['#2E2A2A', '#4A4440', '#6E665E', '#8C8478', '#3E4A44', '#6B3A32'],
  skinHair: ['#D8C0A8', '#C09070', '#8F6046', '#2A2220', '#7A5438', '#C9C0B4'],
  clothing: ['#3F5A78', '#7A3A3A', '#4A6A50', '#D8D0C0', '#6B7F96'],
  ui: ['#201A18', '#302722', '#4A3C34', '#E8DCCB', '#C9A46A'],
  status: ['#2FA8E0', '#17688F', '#F2A93B', '#A86A17', '#E8544E', '#9E2F2C', '#3FCB6B', '#247A42'],
}

export const STATUS_COLOR_MAP: Record<StatusKind, { bright: string; dark: string }> = {
  working: { bright: '#2FA8E0', dark: '#17688F' },
  stuck: { bright: '#F2A93B', dark: '#A86A17' },
  needsDecision: { bright: '#E8544E', dark: '#9E2F2C' },
  done: { bright: '#3FCB6B', dark: '#247A42' },
}

export const MATERIAL_CATEGORIES: readonly PaletteCategory[] = ['wall', 'wood', 'floor', 'furniture', 'skinHair', 'clothing']

function parseHex(hex: string): readonly [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (v: number) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0').toUpperCase()
  return `#${to2(r)}${to2(g)}${to2(b)}`
}

const srgbToLinear = (c: number) => {
  const u = c / 255
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4
}

export function rgbToOklab(r: number, g: number, b: number): readonly [number, number, number] {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

export const FROZEN_PALETTE: readonly PaletteEntry[] = (Object.entries(PALETTE_GROUPS) as [PaletteCategory, readonly string[]][])
  .flatMap(([category, hexes]) => hexes.map((hex) => {
    const rgb = parseHex(hex)
    return { hex, rgb, oklab: rgbToOklab(rgb[0], rgb[1], rgb[2]), category }
  }))

export const MATERIAL_HEXES: readonly string[] = MATERIAL_CATEGORIES.flatMap((cat) => PALETTE_GROUPS[cat])
export const STATUS_HEXES: readonly string[] = PALETTE_GROUPS.status
const STATUS_HEX_SET = new Set(STATUS_HEXES)
const PALETTE_BY_HEX = new Map<string, number>()
const PALETTE_BY_RGB_KEY = new Map<number, PaletteEntry>()

FROZEN_PALETTE.forEach((entry, idx) => {
  PALETTE_BY_HEX.set(entry.hex, idx + 1)
  PALETTE_BY_RGB_KEY.set((entry.rgb[0] << 16) | (entry.rgb[1] << 8) | entry.rgb[2], entry)
})

export function colorIndex(hex: string): number {
  const idx = PALETTE_BY_HEX.get(hex.toUpperCase())
  if (idx === undefined) throw new Error(`Color ${hex} is outside frozen 46-color palette`)
  return idx
}

export function quantizeOklab(r: number, g: number, b: number): PaletteEntry {
  const exact = PALETTE_BY_RGB_KEY.get(((r & 255) << 16) | ((g & 255) << 8) | (b & 255))
  if (exact) return exact
  const [L, a, bk] = rgbToOklab(r, g, b)
  let best = FROZEN_PALETTE[0]!
  let bestDist = Infinity
  for (const entry of FROZEN_PALETTE) {
    const dL = L - entry.oklab[0], da = a - entry.oklab[1], db = bk - entry.oklab[2]
    const dist = dL * dL + da * da + db * db
    if (dist < bestDist) { bestDist = dist; best = entry }
  }
  return best
}

export function quantizeRgbaBuffer(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < 128) continue
    const entry = quantizeOklab(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0)
    out[i] = entry.rgb[0]; out[i + 1] = entry.rgb[1]; out[i + 2] = entry.rgb[2]; out[i + 3] = 255
  }
  return out
}

export function checkAlphaSpec(rgba: Uint8Array, width: number, height: number): AlphaCheckResult {
  let semiTransparentCount = 0
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i] ?? 0
    if (a !== 0 && a !== 255) semiTransparentCount++
  }
  const corners = [0, (width - 1) * 4, (height - 1) * width * 4, (height * width - 1) * 4]
  return { semiTransparentCount, cornersTransparent: corners.every((idx) => (rgba[idx + 3] ?? 0) === 0), ok: semiTransparentCount === 0 }
}

export function auditPaletteBuffer(rgba: Uint8Array, width: number, height: number, statusMask?: Uint8Array): PaletteAuditResult {
  const histogram: Record<string, number> = {}
  const categoryCounts: Record<PaletteCategory, number> = {
    wall: 0, wood: 0, floor: 0, outline: 0, furniture: 0, skinHair: 0, clothing: 0, ui: 0, status: 0,
  }
  const outSet = new Set<string>()
  let totalOpaquePixels = 0, outOfPaletteCount = 0, semiTransparentCount = 0, statusPixelsOutsideMask = 0

  for (let p = 0; p < width * height; p++) {
    const i = p * 4, a = rgba[i + 3] ?? 0
    if (a === 0) continue
    if (a !== 255) semiTransparentCount++
    totalOpaquePixels++
    const r = rgba[i] ?? 0, g = rgba[i + 1] ?? 0, b = rgba[i + 2] ?? 0
    const entry = PALETTE_BY_RGB_KEY.get((r << 16) | (g << 8) | b)
    if (!entry) { outOfPaletteCount++; outSet.add(rgbToHex(r, g, b)); continue }
    histogram[entry.hex] = (histogram[entry.hex] ?? 0) + 1
    categoryCounts[entry.category]++
    if (STATUS_HEX_SET.has(entry.hex) && statusMask && (statusMask[p] ?? 0) === 0) statusPixelsOutsideMask++
  }

  const uniqueHexes = Object.keys(histogram).sort()
  return {
    totalOpaquePixels, uniqueHexes, uniqueCount: uniqueHexes.length, outOfPaletteCount,
    outOfPaletteHexes: [...outSet].sort(), semiTransparentCount, statusPixelsOutsideMask, histogram, categoryCounts,
  }
}

/** Indexed 46-color pixel surface ensuring binary alpha and zero out-of-palette pixels. */
export class PixelGrid {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
  readonly statusMask: Uint8Array

  constructor(width: number, height: number) {
    this.width = width; this.height = height
    this.pixels = new Uint8Array(width * height)
    this.statusMask = new Uint8Array(width * height)
  }

  set(x: number, y: number, idx: number, isStatus = false): void {
    const ix = Math.floor(x), iy = Math.floor(y)
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return
    const pos = iy * this.width + ix
    this.pixels[pos] = idx; this.statusMask[pos] = isStatus ? 1 : 0
  }

  get(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y)
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return 0
    return this.pixels[iy * this.width + ix] ?? 0
  }

  fillRect(x: number, y: number, w: number, h: number, idx: number, isStatus = false): void {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(this.width, Math.floor(x + w)), y1 = Math.min(this.height, Math.floor(y + h))
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const pos = py * this.width + px
        this.pixels[pos] = idx; this.statusMask[pos] = isStatus ? 1 : 0
      }
    }
  }

  fillEllipse(cx: number, cy: number, rx: number, ry: number, idx: number, isStatus = false): void {
    for (let py = Math.floor(cy - ry); py <= Math.ceil(cy + ry); py++) {
      for (let px = Math.floor(cx - rx); px <= Math.ceil(cx + rx); px++) {
        const dx = (px - cx) / Math.max(0.5, rx), dy = (py - cy) / Math.max(0.5, ry)
        if (dx * dx + dy * dy <= 1) this.set(px, py, idx, isStatus)
      }
    }
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, idx: number, isStatus = false): void {
    let cx = Math.round(x0), cy = Math.round(y0)
    const tx = Math.round(x1), ty = Math.round(y1)
    const dx = Math.abs(tx - cx), dy = Math.abs(ty - cy), sx = cx < tx ? 1 : -1, sy = cy < ty ? 1 : -1
    let err = dx - dy
    while (true) {
      this.set(cx, cy, idx, isStatus)
      if (cx === tx && cy === ty) break
      const e2 = 2 * err
      if (e2 > -dy) { err -= dy; cx += sx }
      if (e2 < dx) { err += dx; cy += sy }
    }
  }

  fillPoly(pts: ReadonlyArray<readonly [number, number]>, idx: number, isStatus = false): void {
    if (pts.length < 3) return
    let minY = Infinity, maxY = -Infinity
    for (const [, py] of pts) { if (py < minY) minY = py; if (py > maxY) maxY = py }
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(this.height - 1, Math.ceil(maxY)); y++) {
      const xs: number[] = []
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i]!, [x2, y2] = pts[(i + 1) % pts.length]!
        if ((y1 <= y + 0.5 && y2 > y + 0.5) || (y2 <= y + 0.5 && y1 > y + 0.5)) {
          xs.push(x1 + ((y + 0.5 - y1) * (x2 - x1)) / (y2 - y1))
        }
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const s = Math.max(0, Math.ceil(xs[k]! - 0.5)), e = Math.min(this.width - 1, Math.floor(xs[k + 1]! - 0.5))
        for (let x = s; x <= e; x++) this.set(x, y, idx, isStatus)
      }
    }
  }

  outline(outlineIdx: number): void {
    const snap = new Uint8Array(this.pixels)
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const pos = y * this.width + x
        if (snap[pos] !== 0) continue
        if ((y > 0 && snap[pos - this.width] !== 0) || (y + 1 < this.height && snap[pos + this.width] !== 0)
          || (x > 0 && snap[pos - 1] !== 0) || (x + 1 < this.width && snap[pos + 1] !== 0)) {
          this.pixels[pos] = outlineIdx; this.statusMask[pos] = 0
        }
      }
    }
  }

  blit(src: PixelGrid, dx: number, dy: number, mirrorX = false): void {
    const ox = Math.round(dx), oy = Math.round(dy)
    for (let sy = 0; sy < src.height; sy++) {
      const ty = oy + sy
      if (ty < 0 || ty >= this.height) continue
      for (let sx = 0; sx < src.width; sx++) {
        const sPos = sy * src.width + (mirrorX ? src.width - 1 - sx : sx)
        const idx = src.pixels[sPos] ?? 0
        const tx = ox + sx
        if (idx === 0 || tx < 0 || tx >= this.width) continue
        const tPos = ty * this.width + tx
        this.pixels[tPos] = idx; this.statusMask[tPos] = src.statusMask[sPos] ?? 0
      }
    }
  }

  toRgba(): Uint8Array {
    const rgba = new Uint8Array(this.width * this.height * 4)
    for (let p = 0; p < this.pixels.length; p++) {
      const entry = FROZEN_PALETTE[(this.pixels[p] ?? 0) - 1]
      if (!entry) continue
      const o = p * 4
      rgba[o] = entry.rgb[0]; rgba[o + 1] = entry.rgb[1]; rgba[o + 2] = entry.rgb[2]; rgba[o + 3] = 255
    }
    return rgba
  }
}
