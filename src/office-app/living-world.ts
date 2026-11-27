/** 活世界微动态与可直读状态层：工位头顶像素状态气泡、子代理 +N 徽章、咖啡热气、饮水机水泡、挂钟走针、木牌状态灯与远侧路人。 */
import { type Container, type Graphics, Sprite, Text, TextStyle, type Texture } from 'pixi.js'
import { HIGHLIGHT_GOLD, STATUS_GLOW_COLORS, type StatusKind } from './catalog.ts'
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import type { OfficeActor } from './iso-engine.ts'
import { findSeatSlot, wingSeatSlots } from './seat-slots.ts'
import { worldIsoToScreen } from './world-renderer.ts'
import type { OfficeCamera, OfficeWorldPlan, WorldPickResult, WorldWingPlan } from './world-types.ts'

export interface TownPasser { readonly id: string; readonly u: number; readonly v: number; readonly facing: 'SE' | 'SW'; readonly pose: 'walkA' | 'walkB' }

const passerPool: Sprite[] = []
const hexNum = (hex: string): number => Number.parseInt(hex.slice(1), 16)
const MINI_FONT: Record<string, readonly number[]> = {
  '+': [0b000, 0b010, 0b111, 0b010, 0b000], '0': [0b111, 0b101, 0b101, 0b101, 0b111], '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111], '3': [0b111, 0b001, 0b111, 0b001, 0b111], '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111], '6': [0b111, 0b100, 0b111, 0b101, 0b111], '7': [0b111, 0b001, 0b001, 0b010, 0b010],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111], '9': [0b111, 0b101, 0b111, 0b001, 0b111],
}

export function resolveWingStatus(wing: WorldWingPlan, screenStates: Record<string, StatusKind | 'off'>): StatusKind | 'idle' {
  const sts = [...wingSeatSlots(wing).map((s) => screenStates[s.seatId] ?? 'off'), ...wing.suites.map((s) => screenStates[s.id] ?? 'off')]
  if (sts.includes('needsDecision')) return 'needsDecision'
  if (sts.includes('stuck')) return 'stuck'
  if (sts.includes('working')) return 'working'
  if (sts.includes('done')) return 'done'
  return 'idle'
}

export function computeTownPassersby(world: OfficeWorldPlan, elapsedMs: number): TownPasser[] {
  const t = Math.max(0, elapsedMs) / 1000, rows = world.buildingRows, span = world.buildingCols + 8
  const poseA = Math.floor(elapsedMs / 240) % 2 === 0 ? 'walkA' : 'walkB'
  const poseB = Math.floor((elapsedMs + 120) / 240) % 2 === 0 ? 'walkA' : 'walkB'
  return [
    { id: 'passer-e', u: ((3 + t * 1.35) % span) - 4, v: rows + 6.6, facing: 'SE', pose: poseA },
    { id: 'passer-w', u: world.buildingCols + 4 - ((6 + t * 1.05) % span), v: rows + 7.1, facing: 'SW', pose: poseB },
  ]
}

function drawSubagentPill(g: Graphics, rx: number, ty: number, count: number, z: number): void {
  const label = `+${Math.min(99, count)}`, px = Math.max(1, Math.round(z)), pw = (label.length * 4 + 3) * px, ph = 7 * px
  const bx = Math.round(rx - pw / 2), by = Math.round(ty - 3 * px)
  g.rect(bx - px, by - px, pw + 2 * px, ph + 2 * px).fill(0x1a1412)
  g.rect(bx, by, pw, ph).fill(0x3a2e28).stroke({ color: 0xc9a46a, width: px })
  for (let i = 0; i < label.length; i++) {
    const glyph = MINI_FONT[label[i]!]
    if (!glyph) continue
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if ((glyph[r]! >> (2 - c)) & 1) g.rect(bx + (2 + i * 4 + c) * px, by + (1 + r) * px, px, px).fill(0xf2a93b)
    }
  }
}

