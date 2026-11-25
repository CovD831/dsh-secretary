import { colorIndex, PixelGrid, STATUS_COLOR_MAP, type SecretaryMood, type StatusKind } from './palette.ts'
import {
  FLOOR_ORIGIN_X, FLOOR_ORIGIN_Y, isoToScreen, PORTRAIT_H, PORTRAIT_W, TILE_H, TILE_W,
  type ActorPose, type ActorRole, type Facing, type FurnitureKind, type WallMount,
} from './layout.ts'

const C = (hex: string): number => colorIndex(hex)

function isoBox(
  g: PixelGrid, cx: number, cy: number, wu: number, wv: number, hz: number,
  top: number, left: number, right: number, edge?: number,
): void {
  const hw = TILE_W / 2, hh = TILE_H / 2
  const p0: readonly [number, number] = [cx, cy - hz]
  const p1: readonly [number, number] = [cx + wu * hw, cy + wu * hh - hz]
  const p2: readonly [number, number] = [cx + (wu - wv) * hw, cy + (wu + wv) * hh - hz]
  const p3: readonly [number, number] = [cx - wv * hw, cy + wv * hh - hz]
  const b1: readonly [number, number] = [p1[0], p1[1] + hz]
  const b2: readonly [number, number] = [p2[0], p2[1] + hz]
  const b3: readonly [number, number] = [p3[0], p3[1] + hz]
  g.fillPoly([p0, p1, p2, p3], top)
  g.fillPoly([p3, p2, b2, b3], left)
  g.fillPoly([p2, p1, b1, b2], right)
  if (edge !== undefined) {
    g.drawLine(p3[0], p3[1], p2[0], p2[1], edge)
    g.drawLine(p2[0], p2[1], p1[0], p1[1], edge)
    g.drawLine(p2[0], p2[1], b2[0], b2[1], edge)
  }
}

export function buildFloorTileSprite(variant: 0 | 1 | 2 | 3): PixelGrid {
  const g = new PixelGrid(TILE_W, TILE_H)
  const hw = TILE_W / 2, hh = TILE_H / 2
  const pts: ReadonlyArray<readonly [number, number]> = [[hw, 0], [TILE_W, hh], [hw, TILE_H], [0, hh]]
  if (variant === 3) {
    g.fillPoly(pts, C('#6B3A32'))
    g.fillPoly([[hw, 2], [TILE_W - 4, hh], [hw, TILE_H - 2], [4, hh]], C('#C9A46A'))
    g.fillPoly([[hw, 4], [TILE_W - 8, hh], [hw, TILE_H - 4], [8, hh]], C('#7A3A3A'))
    return g
  }
  const base = variant === 1 ? C('#7C5A3E') : variant === 2 ? C('#96704C') : C('#5E4130')
  const alt = variant === 0 ? C('#7C5A3E') : C('#5E4130')
  g.fillPoly(pts, base)
  for (let y = 0; y < TILE_H; y++) {
    for (let x = 0; x < TILE_W; x++) {
      if (g.get(x, y) === 0) continue
      if ((x + y * 2) % 8 === 0) g.set(x, y, C('#3B2A22'))
      else if ((x + y) % 5 === 0 && variant !== 2) g.set(x, y, alt)
    }
  }
  g.drawLine(hw, 0, TILE_W - 1, hh, C('#3B2A22'))
  g.drawLine(0, hh, hw, TILE_H - 1, C('#3B2A22'))
  return g
}

