import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OFFICE_CATALOG } from '../src/office-app/catalog.ts'
import {
  WORLD_BASE_ORIGIN,
  WORLD_BUILDING_COLS,
  WORLD_BUILDING_ROWS,
  cameraForGridPoint,
  solveWorldFloorplan,
} from '../src/office-app/world-layout.ts'
import {
  createInitialWorldActors,
  pickWorldTarget,
  renderWorldFrame,
  screenToWorldIso,
  spawnWorldWorker,
  stepWorldActors,
  worldIsoToScreen,
} from '../src/office-app/world-renderer.ts'
import type { WorldSceneState, WorldSprites } from '../src/office-app/world-types.ts'

const ROOT = resolve(import.meta.dirname, '..')

function makeMockSprites(): WorldSprites {
  const images: Record<string, CanvasImageSource> = {}
  for (const [id, meta] of Object.entries(OFFICE_CATALOG)) {
    images[id] = { width: meta.nativeSize[0], height: meta.nativeSize[1], id } as unknown as CanvasImageSource
  }
  return { images }
}

function makePixelTrackingCtx(width: number, height: number) {
  const alpha = new Uint8Array(width * height)
  const drawnAssets: string[] = []
  let fillStyle = '#000000'
  const paintRect = (x: number, y: number, w: number, h: number) => {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(width, Math.ceil(x + w)), y1 = Math.min(height, Math.ceil(y + h))
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) alpha[py * width + px] = 255
    }
  }
  const ctx = {
    canvas: { width, height },
    imageSmoothingEnabled: false,
    get fillStyle() { return fillStyle },
    set fillStyle(v: string) { fillStyle = v },
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => paintRect(x, y, w, h)),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn((img: { id?: string }) => {
      if (img?.id) drawnAssets.push(img.id)
    }),
  } as unknown as CanvasRenderingContext2D
  return { ctx, alpha, drawnAssets }
}