function drawStatusBubble(g: Graphics, cx: number, botY: number, kind: StatusKind, z: number, step: number, subCount = 0): void {
  const bw = 20 * z, bh = 15 * z, bob = kind === 'needsDecision' ? (step % 2) * 2 * z : (step % 2) * z
  const bx = Math.round(cx - bw / 2), by = Math.round(botY - bh - 4 * z - bob), col = hexNum(STATUS_GLOW_COLORS[kind].bright)
  const bdr = Math.max(1, z)
  g.rect(bx - bdr, by - bdr, bw + 2 * bdr, bh + 2 * bdr).fill(0x1a1412)
  g.rect(bx, by, bw, bh).fill(0xe8dccb)
  g.rect(Math.round(cx - 2 * z), by + bh, Math.max(2, 4 * z), Math.max(1, 2 * z)).fill(0xe8dccb)
  g.rect(Math.round(cx - z), by + bh + 2 * z, Math.max(1, 2 * z), bdr).fill(0x1a1412)

  if (kind === 'working') {
    for (let r = 0; r < 3; r++) {
      const len = [10, 7, 12][(r + step) % 3]!
      g.rect(bx + 3 * z, by + (3 + r * 4) * z, len * z, Math.max(1, 2 * z)).fill(r === 0 ? col : 0x4a3428)
    }
    if (step % 2 === 0) g.rect(bx + 14 * z, by + 11 * z, Math.max(1, 2 * z), Math.max(1, 2 * z)).fill(col)
  } else if (kind === 'needsDecision') {
    g.rect(bx + z, by + z, bw - 2 * z, bh - 2 * z).stroke({ color: 0xf2a93b, width: bdr })
    g.rect(Math.round(cx - z), by + 3 * z, Math.max(2, 3 * z), Math.max(3, 6 * z)).fill(col)
    g.rect(Math.round(cx - z), by + 10 * z, Math.max(2, 3 * z), Math.max(1, 2 * z)).fill(col)
  } else if (kind === 'stuck') {
    const flip = step % 2 === 0, hx = Math.round(cx - 4 * z), hy = by + 2 * z
    g.rect(hx, hy, 8 * z, 2 * z).fill(0x4a3428).rect(hx, hy + 9 * z, 8 * z, 2 * z).fill(0x4a3428)
    g.rect(hx + z, hy + 2 * z, 6 * z, 2 * z).fill(flip ? col : 0xbfa48c)
    g.rect(hx + 3 * z, hy + 4 * z, 2 * z, 3 * z).fill(col)
    g.rect(hx + z, hy + 7 * z, 6 * z, 2 * z).fill(flip ? 0xbfa48c : col)
  } else {
    const ox = Math.round(cx - 5 * z), oy = by + 4 * z
    g.rect(ox, oy + 4 * z, 2 * z, 2 * z).fill(col).rect(ox + 2 * z, oy + 6 * z, 2 * z, 2 * z).fill(col)
    g.rect(ox + 4 * z, oy + 4 * z, 2 * z, 2 * z).fill(col).rect(ox + 6 * z, oy + 2 * z, 2 * z, 2 * z).fill(col)
    g.rect(ox + 8 * z, oy, 2 * z, 2 * z).fill(col)
  }
  if (subCount > 0) drawSubagentPill(g, bx + bw, by, subCount, z)
}

export function drawWorkstationStatusAndBubbles(
  lightGfx: Graphics, world: OfficeWorldPlan, actors: readonly OfficeActor[], screenStates: Record<string, StatusKind | 'off'>,
  gateIntercept: { targetActorId: string; frame: number } | undefined, elapsedMs: number, camera: OfficeCamera, subagentCounts?: Record<string, number>,
): void {
  const z = camera.zoom, step = Math.floor(elapsedMs / 320), seatedSuites = new Set<string>()
  for (const a of actors) {
    if (a.role === 'secretary' || a.pose !== 'sit' || !a.assignedSuiteId || a.lifecycle === 'removed' || a.lifecycle === 'leaving') continue
    const st = screenStates[a.assignedSuiteId]; if (!st || st === 'off') continue
    seatedSuites.add(a.assignedSuiteId.split('#')[0]!)
    const found = findSeatSlot(world, a.assignedSuiteId), sinkY = (found?.seat.sitSink ?? 0) * z
    const sp = worldIsoToScreen(a.u + 0.5, a.v + 0.5, world, camera)
    drawStatusBubble(lightGfx, sp.x, sp.y - 46 * z + sinkY, st, z, step, subagentCounts?.[a.assignedSuiteId] ?? 0)
  }
  for (const suite of [...world.lobby.suites, ...world.wings.flatMap((w) => w.suites)]) {
    const meta = WORLD_ASSET_CATALOG[suite.assetId], st = screenStates[suite.id]
    if (!meta || st !== 'needsDecision' || seatedSuites.has(suite.id)) continue
    const p = worldIsoToScreen(suite.anchor.u + suite.size[0] / 2, suite.anchor.v + suite.size[1] / 2, world, camera)
    drawStatusBubble(lightGfx, p.x, Math.round(p.y - meta.anchor[1] * z) + 4 * z, st, z, step, subagentCounts?.[suite.id] ?? 0)
  }
  if (gateIntercept) {
    const t = actors.find((a) => a.id === gateIntercept.targetActorId)
    if (t) { const p = worldIsoToScreen(t.u + 0.5, t.v + 0.5, world, camera); drawStatusBubble(lightGfx, p.x, p.y - 46 * z, 'needsDecision', z, step) }
  }
}

