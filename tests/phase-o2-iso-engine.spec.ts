import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditPaletteBuffer } from '../src/pixel-office/palette.ts'
import { decodePngRgba } from '../src/pixel-office/sprites.ts'
import {
  computeL2RenderList,
  createInitialActors,
  isoToScreen,
  pickSceneTarget,
  screenToIso,
  spawnWorkerForTicket,
  stepActors,
  type OfficeSceneState,
} from '../src/office-app/iso-engine.ts'
import { solveOfficeLayout, validateOfficeLayout } from '../src/office-app/layout-solver.ts'

const ROOT = resolve(import.meta.dirname, '..')
const ASSET_DIR = join(ROOT, 'assets', 'office')

describe('Phase O2: 46-Color Quantized Assets & 4-Layer Iso Engine', () => {
  it('validates all sliced assets/office/*.png stay strictly within 38 non-status colors and binary alpha', () => {
    const pngs = readdirSync(ASSET_DIR).filter((f) => f.endsWith('.png')).sort()
    expect(pngs.length).toBe(25)
    const manifest = JSON.parse(readFileSync(join(ASSET_DIR, 'manifest.json'), 'utf8')) as {
      paletteSize: number
      assets: Record<string, { file: string; width: number; height: number }>
    }
    expect(manifest.paletteSize).toBe(38)
    expect(Object.keys(manifest.assets).length).toBe(25)

    for (const file of pngs) {
      const { width, height, rgba } = decodePngRgba(readFileSync(join(ASSET_DIR, file)))
      const audit = auditPaletteBuffer(rgba, width, height, new Uint8Array(width * height))
      expect(audit.outOfPaletteCount, `${file} outOfPaletteCount`).toBe(0)
      expect(audit.statusPixelsOutsideMask, `${file} statusPixelsOutsideMask`).toBe(0)
      expect(audit.semiTransparentCount, `${file} semiTransparentCount`).toBe(0)
      expect(audit.totalOpaquePixels, `${file} opaquePixels`).toBeGreaterThan(0)
    }
  })

  it('keeps src/office-app/* pure browser-safe TS without node:* imports', () => {
    for (const file of ['catalog.ts', 'layout-solver.ts', 'iso-engine.ts']) {
      const src = readFileSync(join(ROOT, 'src', 'office-app', file), 'utf8')
      expect(src).not.toMatch(/['"]node:/)
    }
  })

  it('solves deterministic, collision-free, aisle-clear layouts across workspaceIds', () => {
    const plans = ['ws-alpha', 'ws-beta', 'ws-gamma'].map((id) => solveOfficeLayout(id, 7))
    for (const plan of plans) {
      const audit = validateOfficeLayout(plan)
      expect(audit.valid).toBe(true)
      expect(audit.overlapCount).toBe(0)
      expect(audit.doorBlocked).toBe(false)
      expect(audit.minSuiteChebyshev).toBeGreaterThanOrEqual(2)
      expect(audit.maxAisleWidth).toBeGreaterThanOrEqual(2)
    }

    expect(solveOfficeLayout('ws-alpha', 7)).toEqual(plans[0])
    const signatures = new Set(plans.map((p) => JSON.stringify(p.suites.map((s) => [s.id, s.anchor]))))
    expect(signatures.size).toBeGreaterThanOrEqual(2)

    const broken = solveOfficeLayout('ws-alpha', 1)
    broken.suites[2]!.footprint = [{ u: 0, v: 9 }]
    expect(validateOfficeLayout(broken).valid).toBe(false)
    expect(validateOfficeLayout(broken).doorBlocked).toBe(true)
  })

  it('round-trips isoToScreen and screenToIso at 2:1 ratio', () => {
    const origin = { x: 720, y: 156 }
    const p = isoToScreen(5.5, 4.5, origin, 2)
    expect(screenToIso(p.x, p.y, origin, 2)).toEqual({ u: 5, v: 4 })
  })

  it('drives worker actors from door to workstation seat and back out on ticket completion', () => {
    const plan = solveOfficeLayout('ws-alpha', 1)
    let actors = createInitialActors(plan)
    expect(actors.map((a) => a.role)).toEqual(['secretary', 'lead'])

    actors = [...actors, spawnWorkerForTicket(plan, 'worker-1', 'T-101', 'ws-1')]
    for (let i = 0; i < 60; i++) actors = stepActors(actors, plan, 250)
    const seated = actors.find((a) => a.id === 'worker-1')!
    expect(seated.lifecycle).toBe('working')
    expect(seated.pose).toBe('sit')

    actors = actors.map((a) => (a.id === 'worker-1' ? { ...a, lifecycle: 'leaving' as const, path: [] } : a))
    for (let i = 0; i < 60; i++) actors = stepActors(actors, plan, 250)
    expect(actors.find((a) => a.id === 'worker-1')!.lifecycle).toBe('removed')
  })

  it('sorts L2 render items monotonically by footScreenY then id, and picks all 5 props & actors', () => {
    const plan = solveOfficeLayout('ws-alpha', 1)
    const actors = createInitialActors(plan)
    const l2 = computeL2RenderList(plan, actors, plan.origin, 2)
    for (let i = 1; i < l2.length; i++) {
      const prev = l2[i - 1]!, cur = l2[i]!
      expect(cur.footScreenY).toBeGreaterThanOrEqual(prev.footScreenY)
      if (cur.footScreenY === prev.footScreenY) {
        expect(prev.id.localeCompare(cur.id)).toBeLessThanOrEqual(0)
      }
    }

    const state: OfficeSceneState = {
      plan,
      actors,
      screenStates: { executive: 'working', 'ws-1': 'stuck', 'ws-2': 'needsDecision', 'ws-3': 'done' },
      elapsedMs: 0,
    }

    const sec = actors.find((a) => a.id === 'secretary')!
    const secPos = isoToScreen(sec.u + 0.5, sec.v + 0.5, plan.origin, 2)
    expect(pickSceneTarget(secPos.x, secPos.y - 48, state, plan, 2)).toMatchObject({
      type: 'actor',
      actorId: 'secretary',
      role: 'secretary',
    })

    const rec = plan.suites.find((s) => s.id === 'reception')!
    const recPos = isoToScreen(rec.anchor.u + rec.size[0] / 2, rec.anchor.v + rec.size[1] / 2, plan.origin, 2)
    const ledgerHit = pickSceneTarget(recPos.x - 56, recPos.y - 20, state, plan, 2)
    const notebookHit = pickSceneTarget(recPos.x + 56, recPos.y - 20, state, plan, 2)
    expect(ledgerHit).toMatchObject({ type: 'prop', prop: 'ledger' })
    expect(notebookHit).toMatchObject({ type: 'prop', prop: 'notebook' })
    expect(ledgerHit?.bounds).not.toEqual(notebookHit?.bounds)

    const cab = plan.shared.find((s) => s.id === 'file-cabinet')!
    const cabPos = isoToScreen(cab.anchor.u + cab.size[0] / 2, cab.anchor.v + cab.size[1] / 2, plan.origin, 2)
    expect((pickSceneTarget(cabPos.x, cabPos.y - 20, state, plan, 2) as { prop: string }).prop).toBe('cabinet')

    const dp = plan.wallMounts.find((m) => m.id === 'doorplate')!
    const dpPos = isoToScreen(0, dp.at, plan.origin, 2)
    expect((pickSceneTarget(dpPos.x, dpPos.y - dp.h * 2 - 16, state, plan, 2) as { prop: string }).prop).toBe('doorplate')

    const cb = plan.wallMounts.find((m) => m.id === 'corkboard')!
    const cbPos = isoToScreen(cb.at, 0, plan.origin, 2)
    expect((pickSceneTarget(cbPos.x, cbPos.y - cb.h * 2 - 40, state, plan, 2) as { prop: string }).prop).toBe('corkboard')

    const lead = actors.find((a) => a.id === 'lead')!
    const leadPos = isoToScreen(lead.u + 0.5, lead.v + 0.5, plan.origin, 2)
    const pickedLead = pickSceneTarget(leadPos.x, leadPos.y - 40, state, plan, 2)
    expect(pickedLead).toMatchObject({ type: 'actor', actorId: 'lead', role: 'lead' })
  })
})
