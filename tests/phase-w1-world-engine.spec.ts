import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WORLD_ASSET_CATALOG } from '../src/office-app/diorama-catalog.ts'
import { createDioramaLayerNames } from '../src/office-app/pixi-diorama.ts'
import { CUTAWAY_WALL_H, UNIFIED_WALL_H, armrestCellsFor, buildDoorEntryZones, isChamferEdgeCell, isDeskWallClear, isSeatFacingDoor, type RoomDoorSpec } from '../src/office-app/procedural-rooms.ts'
import { TALL_WALL_BLOCKERS } from '../src/office-app/room-blueprints.ts'
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
      ['roguelike-pcg.ts', 260],
      ['procedural-rooms.ts', 285],
      ['room-blueprints.ts', 260],
      ['world-layout.ts', 270],
      ['world-renderer.ts', 285],
      ['pixi-diorama.ts', 285],
      ['diorama-catalog.ts', 290],
      ['game-hud.tsx', 300],
      ['stage-app.tsx', 300],
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
    expect(world.mainEntrance).toEqual({ u: 13, v: 19 })
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
    expect(large.buildingRows).toBe(30)
  })

  it('generates deterministic seeded irregular prefab rooms, 3-tier walls, MST-loop corridors, and reachable paths for seeds 1..100', () => {
    const specs = [{ id: 'default', title: 'default' }, { id: 'demo-repo', title: 'demo-repo' }]
    const w1a = solveWorldFloorplan(specs, 1)
    const w1b = solveWorldFloorplan(specs, 1)
    expect(w1a.wallSegments).toEqual(w1b.wallSegments)
    expect(w1a.corridorCells).toEqual(w1b.corridorCells)

    const sigs = new Set<string>(), pcgSigs = new Set<string>()
    for (const seed of [1, 2, 3, 4]) {
      const world = solveWorldFloorplan(specs, seed)
      expect(world.networkMetrics?.loopCount).toBeGreaterThanOrEqual(1)
      expect(world.corridorBranches?.length).toBeGreaterThanOrEqual(2)
      expect(world.wings[0]!.doorway.v).not.toBe(world.wings[1]!.doorway.v)

      expect(UNIFIED_WALL_H).toBe(56)
      expect(CUTAWAY_WALL_H).toBe(34)
      expect(world.wallSegments?.length).toBeGreaterThan(0)
      expect(world.wallSegments?.every((s) => s.tier === 'cutaway' || s.tier === 'portal'
        ? s.startH === CUTAWAY_WALL_H && s.endH === CUTAWAY_WALL_H
        : [CUTAWAY_WALL_H, UNIFIED_WALL_H].includes(s.startH) && [CUTAWAY_WALL_H, UNIFIED_WALL_H].includes(s.endH))).toBe(true)
      const partSegs = world.wallSegments!.filter((s) => s.tier === 'partition')
      expect(partSegs.length).toBeLessThanOrEqual(20)
      expect(partSegs.some((s) => s.startH === UNIFIED_WALL_H && s.endH === UNIFIED_WALL_H)).toBe(true)
      expect(world.interiorDoors?.some((d) => d.id === 'door-right-link')).toBe(true)

      for (const wing of world.wings.filter((w) => w.kind === 'studio')) {
        expect(wing.cells!.length).toBeLessThanOrEqual(wing.rect.w * wing.rect.h)
        const cellSet = new Set(wing.cells!.map((c) => `${c.u},${c.v}`))
        for (const ent of [...wing.suites, ...wing.shared]) {
          for (const fc of ent.footprint) expect(cellSet.has(`${fc.u},${fc.v}`)).toBe(true)
          if (ent.seatCell) expect(cellSet.has(`${ent.seatCell.u},${ent.seatCell.v}`)).toBe(true)
        }
        if (wing.rugRect) {
          for (let dv = 0; dv < wing.rugRect.h; dv++) for (let du = 0; du < wing.rugRect.w; du++) {
            const ru = wing.rugRect.u + du, rv = wing.rugRect.v + dv
            expect(cellSet.has(`${ru},${rv}`)).toBe(true)
            expect(isChamferEdgeCell(ru, rv, cellSet)).toBe(false)
          }
        }
      }

      sigs.add(world.wings.slice(0, 3).map((w) => `${w.shapeKind}:${w.comboKind}:${w.doorway.v}`).join('|'))

      let actors = [...createInitialWorldActors(world), spawnWorldWorker(world, 'w-test', 'demo-repo', 'T-1', 'ws-demo-repo-1')]
      for (let i = 0; i < 140; i++) actors = stepWorldActors(actors, world, 250)
      expect(actors.find((a) => a.id === 'w-test')?.lifecycle).toBe('working')
    }
    expect(sigs.size).toBeGreaterThanOrEqual(3)

    const pixiSrc = readFileSync(join(ROOT, 'src', 'office-app', 'pixi-diorama.ts'), 'utf8')
    expect(pixiSrc).not.toContain('bodyAlpha')
    expect(pixiSrc).not.toContain('0.34')

    const multiWs = [{ id: 'default', title: 'default' }, { id: 'demo-repo', title: 'demo-repo' }, { id: 'third', title: 'third' }]
    for (let seed = 1; seed <= 100; seed++) {
      const w = solveWorldFloorplan(multiWs, seed)
      if (seed <= 30) {
        pcgSigs.add(w.wings.slice(0, 3).map((x) => `${x.rect.v}:${x.rect.h}:${x.chamferSE ?? 0}:${x.doorway.v}:${x.suites.map((s) => `${s.assetId}@${s.anchor.u},${s.anchor.v}`).join(',')}`).join('|'))
      }
      const segs = w.wallSegments!
      const vHeights = new Map<string, Set<number>>(), extDeg = new Map<string, number>()
      for (const s of segs) {
        const vh1 = vHeights.get(`${s.from.u},${s.from.v}`) ?? new Set<number>(); vh1.add(s.startH); vHeights.set(`${s.from.u},${s.from.v}`, vh1)
        const vh2 = vHeights.get(`${s.to.u},${s.to.v}`) ?? new Set<number>(); vh2.add(s.endH); vHeights.set(`${s.to.u},${s.to.v}`, vh2)
        if (s.tier === 'cutaway' || s.tier === 'portal') {
          expect(s.startH, `seed=${seed} ${s.tier} startH`).toBe(CUTAWAY_WALL_H)
          expect(s.endH, `seed=${seed} ${s.tier} endH`).toBe(CUTAWAY_WALL_H)
        } else {
          expect([CUTAWAY_WALL_H, UNIFIED_WALL_H].includes(s.startH), `seed=${seed} ${s.tier} startH`).toBe(true)
          expect([CUTAWAY_WALL_H, UNIFIED_WALL_H].includes(s.endH), `seed=${seed} ${s.tier} endH`).toBe(true)
        }
        if (s.tier !== 'partition') {
          extDeg.set(`${s.from.u},${s.from.v}`, (extDeg.get(`${s.from.u},${s.from.v}`) ?? 0) + 1)
          extDeg.set(`${s.to.u},${s.to.v}`, (extDeg.get(`${s.to.u},${s.to.v}`) ?? 0) + 1)
        }
        const isLobbyStep = s.from.u === s.to.u && (s.from.u === 10 || s.from.u === 16) && Math.max(s.from.v, s.to.v) <= 2
        if ((s.tier === 'back' || s.tier === 'cutaway') && (s.from.u === s.to.u || s.from.v === s.to.v) && s.startH === s.endH && !isLobbyStep) {
          const segLen = Math.max(Math.abs(s.to.u - s.from.u), Math.abs(s.to.v - s.from.v))
          expect(segLen, `seed=${seed} ${s.tier} (${s.from.u},${s.from.v})->(${s.to.u},${s.to.v})`).toBeGreaterThanOrEqual(3)
        }
      }
      for (const [vk, hs] of vHeights) expect(hs.size, `seed=${seed} wall vertex ${vk} height mismatch`).toBe(1)
      for (const [vk, deg] of extDeg) expect(deg, `seed=${seed} exterior vertex ${vk} dangling`).toBeGreaterThanOrEqual(2)
      const zone = new Map<string, string>()
      for (const c of [...(w.corridorCells ?? []), ...(w.lobby.cells ?? [])]) zone.set(`${c.u},${c.v}`, 'corr')
      for (const wg of w.wings) if (wg.kind === 'studio') for (const c of wg.cells ?? []) zone.set(`${c.u},${c.v}`, wg.id)
      for (const d of w.interiorDoors ?? []) {
        const pairs = d.axis === 'u'
          ? [[d.u - 1, d.v, d.u, d.v], [d.u - 1, d.v + 1, d.u, d.v + 1]] as const
          : [[d.u, d.v - 1, d.u, d.v], [d.u + 1, d.v - 1, d.u + 1, d.v]] as const
        for (const [u1, v1, u2, v2] of pairs) {
          const z1 = zone.get(`${u1},${v1}`), z2 = zone.get(`${u2},${v2}`)
          expect(Boolean(z1 && z2 && z1 !== z2), `seed=${seed} door ${d.id} valid zones`).toBe(true)
        }
        const onFlat46 = segs.some((s) => s.tier === 'partition' && s.startH === UNIFIED_WALL_H && s.endH === UNIFIED_WALL_H && (
          d.axis === 'u'
            ? s.from.u === d.u && s.to.u === d.u && Math.min(s.from.v, s.to.v) <= d.v && Math.max(s.from.v, s.to.v) >= d.v + 2
            : s.from.v === d.v && s.to.v === d.v && Math.min(s.from.u, s.to.u) <= d.u && Math.max(s.from.u, s.to.u) >= d.u + 2
        ))
        expect(onFlat46, `seed=${seed} door ${d.id} on flat 46px partition`).toBe(true)
      }
    }

    const cam1 = { panX: 0, panY: 0, zoom: 1 as const }
    const inPoly = (px: number, py: number, pts: readonly { x: number; y: number }[]) => {
      let c = false
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i]!, b = pts[j]!
        if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) c = !c
      }
      return c
    }
    const checkBoxOcc = (
      w: ReturnType<typeof solveWorldFloorplan>, label: string, x0: number, y0: number, bw: number, bh: number,
      u0: number, v0: number, u1: number, v1: number, footY: number,
    ) => {
      let hit = 0, tot = 0
      for (let yy = 0; yy < bh; yy += 4) for (let xx = 0; xx < bw; xx += 4) {
        tot++; const px = x0 + xx, py = y0 + yy
        let covered = false
        for (const s of w.wallSegments!) {
          if (s.tier === 'back') continue
          const n = Math.max(1, Math.round(Math.max(Math.abs(s.to.u - s.from.u), Math.abs(s.to.v - s.from.v))))
          for (let i = 0; i < n; i++) {
            const t0 = i / n, t1 = (i + 1) / n
            const ua = s.from.u + (s.to.u - s.from.u) * t0, va = s.from.v + (s.to.v - s.from.v) * t0
            const ub = s.from.u + (s.to.u - s.from.u) * t1, vb = s.from.v + (s.to.v - s.from.v) * t1
            const um = (ua + ub) / 2, vm = (va + vb) / 2
            const a = worldIsoToScreen(ua, va, w, cam1), b = worldIsoToScreen(ub, vb, w, cam1)
            if (um <= u0 || vm <= v0 || (um < u1 && vm < v1 && (a.y + b.y) / 2 <= footY - 3)) continue
            const h0 = s.startH + (s.endH - s.startH) * t0, h1 = s.startH + (s.endH - s.startH) * t1
            if (inPoly(px, py, [a, b, { x: b.x, y: b.y - h1 }, { x: a.x, y: a.y - h0 }])) { covered = true; break }
          }
          if (covered) { hit++; break }
        }
      }
      expect(hit / tot, `${label} foreground solid wall occlusion`).toBeLessThan(0.1)
    }
    expect(pcgSigs.size, '1..30 roguelike diversity').toBeGreaterThanOrEqual(20)
    for (let seed = 1; seed <= 100; seed++) {
      const w = solveWorldFloorplan(multiWs, seed)
      expect(createInitialWorldActors(w).map((a) => a.id), `seed=${seed} only secretary`).toEqual(['secretary'])
      const diagWalls = w.wallSegments!.filter((s) => s.from.u !== s.to.u && s.from.v !== s.to.v)
      for (const wg of w.wings.filter((x) => x.kind === 'studio' && x.workspaceId)) {
        expect(wg.suites.filter((s) => s.suiteKind === 'workstation').length, `seed=${seed} ${wg.id} workstations`).toBeGreaterThanOrEqual(1)
        const cset = new Set(wg.cells!.map((c) => `${c.u},${c.v}`))
        if (wg.rugRect) {
          const r = wg.rugRect
          expect(r.w, `seed=${seed} ${wg.id} square rug`).toBe(r.h)
          expect([4, 6, 8].includes(r.w), `seed=${seed} ${wg.id} even integer rug ${r.w}`).toBe(true)
          if (wg.rect.w >= 10 && wg.rect.h >= 9) expect(r.w, `seed=${seed} ${wg.id} generous rug`).toBeGreaterThanOrEqual(6)
          for (let dv = 0; dv < r.h; dv++) for (let du = 0; du < r.w; du++) {
            expect(cset.has(`${r.u + du},${r.v + dv}`), `seed=${seed} ${wg.id} rug cell inside room`).toBe(true)
            expect(isChamferEdgeCell(r.u + du, r.v + dv, cset), `seed=${seed} ${wg.id} rug off chamfer`).toBe(false)
          }
          for (const dw of diagWalls) {
            const minU = Math.min(dw.from.u, dw.to.u), maxU = Math.max(dw.from.u, dw.to.u)
            const minV = Math.min(dw.from.v, dw.to.v), maxV = Math.max(dw.from.v, dw.to.v)
            if (r.u + r.w > minU && r.u < maxU && r.v + r.h > minV && r.v < maxV) {
              expect(r.u + r.w + r.v + r.h, `seed=${seed} ${wg.id} rug clipped by chamfer wall`).toBeLessThanOrEqual(dw.from.u + dw.from.v)
            }
          }
          const focal = wg.shared.find((e) => e.assetId === 'collab_table' || e.assetId === 'armchair_green' || e.assetId === 'sofa_lounge')
            ?? wg.suites.find((e) => e.assetId === 'desk_cluster' || e.assetId === 'collab_table' || e.assetId === 'exec_desk') ?? wg.suites[0]
          expect(focal, `seed=${seed} ${wg.id} rug must have focal`).toBeTruthy()
          const fu = focal!.anchor.u + focal!.size[0] / 2, fv = focal!.anchor.v + focal!.size[1] / 2
          expect(fu >= r.u && fu <= r.u + r.w && fv >= r.v && fv <= r.v + r.h, `seed=${seed} ${wg.id} focal inside rug`).toBe(true)
        }
        const ents = [...wg.suites, ...wg.shared]
        for (const d of ents) if (d.suiteKind === 'workstation' || d.assetId === 'collab_table') {
          expect(isDeskWallClear(d.anchor.u, d.anchor.v, d.size[0], d.size[1], d.assetId, cset), `seed=${seed} ${wg.id} ${d.id} desk too close to wall`).toBe(true)
        }
        for (let i = 0; i < ents.length; i++) for (let j = i + 1; j < ents.length; j++) {
          const a = ents[i]!, b = ents[j]!
          if (a.assetId === 'lamp_table' || b.assetId === 'lamp_table') continue
          const gap = a.anchor.u <= b.anchor.u + b.size[0] && a.anchor.u + a.size[0] >= b.anchor.u
            && a.anchor.v <= b.anchor.v + b.size[1] && a.anchor.v + a.size[1] >= b.anchor.v
          expect(gap, `seed=${seed} ${wg.id} ${a.id} vs ${b.id} missing 1-tile halo`).toBe(false)
        }
        const wds = wg.suites.filter((s) => s.assetId === 'worker_desk')
        if (wds.length >= 2 && (wg.rect.v >= 9 || wds.every((d) => d.anchor.v === wds[0]!.anchor.v))) {
          if (wds.length === 2 && wg.rect.u >= 14 && wg.rect.v < 9) expect(wds[0]!.anchor.v, `seed=${seed} ${wg.id} row aligned`).toBe(wds[1]!.anchor.v)
        }
        for (const sh of wg.shared) {
          if (['bookshelf', 'file_cabinet', 'water_cooler', 'printer_copier'].includes(sh.assetId)) {
            const onWall = !cset.has(`${sh.anchor.u},${sh.anchor.v - 1}`) || !cset.has(`${sh.anchor.u - 1},${sh.anchor.v}`)
            expect(onWall, `seed=${seed} ${wg.id} ${sh.id} flush against wall`).toBe(true)
          }
          if (TALL_WALL_BLOCKERS.has(sh.assetId)) {
            for (const m of wg.wallMounts.filter((wm) => wm.propKind !== 'doorplate')) {
              const hitMount = m.wall === 'back'
                ? sh.anchor.v === wg.rect.v && sh.anchor.u < m.at + m.span * 0.5 && sh.anchor.u + sh.size[0] > m.at - m.span * 0.5
                : sh.anchor.u === wg.rect.u && sh.anchor.v < m.at + m.span * 0.5 && sh.anchor.v + sh.size[1] > m.at - m.span * 0.5
              expect(hitMount, `seed=${seed} ${wg.id} ${sh.id} overlaps mount ${m.id}`).toBe(false)
            }
          }
        }
      }
      const w1s = solveWorldFloorplan([{ id: 'default', title: 'default' }], seed)
      const resWing = w1s.wings.find((x) => x.id === 'wing-reserve')!
      const lngWing = w1s.wings.find((x) => x.id === 'wing-lounge')!
      const splitV = lngWing.rect.v
      const resTopSet = new Set(resWing.cells!.map((c) => `${c.u},${c.v}`))
      const lngSet = new Set(lngWing.cells!.map((c) => `${c.u},${c.v}`))
      const belowSet = new Set([...lngWing.cells!, ...(w1s.corridorCells ?? [])].map((c) => `${c.u},${c.v}`))
      for (const c of resWing.cells!) if (c.v === splitV - 1) expect(belowSet.has(`${c.u},${splitV}`), `seed=${seed} zero Escher overhang at (${c.u},${splitV})`).toBe(true)
      expect(resWing.shared.some((s) => s.assetId === 'collab_table'), `1ws seed=${seed} meeting room`).toBe(true)
      expect(lngWing.shared.some((s) => s.assetId === 'sofa_lounge'), `1ws seed=${seed} lounge sofa`).toBe(true)
      expect(lngWing.shared.some((s) => s.assetId === 'printer_copier'), `1ws seed=${seed} lounge no copier`).toBe(false)
      expect(lngWing.rugRect?.w, `1ws seed=${seed} lounge rug >=6`).toBeGreaterThanOrEqual(6)
      expect(resTopSet.size, `seed=${seed} resWing expanded >=100`).toBeGreaterThanOrEqual(100)
      expect(lngSet.size, `seed=${seed} lngWing expanded >=100`).toBeGreaterThanOrEqual(100)
      for (const wg of w1s.wings.filter((x) => x.kind === 'studio')) {
        const occ = [...wg.suites, ...wg.shared].reduce((s, e) => s + e.size[0] * e.size[1], 0) / wg.cells!.length
        expect(occ, `1ws seed=${seed} ${wg.id} density <= 0.35`).toBeLessThanOrEqual(0.35)
        const roomDoors: RoomDoorSpec[] = [{ u: wg.doorway.u, v: wg.doorway.v, axis: 'u', inDir: wg.rect.u === 0 ? -1 : 1 }]
        const link = w1s.interiorDoors?.find((d) => d.id === 'door-right-link')
        if (link && wg.rect.u >= 16) roomDoors.push({ u: link.u, v: wg.rect.v < splitV ? splitV - 1 : splitV, axis: 'v', inDir: wg.rect.v < splitV ? -1 : 1 })
        const entryZone = buildDoorEntryZones(roomDoors)
        for (const e of [...wg.suites, ...wg.shared]) {
          for (const fc of e.footprint) expect(entryZone.has(`${fc.u},${fc.v}`), `seed=${seed} ${e.id} inside 2x3 door entry corridor`).toBe(false)
          if (e.assetId === 'armchair_green' || e.assetId === 'sofa_lounge') {
            expect(isSeatFacingDoor(e.anchor.u, e.anchor.v, e.size[0], e.size[1], e.facing, roomDoors), `seed=${seed} ${e.id} faces doorway`).toBe(false)
          }
          if (e.assetId === 'lamp_table') {
            const seats = wg.shared.filter((s) => s.assetId === 'armchair_green' || s.assetId === 'sofa_lounge')
            const paired = seats.some((s) => armrestCellsFor({ u: s.anchor.u, v: s.anchor.v, mw: s.size[0], mh: s.size[1], facing: s.facing }).some((c) => c.u === e.anchor.u && c.v === e.anchor.v))
            expect(paired, `seed=${seed} ${e.id} on seat armrest`).toBe(true)
          }
        }
      }
      const doorTiles = new Set<string>()
      for (const d of w.interiorDoors ?? []) {
        if (d.axis === 'u') { doorTiles.add(`${d.u - 1},${d.v}`); doorTiles.add(`${d.u},${d.v}`); doorTiles.add(`${d.u - 1},${d.v + 1}`); doorTiles.add(`${d.u},${d.v + 1}`) }
        else { doorTiles.add(`${d.u},${d.v - 1}`); doorTiles.add(`${d.u},${d.v}`); doorTiles.add(`${d.u + 1},${d.v - 1}`); doorTiles.add(`${d.u + 1},${d.v}`) }
      }
      for (const ent of [...w.lobby.suites, ...w.lobby.shared, ...w.wings.flatMap((wg) => [...wg.suites, ...wg.shared])]) {
        for (const fc of ent.footprint) expect(doorTiles.has(`${fc.u},${fc.v}`), `seed=${seed} ${ent.id} blocks door`).toBe(false)
      }
      const cab = w.lobby.shared.find((e) => e.id === 'lobby-cabinet')!
      const lsh = w.lobby.shared.find((e) => e.id === 'lobby-bookshelf')!
      for (const ls of w.lightSources ?? []) if (ls.kind === 'sconce' && ls.v < w.buildingRows) {
        const hitDoor = w.interiorDoors?.some((d) => d.axis === 'u' && d.u === ls.u && ls.v > d.v - 1.25 && ls.v < d.v + 2.25)
        expect(hitDoor, `seed=${seed} sconce ${ls.id} at (${ls.u},${ls.v}) clears doors/doorplates`).toBe(false)
      }
      for (const m of w.lobby.wallMounts) expect(m.at, `seed=${seed} lobby mount ${m.id} clears lobby-cabinet`).toBeGreaterThanOrEqual(12.4)
      for (const ent of [...w.lobby.suites, cab, lsh, ...w.wings.flatMap((wg) => wg.suites)]) {
        const m = WORLD_ASSET_CATALOG[ent.assetId]!, cp = worldIsoToScreen(ent.anchor.u + ent.size[0] / 2, ent.anchor.v + ent.size[1] / 2, w, cam1)
        const footY = worldIsoToScreen(ent.anchor.u + ent.size[0], ent.anchor.v + ent.size[1], w, cam1).y
        checkBoxOcc(w, `seed=${seed}:${ent.id}`, cp.x - m.anchor[0], cp.y - m.anchor[1], m.nativeSize[0], m.nativeSize[1], ent.anchor.u, ent.anchor.v, ent.anchor.u + ent.size[0], ent.anchor.v + ent.size[1], footY)
      }
      for (const a of createInitialWorldActors(w)) {
        const p = worldIsoToScreen(a.u + 0.5, a.v + 0.5, w, cam1)
        const s = a.assignedSuiteId ? [...w.lobby.suites, ...w.wings.flatMap((wg) => wg.suites)].find((x) => x.id === a.assignedSuiteId) : undefined
        const zY = s ? worldIsoToScreen(s.anchor.u + s.size[0], s.anchor.v + s.size[1], w, cam1).y - 3 : p.y + 1
        const au = s ? s.anchor.u + 0.9 : a.u, av = s ? s.anchor.v - 0.85 : a.v
        checkBoxOcc(w, `seed=${seed}:actor:${a.id}`, p.x - 16, p.y - 44, 32, 48, au, av, au + 1, av + 1, zY)
      }
    }
    const fourWs = [...multiWs, { id: 'fourth', title: 'fourth' }]
    for (let seed = 1; seed <= 20; seed++) {
      const w4 = solveWorldFloorplan(fourWs, seed)
      for (const wg of w4.wings.filter((x) => x.kind === 'studio' && x.workspaceId)) {
        expect(wg.suites.some((s) => s.suiteKind === 'workstation'), `4ws seed=${seed} ${wg.id} ws`).toBe(true)
      }
    }
  }, 20_000)

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
    expect(actors.map((a) => a.id)).toEqual(['secretary'])

    const worker = spawnWorldWorker(world, 'worker-1', 'demo-repo', 'T-42', 'ws-demo-repo-1')
    expect(worker.u).toBe(13)
    expect(worker.v).toBe(19)
    expect(worker.path.some((p) => p.u === 16 && (p.v === 4 || p.v === 5 || p.v === 6))).toBe(true)

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
      screenStates: { 'ws-default-1': 'working', 'ws-demo-repo-1': 'stuck' },
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
    }
  })

  it('picks secretary, all 5 props (including per-wing doorplates), and wing nameplates', () => {
    const world = solveWorldFloorplan([{ id: 'default', title: 'default' }, { id: 'demo-repo', title: 'demo-repo' }])
    const actors = createInitialWorldActors(world)
    const cam = { panX: 0, panY: 0, zoom: 2 as const }
    const state: WorldSceneState = {
      world,
      actors,
      screenStates: { 'ws-default-1': 'working' },
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
    const cbPos = worldIsoToScreen(cb.at, world.lobby.rect.v, world, cam)
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
