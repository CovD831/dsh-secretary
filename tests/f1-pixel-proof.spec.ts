import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditPaletteBuffer,
  buildCharacterSprite,
  buildMonitorScreen,
  buildSecretaryPortrait,
  checkAlphaSpec,
  DISPLAY_H,
  DISPLAY_W,
  encodePngRgba,
  FROZEN_PALETTE,
  generateRoomLayout,
  MATERIAL_HEXES,
  NATIVE_H,
  NATIVE_W,
  PORTRAIT_H,
  PORTRAIT_W,
  quantizeRgbaBuffer,
  renderF1ProofHtml,
  renderNativeFrame,
  renderStatusFilmStrip,
  STATUS_COLOR_MAP,
  STATUS_HEXES,
  upscaleNearest2x,
  validateRoomLayout,
  writeF1ProofBundle,
  type SecretaryMood,
  type StatusKind,
} from '../src/pixel-office/index.ts'

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'f1-pixel-proof-'))
  tmpDirs.push(d)
  return d
}

function rgbSaturationPct(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  if (max === min) return 0
  const l = (max + min) / 2
  const d = max - min
  return (d / (l > 0.5 ? 2 - max - min : max + min)) * 100
}

function readPngDims(buf: Uint8Array): { sigOk: boolean; width: number; height: number } {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  const sigOk = sig.every((v, i) => buf[i] === v)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { sigOk, width: view.getUint32(16, false), height: view.getUint32(20, false) }
}

