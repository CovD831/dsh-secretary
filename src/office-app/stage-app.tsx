/** 独立像素办公室主舞台壳：4 层 2:1 等距 Canvas、SSE 实时驱动、器物/角色拾取与多面板联动。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AvatarPackSummary } from '../app/avatar-pipeline.ts'
import type { FourWayAttribution, RulingDecision, RulingItem } from '../app/ruling-queue.ts'
import type { SecretaryFeedEntry } from '../app/tools/secretary-core.ts'
import type { SettingsView } from '../app/views/settings.ts'
import type { TicketListView } from '../app/views/tickets.ts'
import { OFFICE_CATALOG, type StatusKind } from './catalog.ts'
import { HandoverSheet } from './handover-sheet.tsx'
import {
  createInitialActors, pickSceneTarget, renderOfficeFrame, spawnWorkerForTicket, stepActors,
  type OfficeActor, type OfficeSprites, type ScenePickResult,
} from './iso-engine.ts'
import { CANVAS_H, CANVAS_W, solveOfficeLayout } from './layout-solver.ts'
import { NpcDialog } from './npc-dialog.tsx'
import { OFFICE_THEME, officeCall, subscribeOfficeStream } from './office-api.tsx'
import { PropsDrawer, type GovernancePropKind } from './props-drawer.tsx'
import { WorkerDrawer, type WorkerDrawerMode } from './worker-drawer.tsx'

type TicketItem = TicketListView['items'][number]
const WORKER_SUITES = ['ws-1', 'ws-2', 'ws-3'] as const
const PILL_PROPS: readonly { id: 'doorplate' | GovernancePropKind; label: string }[] = [
  { id: 'doorplate', label: '门牌簿' },
  { id: 'ledger', label: '规章册' },
  { id: 'notebook', label: '备忘手账' },
  { id: 'corkboard', label: '体检板' },
  { id: 'cabinet', label: '机要柜' },
]

function loadSprite(url: string, onLoad: (img: HTMLImageElement) => void): void {
  if (typeof Image === 'undefined') return
  const img = new Image()
  img.onload = () => onLoad(img)
  img.src = url
}

function syncActorsWithTickets(
  prev: OfficeActor[],
  tickets: readonly TicketItem[],
  plan: ReturnType<typeof solveOfficeLayout>,
): OfficeActor[] {
  const openIds = new Set(tickets.map(t => t.id))
  const kept = prev
    .filter(a => a.role !== 'worker' || a.lifecycle !== 'removed')
    .map(a => (a.role === 'worker' && a.ticketId && !openIds.has(a.ticketId) && a.lifecycle !== 'leaving'
      ? { ...a, lifecycle: 'leaving' as const }
      : a))
  const usedSuites = new Set(kept.filter(a => a.role === 'worker' && a.lifecycle !== 'leaving').map(a => a.assignedSuiteId))
  const activeTicketIds = new Set(kept.filter(a => a.role === 'worker' && a.lifecycle !== 'leaving').map(a => a.ticketId))
  const next = [...kept]
  for (const ticket of tickets) {
    if (activeTicketIds.has(ticket.id)) continue
    const suite = WORKER_SUITES.find(s => !usedSuites.has(s))
    if (!suite) break
    usedSuites.add(suite)
    next.push(spawnWorkerForTicket(plan, `worker-${ticket.id}`, ticket.id, suite))
  }
  return next
}

export function StageApp() {
  const [workspaceId, setWorkspaceId] = useState('default')
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
  const [hoverTarget, setHoverTarget] = useState<ScenePickResult | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const lastGateSeqRef = useRef(0)
  const spritesRef = useRef<OfficeSprites>({ images: {} })
  const plan = useMemo(() => solveOfficeLayout(workspaceId, 1), [workspaceId])
  const actorsRef = useRef<OfficeActor[]>(createInitialActors(plan))

  useEffect(() => {
    actorsRef.current = syncActorsWithTickets(createInitialActors(plan), tickets, plan)
  }, [plan])

  useEffect(() => {
    actorsRef.current = syncActorsWithTickets(actorsRef.current, tickets, plan)
  }, [tickets, plan])

  const refreshAll = useCallback(async () => {
    try {
      const [feedRes, ticketRes, settingsRes, avatarRes, spineRes] = await Promise.all([
        officeCall('GET secretary/feed'),
        officeCall('GET tickets', { query: { state: 'open', limit: 20 } }),
        officeCall('GET settings'),
        officeCall('GET avatars'),
        officeCall('GET projection/spine', { query: { type: 'gate.evaluated', limit: 5 } }),
      ])
      setFeed(feedRes.items)
      setActiveRuling(feedRes.activeRuling)
      setPendingCount(feedRes.pendingCount)
      setTickets(ticketRes.items)
      setSettings(settingsRes)
      setAvatar(avatarRes.items.find(i => i.id === avatarRes.activeId) ?? avatarRes.items[0] ?? null)
      const latestDeny = spineRes.items.find(ev => {
        if (ev.seq <= lastGateSeqRef.current) return false
        const v = (ev.payload as Record<string, unknown> | undefined)?.verdict
        const kind = typeof v === 'string' ? v : (v as { kind?: unknown } | undefined)?.kind
        return (kind === 'deny' || kind === 'unmeasured') && Date.now() - Date.parse(ev.at) < 15_000
      })
      if (latestDeny) {
        lastGateSeqRef.current = latestDeny.seq
        setGateUntil(Date.now() + 8_000)
      }
      setOnline(true)
    } catch { setOnline(false) }
  }, [])

  useEffect(() => {
    for (const meta of Object.values(OFFICE_CATALOG)) {
      loadSprite(meta.spriteUrl, img => { spritesRef.current.images[meta.id] = img })
    }
  }, [])

  useEffect(() => {
    loadSprite(avatar?.spriteUrl || OFFICE_CATALOG.char_secretary!.spriteUrl, img => {
      spritesRef.current.images.char_secretary = img
    })
  }, [avatar?.spriteUrl])

  useEffect(() => {
    void refreshAll()
    const unsub = subscribeOfficeStream(() => {
      setOnline(true)
      setStreamTick(t => t + 1)
      void refreshAll()
    })
    const timer = setInterval(() => { void refreshAll() }, 8000)
    return () => { unsub(); clearInterval(timer) }
  }, [refreshAll])

  const screenStates = useMemo(() => {
    const out: Record<string, StatusKind | 'off'> = {
      executive: activeRuling ? 'needsDecision' : tickets.some(t => t.stage === 'working') ? 'working' : 'off',
    }
    for (const suite of WORKER_SUITES) {
      const actor = actorsRef.current.find(a => a.assignedSuiteId === suite && a.lifecycle !== 'leaving')
      const ticket = actor?.ticketId ? tickets.find(t => t.id === actor.ticketId) : undefined
      out[suite] = !ticket ? 'off' : ticket.stage === 'person' ? 'needsDecision' : ticket.stage === 'working' ? 'working' : 'done'
    }
    return out
  }, [activeRuling, tickets])

  const gateBlocked = gateUntil > Date.now()

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let elapsed = 0
    const tick = (now: number) => {
      const dt = Math.min(100, Math.max(0, now - last))
      last = now; elapsed += dt
      actorsRef.current = stepActors(actorsRef.current, plan, dt)
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (ctx) {
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
        renderOfficeFrame(ctx, {
          plan,
          actors: actorsRef.current,
          screenStates,
          hoverTarget,
          elapsedMs: elapsed,
          ...(gateUntil > Date.now() ? { gateIntercept: { targetActorId: 'lead', frame: Math.floor(elapsed / 200) % 3 } } : {}),
        }, spritesRef.current, 2)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [plan, screenStates, hoverTarget, gateUntil])

  const toCanvasCoords = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const scaleX = rect.width ? CANVAS_W / rect.width : 1
    const scaleY = rect.height ? CANVAS_H / rect.height : 1
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY }
  }

  const handleCanvasClick = (clientX: number, clientY: number) => {
    const { x, y } = toCanvasCoords(clientX, clientY)
    const hit = pickSceneTarget(x, y, { plan, actors: actorsRef.current, screenStates, elapsedMs: 0 }, plan, 2)
    if (!hit) return
    if (hit.type === 'prop') {
      if (hit.prop === 'doorplate') setDrawerMode('doorplate')
      else setActiveProp(hit.prop)
    } else if (hit.role === 'secretary') {
      inputRef.current?.focus()
    } else {
      setSelectedTicketId(hit.ticketId ?? tickets[0]?.id ?? null)
      setDrawerMode('worker')
    }
  }

  const handleSendMessage = async (text: string) => {
    await officeCall('POST secretary/messages', { body: { text } })
    await refreshAll()
  }

  const handleDecideRuling = async (input: {
    id: string; decision: RulingDecision; optionId?: string; attribution?: FourWayAttribution; note?: string; captureAsRule?: boolean
  }) => {
    const { id, ...body } = input
    await officeCall('POST rulings/:id/decide', { id, body })
    await refreshAll()
  }

  return (
    <div style={{ minHeight: '100vh', background: OFFICE_THEME.bgDeep, color: OFFICE_THEME.inkCream, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ position: 'relative', width: '100%', maxWidth: CANVAS_W }}>
        <div style={{
          position: 'absolute', top: 12, left: 16, zIndex: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          background: OFFICE_THEME.bgPanel, border: `2px solid ${OFFICE_THEME.borderWood}`,
          boxShadow: `inset 0 0 0 1px ${OFFICE_THEME.borderGold}`, borderRadius: 4, padding: '6px 10px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
            background: online ? OFFICE_THEME.done : OFFICE_THEME.needsDecision,
          }} title={online ? 'SSE 在线' : '连接中'} />
          <strong style={{ color: OFFICE_THEME.borderGold }}>{workspaceId}</strong>
          {PILL_PROPS.map(p => (
            <button key={p.id} type="button" onClick={() => p.id === 'doorplate' ? setDrawerMode('doorplate') : setActiveProp(p.id)} style={{
              background: OFFICE_THEME.woodDark, color: OFFICE_THEME.inkCream, border: `1px solid ${OFFICE_THEME.borderGold}`,
              borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 12,
            }}>{p.label}</button>
          ))}
        </div>

        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          aria-label="像素办公室主舞台"
          onMouseMove={e => {
            const { x, y } = toCanvasCoords(e.clientX, e.clientY)
            setHoverTarget(pickSceneTarget(x, y, { plan, actors: actorsRef.current, screenStates, elapsedMs: 0 }, plan, 2))
          }}
          onMouseLeave={() => setHoverTarget(null)}
          onClick={e => handleCanvasClick(e.clientX, e.clientY)}
          style={{ width: '100%', height: 'auto', display: 'block', imageRendering: 'pixelated', cursor: hoverTarget ? 'pointer' : 'default' }}
        />

        <NpcDialog
          feed={feed} activeRuling={activeRuling} pendingCount={pendingCount} avatar={avatar}
          hasWorkingTickets={tickets.some(t => t.stage === 'working')} gateBlocked={gateBlocked} inputRef={inputRef}
          onSendMessage={handleSendMessage} onDecideRuling={handleDecideRuling} onOpenHandover={entry => setHandoverEntry(entry)}
        />
      </div>

      <PropsDrawer activeProp={activeProp} onClose={() => setActiveProp(null)} onChanged={() => { void refreshAll() }} />
      <HandoverSheet entry={handoverEntry} onClose={() => setHandoverEntry(null)} />
      <WorkerDrawer
        mode={drawerMode} workspaceId={workspaceId} settings={settings} tickets={tickets}
        selectedTicketId={selectedTicketId} streamTick={streamTick}
        onSelectWorkspace={id => setWorkspaceId(id)} onSelectTicket={id => setSelectedTicketId(id)}
        onChanged={() => { void refreshAll() }} onClose={() => setDrawerMode(null)}
      />
    </div>
  )
}
