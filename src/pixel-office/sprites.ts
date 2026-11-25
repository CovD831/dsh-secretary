import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { packagePath } from '../infra/paths.ts'
import { colorIndex, PixelGrid, STATUS_COLOR_MAP, type SecretaryMood, type StatusKind } from './palette.ts'
import { NATIVE_H, NATIVE_W, PORTRAIT_H, PORTRAIT_W } from './layout.ts'

const C = (hex: string): number => colorIndex(hex)
const ASSET_DIR = packagePath('assets', 'f1-proof')

export const AI_MONITOR_ANCHORS: ReadonlyArray<{ suiteId: string; x: number; y: number }> = [
  { suiteId: 'executive', x: 407, y: 131 },
  { suiteId: 'executive', x: 424, y: 141 },
  { suiteId: 'ws-1', x: 560, y: 179 },
  { suiteId: 'ws-2', x: 475, y: 221 },
  { suiteId: 'ws-3', x: 382, y: 273 },
]

export const GATE_TARGET_POS = { boxX: 486, boxY: 204, scanX: 478, scanY: 266 } as const

const PORTRAIT_FILES: Record<SecretaryMood, string> = {
  neutral: 'portrait_neutral.png',
  working: 'portrait_working.png',
  happy: 'portrait_happy.png',
  concerned: 'portrait_concerned.png',
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function decodePngRgba(buf: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let width = 0, height = 0, offset = 8
  const idats: Uint8Array[] = []
  while (offset + 8 <= buf.length) {
    const len = view.getUint32(offset, false)
    const type = String.fromCharCode(buf[offset + 4]!, buf[offset + 5]!, buf[offset + 6]!, buf[offset + 7]!)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      const iv = new DataView(data.buffer, data.byteOffset, data.byteLength)
      width = iv.getUint32(0, false)
      height = iv.getUint32(4, false)
      if (data[8] !== 8 || data[9] !== 6) {
        throw new Error(`Unsupported PNG IHDR bitDepth=${data[8]} colorType=${data[9]}, expected 8-bit RGBA`)
      }
    } else if (type === 'IDAT') {
      idats.push(data)
    } else if (type === 'IEND') break
    offset += 12 + len
  }
  const totalLen = idats.reduce((s, d) => s + d.length, 0)
  const compressed = new Uint8Array(totalLen)
  let pos = 0
  for (const d of idats) { compressed.set(d, pos); pos += d.length }
  const raw = inflateSync(compressed)
  const stride = width * 4
  const rgba = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)] ?? 0
    const rowOff = y * (stride + 1) + 1
    const outOff = y * stride
    for (let x = 0; x < stride; x++) {
      const val = raw[rowOff + x] ?? 0
      const a = x >= 4 ? (rgba[outOff + x - 4] ?? 0) : 0
      const b = y > 0 ? (rgba[outOff - stride + x] ?? 0) : 0
      const c = y > 0 && x >= 4 ? (rgba[outOff - stride + x - 4] ?? 0) : 0
      const recon = f === 0 ? val : f === 1 ? val + a : f === 2 ? val + b : f === 3 ? val + ((a + b) >> 1) : val + paeth(a, b, c)
      rgba[outOff + x] = recon & 255
    }
  }
  return { width, height, rgba }
}

const spriteCache = new Map<string, PixelGrid>()

function loadAssetGrid(filename: string, expectedW: number, expectedH: number): PixelGrid {
  const hit = spriteCache.get(filename)
  if (hit) return hit
  const decoded = decodePngRgba(readFileSync(join(ASSET_DIR, filename)))
  if (decoded.width !== expectedW || decoded.height !== expectedH) {
    throw new Error(`Asset ${filename} size ${decoded.width}x${decoded.height} != ${expectedW}x${expectedH}`)
  }
  const grid = PixelGrid.fromRgba(decoded.rgba, decoded.width, decoded.height)
  spriteCache.set(filename, grid)
  return grid
}

export function loadAiRoomGrid(): PixelGrid {
  return loadAssetGrid('room_ai_quantized.png', NATIVE_W, NATIVE_H)
}

export function buildSecretaryPortrait(mood: SecretaryMood): PixelGrid {
  return loadAssetGrid(PORTRAIT_FILES[mood], PORTRAIT_W, PORTRAIT_H)
}

export function buildMonitorScreen(state: StatusKind | 'off'): PixelGrid {
  const g = new PixelGrid(20, 16)
  g.fillRect(2, 2, 16, 12, C('#2E2A2A'))
  g.fillRect(3, 3, 14, 10, C('#201A18'))
  if (state === 'off') return g
  const { bright, dark } = STATUS_COLOR_MAP[state]
  const b = C(bright), d = C(dark)
  for (let y = 1; y < 15; y++) for (let x = 1; x < 19; x++) {
    if (x < 3 || x >= 17 || y < 3 || y >= 13) g.set(x, y, d, true)
  }
  g.fillRect(3, 3, 14, 10, d, true)
  if (state === 'working') {
    g.fillRect(4, 5, 12, 2, b, true); g.fillRect(4, 8, 9, 2, b, true); g.fillRect(4, 11, 12, 1, b, true)
  } else if (state === 'stuck') {
    g.fillRect(4, 5, 4, 2, b, true); g.fillRect(10, 5, 5, 2, b, true)
    g.fillRect(4, 9, 7, 2, b, true); g.fillRect(13, 9, 2, 2, b, true)
  } else if (state === 'needsDecision') {
    g.fillPoly([[10, 4], [15, 12], [5, 12]], b, true)
    g.fillRect(10, 6, 1, 3, C('#201A18')); g.set(10, 10, C('#201A18'))
  } else {
    g.drawLine(5, 8, 8, 11, b, true); g.drawLine(8, 11, 14, 5, b, true); g.drawLine(5, 9, 8, 12, b, true)
  }
  return g
}

export function buildGateInterceptOverlay(frame: number): { box: PixelGrid; scanline: PixelGrid } {
  const box = new PixelGrid(20, 14)
  box.fillRect(0, 0, 20, 14, C('#9E2F2C'), true); box.fillRect(1, 1, 18, 12, C('#E8544E'), true)
  box.fillRect(9, 3, 2, 5, C('#E8DCCB')); box.fillRect(9, 9, 2, 2, C('#E8DCCB'))
  const scanline = new PixelGrid(36, 10)
  const barY = (frame % 3) * 3
  scanline.fillRect(0, barY, 36, 2, C('#E8544E'), true); scanline.fillRect(2, barY + 2, 32, 1, C('#9E2F2C'), true)
  return { box, scanline }
}
