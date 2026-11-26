/** 独立像素办公室主舞台壳：同屏多房间世界、整数缩放拖拽相机、HUD 与智能折叠底栏联动。 */
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AvatarPackSummary } from '../app/avatar-pipeline.ts'
import type { FourWayAttribution, RulingDecision, RulingItem } from '../app/ruling-queue.ts'
import type { SecretaryFeedEntry } from '../app/tools/secretary-core.ts'
import type { SettingsView } from '../app/views/settings.ts'
import type { TicketListView } from '../app/views/tickets.ts'
import { type StatusKind } from './catalog.ts'
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import { GameHud, type RoomHudStat } from './game-hud.tsx'
import { HandoverSheet } from './handover-sheet.tsx'
import type { OfficeActor, OfficeSprites } from './iso-engine.ts'
import { CANVAS_H, CANVAS_W } from './layout-solver.ts'
import { NpcDialog, resolveSecretaryMood } from './npc-dialog.tsx'
import { OFFICE_THEME, officeCall, subscribeOfficeStream } from './office-api.tsx'
import { mountPixiDioramaStage } from './pixi-diorama.ts'
import { PropsDrawer, type GovernancePropKind } from './props-drawer.tsx'
import { WorkerDrawer, type WorkerDrawerMode } from './worker-drawer.tsx'
import { cameraForGridPoint, solveWorldFloorplan } from './world-layout.ts'
import { createInitialWorldActors, pickWorldTarget, reSeatWorkerOnWorld, renderWorldFrame, spawnWorldWorker, stepWorldActors } from './world-renderer.ts'
import type { OfficeCamera, OfficeWorldPlan, WorkspaceWingSpec, WorldPickResult, WorldWingPlan } from './world-types.ts'

type TicketItem = TicketListView['items'][number]
const WORLD_CENTER = { u: 11.8, v: 9.0 } as const
const SEED_STORAGE_KEY = 'dsh_office_world_seed'
const defaultZoomFor = (w: number): 1 | 2 => (w >= 1320 ? 2 : 1)
function readInitialSeed(): number {
  try { const n = typeof localStorage !== 'undefined' ? Number.parseInt(localStorage.getItem(SEED_STORAGE_KEY) ?? '', 10) : NaN; return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 1 }
  catch (err) { console.warn('seed read fallback', err); return 1 }
}

const getInitialViewport = () => typeof window === 'undefined'
  ? { w: CANVAS_W, h: CANVAS_H }
  : { w: Math.max(640, window.innerWidth || CANVAS_W), h: Math.max(480, window.innerHeight || CANVAS_H) }
function loadSprite(url: string, onLoad: (img: HTMLImageElement) => void): void {
  if (typeof Image === 'undefined') return
  const img = new Image(); img.onload = () => onLoad(img); img.src = url
}
const resolveRoomId = (t: TicketItem, s: SettingsView | null) =>
  t.workspace || s?.blocks.workspaces.value?.find(w => w.repository && t.directory?.startsWith(w.repository))?.id || 'default'

function syncWorldActors(prev: OfficeActor[], tickets: readonly TicketItem[], world: OfficeWorldPlan, settings: SettingsView | null): OfficeActor[] {
  const residents = createInitialWorldActors(world)
  const residentIds = new Set(residents.map(r => r.id))
  const openIds = new Set(tickets.map(t => t.id))
  const keptWorkers = prev.filter(a => a.role === 'worker' && a.lifecycle !== 'removed').map(a => {
    const tk = a.ticketId ? tickets.find(t => t.id === a.ticketId) : undefined
    return reSeatWorkerOnWorld(a.ticketId && !openIds.has(a.ticketId) && a.lifecycle !== 'leaving' ? { ...a, lifecycle: 'leaving' as const } : a, world, tk ? resolveRoomId(tk, settings) : undefined)
  })
  const mergedResidents = residents.map(r => { const ex = prev.find(p => p.id === r.id && residentIds.has(p.id)); return ex ? { ...r, animMs: ex.animMs } : r })
  const usedSuites = new Set(keptWorkers.filter(a => a.lifecycle !== 'leaving').map(a => a.assignedSuiteId))
  const activeIds = new Set(keptWorkers.filter(a => a.lifecycle !== 'leaving').map(a => a.ticketId))
  const next: OfficeActor[] = [...mergedResidents, ...keptWorkers]
  for (const ticket of tickets) {
    if (activeIds.has(ticket.id)) continue
    const roomId = resolveRoomId(ticket, settings)
    const wing = world.wings.find(w => w.workspaceId === roomId) ?? world.wings[0]
    const suites = wing ? wing.suites.filter(s => s.suiteKind === 'workstation').map(s => s.id) : [`ws-${roomId}-1`, `ws-${roomId}-2`, `ws-${roomId}-3`]
    const suite = suites.find(s => !usedSuites.has(s))
    if (!suite) continue
    usedSuites.add(suite)
    next.push(spawnWorldWorker(world, `worker-${ticket.id}`, roomId, ticket.id, suite))
  }
  return next
}

