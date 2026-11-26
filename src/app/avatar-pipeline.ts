/** 自定义秘书形象 46 色规整、存储与切换管线（严禁任意图片上传与密钥落盘）。 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { KV } from '../kv.ts'
import {
  auditPaletteBuffer, colorIndex, encodePngRgba, FROZEN_PALETTE, PixelGrid, PORTRAIT_H, PORTRAIT_W,
  rgbToOklab, type PaletteEntry, type SecretaryMood,
} from '../pixel-office/index.ts'
import type { Store } from './store.ts'

export const DEFAULT_AVATAR_ID = 'preset-walnut-01'
const MOODS: readonly SecretaryMood[] = ['neutral', 'working', 'happy', 'concerned']
const AVATAR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const NON_STATUS_PALETTE: readonly PaletteEntry[] = FROZEN_PALETTE.filter(e => e.category !== 'status')
const NON_STATUS_BY_RGB = new Map<number, PaletteEntry>(
  NON_STATUS_PALETTE.map(e => [((e.rgb[0] << 16) | (e.rgb[1] << 8) | e.rgb[2]), e]),
)

export type AvatarProviderKind = 'preset' | 'remote-ai' | 'local-remix'

export interface AvatarPackSummary {
  id: string
  name: string
  source: 'preset' | 'ai'
  provider?: AvatarProviderKind
  createdAt: string
  portraitUrls: Record<SecretaryMood, string>
  spriteUrl?: string
  quantized: boolean
  outOfPaletteCount: number
  statusPixels: number
  semiTransparentCount: number
}

export interface ProcessAvatarPackInput {
  stateDir: string
  id: string
  name: string
  prompt: string
  model: string
  provider?: AvatarProviderKind
  seed: number
  rawPortraits: Partial<Record<SecretaryMood, Buffer>>
  rawSpriteSheet?: Buffer
  now?: () => Date
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function decodePng(buf: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error('无效的 PNG 文件头')
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let width = 0, height = 0, colorType = 6, offset = 8
  const idats: Uint8Array[] = []
  while (offset + 8 <= buf.length) {
    const len = view.getUint32(offset, false)
    const type = String.fromCharCode(buf[offset + 4]!, buf[offset + 5]!, buf[offset + 6]!, buf[offset + 7]!)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      const iv = new DataView(data.buffer, data.byteOffset, data.byteLength)
      width = iv.getUint32(0, false); height = iv.getUint32(4, false); colorType = data[9] ?? 0
      if (data[8] !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new Error(`仅支持 8-bit RGB/RGBA PNG（收到 bitDepth=${data[8]} colorType=${colorType}）`)
      }
    } else if (type === 'IDAT') idats.push(data)
    else if (type === 'IEND') break
    offset += 12 + len
  }
  const bpp = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idats))
  const stride = width * bpp
  const pixels = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)] ?? 0
    const rowOff = y * (stride + 1) + 1
    const outOff = y * stride
    for (let x = 0; x < stride; x++) {
      const val = raw[rowOff + x] ?? 0
      const a = x >= bpp ? (pixels[outOff + x - bpp] ?? 0) : 0
      const b = y > 0 ? (pixels[outOff - stride + x] ?? 0) : 0
      const c = y > 0 && x >= bpp ? (pixels[outOff - stride + x - bpp] ?? 0) : 0
      const recon = f === 0 ? val : f === 1 ? val + a : f === 2 ? val + b : f === 3 ? val + ((a + b) >> 1) : val + paeth(a, b, c)
      pixels[outOff + x] = recon & 255
    }
  }
  if (colorType === 6) return { width, height, rgba: pixels }
  const rgba = new Uint8Array(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = pixels[p * 3]!; rgba[p * 4 + 1] = pixels[p * 3 + 1]!; rgba[p * 4 + 2] = pixels[p * 3 + 2]!; rgba[p * 4 + 3] = 255
  }
  return { width, height, rgba }
}

function quantizeNonStatusOklab(r: number, g: number, b: number): PaletteEntry {
  const exact = NON_STATUS_BY_RGB.get(((r & 255) << 16) | ((g & 255) << 8) | (b & 255))
  if (exact) return exact
  const [L, a, bk] = rgbToOklab(r, g, b)
  let best = NON_STATUS_PALETTE[0]!, bestDist = Infinity
  for (const entry of NON_STATUS_PALETTE) {
    const dL = L - entry.oklab[0], da = a - entry.oklab[1], db = bk - entry.oklab[2]
    const dist = dL * dL + da * da + db * db
    if (dist < bestDist) { bestDist = dist; best = entry }
  }
  return best
}

function removeBackgroundBfs(rgba: Uint8Array, width: number, height: number, tolerance = 28): Uint8Array {
  const out = new Uint8Array(rgba)
  const corners: [number, number][] = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
  const bgSeeds: [number, number, number][] = []
  for (const [cx, cy] of corners) {
    const idx = (cy * width + cx) * 4
    if ((out[idx + 3] ?? 0) >= 128) bgSeeds.push([out[idx]!, out[idx + 1]!, out[idx + 2]!])
  }
  if (bgSeeds.length === 0) return out
  const visited = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0, tail = 0
  const matchesBg = (p: number): boolean => {
    const idx = p * 4
    if ((out[idx + 3] ?? 0) < 128) return true
    const r = out[idx]!, g = out[idx + 1]!, b = out[idx + 2]!
    return bgSeeds.some(([sr, sg, sb]) =>
      Math.abs(r - sr) <= tolerance && Math.abs(g - sg) <= tolerance && Math.abs(b - sb) <= tolerance)
  }
  for (const [cx, cy] of corners) {
    const p = cy * width + cx
    if (!visited[p] && matchesBg(p)) { visited[p] = 1; queue[tail++] = p }
  }
  while (head < tail) {
    const p = queue[head++]!
    out[p * 4 + 3] = 0
    const x = p % width, y = (p - x) / width
    const neighbors = [x > 0 ? p - 1 : -1, x + 1 < width ? p + 1 : -1, y > 0 ? p - width : -1, y + 1 < height ? p + width : -1]
    for (const np of neighbors) {
      if (np >= 0 && !visited[np] && matchesBg(np)) { visited[np] = 1; queue[tail++] = np }
    }
  }
  return out
}

function normalizeToGrid(rgba: Uint8Array, width: number, height: number, targetW: number, targetH: number): PixelGrid {
  const clean = removeBackgroundBfs(rgba, width, height)
  const scale = width / targetW
  const grid = new PixelGrid(targetW, targetH)
  const offset = Math.floor(scale / 2)
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(width - 1, x * scale + offset)
      const sy = Math.min(height - 1, y * scale + offset)
      const i = (sy * width + sx) * 4
      if ((clean[i + 3] ?? 0) < 128) continue
      const entry = quantizeNonStatusOklab(clean[i]!, clean[i + 1]!, clean[i + 2]!)
      grid.set(x, y, colorIndex(entry.hex), false)
    }
  }
  grid.outline(colorIndex('#1A1412'))
  return grid
}

/** 校验、去底、整数倍降采样并量化入库自定义秘书形象包（46 色中仅用 38 个非状态色）。 */
export function processAndStoreAvatarPack(input: ProcessAvatarPackInput): AvatarPackSummary {
  if (!AVATAR_ID_RE.test(input.id)) throw new Error(`非法形象包 ID：${input.id}`)
  for (const mood of MOODS) {
    if (!input.rawPortraits[mood]?.length) throw new Error(`缺少 ${mood}：四表情缺一不可，请补图后重试`)
  }
  const decodedPortraits = {} as Record<SecretaryMood, { width: number; height: number; rgba: Uint8Array }>
  for (const mood of MOODS) {
    const img = decodePng(input.rawPortraits[mood]!)
    const valid = (img.width === 192 && img.height === 240) || (img.width === 384 && img.height === 480) || (img.width === 768 && img.height === 960)
    if (!valid) throw new Error(`图片 ${img.width}x${img.height} 不是 192×240 的整数倍，请使用 384×480 或 768×960`)
    decodedPortraits[mood] = img
  }
  let decodedSprite: { width: number; height: number; rgba: Uint8Array } | undefined
  if (input.rawSpriteSheet) {
    const sp = decodePng(input.rawSpriteSheet)
    const valid = (sp.width === 192 && sp.height === 192) || (sp.width === 384 && sp.height === 384) || (sp.width === 768 && sp.height === 768)
    if (!valid) throw new Error(`帧表 ${sp.width}x${sp.height} 不是 192×192 的整数倍，请使用 384×384 或 768×768`)
    decodedSprite = sp
  }
  let outOfPaletteCount = 0, statusPixels = 0, semiTransparentCount = 0
  const encodedPortraits = {} as Record<SecretaryMood, Uint8Array>
  for (const mood of MOODS) {
    const img = decodedPortraits[mood]
    const grid = normalizeToGrid(img.rgba, img.width, img.height, PORTRAIT_W, PORTRAIT_H)
    const outRgba = grid.toRgba()
    const audit = auditPaletteBuffer(outRgba, PORTRAIT_W, PORTRAIT_H, new Uint8Array(PORTRAIT_W * PORTRAIT_H))
    outOfPaletteCount += audit.outOfPaletteCount
    statusPixels += audit.statusPixelsOutsideMask
    semiTransparentCount += audit.semiTransparentCount
    encodedPortraits[mood] = encodePngRgba(outRgba, PORTRAIT_W, PORTRAIT_H)
  }
  let encodedSprite: Uint8Array | undefined
  if (decodedSprite) {
    const grid = normalizeToGrid(decodedSprite.rgba, decodedSprite.width, decodedSprite.height, 192, 192)
    const outRgba = grid.toRgba()
    const audit = auditPaletteBuffer(outRgba, 192, 192, new Uint8Array(192 * 192))
    outOfPaletteCount += audit.outOfPaletteCount
    statusPixels += audit.statusPixelsOutsideMask
    semiTransparentCount += audit.semiTransparentCount
    encodedSprite = encodePngRgba(outRgba, 192, 192)
  }
  if (outOfPaletteCount > 0 || statusPixels > 0 || semiTransparentCount > 0) {
    throw new Error(`色板核验未通过，拒绝入库 (outOfPalette=${outOfPaletteCount}, status=${statusPixels}, semiAlpha=${semiTransparentCount})`)
  }
  const packDir = join(input.stateDir, 'avatars', input.id)
  const portraitDir = join(packDir, 'portrait')
  mkdirSync(portraitDir, { recursive: true })
  for (const mood of MOODS) writeFileSync(join(portraitDir, `${mood}.png`), encodedPortraits[mood])
  if (encodedSprite) {
    mkdirSync(join(packDir, 'sprite'), { recursive: true })
    writeFileSync(join(packDir, 'sprite', 'secretary.png'), encodedSprite)
  }
  const createdAt = (input.now?.() ?? new Date()).toISOString()
  const provider = input.provider ?? 'remote-ai'
  writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({
    v: 1, id: input.id, name: input.name, source: 'ai', provider, createdAt,
    palette: { quantized: true, colors: 46, nonStatusColors: NON_STATUS_PALETTE.length },
    generation: { model: input.model, provider, seed: input.seed, prompt: input.prompt },
  }, null, 2))
  writeFileSync(join(packDir, 'metrics.json'), JSON.stringify({
    outOfPaletteCount, statusPixels, semiTransparentCount, nativeSize: [PORTRAIT_W, PORTRAIT_H], createdAt,
  }, null, 2))
  return {
    id: input.id, name: input.name, source: 'ai', provider, createdAt,
    portraitUrls: {
      neutral: `/avatar-assets/${input.id}/portrait/neutral.png`,
      working: `/avatar-assets/${input.id}/portrait/working.png`,
      happy: `/avatar-assets/${input.id}/portrait/happy.png`,
      concerned: `/avatar-assets/${input.id}/portrait/concerned.png`,
    },
    ...(encodedSprite ? { spriteUrl: `/avatar-assets/${input.id}/sprite/secretary.png` } : {}),
    quantized: true, outOfPaletteCount, statusPixels, semiTransparentCount,
  }
}

