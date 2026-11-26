import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

const OUT_DIR = join(resolve(import.meta.dirname, '..'), 'assets', 'office')
const NON_STATUS_HEXES = [
  '#3A2E28', '#5A463A', '#7A6150', '#9C8069', '#BFA48C', '#D9C4A8', '#4A3428', '#6B4A32', '#8A6242', '#A87A52',
  '#3B2A22', '#5E4130', '#7C5A3E', '#96704C', '#1A1412', '#2C211B', '#2E2A2A', '#4A4440', '#6E665E', '#8C8478',
  '#3E4A44', '#6B3A32', '#D8C0A8', '#C09070', '#8F6046', '#2A2220', '#7A5438', '#C9C0B4', '#3F5A78', '#7A3A3A',
  '#4A6A50', '#D8D0C0', '#6B7F96', '#201A18', '#302722', '#4A3C34', '#E8DCCB', '#C9A46A',
]
const OUTLINE_RGB = [0x1A, 0x14, 0x12]
const srgbToLin = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
function rgbToOklab(r, g, b) {
  const lr = srgbToLin(r), lg = srgbToLin(g), lb = srgbToLin(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
const PALETTE = NON_STATUS_HEXES.map((hex) => {
  const n = Number.parseInt(hex.slice(1), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return { hex, rgb, oklab: rgbToOklab(rgb[0], rgb[1], rgb[2]) }
})
const PALETTE_SET = new Set(NON_STATUS_HEXES)
function quantizeNonStatus(r, g, b) {
  const [L, a, bk] = rgbToOklab(r, g, b)
  let best = PALETTE[0], bestDist = Infinity
  for (const e of PALETTE) {
    const dL = L - e.oklab[0], da = a - e.oklab[1], db = bk - e.oklab[2]
    const dist = dL * dL + da * da + db * db
    if (dist < bestDist) { bestDist = dist; best = e }
  }
  return best
}
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
function decodePng(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let offset = 8, w = 0, h = 0, ct = 0
  const idats = []
  while (offset + 8 <= buf.length) {
    const len = view.getUint32(offset, false), type = buf.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') { const iv = new DataView(data.buffer, data.byteOffset, data.byteLength); w = iv.getUint32(0, false); h = iv.getUint32(4, false); ct = data[9] }
    else if (type === 'IDAT') idats.push(data)
    else if (type === 'IEND') break
    offset += 12 + len
  }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idats)), stride = w * bpp, rgba = new Uint8Array(w * h * 4)
  const prev = new Uint8Array(stride), curr = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], rowOff = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const val = raw[rowOff + x], a = x >= bpp ? curr[x - bpp] : 0, b = y > 0 ? prev[x] : 0, c = y > 0 && x >= bpp ? prev[x - bpp] : 0
      curr[x] = (f === 0 ? val : f === 1 ? val + a : f === 2 ? val + b : f === 3 ? val + ((a + b) >> 1) : val + paeth(a, b, c)) & 255
    }
    prev.set(curr)
    for (let x = 0; x < w; x++) {
      const si = x * bpp, di = (y * w + x) * 4
      rgba[di] = curr[si]; rgba[di + 1] = curr[si + 1]; rgba[di + 2] = curr[si + 2]; rgba[di + 3] = ct === 6 ? curr[si + 3] : 255
    }
  }
  return { w, h, rgba }
}
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0
})
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer)
  dv.setUint32(0, data.length, false)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8); dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false)
  return out
}
function encodePngRgba(rgba, w, h) {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ihdr = new Uint8Array(13), iv = new DataView(ihdr.buffer)
  iv.setUint32(0, w, false); iv.setUint32(4, h, false); ihdr[8] = 8; ihdr[9] = 6
  const raw = new Uint8Array(h * (1 + w * 4))
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 4)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1) }
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let pos = 0; for (const p of parts) { out.set(p, pos); pos += p.length }
  return out
}
function floodBgAndComponents(w, h, rgba) {
  const bg = new Uint8Array(w * h), q = new Int32Array(w * h)
  let head = 0, tail = 0
  const isBg = (p) => { const i = p * 4; return rgba[i + 3] < 128 || (rgba[i] > 238 && rgba[i + 1] > 238 && rgba[i + 2] > 238) }
  const push = (x, y) => { const p = y * w + x; if (!bg[p] && isBg(p)) { bg[p] = 1; q[tail++] = p } }
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }
  while (head < tail) {
    const p = q[head++], x = p % w, y = (p - x) / w
    if (x > 0) push(x - 1, y); if (x + 1 < w) push(x + 1, y); if (y > 0) push(x, y - 1); if (y + 1 < h) push(x, y + 1)
  }
  const seen = new Uint8Array(w * h), comps = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p0 = y * w + x; if (bg[p0] || seen[p0]) continue
    let ch = 0, ct = 0; seen[p0] = 1; q[ct++] = p0
    let minX = x, maxX = x, minY = y, maxY = y, count = 0
    while (ch < ct) {
      const p = q[ch++]; count++; const cx = p % w, cy = (p - cx) / w
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx; if (cy < minY) minY = cy; if (cy > maxY) maxY = cy
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = cx + dx, ny = cy + dy
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) { const np = ny * w + nx; if (!bg[np] && !seen[np]) { seen[np] = 1; q[ct++] = np } }
      }
    }
    if (count > 50) comps.push({ minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 })
  }
  return { bg, comps }
}
function resampleAndQuantize(src, bg, comp, tw, th, fitMode = 'contain') {
  const out = new Uint8Array(tw * th * 4)
  let dw = tw, dh = th, ox = 0, oy = 0
  if (fitMode === 'contain' || fitMode === 'bottom') {
    const scale = Math.min((tw - 2) / comp.w, (fitMode === 'bottom' ? th - 5 : th - 2) / comp.h)
    dw = Math.max(1, Math.round(comp.w * scale)); dh = Math.max(1, Math.round(comp.h * scale))
    ox = Math.floor((tw - dw) / 2); oy = fitMode === 'bottom' ? (th - 4 - dh) : Math.floor((th - dh) / 2)
  }
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(comp.maxY, comp.minY + Math.floor((y + 0.5) * comp.h / dh))
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(comp.maxX, comp.minX + Math.floor((x + 0.5) * comp.w / dw)), sp = sy * src.w + sx
      if (bg[sp]) continue
      const si = sp * 4, e = quantizeNonStatus(src.rgba[si], src.rgba[si + 1], src.rgba[si + 2])
      const di = ((oy + y) * tw + (ox + x)) * 4
      out[di] = e.rgb[0]; out[di + 1] = e.rgb[1]; out[di + 2] = e.rgb[2]; out[di + 3] = 255
    }
  }
  const snap = new Uint8Array(out)
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const di = (y * tw + x) * 4; if (snap[di + 3] !== 0) continue
    if ((y > 0 && snap[((y - 1) * tw + x) * 4 + 3] === 255) || (y + 1 < th && snap[((y + 1) * tw + x) * 4 + 3] === 255)
      || (x > 0 && snap[(y * tw + x - 1) * 4 + 3] === 255) || (x + 1 < tw && snap[(y * tw + x + 1) * 4 + 3] === 255)) {
      out[di] = OUTLINE_RGB[0]; out[di + 1] = OUTLINE_RGB[1]; out[di + 2] = OUTLINE_RGB[2]; out[di + 3] = 255
    }
  }
  return out
}
function auditBuffer(rgba) {
  const colors = new Set(); let opaquePixels = 0, semiTransparentCount = 0, outOfPaletteCount = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]; if (a === 0) continue; if (a !== 255) semiTransparentCount++; opaquePixels++
    const hex = `#${[rgba[i], rgba[i + 1], rgba[i + 2]].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')}`
    if (!PALETTE_SET.has(hex)) outOfPaletteCount++; colors.add(hex)
  }
  return { opaquePixels, uniqueColors: colors.size, outOfPaletteCount, semiTransparentCount }
}
function mirrorRgbaX(rgba, w, h) {
  const out = new Uint8Array(rgba.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y * w + (w - 1 - x)) * 4, di = (y * w + x) * 4
    out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3]
  }
  return out
}