export function drawAmbientOfficeLife(
  lightGfx: Graphics, ySorted: Container, aoGfx: Graphics, world: OfficeWorldPlan, camera: OfficeCamera, elapsedMs: number,
  getCharTex: (role: string, col: number, row: number, images: Record<string, CanvasImageSource>, cropH?: number, variantIdx?: number) => Texture | null,
  images: Record<string, CanvasImageSource>,
): void {
  const z = camera.zoom, step = Math.floor(elapsedMs / 340)
  const entities = [...world.lobby.suites, ...world.lobby.shared, ...world.wings.flatMap((w) => [...w.suites, ...w.shared])]
  for (const [ei, e] of entities.entries()) {
    const meta = WORLD_ASSET_CATALOG[e.assetId]; if (!meta) continue
    const p = worldIsoToScreen(e.anchor.u + e.size[0] / 2, e.anchor.v + e.size[1] / 2, world, camera)
    const bx = Math.round(p.x - meta.anchor[0] * z), by = Math.round(p.y - meta.anchor[1] * z), nw = meta.nativeSize[0]
    const mapPt = (nx: number, ny: number) => ({ x: bx + (e.mirrorX ? nw - nx : nx) * z, y: by + ny * z })

    if (e.assetId === 'desk_cluster' || e.assetId === 'collab_table') {
      const mugs = e.assetId === 'desk_cluster' ? ([[26, 33], [95, 29]] as const) : ([[35, 34], [96, 31]] as const)
      for (const [mi, [mx, my]] of mugs.entries()) {
        const pt = mapPt(mx, my), ph = (step + mi + ei) % 5
        lightGfx.rect(Math.round(pt.x + (ph % 2) * z), Math.round(pt.y - (2 + ph) * z), z, z).fill({ color: 0xe8dccb, alpha: 0.45 })
        lightGfx.rect(Math.round(pt.x - z), Math.round(pt.y - (4 + ((ph + 2) % 4)) * z), z, z).fill({ color: 0xe8dccb, alpha: 0.28 })
      }
    } else if (e.assetId === 'exec_desk') {
      const lp = mapPt(29, 24)
      lightGfx.ellipse(Math.round(lp.x), Math.round(lp.y + 4 * z), 16 * z, 9 * z).fill({ color: 0xf2a93b, alpha: 0.1 })
    } else if (e.assetId === 'water_cooler') {
      const phase = (step + ei * 3) % 14
      if (phase < 4) { const pt = mapPt(16, 15 - phase * 2); lightGfx.rect(Math.round(pt.x), Math.round(pt.y), z, z).fill({ color: 0xe8dccb, alpha: 0.65 }) }
    }
  }

  const clock = world.lobby.wallMounts.find((m) => m.assetId === 'clock_wall')
  if (clock) {
    const p = worldIsoToScreen(clock.at, world.lobby.rect.v, world, camera), sz = Math.round(24 * 0.85 * z)
    const cx = Math.round(p.x), cy = Math.round(p.y - sz / 2 - clock.h * z), ang = (new Date().getMinutes() / 60) * Math.PI * 2 - Math.PI / 2
    lightGfx.rect(Math.round(cx + Math.cos(ang) * 2.5 * z), Math.round(cy + Math.sin(ang) * 2.5 * z), z, z).fill(0x1a1412)
  }

  for (const [pi, ps] of computeTownPassersby(world, elapsedMs).entries()) {
    const tex = getCharTex('worker', ps.pose === 'walkA' ? 1 : 2, ps.facing === 'SW' ? 1 : 0, images, 48, pi === 0 ? 4 : 6); if (!tex) continue
    const p = worldIsoToScreen(ps.u + 0.5, ps.v + 0.5, world, camera)
    const sp = passerPool[pi] ?? (passerPool[pi] = new Sprite(tex))
    sp.texture = tex; sp.scale.set(1, 1); sp.width = 32 * z; sp.height = 48 * z; sp.tint = 0xc8c0bc
    sp.x = Math.round(p.x - 16 * z); sp.y = Math.round(p.y - 44 * z); sp.zIndex = Math.round(p.y) + 1
    ySorted.addChild(sp)
    aoGfx.ellipse(Math.round(p.x), Math.round(p.y + z), 7 * z, 3 * z).fill({ color: 0x1a1412, alpha: 0.32 })
  }
}

