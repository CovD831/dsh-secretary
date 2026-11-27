/** 手工 2:1 等距街景像素精灵集（纹理石板、沥青路、屋顶石砖、纸箱、空调外机与街景道具），严格 46 色契约。 */
import { ImageSource, Texture } from 'pixi.js'

export interface StreetSpriteMeta { readonly tex: Texture; readonly canvas: HTMLCanvasElement; readonly w: number; readonly h: number; readonly ax: number; readonly ay: number }
export interface StreetSpriteAtlas {
  readonly flagstone: StreetSpriteMeta; readonly asphalt: StreetSpriteMeta; readonly slateTile: StreetSpriteMeta
  readonly lamp: StreetSpriteMeta; readonly bench: StreetSpriteMeta; readonly fence: StreetSpriteMeta
  readonly pillar: StreetSpriteMeta; readonly shelter: StreetSpriteMeta; readonly mailbox: StreetSpriteMeta
  readonly bike: StreetSpriteMeta; readonly cardboardBoxes: StreetSpriteMeta; readonly acUnit: StreetSpriteMeta
}

let cachedAtlas: StreetSpriteAtlas | null = null

function makeCanvasSprite(w: number, h: number, ax: number, ay: number, paint: (c: CanvasRenderingContext2D) => void): StreetSpriteMeta {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  const c = cv.getContext('2d')!; c.imageSmoothingEnabled = false; paint(c)
  return { tex: new Texture({ source: new ImageSource({ resource: cv, scaleMode: 'nearest' }) }), canvas: cv, w, h, ax, ay }
}

const p = (c: CanvasRenderingContext2D, x: number, y: number, col: string, w = 1, h = 1) => { c.fillStyle = col; c.fillRect(x, y, w, h) }

function isoDiamondFill(c: CanvasRenderingContext2D, base: string, mortar: string, hi: string, grain: readonly [number, number, string][]): void {
  for (let y = 0; y < 16; y++) {
    const hw = y < 8 ? (y + 1) * 2 : (16 - y) * 2
    p(c, 16 - hw, y, y % 7 === 0 ? mortar : base, hw * 2, 1)
  }
  for (let i = 0; i < 8; i++) p(c, 15 - i * 2, i, mortar, 2, 1), p(c, 15 + i * 2, 15 - i, mortar, 2, 1)
  p(c, 14, 2, hi, 4, 1); p(c, 8, 6, hi, 3, 1); p(c, 20, 9, hi, 3, 1)
  for (const [gx, gy, gcol] of grain) p(c, gx, gy, gcol, 1, 1)
}

function isoQuadFill(c: CanvasRenderingContext2D, x0: number, y0: number, dxU: number, dxV: number, col: string): void {
  c.fillStyle = col
  for (let u = 0; u < dxU; u++) for (let v = 0; v < dxV; v++) {
    c.fillRect(x0 + u - v, y0 + Math.floor((u + v) * 0.5), 2, 1)
  }
}