mkdirSync(OUT_DIR, { recursive: true })
const manifest = { version: 1, paletteSize: PALETTE.length, assets: {} }
function emitAsset(id, rgba, w, h, anchor, extra = {}) {
  const file = `${id}.png`
  writeFileSync(join(OUT_DIR, file), encodePngRgba(rgba, w, h))
  const audit = auditBuffer(rgba)
  if (audit.outOfPaletteCount > 0 || audit.semiTransparentCount > 0) throw new Error(`Asset ${id} failed audit`)
  manifest.assets[id] = { file, width: w, height: h, anchor, ...extra, ...audit }
}

const archSrc = decodePng(readFileSync('/tmp/office_raw_arch.png'))
const arch = floodBgAndComponents(archSrc.w, archSrc.h, archSrc.rgba)
const archSorted = [...arch.comps].sort((a, b) => (a.minY < 410 ? 0 : 1) - (b.minY < 410 ? 0 : 1) || a.minX - b.minX)
;[
  ['floor_wood', 32, 16, [16, 8], 'stretch'], ['rug_woven', 64, 32, [32, 16], 'stretch'],
  ['wall_segment', 80, 56, [40, 52], 'contain'], ['door_glass', 80, 56, [40, 52], 'contain'],
  ['window_day', 64, 48, [32, 44], 'contain'], ['clock_wall', 24, 24, [12, 12], 'contain'],
  ['corkboard', 80, 56, [40, 52], 'contain'],
].forEach(([id, w, h, anchor, mode], idx) => emitAsset(id, resampleAndQuantize(archSrc, arch.bg, archSorted[idx], w, h, mode), w, h, anchor))

