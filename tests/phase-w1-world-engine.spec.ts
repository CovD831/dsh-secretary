import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WORLD_ASSET_CATALOG } from '../src/office-app/diorama-catalog.ts'
import { createDioramaLayerNames } from '../src/office-app/pixi-diorama.ts'
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
import { auditPaletteBuffer } from '../src/pixel-office/palette.ts'
import { decodePngRgba } from '../src/pixel-office/sprites.ts'

const ROOT = resolve(import.meta.dirname, '..')

function makeMockSprites(): WorldSprites {
  const images: Record<string, CanvasImageSource> = {}
  for (const [id, meta] of Object.entries(WORLD_ASSET_CATALOG)) {
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

describe('Phase W1/V2: Asymmetric Diorama Floorplan, 7-Layer Renderer & Pixi Stage', () => {
  it('keeps V2 world modules browser-safe and within line limits', () => {
    for (const [file, maxLines] of [
      ['procedural-rooms.ts', 285],
      ['world-layout.ts', 270],
      ['world-renderer.ts', 285],
      ['pixi-diorama.ts', 285],
      ['diorama-catalog.ts', 290],
    ] as const) {
      const src = readFileSync(join(ROOT, 'src', 'office-app', file), 'utf8')
      expect(src, `${file} node: import`).not.toMatch(/['"]node:/)
      const nonEmpty = src.split('\n').filter((l) => l.trim().length > 0).length
      expect(nonEmpty, `${file} non-empty lines`).toBeLessThanOrEqual(maxLines)
    }
    expect(createDioramaLayerNames()).toEqual([
      'stageVignette', 'baseAndFloors', 'aoShadows', 'cutawayWalls', 'ySortedEntities', 'warmLighting',
    ])
    const rendererSrc = readFileSync(join(ROOT, 'src', 'office-app', 'world-renderer.ts'), 'utf8')
    expect(rendererSrc).not.toContain('rgba(20, 14, 12')
    expect(rendererSrc).not.toContain('rgba(255, 232, 178')
  })

  it('audits all 18 office-diorama and 16 office-ui PNGs for strict palette & binary alpha', () => {
    const groups = [
      ['office-diorama', 18],
      ['office-ui', 18],
    ] as const
    for (const [dirName, expectedCount] of groups) {
      const dir = join(ROOT, 'assets', dirName)
      const pngs = readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
      expect(pngs.length, `${dirName} png count`).toBe(expectedCount)
      for (const file of pngs) {
        const { width, height, rgba } = decodePngRgba(readFileSync(join(dir, file)))
        const audit = auditPaletteBuffer(rgba, width, height, new Uint8Array(width * height))
        expect(audit.outOfPaletteCount, `${dirName}/${file} outOfPaletteCount`).toBe(0)
        expect(audit.semiTransparentCount, `${dirName}/${file} semiTransparentCount`).toBe(0)
        expect(audit.totalOpaquePixels, `${dirName}/${file} opaquePixels`).toBeGreaterThan(0)
      }
    }
  })

  it('solves asymmetric interlocking diorama topology with doors, facade, and warm lights', () => {
    const world = solveWorldFloorplan([
      { id: 'demo-repo', title: 'demo-repo' },
      { id: 'default', title: 'default' },
      { id: 'demo-repo', title: 'duplicate-ignored' },
    ])
    expect(world.buildingCols).toBe(WORLD_BUILDING_COLS)
    expect(world.buildingRows).toBe(WORLD_BUILDING_ROWS)
    expect(world.baseOrigin).toEqual(WORLD_BASE_ORIGIN)
    expect(world.mainEntrance).toEqual({ u: 11, v: 17 })
    expect(world.lobby.suites.map((s) => s.id)).toEqual(['lobby-reception'])
    expect(world.wings).toHaveLength(4)
    expect(world.wings[0]).toMatchObject({ workspaceId: 'default', kind: 'studio', rugStyle: 'sage' })
    expect(world.wings[1]).toMatchObject({ workspaceId: 'demo-repo', kind: 'studio', rugStyle: 'indigo' })
    expect(world.wings[0]!.doorway.v).not.toBe(world.wings[1]!.doorway.v)
    expect(world.wings[2]).toMatchObject({ id: 'wing-lounge', kind: 'studio', chamferSE: 2, rugStyle: 'persian' })
    expect(world.wings[3]!.kind).toBe('courtyard')
    expect(world.interiorDoors?.length).toBeGreaterThanOrEqual(3)
    expect(world.lightSources?.length).toBeGreaterThanOrEqual(6)
    expect(world.frontFacade?.length).toBeGreaterThanOrEqual(3)
    expect(world.exteriorProps.length).toBeGreaterThanOrEqual(6)

    const large = solveWorldFloorplan([
      { id: 'a', title: 'a' }, { id: 'b', title: 'b' }, { id: 'c', title: 'c' }, { id: 'd', title: 'd' },
    ])
    expect(large.wings).toHaveLength(6)
    expect(large.buildingRows).toBe(28)
  })

  it('generates deterministic seeded irregular prefab rooms, 3-tier walls, MST-loop corridors, and reachable paths for seeds 1..4', () => {
    const specs = [{ id: 'default', title: 'default' }, { id: 'demo-repo', title: 'demo-repo' }]
    const w1a = solveWorldFloorplan(specs, 1)
    const w1b = solveWorldFloorplan(specs, 1)
    expect(w1a.wallSegments).toEqual(w1b.wallSegments)
    expect(w1a.corridorCells).toEqual(w1b.corridorCells)

    const sigs = new Set<string>()
    for (const seed of [1, 2, 3, 4]) {
      const world = solveWorldFloorplan(specs, seed)
      expect(world.networkMetrics?.loopCount).toBeGreaterThanOrEqual(1)
      expect(world.corridorBranches?.length).toBeGreaterThanOrEqual(2)
      expect(world.wings[0]!.doorway.v).not.toBe(world.wings[1]!.doorway.v)

      const tiers = new Map(world.wallSegments?.map((s) => [s.tier, s.startH]))
      expect(tiers.get('back')).toBe(64)
      expect(tiers.get('partition')).toBe(48)
      expect(tiers.get('cutaway')).toBe(32)
      expect(tiers.get('portal')).toBe(50)

      for (const wing of world.wings.filter((w) => w.kind === 'studio')) {
        expect(wing.cells!.length).toBeLessThan(wing.rect.w * wing.rect.h)
        const cellSet = new Set(wing.cells!.map((c) => `${c.u},${c.v}`))
        for (const ent of [...wing.suites, ...wing.shared]) {
          for (const fc of ent.footprint) expect(cellSet.has(`${fc.u},${fc.v}`)).toBe(true)
          if (ent.seatCell) expect(cellSet.has(`${ent.seatCell.u},${ent.seatCell.v}`)).toBe(true)
        }
      }

      sigs.add(world.wings.slice(0, 3).map((w) => `${w.shapeKind}:${w.comboKind}:${w.doorway.v}`).join('|'))

      let actors = [...createInitialWorldActors(world), spawnWorldWorker(world, 'w-test', 'demo-repo', 'T-1', 'ws-demo-repo-1')]
      for (let i = 0; i < 140; i++) actors = stepWorldActors(actors, world, 250)
      expect(actors.find((a) => a.id === 'w-test')?.lifecycle).toBe('working')
    }
    expect(sigs.size).toBeGreaterThanOrEqual(3)
  })

  it('round-trips worldIsoToScreen and screenToWorldIso at 1x and 2x zoom with pan', () => {
    const world = solveWorldFloorplan([{ id: 'default', title: 'default' }])
    for (const zoom of [1, 2] as const) {
      const cam = cameraForGridPoint({ u: 11.5, v: 6.5 }, world, zoom, 1280, 800)
      expect(cam.zoom).toBe(zoom)
      const pt = worldIsoToScreen(11.5, 6.5, world, cam)
      expect(Math.round(pt.x)).toBe(640)
      expect(Math.round(pt.y)).toBe(400)
      expect(screenToWorldIso(pt.x, pt.y, world, cam)).toEqual({ u: 11, v: 6 })
    }
  })

  it('routes worker from main entrance across corridor through demo-repo doorway and back out', () => {
    const world = solveWorldFloorplan([{ id: 'default', title: 'default' }, { id: 'demo-repo', title: 'demo-repo' }])
    let actors = createInitialWorldActors(world)
    expect(actors.map((a) => a.id)).toEqual(['secretary', 'lead-default', 'lead-demo-repo'])

    const worker = spawnWorldWorker(world, 'worker-1', 'demo-repo', 'T-42', 'ws-demo-repo-1')
    expect(worker.u).toBe(11)
    expect(worker.v).toBe(17)
    expect(worker.path.some((p) => p.u === 13 && (p.v === 5 || p.v === 6))).toBe(true)

    actors = [...actors, worker]
    for (let i = 0; i < 120; i++) actors = stepWorldActors(actors, world, 250)
    const seated = actors.find((a) => a.id === 'worker-1')!
    expect(seated.lifecycle).toBe('working')
    expect(seated.pose).toBe('sit')

    actors = actors.map((a) => (a.id === 'worker-1' ? { ...a, lifecycle: 'leaving' as const, path: [] } : a))
    for (let i = 0; i < 120; i++) actors = stepWorldActors(actors, world, 250)
    expect(actors.find((a) => a.id === 'worker-1')!.lifecycle).toBe('removed')
  })

  it('renders 7-layer diorama with zero transparent pixels and new V2 suite assets', () => {
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
      expect(drawnAssets).toContain('stone_tile')
      expect(drawnAssets).toContain('corridor_tile')
      expect(drawnAssets).toContain('floor_wood')
      expect(drawnAssets).toContain('runner_navy')
      expect(drawnAssets).toContain('welcome_mat')
      expect(drawnAssets).toContain('rug_sage')
      expect(drawnAssets).toContain('door_wood')
      expect(drawnAssets).toContain('desk_cluster')
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
      type: 'actor', actorId: 'secretary', role: 'secretary',
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
    const dpPos = worldIsoToScreen(demoWing.doorway.u + 0.2, demoWing.doorway.v - 0.8, world, cam)
    expect(pickWorldTarget(dpPos.x, dpPos.y - 48, state, cam)).toMatchObject({
      type: 'prop', prop: 'doorplate', workspaceId: 'demo-repo',
    })

    const signPos = worldIsoToScreen(demoWing.rect.u + demoWing.rect.w / 2, demoWing.rect.v + Math.min(4.2, demoWing.rect.h / 2), world, cam)
    expect(pickWorldTarget(signPos.x, signPos.y - 16, state, cam)).toMatchObject({
      type: 'wing', wingId: 'wing-demo-repo', workspaceId: 'demo-repo', kind: 'studio',
    })
  })
})
