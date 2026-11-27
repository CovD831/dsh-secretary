/** 独立像素办公室主舞台壳：同屏多房间世界、整数缩放拖拽相机、HUD 与智能折叠底栏联动。 */
import { type MouseEvent, type WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AvatarPackSummary } from '../app/avatar-pipeline.ts'
import type { FourWayAttribution, RulingDecision, RulingItem } from '../app/ruling-queue.ts'
import type { SecretaryFeedEntry } from '../app/tools/secretary-core.ts'
import type { SettingsView } from '../app/views/settings.ts'
import type { TicketListView } from '../app/views/tickets.ts'
import { type StatusKind } from './catalog.ts'
import { WORLD_ASSET_CATALOG } from './diorama-catalog.ts'
import { stepCameraTowards } from './diorama-polish.ts'
import { type FloorSlotEntry, SEED_STORAGE_KEY, SLOT_STORAGE_KEY, readInitialSeed, readSlotRegistry, reconcileSlotRegistry } from './floor-slots.ts'
import { GameHud, type RoomHudStat } from './game-hud.tsx'
import { HandoverSheet } from './handover-sheet.tsx'
import type { OfficeActor, OfficeSprites } from './iso-engine.ts'
import { CANVAS_H, CANVAS_W } from './layout-solver.ts'
import { NpcDialog, resolveSecretaryMood } from './npc-dialog.tsx'
import { OFFICE_THEME, officeCall, subscribeOfficeStream } from './office-api.tsx'
import { mountPixiDioramaStage } from './pixi-diorama.ts'
import { PropsDrawer, type GovernancePropKind } from './props-drawer.tsx'
import { assignRoomTicketsToSeats } from './seat-slots.ts'
import { PixelUiStyles } from './ui-skin.tsx'
import { useStageHotkeys } from './stage-hotkeys.ts'
import { WorkerDrawer, type WorkerDrawerMode } from './worker-drawer.tsx'
import { cameraForGridPoint, cameraForWorldFit, solveWorldFloorplan } from './world-layout.ts'
import { createInitialWorldActors, pickWorldTarget, reSeatWorkerOnWorld, renderWorldFrame, screenToWorldIso, seatWorldWorker, spawnWorldWorker, stepWorldActors } from './world-renderer.ts'
import type { OfficeCamera, OfficeWorldPlan, WorkspaceWingSpec, WorldPickResult, WorldWingPlan } from './world-types.ts'

type TicketItem = TicketListView['items'][number]
const getInitialViewport = () => typeof window === 'undefined' ? { w: CANVAS_W, h: CANVAS_H } : { w: Math.max(640, window.innerWidth || CANVAS_W), h: Math.max(480, window.innerHeight || CANVAS_H) }
function loadSprite(url: string, onLoad: (img: HTMLImageElement) => void): void { if (typeof Image === 'undefined') return; const img = new Image(); img.onload = () => onLoad(img); img.src = url }
const resolveRoomId = (t: TicketItem, s: SettingsView | null) => t.workspace || s?.blocks.workspaces.value?.find(w => w.repository && t.directory?.startsWith(w.repository))?.id || 'default'

function syncWorldActors(
  prev: OfficeActor[], world: OfficeWorldPlan, assignments: ReadonlyMap<string, { roomId: string; seatId: string }>, immediate = false,
): OfficeActor[] {
  const residents = createInitialWorldActors(world), residentIds = new Set(residents.map(r => r.id))
  const kept = prev.filter(a => a.role === 'worker' && a.lifecycle !== 'removed').flatMap(a => {
    const target = a.ticketId ? assignments.get(a.ticketId) : undefined
    if (target && !world.wings.some(w => w.workspaceId === target.roomId && !w.vacant)) return []
    const next = target
      ? reSeatWorkerOnWorld(a.lifecycle === 'leaving' ? { ...a, lifecycle: 'working' as const, assignedSuiteId: target.seatId } : { ...a, assignedSuiteId: target.seatId }, world, target.roomId)
      : reSeatWorkerOnWorld(a.lifecycle !== 'leaving' ? { ...a, lifecycle: 'leaving' as const } : a, world)
    return [next]
  })
  const merged = residents.map(r => { const ex = prev.find(p => p.id === r.id && residentIds.has(p.id)); return ex ? { ...r, animMs: ex.animMs } : r })
  const active = new Set(kept.filter(a => a.lifecycle !== 'leaving').map(a => a.ticketId))
  const spawned: OfficeActor[] = []
  for (const [ticketId, target] of assignments) {
    if (active.has(ticketId)) continue
    spawned.push((immediate ? seatWorldWorker : spawnWorldWorker)(world, `worker-${ticketId}`, target.roomId, ticketId, target.seatId))
  }
  return [...merged, ...kept, ...spawned]
}