export function drawWoodWingNameplates(
  lightGfx: Graphics, layer: Container, wingLabels: Map<string, Text>, world: OfficeWorldPlan, camera: OfficeCamera,
  screenStates: Record<string, StatusKind | 'off'>, activeWorkspaceId: string, hoverTarget: WorldPickResult | null | undefined,
  roomOverflows?: Record<string, number>,
): void {
  const z = camera.zoom, fontPx = Math.max(8, Math.round(9 * z))
  if (z > 1.05 && hoverTarget?.type !== 'wing') return
  for (const w of world.wings) {
    if (z > 1.05 && hoverTarget?.type === 'wing' && hoverTarget.wingId !== w.id) continue
    const ov = w.workspaceId ? (roomOverflows?.[w.workspaceId] ?? 0) : 0
    const titleText = ov > 0 ? `${w.title} +${ov}候席` : w.title
    const pos = worldIsoToScreen(w.rect.u + w.rect.w / 2, w.rect.v + Math.min(4.2, w.rect.h / 2), world, camera)
    const bw = Math.max(76, titleText.length * 10 + 22) * z, bh = Math.max(13, 16 * z), bx = Math.round(pos.x - bw / 2), by = Math.round(pos.y - bh)
    const active = Boolean(w.workspaceId && w.workspaceId === activeWorkspaceId), st = resolveWingStatus(w, screenStates)
    const ledCol = st === 'idle' ? 0x5a463a : hexNum(STATUS_GLOW_COLORS[st].bright)
    lightGfx.rect(bx, by, bw, bh).fill({ color: 0x3a2e28, alpha: 0.94 }).stroke({ color: active ? hexNum(HIGHLIGHT_GOLD) : 0x1a1412, width: Math.max(1, z) })
    lightGfx.rect(bx + Math.max(1, z), by + Math.max(1, z), bw - Math.max(2, 2 * z), Math.max(1, 2 * z)).fill({ color: 0x6b4a32, alpha: 0.75 })
    for (const [rx, ry] of [[bx + 2 * z, by + 2 * z], [bx + bw - 3 * z, by + 2 * z], [bx + 2 * z, by + bh - 3 * z], [bx + bw - 3 * z, by + bh - 3 * z]] as const) {
      lightGfx.rect(rx, ry, Math.max(1, z), Math.max(1, z)).fill(0xc9a46a)
    }
    lightGfx.rect(bx + 6 * z, by + 6 * z, Math.max(3, 4 * z), Math.max(3, 4 * z)).fill(ledCol).stroke({ color: 0x1a1412, width: Math.max(1, z) })
    let label = wingLabels.get(w.id)
    if (!label) { label = new Text({ text: titleText, style: new TextStyle({ fontFamily: 'monospace', fontSize: fontPx, fill: 0xe8dccb }) }); wingLabels.set(w.id, label) }
    else { label.text = titleText; label.style.fontSize = fontPx }
    label.x = bx + Math.round(13 * z); label.y = by + Math.round((bh - fontPx) / 2) - 1; layer.addChild(label)
  }
}