export function StageApp() {
  const [viewport, setViewport] = useState(getInitialViewport)
  const [workspaceId, setWorkspaceId] = useState('default')
  const [worldSeed, setWorldSeed] = useState(readInitialSeed)
  const [camera, setCamera] = useState<OfficeCamera>(() => { const vp = getInitialViewport(); return cameraForGridPoint(WORLD_CENTER, solveWorldFloorplan([{ id: 'default', title: 'default' }], readInitialSeed()), defaultZoomFor(vp.w), vp.w, vp.h) })
  const [dialogCollapsed, setDialogCollapsed] = useState(true)
  const [feed, setFeed] = useState<SecretaryFeedEntry[]>([])
  const [activeRuling, setActiveRuling] = useState<RulingItem | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [tickets, setTickets] = useState<TicketItem[]>([])
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [avatar, setAvatar] = useState<AvatarPackSummary | null>(null)
  const [streamTick, setStreamTick] = useState(0)
  const [online, setOnline] = useState(false)
  const [gateUntil, setGateUntil] = useState(0)
  const [activeProp, setActiveProp] = useState<GovernancePropKind | null>(null)
  const [handoverEntry, setHandoverEntry] = useState<SecretaryFeedEntry | null>(null)
  const [drawerMode, setDrawerMode] = useState<WorkerDrawerMode>(null)
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  const [hoverTarget, setHoverTarget] = useState<WorldPickResult | null>(null)
  const [pendingBoss, setPendingBoss] = useState<{ text: string; sentAt: number; baseSayId?: string } | null>(null)
  const [actorSnap, setActorSnap] = useState<OfficeActor[]>([])

  const canvasRef = useRef<HTMLCanvasElement | null>(null), inputRef = useRef<HTMLInputElement | null>(null)
  const lastGateSeqRef = useRef(0), gateTicketRef = useRef<string | undefined>(undefined), prevSayIdRef = useRef<string | undefined>(undefined)
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number; moved: boolean } | null>(null)
  const suppressClickRef = useRef(false), spritesRef = useRef<OfficeSprites>({ images: {} })

  const workspaces = useMemo<WorkspaceWingSpec[]>(() => [
    { id: 'default', title: 'default', repository: settings?.environment.root },
    ...(settings?.blocks.workspaces.value ?? []).map(w => ({ id: w.id, title: w.id, repository: w.repository })),
  ], [settings])
  const world = useMemo(() => solveWorldFloorplan(workspaces, worldSeed), [workspaces, worldSeed])
  const actorsRef = useRef<OfficeActor[]>(createInitialWorldActors(world))

  const roomTickets = useMemo(() => tickets.filter(t => resolveRoomId(t, settings) === workspaceId), [tickets, workspaceId, settings])
  const roomStats = useMemo(() => {
    const out: Record<string, RoomHudStat> = {}
    for (const wing of world.wings) {
      if (!wing.workspaceId) continue
      const list = tickets.filter(t => resolveRoomId(t, settings) === wing.workspaceId)
      const status: StatusKind | 'idle' = list.some(t => t.stage === 'person') ? 'needsDecision' : list.some(t => t.stage === 'working') ? 'working' : list.length > 0 ? 'done' : 'idle'
      out[wing.workspaceId] = { count: list.length, status }
    }
    return out
  }, [world, tickets, settings])

  useEffect(() => { const synced = syncWorldActors(actorsRef.current, tickets, world, settings); actorsRef.current = synced; setActorSnap(synced) }, [tickets, world, settings])

  const refreshAll = useCallback(async () => {
    try {
      const [feedRes, ticketRes, settingsRes, avatarRes, spineRes] = await Promise.all([
        officeCall('GET secretary/feed'), officeCall('GET tickets', { query: { state: 'open', limit: 20 } }),
        officeCall('GET settings'), officeCall('GET avatars'),
        officeCall('GET projection/spine', { query: { type: 'gate.evaluated', limit: 10, tail: '1', ...(lastGateSeqRef.current > 0 ? { sinceSeq: lastGateSeqRef.current } : {}) } }),
      ])
      setFeed(feedRes.items); setActiveRuling(feedRes.activeRuling); setPendingCount(feedRes.pendingCount)
      setTickets(ticketRes.items); setSettings(settingsRes)
      setAvatar(avatarRes.items.find(i => i.id === avatarRes.activeId) ?? avatarRes.items[0] ?? null)
      const latestDeny = [...spineRes.items].reverse().find(ev => {
        if (ev.seq <= lastGateSeqRef.current) return false
        const v = (ev.payload as Record<string, unknown> | undefined)?.verdict
        const kind = typeof v === 'string' ? v : (v as { kind?: unknown } | undefined)?.kind
        return (kind === 'deny' || kind === 'unmeasured') && Date.now() - Date.parse(ev.at) < 15_000
      })
      if (latestDeny) {
        lastGateSeqRef.current = latestDeny.seq
        const tid = (latestDeny.payload as Record<string, unknown> | undefined)?.ticketId
        gateTicketRef.current = typeof tid === 'string' ? tid : undefined
        setGateUntil(Date.now() + 8_000)
      }
      setOnline(true)
    } catch { setOnline(false) }
  }, [])

  useEffect(() => { for (const m of Object.values(WORLD_ASSET_CATALOG)) loadSprite(m.spriteUrl, img => { spritesRef.current.images[m.id] = img }) }, [])
  useEffect(() => { loadSprite(avatar?.spriteUrl || WORLD_ASSET_CATALOG.char_secretary!.spriteUrl, img => { spritesRef.current.images.char_secretary = img }) }, [avatar?.spriteUrl])

  useEffect(() => {
    void refreshAll()
    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    const unsub = subscribeOfficeStream(() => {
      setOnline(true); setStreamTick(t => t + 1)
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => { void refreshAll() }, 120)
    })
    const timer = setInterval(() => { void refreshAll() }, 8000)
    return () => { unsub(); clearInterval(timer); if (debounceTimer) clearTimeout(debounceTimer) }
  }, [refreshAll])

  const screenStates = useMemo(() => {
    const out: Record<string, StatusKind | 'off'> = {}
    for (const wing of world.wings) {
      if (!wing.workspaceId) continue
      const roomList = tickets.filter(t => resolveRoomId(t, settings) === wing.workspaceId)
      out[`exec-${wing.workspaceId}`] = activeRuling && wing.workspaceId === workspaceId ? 'needsDecision' : roomList.some(t => t.stage === 'working') ? 'working' : 'off'
    }
    for (const actor of actorSnap) {
      if (actor.role !== 'worker' || !actor.assignedSuiteId || actor.lifecycle === 'leaving') continue
      const ticket = actor.ticketId ? tickets.find(t => t.id === actor.ticketId) : undefined
      out[actor.assignedSuiteId] = !ticket ? 'off' : ticket.stage === 'person' ? 'needsDecision' : ticket.stage === 'working' ? 'working' : 'done'
    }
    return out
  }, [activeRuling, tickets, world, settings, workspaceId, actorSnap])

  const gateBlocked = gateUntil > Date.now()
  const latestSayId = useMemo(() => [...feed].reverse().find(e => e.role === 'secretary')?.id, [feed])
  const latestEntry = feed[feed.length - 1]
  const secretaryThinking = Boolean(pendingBoss) || Boolean(latestEntry?.role === 'boss' && !activeRuling && Date.now() - Date.parse(latestEntry.at) < 45_000)
  const effectiveCollapsed = dialogCollapsed && !activeRuling && !gateBlocked && !secretaryThinking
  const secretaryMood = resolveSecretaryMood(activeRuling, gateBlocked, tickets.some(t => t.stage === 'working'), feed, secretaryThinking)
  const secretaryPortraitSrc = avatar?.portraitUrls[secretaryMood] ?? `/assets/f1-proof/portrait_${secretaryMood}.png`

  useEffect(() => { if (activeRuling || gateBlocked || secretaryThinking) setDialogCollapsed(false) }, [activeRuling, gateBlocked, secretaryThinking])
  useEffect(() => { if (prevSayIdRef.current && latestSayId && prevSayIdRef.current !== latestSayId) setDialogCollapsed(false); prevSayIdRef.current = latestSayId }, [latestSayId])
  useEffect(() => {
    if (!pendingBoss) return
    if (activeRuling || (latestSayId && latestSayId !== pendingBoss.baseSayId)) { setPendingBoss(null); return }
    const timer = setTimeout(() => setPendingBoss(null), Math.max(0, 45_000 - (Date.now() - pendingBoss.sentAt)))
    return () => clearTimeout(timer)
  }, [pendingBoss, activeRuling, latestSayId])
  useEffect(() => { if (!secretaryThinking) return; const fast = setInterval(() => { void refreshAll() }, 1200); return () => clearInterval(fast) }, [secretaryThinking, refreshAll])
  const pixiHandleRef = useRef<{ resize: (w: number, h: number) => void; destroy: () => void } | null>(null)
  useEffect(() => {
    const syncVp = () => {
      const el = canvasRef.current?.parentElement
      const vp = el && el.clientWidth > 0 && el.clientHeight > 0 ? { w: Math.max(640, el.clientWidth), h: Math.max(480, el.clientHeight) } : getInitialViewport()
      setViewport(vp); pixiHandleRef.current?.resize(vp.w, vp.h)
      setCamera(cameraForGridPoint(WORLD_CENTER, world, defaultZoomFor(vp.w), vp.w, vp.h))
    }
    const ro = typeof ResizeObserver !== 'undefined' && canvasRef.current?.parentElement ? new ResizeObserver(syncVp) : null
    if (ro && canvasRef.current?.parentElement) ro.observe(canvasRef.current.parentElement)
    window.addEventListener('resize', syncVp)
    return () => { ro?.disconnect(); window.removeEventListener('resize', syncVp) }
  }, [world])

  const liveRef = useRef({ world, screenStates, workspaceId, hoverTarget, gateUntil, secretaryThinking, camera, viewport })
  liveRef.current = { world, screenStates, workspaceId, hoverTarget, gateUntil, secretaryThinking, camera, viewport }
  const usePixiWebGL = typeof WebGLRenderingContext !== 'undefined'
  const buildFrameState = (dt: number, elapsed: number) => {
    const s = liveRef.current
    actorsRef.current = stepWorldActors(actorsRef.current, s.world, dt)
    const gateId = actorsRef.current.find(a => a.ticketId && a.ticketId === gateTicketRef.current)?.id
      ?? actorsRef.current.find(a => a.id === `lead-${s.workspaceId}`)?.id ?? actorsRef.current.find(a => a.role === 'lead')?.id ?? 'secretary'
    return {
      camera: s.camera, viewport: s.viewport, images: spritesRef.current.images,
      scene: {
        world: s.world, actors: actorsRef.current, screenStates: s.screenStates, activeWorkspaceId: s.workspaceId,
        hoverTarget: s.hoverTarget, secretaryThinking: s.secretaryThinking, elapsedMs: elapsed,
        ...(s.gateUntil > Date.now() ? { gateIntercept: { targetActorId: gateId, frame: Math.floor(elapsed / 200) % 3 } } : {}),
      },
    }
  }

  useEffect(() => {
    if (!usePixiWebGL || !canvasRef.current) return
    let last = performance.now(), elapsed = 0
    const handle = mountPixiDioramaStage(canvasRef.current, () => {
      const now = performance.now(), dt = Math.min(100, Math.max(0, now - last)); last = now; elapsed += dt
      return buildFrameState(dt, elapsed)
    }, liveRef.current.viewport.w, liveRef.current.viewport.h)
    pixiHandleRef.current = handle
    handle.resize(liveRef.current.viewport.w, liveRef.current.viewport.h)
    return () => { pixiHandleRef.current = null; handle.destroy() }
  }, [usePixiWebGL])

  useEffect(() => {
    if (usePixiWebGL || !canvasRef.current) return
    let raf = 0, last = performance.now(), elapsed = 0
    const tick = (now: number) => {
      const dt = Math.min(100, Math.max(0, now - last)); last = now; elapsed += dt
      const ctx = canvasRef.current?.getContext('2d'), f = buildFrameState(dt, elapsed)
      if (ctx) { ctx.clearRect(0, 0, f.viewport.w, f.viewport.h); renderWorldFrame(ctx, f.scene, spritesRef.current, f.camera) }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [usePixiWebGL])

  const toCanvasCoords = (clientX: number, clientY: number) => {
    const r = canvasRef.current?.getBoundingClientRect(), sx = r?.width ? viewport.w / r.width : 1, sy = r?.height ? viewport.h / r.height : 1
    return { x: (clientX - (r?.left ?? 0)) * sx, y: (clientY - (r?.top ?? 0)) * sy, scaleX: sx, scaleY: sy }
  }
  const focusWing = (wing: WorldWingPlan) => { if (wing.workspaceId) setWorkspaceId(wing.workspaceId); setCamera(c => cameraForGridPoint(wing.focusPoint, world, c.zoom, viewport.w, viewport.h)) }
  const handleCanvasClick = (clientX: number, clientY: number) => {
    const { x, y } = toCanvasCoords(clientX, clientY)
    const hit = pickWorldTarget(x, y, { world, actors: actorsRef.current, screenStates, activeWorkspaceId: workspaceId, elapsedMs: 0 }, camera)
    if (!hit) return
    if (hit.type === 'prop') { if (hit.workspaceId) setWorkspaceId(hit.workspaceId); if (hit.prop === 'doorplate') setDrawerMode('doorplate'); else setActiveProp(hit.prop) }
    else if (hit.type === 'wing') { const w = world.wings.find(x => x.id === hit.wingId); if (w) focusWing(w); else if (hit.workspaceId) setWorkspaceId(hit.workspaceId) }
    else if (hit.role === 'secretary') { setDialogCollapsed(false); setTimeout(() => inputRef.current?.focus(), 0) }
    else if (hit.workspaceId && hit.workspaceId !== workspaceId) { const w = world.wings.find(x => x.workspaceId === hit.workspaceId); if (w) focusWing(w); else setWorkspaceId(hit.workspaceId) }
    else { setSelectedTicketId(hit.ticketId ?? roomTickets[0]?.id ?? null); setDrawerMode('worker') }
  }
  const handleMouseMove = (e: MouseEvent<HTMLCanvasElement>) => {
    const { x, y, scaleX, scaleY } = toCanvasCoords(e.clientX, e.clientY)
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX, dy = e.clientY - dragRef.current.startY
      if (!dragRef.current.moved && Math.hypot(dx, dy) >= 5) { dragRef.current.moved = true; if (!activeRuling && !gateBlocked && !secretaryThinking) setDialogCollapsed(true) }
      if (dragRef.current.moved) setCamera(c => ({ ...c, panX: Math.round(dragRef.current!.panX + dx * scaleX), panY: Math.round(dragRef.current!.panY + dy * scaleY) }))
      return
    }
    setHoverTarget(pickWorldTarget(x, y, { world, actors: actorsRef.current, screenStates, activeWorkspaceId: workspaceId, elapsedMs: 0 }, camera))
  }
  const handleSendMessage = async (text: string) => {
    setDialogCollapsed(false); setPendingBoss({ text, sentAt: Date.now(), baseSayId: latestSayId })
    try { await officeCall('POST secretary/messages', { body: { text } }); await refreshAll() } catch (err) { setPendingBoss(null); throw err }
  }
  const handleDecideRuling = async (input: { id: string; decision: RulingDecision; optionId?: string; attribution?: FourWayAttribution; note?: string; captureAsRule?: boolean }) => {
    const { id, ...body } = input; await officeCall('POST rulings/:id/decide', { id, body }); await refreshAll()
  }

  const resetCam = () => setCamera(cameraForGridPoint(WORLD_CENTER, world, defaultZoomFor(viewport.w), viewport.w, viewport.h))
  const rerollSeed = () => {
    const next = (worldSeed % 16) + 1; setWorldSeed(next)
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(SEED_STORAGE_KEY, String(next)) } catch (err) { console.warn('seed persist skipped', err) }
    setCamera(c => cameraForGridPoint(WORLD_CENTER, solveWorldFloorplan(workspaces, next), c.zoom, viewport.w, viewport.h))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', background: OFFICE_THEME.bgDeep, color: OFFICE_THEME.inkCream, overflow: 'hidden' }}>
      <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
        <GameHud online={online} activeWorkspaceId={workspaceId} world={world} actors={actorSnap.length > 0 ? actorSnap : actorsRef.current} roomStats={roomStats}
          workingCount={tickets.filter(t => t.stage === 'working').length} camera={camera} dialogCollapsed={effectiveCollapsed}
          secretaryMood={secretaryMood} secretaryPortraitSrc={secretaryPortraitSrc} gateBlocked={gateBlocked} seed={worldSeed} onRerollSeed={rerollSeed}
          onOpenProp={p => { if (p === 'doorplate') setDrawerMode('doorplate'); else setActiveProp(p) }}
          onZoomChange={zoom => setCamera(cameraForGridPoint(WORLD_CENTER, world, zoom, viewport.w, viewport.h))}
          onResetCamera={resetCam}
          onFocusLobby={() => { setCamera(c => cameraForGridPoint(world.lobby.focusPoint, world, c.zoom, viewport.w, viewport.h)); setDialogCollapsed(false) }}
          onSelectWing={focusWing}
          onOpenRoomDrawer={roomId => { setWorkspaceId(roomId); setSelectedTicketId(tickets.find(t => resolveRoomId(t, settings) === roomId)?.id ?? null); setDrawerMode('worker') }} />
        <canvas ref={canvasRef} width={usePixiWebGL ? undefined : viewport.w} height={usePixiWebGL ? undefined : viewport.h} aria-label="像素办公室主舞台"
          onMouseDown={e => { dragRef.current = { startX: e.clientX, startY: e.clientY, panX: camera.panX, panY: camera.panY, moved: false } }}
          onMouseMove={handleMouseMove}
          onMouseUp={() => { if (dragRef.current?.moved) suppressClickRef.current = true; dragRef.current = null }}
          onMouseLeave={() => { dragRef.current = null; setHoverTarget(null) }}
          onClick={e => { if (suppressClickRef.current) { suppressClickRef.current = false; return } handleCanvasClick(e.clientX, e.clientY) }}
          style={{ width: '100%', height: '100%', display: 'block', imageRendering: 'pixelated', cursor: hoverTarget ? 'pointer' : 'grab' }} />
        <NpcDialog feed={feed} activeRuling={activeRuling} pendingCount={pendingCount} avatar={avatar}
          hasWorkingTickets={tickets.some(t => t.stage === 'working')} gateBlocked={gateBlocked}
          secretaryThinking={secretaryThinking} collapsed={dialogCollapsed}
          pendingBossText={pendingBoss?.text ?? (latestEntry?.role === 'boss' ? latestEntry.text : null)} inputRef={inputRef}
          onSendMessage={handleSendMessage} onDecideRuling={handleDecideRuling} onOpenHandover={entry => setHandoverEntry(entry)}
          onExpand={() => setDialogCollapsed(false)} onCollapse={() => setDialogCollapsed(true)} />
      </div>
      <PropsDrawer activeProp={activeProp} onClose={() => setActiveProp(null)} onChanged={() => { void refreshAll() }} />
      <HandoverSheet entry={handoverEntry} onClose={() => setHandoverEntry(null)} />
      <WorkerDrawer mode={drawerMode} workspaceId={workspaceId} settings={settings} tickets={roomTickets} allTickets={tickets}
        selectedTicketId={selectedTicketId} streamTick={streamTick}
        onSelectWorkspace={id => { setWorkspaceId(id); const w = world.wings.find(x => x.workspaceId === id); if (w) setCamera(c => cameraForGridPoint(w.focusPoint, world, c.zoom, viewport.w, viewport.h)) }}
        onSelectTicket={id => setSelectedTicketId(id)} onChanged={() => { void refreshAll() }} onClose={() => setDrawerMode(null)} />
    </div>
  )
}