export function StageApp() {
  const [viewport, setViewport] = useState(getInitialViewport)
  const [workspaceId, setWorkspaceId] = useState('default')
  const [worldSeed, setWorldSeed] = useState(readInitialSeed), [slotRegistry, setSlotRegistry] = useState<FloorSlotEntry[]>(readSlotRegistry)
  const [camera, setCamera] = useState<OfficeCamera>(() => { const vp = getInitialViewport(); return cameraForWorldFit(solveWorldFloorplan([{ id: 'default', title: 'default' }], readInitialSeed(), { slotEntries: readSlotRegistry() }), vp.w, vp.h) })
  const [dialogCollapsed, setDialogCollapsed] = useState(true), [feed, setFeed] = useState<SecretaryFeedEntry[]>([])
  const [activeRuling, setActiveRuling] = useState<RulingItem | null>(null), [pendingCount, setPendingCount] = useState(0)
  const [tickets, setTickets] = useState<TicketItem[]>([]), [settings, setSettings] = useState<SettingsView | null>(null)
  const [avatar, setAvatar] = useState<AvatarPackSummary | null>(null), [streamTick, setStreamTick] = useState(0), [online, setOnline] = useState(false), [spriteVer, setSpriteVer] = useState(0)
  const [gateUntil, setGateUntil] = useState(0), [activeProp, setActiveProp] = useState<GovernancePropKind | null>(null)
  const [handoverEntry, setHandoverEntry] = useState<SecretaryFeedEntry | null>(null), [drawerMode, setDrawerMode] = useState<WorkerDrawerMode>(null)
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null), [hoverTarget, setHoverTarget] = useState<WorldPickResult | null>(null)
  const [pendingBoss, setPendingBoss] = useState<{ text: string; sentAt: number; baseSayId?: string } | null>(null), [actorSnap, setActorSnap] = useState<OfficeActor[]>([])

  const canvasRef = useRef<HTMLCanvasElement | null>(null), inputRef = useRef<HTMLInputElement | null>(null)
  const lastGateSeqRef = useRef(0), gateTicketRef = useRef<string | undefined>(undefined), prevSayIdRef = useRef<string | undefined>(undefined), hydratedRef = useRef(false)
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number; moved: boolean } | null>(null)
  const suppressClickRef = useRef(false), spritesRef = useRef<OfficeSprites>({ images: {} })

  const workspaces = useMemo<WorkspaceWingSpec[]>(() => [
    { id: 'default', title: 'default', repository: settings?.environment.root },
    ...(settings?.blocks.workspaces.value ?? []).map(w => ({ id: w.id, title: w.id, repository: w.repository })),
  ], [settings])
  const syncedSlots = useMemo(() => (settings || slotRegistry.length === 0) ? reconcileSlotRegistry(slotRegistry, workspaces, worldSeed) : slotRegistry, [settings, slotRegistry, workspaces, worldSeed])
  useEffect(() => {
    if (!settings || JSON.stringify(syncedSlots) === JSON.stringify(slotRegistry)) return
    setSlotRegistry(syncedSlots)
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(SLOT_STORAGE_KEY, JSON.stringify(syncedSlots)) } catch {}
  }, [settings, syncedSlots, slotRegistry])
  const world = useMemo(() => solveWorldFloorplan(workspaces, worldSeed, { slotEntries: syncedSlots }), [workspaces, worldSeed, syncedSlots])
  const actorsRef = useRef<OfficeActor[]>(createInitialWorldActors(world)), renderCamRef = useRef<OfficeCamera>(camera)
  const seatPlan = useMemo(() => assignRoomTicketsToSeats(tickets, world, t => resolveRoomId(t, settings)), [tickets, world, settings])
  const subagentTotal = useMemo(() => tickets.reduce((sum, t) => sum + (t.subagents?.length ?? 0), 0), [tickets])

  const roomTickets = useMemo(() => tickets.filter(t => resolveRoomId(t, settings) === workspaceId), [tickets, workspaceId, settings])
  const roomStats = useMemo(() => Object.fromEntries(workspaces.map(ws => {
    const list = tickets.filter(t => resolveRoomId(t, settings) === ws.id)
    const status: StatusKind | 'idle' = list.some(t => t.stage === 'person') ? 'needsDecision' : list.some(t => t.stage === 'working') ? 'working' : list.length > 0 ? 'done' : 'idle'
    return [ws.id, { count: list.length, status }]
  })) as Record<string, RoomHudStat>, [workspaces, tickets, settings])

  useEffect(() => { const imm = !hydratedRef.current && tickets.length > 0; if (tickets.length > 0) hydratedRef.current = true; const synced = syncWorldActors(actorsRef.current, world, seatPlan.assignments, imm); actorsRef.current = synced; setActorSnap(synced) }, [tickets, world, seatPlan])

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
        const v = (ev.payload as Record<string, unknown> | undefined)?.verdict, kind = typeof v === 'string' ? v : (v as { kind?: unknown } | undefined)?.kind
        return ev.seq > lastGateSeqRef.current && (kind === 'deny' || kind === 'unmeasured') && Date.now() - Date.parse(ev.at) < 15_000
      })
      if (latestDeny) {
        lastGateSeqRef.current = latestDeny.seq; const tid = (latestDeny.payload as Record<string, unknown> | undefined)?.ticketId
        gateTicketRef.current = typeof tid === 'string' ? tid : undefined; setGateUntil(Date.now() + 8_000)
      }
      setOnline(true)
    } catch { setOnline(false) }
  }, [])

  useEffect(() => { for (const m of Object.values(WORLD_ASSET_CATALOG)) loadSprite(m.spriteUrl, img => { spritesRef.current.images[m.id] = img; if (m.id === 'char_worker' || m.id === 'char_lead') setSpriteVer(v => v + 1) }) }, [])
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

  const { screenStates, subagentCounts } = useMemo(() => {
    const out: Record<string, StatusKind | 'off'> = {}, subs: Record<string, number> = {}
    const statusOf = (t: TicketItem): StatusKind => t.stage === 'person' ? (t.action === 'blocked' || t.action === 'failed' ? 'stuck' : 'needsDecision') : t.stage === 'working' ? 'working' : 'done'
    for (const wing of world.wings) {
      if (!wing.workspaceId) continue
      const roomList = tickets.filter(t => resolveRoomId(t, settings) === wing.workspaceId)
      const primaryId = wing.suites[0]?.id
      if (primaryId) out[primaryId] = (activeRuling && wing.workspaceId === workspaceId) || roomList.some(t => statusOf(t) === 'needsDecision') ? 'needsDecision' : roomList.some(t => statusOf(t) === 'stuck') ? 'stuck' : roomList.some(t => statusOf(t) === 'working') ? 'working' : roomList.length > 0 ? 'done' : 'off'
    }
    for (const actor of actorSnap) {
      if (actor.role !== 'worker' || !actor.assignedSuiteId || actor.lifecycle === 'leaving') continue
      const ticket = actor.ticketId ? tickets.find(t => t.id === actor.ticketId) : undefined
      out[actor.assignedSuiteId] = !ticket ? 'off' : statusOf(ticket)
      if (ticket?.subagents?.length) subs[actor.assignedSuiteId] = ticket.subagents.length
    }
    return { screenStates: out, subagentCounts: subs }
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
      const nc = cameraForWorldFit(world, vp.w, vp.h)
      renderCamRef.current = nc; setCamera(nc)
    }
    const ro = typeof ResizeObserver !== 'undefined' && canvasRef.current?.parentElement ? new ResizeObserver(syncVp) : null
    if (ro && canvasRef.current?.parentElement) ro.observe(canvasRef.current.parentElement)
    window.addEventListener('resize', syncVp)
    return () => { ro?.disconnect(); window.removeEventListener('resize', syncVp) }
  }, [world])

  const liveRef = useRef({ world, screenStates, subagentCounts, roomOverflows: seatPlan.roomOverflows, workspaceId, hoverTarget, gateUntil, secretaryThinking, camera, viewport })
  liveRef.current = { world, screenStates, subagentCounts, roomOverflows: seatPlan.roomOverflows, workspaceId, hoverTarget, gateUntil, secretaryThinking, camera, viewport }
  const usePixiWebGL = typeof WebGLRenderingContext !== 'undefined'
  const buildFrameState = (dt: number, elapsed: number) => {
    const s = liveRef.current; actorsRef.current = stepWorldActors(actorsRef.current, s.world, dt); renderCamRef.current = stepCameraTowards(renderCamRef.current, s.camera, dt)
    const gateId = actorsRef.current.find(a => a.ticketId && a.ticketId === gateTicketRef.current)?.id ?? 'secretary'
    return {
      camera: renderCamRef.current, viewport: s.viewport, images: spritesRef.current.images,
      scene: { world: s.world, actors: actorsRef.current, screenStates: s.screenStates, subagentCounts: s.subagentCounts, roomOverflows: s.roomOverflows, activeWorkspaceId: s.workspaceId, hoverTarget: s.hoverTarget, secretaryThinking: s.secretaryThinking, elapsedMs: elapsed, ...(s.gateUntil > Date.now() ? { gateIntercept: { targetActorId: gateId, frame: Math.floor(elapsed / 200) % 3 } } : {}) },
    }
  }

  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return
    let last = performance.now(), elapsed = 0, raf = 0
    const next = (now: number) => { const dt = Math.min(100, Math.max(0, now - last)); last = now; elapsed += dt; return buildFrameState(dt, elapsed) }
    if (usePixiWebGL) {
      const handle = mountPixiDioramaStage(cv, () => next(performance.now()), liveRef.current.viewport.w, liveRef.current.viewport.h)
      pixiHandleRef.current = handle; handle.resize(liveRef.current.viewport.w, liveRef.current.viewport.h)
      return () => { pixiHandleRef.current = null; handle.destroy() }
    }
    const tick = (now: number) => {
      const ctx = cv.getContext('2d'), f = next(now)
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
  const selectWorkspace = (id: string) => { setWorkspaceId(id); const w = world.wings.find(x => x.workspaceId === id); if (w) setCamera(c => cameraForGridPoint(w.focusPoint, world, c.zoom, viewport.w, viewport.h)) }
  const zoomTo = (nz: 1 | 2) => {
    if (nz === 1) { setCamera(cameraForWorldFit(world, viewport.w, viewport.h)); return }
    const c = screenToWorldIso(viewport.w / 2, viewport.h / 2, world, renderCamRef.current)
    const pt = c.u >= 0 && c.v >= 0 && c.u < world.buildingCols && c.v < world.buildingRows ? { u: c.u + 0.5, v: c.v + 0.5 } : { u: world.buildingCols / 2, v: world.buildingRows / 2 }
    setCamera(cameraForGridPoint(pt, world, nz, viewport.w, viewport.h))
  }
  const handleCanvasClick = (clientX: number, clientY: number) => {
    const { x, y } = toCanvasCoords(clientX, clientY), hit = pickWorldTarget(x, y, { world, actors: actorsRef.current, screenStates, activeWorkspaceId: workspaceId, elapsedMs: 0 }, renderCamRef.current)
    if (!hit) {
      if (!effectiveCollapsed) { setDialogCollapsed(true); return }
      const cell = screenToWorldIso(x, y, world, renderCamRef.current), rw = world.wings.find(w => w.kind === 'studio' && w.workspaceId && w.cells?.some(c => c.u === cell.u && c.v === cell.v))
      if (rw) focusWing(rw); return
    }
    if (hit.type === 'prop') { if (hit.workspaceId) setWorkspaceId(hit.workspaceId); if (hit.prop === 'doorplate') setDrawerMode('doorplate'); else setActiveProp(hit.prop) }
    else if (hit.type === 'wing') { const w = world.wings.find(item => item.id === hit.wingId); if (w) focusWing(w); else if (hit.workspaceId) setWorkspaceId(hit.workspaceId) }
    else if (hit.role === 'secretary') { setDialogCollapsed(false); setTimeout(() => inputRef.current?.focus(), 0) }
    else {
      const room = hit.workspaceId ?? workspaceId, w = world.wings.find(item => item.workspaceId === room)
      if (w) focusWing(w); else if (hit.workspaceId) setWorkspaceId(hit.workspaceId)
      setSelectedTicketId(hit.ticketId ?? tickets.find(t => resolveRoomId(t, settings) === room)?.id ?? null); setDrawerMode('worker')
    }
  }
  const handleMouseMove = (e: MouseEvent<HTMLCanvasElement>) => {
    const { x, y, scaleX, scaleY } = toCanvasCoords(e.clientX, e.clientY)
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX, dy = e.clientY - dragRef.current.startY
      if (!dragRef.current.moved && Math.hypot(dx, dy) >= 5) { dragRef.current.moved = true; if (!activeRuling && !gateBlocked && !secretaryThinking) setDialogCollapsed(true) }
      if (dragRef.current.moved) {
        const nc: OfficeCamera = { ...camera, panX: Math.round(dragRef.current.panX + dx * scaleX), panY: Math.round(dragRef.current.panY + dy * scaleY) }
        renderCamRef.current = nc; setCamera(nc)
      }
      return
    }
    setHoverTarget(pickWorldTarget(x, y, { world, actors: actorsRef.current, screenStates, activeWorkspaceId: workspaceId, elapsedMs: 0 }, renderCamRef.current))
  }
  const handleWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    if (Math.abs(e.deltaY) < 4) return
    const nz: 1 | 2 = e.deltaY < 0 ? 2 : 1; if (nz !== camera.zoom) zoomTo(nz)
  }
  const handleSendMessage = async (text: string) => {
    setDialogCollapsed(false); setPendingBoss({ text, sentAt: Date.now(), baseSayId: latestSayId })
    try { await officeCall('POST secretary/messages', { body: { text } }); await refreshAll() } catch (err) { setPendingBoss(null); throw err }
  }
  const handleDecideRuling = async (input: { id: string; decision: RulingDecision; optionId?: string; attribution?: FourWayAttribution; note?: string; captureAsRule?: boolean }) => {
    const { id, ...body } = input; await officeCall('POST rulings/:id/decide', { id, body }); await refreshAll()
  }

  const resetCam = () => setCamera(cameraForWorldFit(world, viewport.w, viewport.h))
  useStageHotkeys({ hasModal: Boolean(activeProp || drawerMode || handoverEntry), dialogCanCollapse: !dialogCollapsed && !activeRuling && !gateBlocked && !secretaryThinking, onCollapseDialog: () => setDialogCollapsed(true), onFocusInput: () => inputRef.current?.focus(), onZoom: zoomTo, onReset: resetCam, onPan: (dx, dy) => setCamera(c => ({ ...c, panX: c.panX + dx, panY: c.panY + dy })) })
  const applySeed = (raw: number) => {
    const next = Math.max(1, Math.min(999999, Math.floor(raw) || 1)); setWorldSeed(next)
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(SEED_STORAGE_KEY, String(next)) } catch (err) { console.warn('seed persist skipped', err) }
    const nw = solveWorldFloorplan(workspaces, next, { slotEntries: reconcileSlotRegistry(syncedSlots, workspaces, next) })
    setCamera(c => c.zoom <= 1.01 ? cameraForWorldFit(nw, viewport.w, viewport.h) : cameraForGridPoint({ u: nw.buildingCols / 2, v: nw.buildingRows / 2 }, nw, c.zoom, viewport.w, viewport.h))
  }
  const rerollSeed = () => { let next = 2 + Math.floor(Math.random() * 9998); if (next === worldSeed) next = (next % 9998) + 2; applySeed(next) }

  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', background: OFFICE_THEME.bgDeep, color: OFFICE_THEME.inkCream, overflow: 'hidden' }}>
      <PixelUiStyles />
      <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
        <GameHud online={online} activeWorkspaceId={workspaceId} world={world} actors={actorSnap.length > 0 ? actorSnap : actorsRef.current} roomStats={roomStats} screenStates={screenStates}
          workingCount={tickets.filter(t => t.stage === 'working').length} subagentTotal={subagentTotal} camera={camera} dialogCollapsed={effectiveCollapsed} viewport={viewport}
          secretaryMood={secretaryMood} secretaryPortraitSrc={secretaryPortraitSrc} gateBlocked={gateBlocked} seed={worldSeed} allWorkspaces={workspaces} spriteImages={spritesRef.current.images} spriteVersion={spriteVer}
          onSelectWorkspace={selectWorkspace} onSetSeed={applySeed} onRerollSeed={rerollSeed} onOpenProp={p => { if (p === 'doorplate') setDrawerMode('doorplate'); else setActiveProp(p) }}
          onZoomChange={zoomTo} onResetCamera={resetCam}
          onFocusLobby={() => { setCamera(c => cameraForGridPoint(world.lobby.focusPoint, world, c.zoom, viewport.w, viewport.h)); setDialogCollapsed(false) }}
          onSelectWing={focusWing} onOpenRoomDrawer={roomId => { selectWorkspace(roomId); setSelectedTicketId(tickets.find(t => resolveRoomId(t, settings) === roomId)?.id ?? null); setDrawerMode('worker') }} />
        <canvas ref={canvasRef} width={usePixiWebGL ? undefined : viewport.w} height={usePixiWebGL ? undefined : viewport.h} aria-label="像素办公室主舞台"
          onMouseDown={e => { dragRef.current = { startX: e.clientX, startY: e.clientY, panX: camera.panX, panY: camera.panY, moved: false } }} onMouseMove={handleMouseMove}
          onWheel={handleWheel} onMouseUp={() => { if (dragRef.current?.moved) suppressClickRef.current = true; dragRef.current = null }} onMouseLeave={() => { dragRef.current = null; setHoverTarget(null) }}
          onClick={e => { if (suppressClickRef.current) { suppressClickRef.current = false; return } handleCanvasClick(e.clientX, e.clientY) }}
          style={{ width: '100%', height: '100%', display: 'block', imageRendering: 'pixelated', cursor: hoverTarget ? 'pointer' : 'grab' }} />
        <NpcDialog feed={feed} activeRuling={activeRuling} pendingCount={pendingCount} avatar={avatar} hasWorkingTickets={tickets.some(t => t.stage === 'working')}
          gateBlocked={gateBlocked} secretaryThinking={secretaryThinking} collapsed={dialogCollapsed}
          pendingBossText={pendingBoss?.text ?? (latestEntry?.role === 'boss' ? latestEntry.text : null)} inputRef={inputRef} onSendMessage={handleSendMessage}
          onDecideRuling={handleDecideRuling} onOpenHandover={entry => setHandoverEntry(entry)} onExpand={() => setDialogCollapsed(false)} onCollapse={() => setDialogCollapsed(true)} />
      </div>
      <PropsDrawer activeProp={activeProp} onClose={() => setActiveProp(null)} onChanged={() => { void refreshAll() }} />
      <HandoverSheet entry={handoverEntry} onClose={() => setHandoverEntry(null)} />
      <WorkerDrawer mode={drawerMode} workspaceId={workspaceId} settings={settings} tickets={roomTickets} allTickets={tickets} selectedTicketId={selectedTicketId}
        streamTick={streamTick} onSelectWorkspace={selectWorkspace} onSelectTicket={id => setSelectedTicketId(id)} onChanged={() => { void refreshAll() }} onClose={() => setDrawerMode(null)} />
    </div>
  )
}