describe('Phase W1: Multi-Room World Floorplan & 4-Layer Iso Renderer', () => {
  it('keeps world-layout.ts and world-renderer.ts browser-safe and within line limits', () => {
    for (const [file, maxLines] of [['world-layout.ts', 260], ['world-renderer.ts', 290]] as const) {
      const src = readFileSync(join(ROOT, 'src', 'office-app', file), 'utf8')
      expect(src).not.toMatch(/['"]node:/)
      const nonEmpty = src.split('\n').filter((l) => l.trim().length > 0).length
      expect(nonEmpty, `${file} non-empty lines`).toBeLessThanOrEqual(maxLines)
    }
  })

  it('solves 2 workspaces into 2 studios + 2 courtyards + secretary-only lobby', () => {
    const world = solveWorldFloorplan([
      { id: 'demo-repo', title: 'demo-repo' },
      { id: 'default', title: 'default' },
      { id: 'demo-repo', title: 'duplicate-ignored' },
    ])
    expect(world.buildingCols).toBe(WORLD_BUILDING_COLS)
    expect(world.buildingRows).toBe(WORLD_BUILDING_ROWS)
    expect(world.baseOrigin).toEqual(WORLD_BASE_ORIGIN)
    expect(world.mainEntrance).toEqual({ u: 15, v: 23 })
    expect(world.lobby.suites.map((s) => s.id)).toEqual(['lobby-reception'])
    expect(world.wings).toHaveLength(4)
    expect(world.wings[0]).toMatchObject({ workspaceId: 'default', kind: 'studio' })
    expect(world.wings[1]).toMatchObject({ workspaceId: 'demo-repo', kind: 'studio' })
    expect(world.wings[2]).toMatchObject({ id: 'wing-lounge', kind: 'studio', title: '茶歇与阅览室' })
    expect(world.wings[3]!.kind).toBe('courtyard')
    expect(world.wings[3]!.suites).toEqual([])
    expect(world.wings[3]!.shared.filter((e) => e.assetId === 'tree_shrub')).toHaveLength(2)
    expect(world.exteriorProps.length).toBeGreaterThanOrEqual(6)

    const large = solveWorldFloorplan([
      { id: 'a', title: 'a' }, { id: 'b', title: 'b' }, { id: 'c', title: 'c' }, { id: 'd', title: 'd' },
    ])
    expect(large.wings).toHaveLength(6)
    expect(large.buildingRows).toBe(36)
  })

  it('round-trips worldIsoToScreen and screenToWorldIso at 1x and 2x zoom with pan', () => {
    const world = solveWorldFloorplan([{ id: 'default', title: 'default' }])
    for (const zoom of [1, 2] as const) {
      const cam = cameraForGridPoint({ u: 19.5, v: 6.5 }, world, zoom, 1280, 800)
      expect(cam.zoom).toBe(zoom)
      const pt = worldIsoToScreen(19.5, 6.5, world, cam)
      expect(Math.round(pt.x)).toBe(640)
      expect(Math.round(pt.y)).toBe(400)
      expect(screenToWorldIso(pt.x, pt.y, world, cam)).toEqual({ u: 19, v: 6 })
    }
  })

  it('routes worker from main entrance across corridor through demo-repo doorway and back out', () => {
    const world = solveWorldFloorplan([{ id: 'default', title: 'default' }, { id: 'demo-repo', title: 'demo-repo' }])
    let actors = createInitialWorldActors(world)
    expect(actors.map((a) => a.id)).toEqual(['secretary', 'lead-default', 'lead-demo-repo'])

    const worker = spawnWorldWorker(world, 'worker-1', 'demo-repo', 'T-42', 'ws-demo-repo-1')
    expect(worker.u).toBe(15)
    expect(worker.v).toBe(23)
    expect(worker.path.some((p) => p.u === 19 && p.v === 6)).toBe(true)

    actors = [...actors, worker]
    for (let i = 0; i < 120; i++) actors = stepWorldActors(actors, world, 250)
    const seated = actors.find((a) => a.id === 'worker-1')!
    expect(seated.lifecycle).toBe('working')
    expect(seated.pose).toBe('sit')

    actors = actors.map((a) => (a.id === 'worker-1' ? { ...a, lifecycle: 'leaving' as const, path: [] } : a))
    for (let i = 0; i < 120; i++) actors = stepWorldActors(actors, world, 250)
    expect(actors.find((a) => a.id === 'worker-1')!.lifecycle).toBe('removed')
  })

  it('renders full viewport with zero transparent pixels and draws outdoor + indoor layers', () => {
    const world = solveWorldFloorplan([{ id: 'default', title: 'default' }, { id: 'demo-repo', title: 'demo-repo' }])
    const actors = createInitialWorldActors(world)
    const sprites = makeMockSprites()
    const state: WorldSceneState = {
      world,
      actors,
      screenStates: { 'exec-default': 'working', 'exec-demo-repo': 'stuck' },
      activeWorkspaceId: 'demo-repo',
      secretaryThinking: true,
      elapsedMs: 100,
    }

    for (const zoom of [1, 2] as const) {
      const cam = cameraForGridPoint(world.lobby.focusPoint, world, zoom, 640, 480)
      const { ctx, alpha, drawnAssets } = makePixelTrackingCtx(640, 480)
      renderWorldFrame(ctx, state, sprites, cam)
      const transparentCount = alpha.reduce((acc, a) => acc + (a === 0 ? 1 : 0), 0)
      expect(transparentCount).toBe(0)
      expect(drawnAssets).toContain('grass_tile')
      expect(drawnAssets).toContain('stone_tile')
      expect(drawnAssets).toContain('corridor_tile')
      expect(drawnAssets).toContain('floor_wood')
      expect(drawnAssets).toContain('office_chair')
      expect(drawnAssets).toContain('char_secretary')
      expect(drawnAssets).toContain('char_lead')
    }
  })

  it('picks secretary, all 5 props (including per-wing doorplates), and wing nameplates', () => {
    const world = solveWorldFloorplan([{ id: 'default', title: 'default' }, { id: 'demo-repo', title: 'demo-repo' }])
    const actors = createInitialWorldActors(world)
    const cam = { panX: 0, panY: 0, zoom: 2 as const }
    const state: WorldSceneState = {
      world,
      actors,
      screenStates: { 'exec-default': 'working' },
      activeWorkspaceId: 'default',
      elapsedMs: 0,
    }

    const sec = actors.find((a) => a.id === 'secretary')!
    const secPos = worldIsoToScreen(sec.u + 0.5, sec.v + 0.5, world, cam)
    expect(pickWorldTarget(secPos.x, secPos.y - 48, state, cam)).toMatchObject({
      type: 'actor',
      actorId: 'secretary',
      role: 'secretary',
    })

    const rec = world.lobby.suites.find((s) => s.id === 'lobby-reception')!
    const recPos = worldIsoToScreen(rec.anchor.u + rec.size[0] / 2, rec.anchor.v + rec.size[1] / 2, world, cam)
    expect(pickWorldTarget(recPos.x - 56, recPos.y - 20, state, cam)).toMatchObject({ type: 'prop', prop: 'ledger' })
    expect(pickWorldTarget(recPos.x + 56, recPos.y - 20, state, cam)).toMatchObject({ type: 'prop', prop: 'notebook' })

    const cab = world.lobby.shared.find((s) => s.id === 'lobby-cabinet')!
    const cabPos = worldIsoToScreen(cab.anchor.u + cab.size[0] / 2, cab.anchor.v + cab.size[1] / 2, world, cam)
    expect(pickWorldTarget(cabPos.x, cabPos.y - 20, state, cam)).toMatchObject({ type: 'prop', prop: 'cabinet' })

    const cb = world.lobby.wallMounts.find((m) => m.id === 'lobby-corkboard')!
    const cbPos = worldIsoToScreen(cb.at, 0, world, cam)
    expect(pickWorldTarget(cbPos.x, cbPos.y - cb.h * 2 - 95, state, cam)).toMatchObject({ type: 'prop', prop: 'corkboard' })

    const demoWing = world.wings.find((w) => w.workspaceId === 'demo-repo')!
    const dpPos = worldIsoToScreen(19.2, demoWing.doorway.v - 0.8, world, cam)
    expect(pickWorldTarget(dpPos.x, dpPos.y - 48, state, cam)).toMatchObject({
      type: 'prop',
      prop: 'doorplate',
      workspaceId: 'demo-repo',
    })

    const signPos = worldIsoToScreen(demoWing.rect.u + demoWing.rect.w / 2, demoWing.rect.v + 5.6, world, cam)
    expect(pickWorldTarget(signPos.x, signPos.y - 16, state, cam)).toMatchObject({
      type: 'wing',
      wingId: 'wing-demo-repo',
      workspaceId: 'demo-repo',
      kind: 'studio',
    })
  })
})