export function listAvatarPacks(stateDir: string, store: Store): { activeId: string; items: AvatarPackSummary[] } {
  const preset: AvatarPackSummary = {
    id: DEFAULT_AVATAR_ID, name: '胡桃木默认秘书', source: 'preset', provider: 'preset', createdAt: '2026-11-23T00:00:00.000Z',
    portraitUrls: {
      neutral: '/assets/f1-proof/portrait_neutral.png', working: '/assets/f1-proof/portrait_working.png',
      happy: '/assets/f1-proof/portrait_happy.png', concerned: '/assets/f1-proof/portrait_concerned.png',
    },
    spriteUrl: '/assets/office/char_secretary.png', quantized: true, outOfPaletteCount: 0, statusPixels: 0, semiTransparentCount: 0,
  }
  const items: AvatarPackSummary[] = [preset]
  const root = join(stateDir, 'avatars')
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !AVATAR_ID_RE.test(entry.name)) continue
      const dir = join(root, entry.name)
      try {
        const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { name?: string; createdAt?: string; provider?: AvatarProviderKind }
        const met = JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8')) as { outOfPaletteCount?: number; statusPixels?: number; semiTransparentCount?: number }
        if (!MOODS.every(mood => existsSync(join(dir, 'portrait', `${mood}.png`)))) continue
        items.push({
          id: entry.name, name: m.name || entry.name, source: 'ai', provider: m.provider ?? 'remote-ai', createdAt: m.createdAt || '',
          portraitUrls: {
            neutral: `/avatar-assets/${entry.name}/portrait/neutral.png`, working: `/avatar-assets/${entry.name}/portrait/working.png`,
            happy: `/avatar-assets/${entry.name}/portrait/happy.png`, concerned: `/avatar-assets/${entry.name}/portrait/concerned.png`,
          },
          ...(existsSync(join(dir, 'sprite', 'secretary.png')) ? { spriteUrl: `/avatar-assets/${entry.name}/sprite/secretary.png` } : {}),
          quantized: true, outOfPaletteCount: met.outOfPaletteCount ?? 0, statusPixels: met.statusPixels ?? 0, semiTransparentCount: met.semiTransparentCount ?? 0,
        })
      } catch { /* 忽略残缺目录 */ }
    }
  }
  const saved = store.get(KV.governance.activeAvatar)
  const activeId = saved && items.some(i => i.id === saved) ? saved : DEFAULT_AVATAR_ID
  return { activeId, items }
}

export function selectAvatarPack(stateDir: string, store: Store, avatarId: string): { ok: boolean; activeId: string } {
  const { items } = listAvatarPacks(stateDir, store)
  if (!items.some(i => i.id === avatarId)) throw new Error(`形象包不存在: ${avatarId}`)
  store.set(KV.governance.activeAvatar, avatarId)
  return { ok: true, activeId: avatarId }
}