const propsSrc = decodePng(readFileSync('/tmp/office_raw_props.png'))
const props = floodBgAndComponents(propsSrc.w, propsSrc.h, propsSrc.rgba)
const propsSorted = [...props.comps].sort((a, b) => (a.minY < 410 ? 0 : 1) - (b.minY < 410 ? 0 : 1) || a.minX - b.minX)
;[
  ['reception_desk', 80, 56, [40, 50], 'contain'], ['exec_desk', 96, 64, [48, 56], 'contain'],
  ['worker_desk', 64, 48, [32, 42], 'contain'], ['bookshelf', 64, 56, [32, 50], 'contain'],
  ['file_cabinet', 64, 56, [32, 50], 'contain'], ['water_cooler', 32, 48, [16, 44], 'contain'],
  ['plant_pot', 32, 48, [16, 44], 'contain'],
].forEach(([id, w, h, anchor, mode], idx) => emitAsset(id, resampleAndQuantize(propsSrc, props.bg, propsSorted[idx], w, h, mode), w, h, anchor))

const charSrc = decodePng(readFileSync('/tmp/office_raw_chars.png'))
const chars = floodBgAndComponents(charSrc.w, charSrc.h, charSrc.rgba)
const charRows = [0, 1, 2].map((r) => chars.comps.filter((c) => c.minY >= r * 295 && c.minY < (r + 1) * 295).sort((a, b) => a.minX - b.minX))
;['char_secretary', 'char_lead', 'char_worker'].forEach((id, r) => {
  const sheetW = 128, sheetH = 96, sheet = new Uint8Array(sheetW * sheetH * 4)
  for (let c = 0; c < 4; c++) {
    const cellSe = resampleAndQuantize(charSrc, chars.bg, charRows[r][c], 32, 48, 'bottom')
    const cellSw = mirrorRgbaX(cellSe, 32, 48)
    for (let y = 0; y < 48; y++) {
      sheet.set(cellSe.subarray(y * 32 * 4, (y + 1) * 32 * 4), (y * sheetW + c * 32) * 4)
      sheet.set(cellSw.subarray(y * 32 * 4, (y + 1) * 32 * 4), ((48 + y) * sheetW + c * 32) * 4)
    }
  }
  emitAsset(id, sheet, sheetW, sheetH, [16, 44], { cellSize: [32, 48], cols: 4, rows: 2 })
})

function buildDoorplateRgba() {
  const w = 24, h = 16, out = new Uint8Array(w * h * 4)
  const setPx = (x, y, hex) => {
    const n = Number.parseInt(hex.slice(1), 16), di = (y * w + x) * 4
    out[di] = (n >> 16) & 255; out[di + 1] = (n >> 8) & 255; out[di + 2] = n & 255; out[di + 3] = 255
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const border = x === 1 || x === w - 2 || y === 1 || y === h - 2
    const inner = x >= 4 && x <= w - 5 && y >= 4 && y <= h - 5
    const textLine = (y === 6 || y === 9) && x >= 6 && x <= w - 7 && x % 2 === 0
    setPx(x, y, border ? '#1A1412' : textLine ? '#2C211B' : inner ? '#C9A46A' : '#4A3428')
  }
  return out
}
emitAsset('doorplate', buildDoorplateRgba(), 24, 16, [12, 12])

writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`Sliced ${Object.keys(manifest.assets).length} assets into ${OUT_DIR}`)