export function renderWallsToGrid(g: PixelGrid, cols: number, rows: number, mounts: readonly WallMount[]): void {
  const backH = 64, leftH = 48, rightH = 16
  const doorMount = mounts.find((m) => m.kind === 'door')
  for (let u = 0; u < cols; u++) {
    const a = isoToScreen(u, 0), b = isoToScreen(u + 1, 0)
    g.fillPoly([[a.x, a.y - backH], [b.x, b.y - backH], [b.x, b.y], [a.x, a.y]], C('#BFA48C'))
    g.fillPoly([[a.x, a.y - backH], [b.x, b.y - backH], [b.x, b.y - backH + 8], [a.x, a.y - backH + 8]], C('#5A463A'))
    g.fillPoly([[a.x, a.y - 10], [b.x, b.y - 10], [b.x, b.y], [a.x, a.y]], C('#4A3428'))
    g.drawLine(a.x, a.y - backH, b.x, b.y - backH, C('#1A1412'))
    g.drawLine(a.x, a.y - backH + 8, b.x, b.y - backH + 8, C('#2C211B'))
    g.drawLine(a.x, a.y - 10, b.x, b.y - 10, C('#2C211B'))
  }
  for (let v = 0; v < rows; v++) {
    const a = isoToScreen(0, v), b = isoToScreen(0, v + 1)
    const isDoor = doorMount && v >= doorMount.at && v < doorMount.at + doorMount.span
    g.fillPoly([[a.x, a.y - leftH], [b.x, b.y - leftH], [b.x, b.y], [a.x, a.y]], isDoor ? C('#4A3428') : C('#9C8069'))
    g.fillPoly([[a.x, a.y - leftH], [b.x, b.y - leftH], [b.x, b.y - leftH + 8], [a.x, a.y - leftH + 8]], C('#5A463A'))
    if (isDoor) {
      g.fillPoly([[a.x - 2, a.y - 38], [b.x + 2, b.y - 38], [b.x + 2, b.y - 2], [a.x - 2, a.y - 2]], C('#6B7F96'))
      g.drawLine(a.x - 2, a.y - 38, b.x + 2, b.y - 2, C('#D8D0C0'))
      g.fillRect(Math.round((a.x + b.x) / 2) - 1, Math.round((a.y + b.y) / 2) - 18, 2, 4, C('#C9A46A'))
    } else {
      g.fillPoly([[a.x, a.y - 10], [b.x, b.y - 10], [b.x, b.y], [a.x, a.y]], C('#4A3428'))
    }
    g.drawLine(a.x, a.y - leftH, b.x, b.y - leftH, C('#1A1412'))
  }
  const corner = isoToScreen(0, 0)
  g.drawLine(corner.x, corner.y - backH, corner.x, corner.y, C('#1A1412'))
  for (let v = 0; v < rows; v++) {
    const a = isoToScreen(cols, v), b = isoToScreen(cols, v + 1)
    g.fillPoly([[a.x, a.y - rightH], [b.x, b.y - rightH], [b.x, b.y], [a.x, a.y]], C('#4A3428'))
    g.drawLine(a.x, a.y - rightH, b.x, b.y - rightH, C('#1A1412'))
  }
  for (const m of mounts) {
    if (m.kind === 'window') {
      const p0 = isoToScreen(m.at, 0), p1 = isoToScreen(m.at + m.span, 0)
      g.fillPoly([[p0.x, p0.y - 46], [p1.x, p1.y - 46], [p1.x, p1.y - 22], [p0.x, p0.y - 22]], C('#D8D0C0'))
      g.fillPoly([[p0.x + 2, p0.y - 43], [p1.x - 2, p1.y - 43], [p1.x - 2, p1.y - 25], [p0.x + 2, p0.y - 25]], C('#6B7F96'))
    } else if (m.kind === 'clock') {
      const p = isoToScreen(m.at + 0.5, 0)
      g.fillEllipse(p.x, p.y - 38, 6, 6, C('#4A3428'))
      g.fillEllipse(p.x, p.y - 38, 4, 4, C('#E8DCCB'))
      g.drawLine(p.x, p.y - 38, p.x, p.y - 41, C('#1A1412'))
      g.drawLine(p.x, p.y - 38, p.x + 2, p.y - 38, C('#1A1412'))
    } else if (m.kind === 'corkboard') {
      const p0 = isoToScreen(0, m.at), p1 = isoToScreen(0, m.at + m.span)
      g.fillPoly([[p0.x, p0.y - 36], [p1.x, p1.y - 36], [p1.x, p1.y - 18], [p0.x, p0.y - 18]], C('#6B4A32'))
      g.fillPoly([[p0.x - 2, p0.y - 33], [p1.x + 2, p1.y - 33], [p1.x + 2, p1.y - 21], [p0.x - 2, p0.y - 21]], C('#C9A46A'))
      g.fillRect(Math.round((p0.x + p1.x) / 2) - 4, Math.round((p0.y + p1.y) / 2) - 30, 5, 5, C('#E8DCCB'))
    }
  }
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

export interface FurnitureAsset { grid: PixelGrid; anchorX: number; anchorY: number; screens: Array<{ dx: number; dy: number }> }

export function buildFurnitureSprite(kind: FurnitureKind, facing: Facing): FurnitureAsset {
  const mirror = facing === 'NW' || facing === 'SW'
  if (kind === 'reception-desk') {
    const g = new PixelGrid(92, 64)
    isoBox(g, 46, 26, 2.5, 1.3, 11, C('#D9C4A8'), C('#6B4A32'), C('#8A6242'), C('#2C211B'))
    isoBox(g, 38, 22, 0.5, 0.4, 5, C('#C9A46A'), C('#8A6242'), C('#6B4A32'))
    isoBox(g, 50, 28, 0.4, 0.4, 3, C('#2E2A2A'), C('#1A1412'), C('#4A4440'))
    isoBox(g, 58, 32, 0.5, 0.4, 2, C('#E8DCCB'), C('#D8D0C0'), C('#9C8069'))
    g.outline(C('#1A1412'))
    return { grid: g, anchorX: 46, anchorY: 50, screens: [] }
  }
  if (kind === 'exec-desk') {
    const g = new PixelGrid(112, 74)
    isoBox(g, 54, 26, 3.1, 1.3, 12, C('#8A6242'), C('#4A3428'), C('#6B4A32'), C('#2C211B'))
    isoBox(g, 44, 20, 0.5, 0.3, 4, C('#C9A46A'), C('#8A6242'), C('#6B4A32'))
    isoBox(g, 64, 30, 0.5, 0.5, 2, C('#E8DCCB'), C('#D8D0C0'), C('#9C8069'))
    g.outline(C('#1A1412'))
    return { grid: g, anchorX: 56, anchorY: 58, screens: [{ dx: 38, dy: 8 }, { dx: 54, dy: 16 }] }
  }
  if (kind === 'workstation') {
    const g = new PixelGrid(72, 56)
    isoBox(g, 36, 22, 1.6, 1.1, 10, C('#A87A52'), C('#6B4A32'), C('#8A6242'), C('#2C211B'))
    isoBox(g, 28, 22, 0.5, 0.3, 2, C('#6E665E'), C('#4A4440'), C('#2E2A2A'))
    isoBox(g, 44, 24, 0.25, 0.25, 3, C('#D8D0C0'), C('#9C8069'), C('#7A6150'))
    isoBox(g, 20, 18, 0.3, 0.3, 3, C('#6B3A32'), C('#4A3428'), C('#3E4A44'))
    g.fillEllipse(20, 15, 3, 2, C('#4A6A50'))
    g.outline(C('#1A1412'))
    return { grid: g, anchorX: 36, anchorY: 42, screens: [{ dx: mirror ? 22 : 28, dy: 6 }] }
  }
  if (kind === 'bookshelf') {
    const g = new PixelGrid(64, 62)
    isoBox(g, 32, 32, 1.8, 0.6, 28, C('#8A6242'), C('#4A3428'), C('#6B4A32'), C('#2C211B'))
    g.fillRect(26, 18, 4, 6, C('#7A3A3A')); g.fillRect(31, 19, 4, 6, C('#3F5A78'))
    g.fillRect(36, 21, 4, 6, C('#4A6A50')); g.fillRect(28, 28, 5, 5, C('#C9A46A'))
    g.outline(C('#1A1412'))
    return { grid: g, anchorX: 32, anchorY: 50, screens: [] }
  }
  if (kind === 'water-cooler') {
    const g = new PixelGrid(32, 46)
    isoBox(g, 16, 24, 0.7, 0.7, 16, C('#D8D0C0'), C('#8C8478'), C('#C9C0B4'), C('#2C211B'))
    isoBox(g, 16, 15, 0.5, 0.5, 9, C('#6B7F96'), C('#3F5A78'), C('#6B7F96'))
    g.outline(C('#1A1412'))
    return { grid: g, anchorX: 16, anchorY: 36, screens: [] }
  }
  if (kind === 'floor-plant') {
    const g = new PixelGrid(32, 44)
    isoBox(g, 16, 28, 0.6, 0.6, 8, C('#6B3A32'), C('#4A3428'), C('#6B3A32'))
    g.fillEllipse(16, 17, 7, 6, C('#3E4A44')); g.fillEllipse(14, 14, 5, 4, C('#4A6A50'))
    g.outline(C('#1A1412'))
    return { grid: g, anchorX: 16, anchorY: 36, screens: [] }
  }
  const g = new PixelGrid(24, 24)
  isoBox(g, 12, 12, 0.45, 0.45, 7, C('#4A4440'), C('#2E2A2A'), C('#6E665E'))
  g.outline(C('#1A1412'))
  return { grid: g, anchorX: 12, anchorY: 20, screens: [] }
}

export function buildCharacterSprite(role: ActorRole, pose: ActorPose, facing: Facing): PixelGrid {
  const g = new PixelGrid(32, 48)
  const pal = role === 'secretary'
    ? { shirt: C('#3F5A78'), accent: C('#D8D0C0'), skin: C('#D8C0A8'), hair: C('#2A2220'), pants: C('#2E2A2A') }
    : role === 'lead'
      ? { shirt: C('#7A3A3A'), accent: C('#D8D0C0'), skin: C('#C09070'), hair: C('#C9C0B4'), pants: C('#2E2A2A') }
      : { shirt: C('#4A6A50'), accent: C('#6B7F96'), skin: C('#8F6046'), hair: C('#7A5438'), pants: C('#3F5A78') }
  const seated = pose === 'sit' || pose === 'type', yOff = seated ? 2 : 0
  if (seated) g.fillRect(10, 22 + yOff, 12, 11, C('#4A4440'))
  g.fillEllipse(16, 15 + yOff, 5, 5, pal.skin); g.fillEllipse(16, 12 + yOff, 5, 3, pal.hair)
  g.fillRect(11, 20 + yOff, 10, 11, pal.shirt); g.fillRect(14, 20 + yOff, 4, 2, pal.accent)
  if (pose === 'type') g.fillRect(18, 24 + yOff, 5, 3, pal.skin)
  if (seated) {
    g.fillRect(12, 31 + yOff, 9, 4, pal.pants)
    g.fillRect(12, 35 + yOff, 3, 5, pal.pants); g.fillRect(17, 35 + yOff, 3, 5, pal.pants)
    g.fillRect(11, 40 + yOff, 4, 2, C('#2C211B')); g.fillRect(17, 40 + yOff, 4, 2, C('#2C211B'))
  } else {
    g.fillRect(12, 31, 4, 11, pal.pants); g.fillRect(17, 31, 4, 11, pal.pants)
    g.fillRect(11, 42, 5, 2, C('#2C211B')); g.fillRect(17, 42, 5, 2, C('#2C211B'))
  }
  g.set(18, 15 + yOff, C('#1A1412')); g.outline(C('#1A1412'))
  if (facing === 'NW' || facing === 'SW') { const f = new PixelGrid(32, 48); f.blit(g, 0, 0, true); return f }
  return g
}

export function buildSecretaryPortrait(mood: SecretaryMood): PixelGrid {
  const half = new PixelGrid(96, 120)
  half.fillEllipse(48, 42, 20, 24, C('#2A2220')); half.fillRect(28, 42, 40, 32, C('#2A2220'))
  half.fillEllipse(44, 30, 14, 8, C('#4A3428'))
  half.fillPoly([[20, 118], [28, 74], [68, 74], [76, 118]], C('#3F5A78'))
  half.fillPoly([[36, 74], [48, 89], [60, 74]], C('#D8D0C0'))
  half.fillRect(43, 61, 10, 16, C('#C09070')); half.fillEllipse(48, 44, 15, 19, C('#D8C0A8'))
  half.fillEllipse(37, 48, 3, 2, C('#C09070')); half.fillEllipse(59, 48, 3, 2, C('#C09070'))
  half.fillPoly([[32, 34], [44, 23], [62, 29], [63, 36], [48, 31]], C('#2A2220'))
  half.fillRect(58, 86, 3, 3, C('#C9A46A'))

  if (mood === 'neutral') {
    half.drawLine(39, 37, 44, 37, C('#2A2220')); half.drawLine(52, 37, 57, 37, C('#2A2220'))
    half.fillRect(40, 41, 4, 4, C('#E8DCCB')); half.fillRect(52, 41, 4, 4, C('#E8DCCB'))
    half.fillRect(41, 42, 2, 3, C('#2A2220')); half.fillRect(53, 42, 2, 3, C('#2A2220'))
    half.drawLine(44, 54, 52, 54, C('#8F6046'))
  } else if (mood === 'working') {
    half.drawLine(39, 36, 44, 38, C('#2A2220')); half.drawLine(52, 38, 57, 36, C('#2A2220'))
    half.fillRect(40, 42, 4, 2, C('#2A2220')); half.fillRect(52, 42, 4, 2, C('#2A2220'))
    half.drawLine(45, 54, 51, 54, C('#8F6046'))
    half.fillRect(62, 82, 16, 22, C('#E8DCCB')); half.drawLine(64, 78, 72, 92, C('#C9A46A'))
  } else if (mood === 'happy') {
    half.drawLine(39, 35, 44, 34, C('#2A2220')); half.drawLine(52, 34, 57, 35, C('#2A2220'))
    half.drawLine(40, 42, 42, 40, C('#2A2220')); half.drawLine(42, 40, 44, 42, C('#2A2220'))
    half.drawLine(52, 42, 54, 40, C('#2A2220')); half.drawLine(54, 40, 56, 42, C('#2A2220'))
    half.fillPoly([[42, 52], [54, 52], [48, 58]], C('#E8DCCB'))
    half.drawLine(42, 52, 48, 58, C('#7A3A3A')); half.drawLine(54, 52, 48, 58, C('#7A3A3A'))
  } else {
    half.drawLine(39, 39, 44, 35, C('#2A2220')); half.drawLine(52, 35, 57, 39, C('#2A2220'))
    half.fillRect(39, 41, 5, 5, C('#E8DCCB')); half.fillRect(52, 41, 5, 5, C('#E8DCCB'))
    half.fillRect(41, 43, 2, 2, C('#2A2220')); half.fillRect(53, 43, 2, 2, C('#2A2220'))
    half.drawLine(43, 56, 48, 53, C('#7A3A3A')); half.drawLine(48, 53, 53, 56, C('#7A3A3A'))
    half.fillPoly([[76, 18], [84, 30], [68, 30]], C('#E8544E'), true)
    half.fillRect(76, 22, 1, 4, C('#E8DCCB')); half.set(76, 28, C('#E8DCCB'))
  }

  const out = new PixelGrid(PORTRAIT_W, PORTRAIT_H)
  for (let y = 0; y < 120; y++) {
    for (let x = 0; x < 96; x++) {
      const idx = half.get(x, y)
      if (idx !== 0) out.fillRect(x * 2, y * 2, 2, 2, idx, (half.statusMask[y * 96 + x] ?? 0) === 1)
    }
  }
  out.outline(C('#1A1412'))
  return out
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

export const floorScreenOrigin = () => ({ x: FLOOR_ORIGIN_X, y: FLOOR_ORIGIN_Y })