describe('F1 Pixel Office Proof & Deterministic Room Engine', () => {
  it('enforces the exact 46-color frozen palette, saturation separation, and binary alpha spec', () => {
    expect(FROZEN_PALETTE).toHaveLength(46)
    expect(MATERIAL_HEXES).toHaveLength(31)
    expect(STATUS_HEXES).toHaveLength(8)

    for (const hex of MATERIAL_HEXES) {
      const entry = FROZEN_PALETTE.find((e) => e.hex === hex)!
      const sat = rgbSaturationPct(entry.rgb[0], entry.rgb[1], entry.rgb[2])
      expect(sat).toBeGreaterThanOrEqual(4.0)
      expect(sat).toBeLessThanOrEqual(40.0)
    }
    for (const hex of STATUS_HEXES) {
      const entry = FROZEN_PALETTE.find((e) => e.hex === hex)!
      const sat = rgbSaturationPct(entry.rgb[0], entry.rgb[1], entry.rgb[2])
      expect(sat).toBeGreaterThanOrEqual(54.0)
      expect(sat).toBeLessThanOrEqual(88.0)
    }

    const noisy = new Uint8Array([255, 0, 255, 120, 140, 100, 68, 250, 0, 0, 0, 0])
    expect(checkAlphaSpec(noisy, 3, 1).ok).toBe(false)
    const snapped = quantizeRgbaBuffer(noisy)
    expect(checkAlphaSpec(snapped, 3, 1).ok).toBe(true)
    expect(auditPaletteBuffer(snapped, 3, 1).outOfPaletteCount).toBe(0)
  })

  it('renders native 720x450 proof & gate frames within 46 colors, 0/255 alpha, and zero status bleed', () => {
    for (const gate of [undefined, { targetActorId: 'worker-1', frame: 1 }] as const) {
      const frame = renderNativeFrame({ gateIntercept: gate })
      expect(frame.width).toBe(NATIVE_W)
      expect(frame.height).toBe(NATIVE_H)
      const audit = auditPaletteBuffer(frame.rgba, frame.width, frame.height, frame.statusMask)
      expect(audit.uniqueCount).toBeLessThanOrEqual(46)
      expect(audit.outOfPaletteCount).toBe(0)
      expect(audit.semiTransparentCount).toBe(0)
      expect(audit.statusPixelsOutsideMask).toBe(0)
    }
  })

  it('upscales 720x450 strictly 2x nearest-neighbor to 1440x900 with uniform 2x2 blocks', () => {
    const frame = renderNativeFrame()
    const upscaled = upscaleNearest2x(frame.rgba, NATIVE_W, NATIVE_H)
    expect(upscaled.length).toBe(DISPLAY_W * DISPLAY_H * 4)

    let mismatch = 0
    for (let y = 0; y < NATIVE_H; y++) {
      for (let x = 0; x < NATIVE_W; x++) {
        const i00 = ((y * 2) * DISPLAY_W + x * 2) * 4
        const i10 = i00 + 4
        const i01 = i00 + DISPLAY_W * 4
        const i11 = i01 + 4
        for (let c = 0; c < 4; c++) {
          if (upscaled[i10 + c] !== upscaled[i00 + c]
            || upscaled[i01 + c] !== upscaled[i00 + c]
            || upscaled[i11 + c] !== upscaled[i00 + c]) mismatch++
        }
      }
    }
    expect(mismatch).toBe(0)
  })

  it('enforces suite hard constraints (zero overlap, door clear, aisle >= 2, Chebyshev >= 2) and deterministic PNG bytes', () => {
    for (const seed of [1, 2, 7, 42]) {
      const plan = generateRoomLayout({ workspaceId: 'ws-alpha', workspaceOrder: 0, seed })
      const audit = validateRoomLayout(plan)
      expect(audit.valid).toBe(true)
      expect(audit.overlapCount).toBe(0)
      expect(audit.doorBlocked).toBe(false)
      expect(audit.minSuiteChebyshev).toBeGreaterThanOrEqual(2)
      expect(audit.maxAisleWidth).toBeGreaterThanOrEqual(2)
      expect(audit.wallAttachOk).toBe(true)
      expect(audit.lineOfSightOk).toBe(true)
    }

    const broken = generateRoomLayout({ workspaceId: 'ws-alpha', workspaceOrder: 0, seed: 1 })
    broken.suites[2]!.footprint = [{ u: 0, v: 9 }]
    expect(validateRoomLayout(broken).valid).toBe(false)
    expect(validateRoomLayout(broken).doorBlocked).toBe(true)

    const p1 = generateRoomLayout({ workspaceId: 'ws-det', workspaceOrder: 3, seed: 99 })
    const p2 = generateRoomLayout({ workspaceId: 'ws-det', workspaceOrder: 3, seed: 99 })
    expect(p1).toEqual(p2)
    const png1 = encodePngRgba(upscaleNearest2x(renderNativeFrame({ plan: p1 }).rgba, NATIVE_W, NATIVE_H), DISPLAY_W, DISPLAY_H)
    const png2 = encodePngRgba(upscaleNearest2x(renderNativeFrame({ plan: p2 }).rgba, NATIVE_W, NATIVE_H), DISPLAY_W, DISPLAY_H)
    expect(Buffer.compare(Buffer.from(png1), Buffer.from(png2))).toBe(0)
  })

  it('distinguishes all 4 monitor states by both frozen status colors and colorblind shape sub-encoding', () => {
    const states: readonly StatusKind[] = ['working', 'stuck', 'needsDecision', 'done']
    const silhouettes = states.map((st) => {
      const scr = buildMonitorScreen(st)
      const rgba = scr.toRgba()
      const audit = auditPaletteBuffer(rgba, scr.width, scr.height, scr.statusMask)
      expect(audit.outOfPaletteCount).toBe(0)
      expect(audit.histogram[STATUS_COLOR_MAP[st].bright]).toBeGreaterThan(0)
      expect(audit.histogram[STATUS_COLOR_MAP[st].dark]).toBeGreaterThan(0)
      const brightHex = STATUS_COLOR_MAP[st].bright
      const targetRgb = FROZEN_PALETTE.find((e) => e.hex === brightHex)!.rgb
      const bits: string[] = []
      for (let i = 0; i < rgba.length; i += 4) {
        bits.push(rgba[i] === targetRgb[0] && rgba[i + 1] === targetRgb[1] && rgba[i + 2] === targetRgb[2] ? '1' : '0')
      }
      return bits.join('')
    })
    expect(new Set(silhouettes).size).toBe(4)

    const frame = renderNativeFrame()
    const litStates = Object.values(frame.screenStates).filter((s) => s !== 'off')
    expect(litStates).toHaveLength(3)

    const film = renderStatusFilmStrip()
    const filmAudit = auditPaletteBuffer(film.rgba, film.width, film.height)
    for (const hex of STATUS_HEXES) expect(filmAudit.histogram[hex]).toBeGreaterThan(0)
  })

  it('renders 4 distinct 192x240 secretary portraits and 3 distinct character roles', () => {
    const moods: readonly SecretaryMood[] = ['neutral', 'working', 'happy', 'concerned']
    const bufs = moods.map((m) => {
      const p = buildSecretaryPortrait(m)
      expect(p.width).toBe(PORTRAIT_W)
      expect(p.height).toBe(PORTRAIT_H)
      const rgba = p.toRgba()
      const alpha = checkAlphaSpec(rgba, p.width, p.height)
      expect(alpha.ok).toBe(true)
      expect(alpha.cornersTransparent).toBe(true)
      expect(auditPaletteBuffer(rgba, p.width, p.height, p.statusMask).outOfPaletteCount).toBe(0)
      return p.pixels
    })

    for (let i = 0; i < bufs.length; i++) {
      for (let j = i + 1; j < bufs.length; j++) {
        let diff = 0
        for (let k = 0; k < bufs[i]!.length; k++) if (bufs[i]![k] !== bufs[j]![k]) diff++
        expect(diff).toBeGreaterThan(80)
      }
    }

    for (const role of ['secretary', 'lead', 'worker'] as const) {
      const ch = buildCharacterSprite(role, 'sit', 'SE')
      expect(ch.width).toBe(32)
      expect(ch.height).toBe(48)
      expect(auditPaletteBuffer(ch.toRgba(), ch.width, ch.height).outOfPaletteCount).toBe(0)
    }
  })

  it('switches screen to #E8544E, portrait to concerned, and writes valid PNG + HTML proof bundle on gate intercept', () => {
    const normal = renderNativeFrame()
    const gate = renderNativeFrame({ gateIntercept: { targetActorId: 'worker-1', frame: 2 } })
    expect(gate.mood).toBe('concerned')
    expect(gate.screenStates['ws-1']).toBe('needsDecision')
    expect(Buffer.compare(Buffer.from(normal.rgba), Buffer.from(gate.rgba))).not.toBe(0)

    const outDir = makeTmpDir()
    const bundle = writeF1ProofBundle(outDir)
    const proofDims = readPngDims(readFileSync(bundle.proofPng))
    const gateDims = readPngDims(readFileSync(bundle.gatePng))
    expect(proofDims).toEqual({ sigOk: true, width: DISPLAY_W, height: DISPLAY_H })
    expect(gateDims).toEqual({ sigOk: true, width: DISPLAY_W, height: DISPLAY_H })

    const html = readFileSync(bundle.htmlPath, 'utf8')
    expect(html).toContain('image-rendering:pixelated')
    expect(html).toContain('worker-1 在合并门前被路径闸拦截')
    expect(html).toContain('剩余待办')
    expect(html).toContain('四态屏幕灯带')
    expect(renderF1ProofHtml().length).toBeGreaterThan(1000)
  })
})