export function getStreetSpriteAtlas(): StreetSpriteAtlas {
  if (cachedAtlas) return cachedAtlas
  const flagstone = makeCanvasSprite(32, 16, 16, 8, (c) => isoDiamondFill(c, '#4A4440', '#2E2A2A', '#6E665E', [[12, 4, '#5A463A'], [18, 7, '#3A2E28'], [14, 11, '#5A463A'], [22, 6, '#6E665E']]))
  const asphalt = makeCanvasSprite(32, 16, 16, 8, (c) => isoDiamondFill(c, '#2E2A2A', '#201A18', '#3A2E28', [[11, 6, '#201A18'], [17, 5, '#4A4440'], [15, 10, '#201A18'], [21, 8, '#3A2E28'], [13, 8, '#4A4440']]))
  const slateTile = makeCanvasSprite(32, 16, 16, 8, (c) => isoDiamondFill(c, '#3A2E28', '#201A18', '#5A463A', [[10, 7, '#4A4440'], [16, 5, '#6E665E'], [21, 9, '#2E2A2A'], [14, 10, '#4A4440']]))

  const lamp = makeCanvasSprite(28, 58, 14, 54, (c) => {
    p(c, 10, 50, '#1A1412', 8, 5); p(c, 11, 51, '#4A4440', 6, 3); p(c, 11, 47, '#1A1412', 6, 4); p(c, 12, 48, '#2E2A2A', 4, 2)
    p(c, 12, 18, '#1A1412', 4, 30); p(c, 13, 18, '#4A4440', 2, 29); p(c, 11, 29, '#C9A46A', 6, 2)
    p(c, 9, 13, '#1A1412', 10, 4); p(c, 10, 14, '#4A4440', 8, 2); p(c, 11, 4, '#1A1412', 6, 3); p(c, 12, 3, '#4A3428', 4, 2)
    p(c, 9, 7, '#1A1412', 10, 7); p(c, 10, 8, '#C9A46A', 8, 5); p(c, 11, 9, '#F2A93B', 6, 4); p(c, 13, 10, '#E8DCCB', 2, 2)
  })

  const bench = makeCanvasSprite(48, 34, 24, 28, (c) => {
    for (let u = 0; u < 24; u++) {
      const x = 12 + u, sy = 14 + Math.floor(u * 0.5)
      p(c, x, sy - 6, '#1A1412', 1, 7); p(c, x, sy - 5, u % 2 === 0 ? '#6B4A32' : '#8A6242', 1, 2); p(c, x, sy - 2, '#4A3428', 1, 2)
      p(c, x - 4, sy + 2, '#1A1412', 5, 5); p(c, x - 2, sy + 2, u % 2 === 0 ? '#8A6242' : '#6B4A32', 2, 2); p(c, x - 4, sy + 4, '#4A3428', 2, 2)
    }
    for (const dx of [0, 22]) {
      const lx = 12 + dx, ly = 14 + Math.floor(dx * 0.5)
      p(c, lx - 6, ly + 4, '#1A1412', 3, 8); p(c, lx - 5, ly + 4, '#4A4440', 1, 7)
      p(c, lx, ly + 1, '#1A1412', 3, 8); p(c, lx + 1, ly + 1, '#4A4440', 1, 7)
      p(c, lx - 5, ly + 1, '#1A1412', 6, 3); p(c, lx - 4, ly + 2, '#6E665E', 4, 1)
    }
  })

  const fence = makeCanvasSprite(32, 26, 16, 22, (c) => {
    for (let u = 0; u < 30; u++) {
      const x = 1 + u, y = 7 + Math.floor(u * 0.5)
      p(c, x, y + 6, '#1A1412', 1, 7); p(c, x, y + 7, '#5A463A', 1, 4); p(c, x, y + 11, '#3A2E28', 1, 2)
      p(c, x, y + 1, '#1A1412', 1, 1); p(c, x, y + 4, '#2E2A2A', 1, 1)
      if (u % 4 === 1) p(c, x, y - 1, '#1A1412', 2, 7), p(c, x, y, '#4A4440', 1, 5)
    }
  })

  const pillar = makeCanvasSprite(20, 34, 10, 30, (c) => {
    for (let i = 0; i < 6; i++) {
      const dy = Math.floor(i * 0.5)
      p(c, 4 + i, 10 + dy, '#1A1412', 1, 19); p(c, 15 - i, 10 + dy, '#1A1412', 1, 19)
      if (i > 0) {
        p(c, 4 + i, 11 + dy, (11 + dy) % 4 === 0 ? '#3A2E28' : '#5A463A', 1, 16)
        p(c, 15 - i, 11 + dy, (11 + dy) % 4 === 0 ? '#2E2A2A' : '#3A2E28', 1, 16)
      }
    }
    isoQuadFill(c, 10, 6, 6, 6, '#BFA48C'); p(c, 8, 5, '#C9A46A', 4, 2)
  })

  const shelter = makeCanvasSprite(56, 54, 28, 46, (c) => {
    for (const [px, py] of [[10, 22], [38, 36], [16, 17], [44, 31]] as const) {
      p(c, px, py, '#1A1412', 4, 20); p(c, px + 1, py + 1, '#4A3428', 2, 18)
    }
    for (let u = 0; u < 28; u++) {
      const x = 14 + u, y = 18 + Math.floor(u * 0.5)
      p(c, x, y, '#1A1412', 1, 16); p(c, x, y + 2, u % 7 === 0 ? '#6B7F96' : '#3F5A78', 1, 11)
      if (u > 6 && u < 16) p(c, x, y + 4, '#E8DCCB', 1, 5)
    }
    for (let u = 0; u < 36; u++) for (let v = 0; v < 10; v++) {
      const rx = 8 + u - v, ry = 8 + Math.floor((u + v) * 0.5)
      p(c, rx, ry, v === 0 || v === 9 || u === 0 || u === 35 ? '#1A1412' : u % 3 === 0 ? '#4A3428' : '#6B4A32', 2, 2)
    }
    p(c, 26, 20, '#F2A93B', 4, 3); p(c, 27, 21, '#E8DCCB', 2, 1)
  })

  const mailbox = makeCanvasSprite(24, 36, 12, 32, (c) => {
    p(c, 10, 17, '#1A1412', 4, 15); p(c, 11, 18, '#4A3428', 2, 13)
    p(c, 6, 7, '#1A1412', 12, 11); p(c, 7, 8, '#7A3A3A', 6, 9); p(c, 13, 9, '#9E2F2C', 4, 8)
    p(c, 8, 10, '#C9A46A', 4, 2); p(c, 7, 6, '#3A2E28', 10, 2)
  })

  const bike = makeCanvasSprite(36, 30, 18, 26, (c) => {
    for (const [wx, wy] of [[9, 17], [25, 22]] as const) {
      p(c, wx - 4, wy - 4, '#1A1412', 8, 8); p(c, wx - 3, wy - 3, '#4A4440', 6, 6); p(c, wx - 2, wy - 2, '#6E665E', 4, 4); p(c, wx - 1, wy - 1, '#2E2A2A', 2, 2)
    }
    for (let i = 0; i <= 10; i++) p(c, 10 + i, 14 + Math.floor(i * 0.3), '#3F5A78', 2, 2)
    p(c, 12, 10, '#1A1412', 4, 2); p(c, 12, 9, '#8A6242', 4, 2); p(c, 21, 9, '#1A1412', 3, 10)
    p(c, 19, 8, '#6E665E', 6, 2); p(c, 22, 10, '#8A6242', 5, 4)
  })

  const cardboardBoxes = makeCanvasSprite(40, 34, 20, 29, (c) => {
    for (const [bx, by, w, h] of [[8, 12, 16, 16], [19, 17, 14, 13], [13, 6, 11, 9]] as const) {
      p(c, bx, by, '#1A1412', w, h); p(c, bx + 1, by + 1, '#BFA48C', w - 2, 3)
      p(c, bx + 1, by + 4, '#8A6242', Math.floor((w - 2) / 2), h - 5)
      p(c, bx + 1 + Math.floor((w - 2) / 2), by + 4, '#6B4A32', Math.ceil((w - 2) / 2), h - 5)
      p(c, bx + Math.floor(w / 2) - 1, by + 1, '#D9C4A8', 2, 5)
    }
    p(c, 4, 20, '#1A1412', 7, 10); p(c, 5, 21, '#E8DCCB', 5, 5); p(c, 6, 23, '#C9A46A', 3, 1); p(c, 5, 26, '#4A3428', 1, 4); p(c, 9, 26, '#4A3428', 1, 4)
  })

  const acUnit = makeCanvasSprite(32, 28, 16, 23, (c) => {
    p(c, 4, 8, '#1A1412', 24, 17); p(c, 5, 9, '#6E665E', 22, 3)
    p(c, 5, 12, '#4A4440', 11, 12); p(c, 16, 12, '#2E2A2A', 11, 12)
    for (let y = 14; y < 22; y += 2) p(c, 7, y, '#201A18', 7, 1)
    p(c, 18, 14, '#1A1412', 7, 7); p(c, 20, 16, '#4A4440', 3, 3)
  })

  cachedAtlas = { flagstone, asphalt, slateTile, lamp, bench, fence, pillar, shelter, mailbox, bike, cardboardBoxes, acUnit }
  return cachedAtlas
}
