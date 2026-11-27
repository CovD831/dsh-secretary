/** 整数像素木金游戏 HUD：顶部状态与分段镜头栏、左侧半身像与角标卷宗轨、左下实时罗盘小地图与紧凑器物坞。 */
import { useEffect, useState } from 'react'
import type { SecretaryExpression } from '../app/tools/secretary-core.ts'
import { type StatusKind } from './catalog.ts'
import { buildVariantMugshotUrl, resolveRoomVariantMap } from './char-variants.ts'
import { UI_SKIN_URLS } from './diorama-catalog.ts'
import { getTimeOfDayProfile } from './diorama-polish.ts'
import type { OfficeActor } from './iso-engine.ts'
import { OFFICE_THEME } from './office-api.tsx'
import type { GovernancePropKind } from './props-drawer.tsx'
import { MugshotSlot, NINE_SLICE_PANEL, NineSliceButton, PIXEL_MONO_FONT, statusPipColor } from './ui-skin.tsx'
import { screenToWorldIso } from './world-renderer.ts'
import type { OfficeCamera, OfficeWorldPlan, WorkspaceWingSpec, WorldWingPlan } from './world-types.ts'

export interface RoomHudStat { readonly count: number; readonly status: StatusKind | 'idle' }

export interface GameHudProps {
  readonly online: boolean; readonly activeWorkspaceId: string; readonly world: OfficeWorldPlan
  readonly actors: readonly OfficeActor[]; readonly roomStats: Record<string, RoomHudStat>
  readonly screenStates?: Record<string, StatusKind | 'off'>
  readonly workingCount: number; readonly subagentTotal?: number; readonly camera: OfficeCamera; readonly dialogCollapsed: boolean
  readonly secretaryMood: SecretaryExpression; readonly secretaryPortraitSrc: string; readonly gateBlocked: boolean
  readonly seed?: number; readonly allWorkspaces?: readonly WorkspaceWingSpec[]
  readonly spriteImages?: Record<string, CanvasImageSource>; readonly spriteVersion?: number
  readonly viewport?: { readonly w: number; readonly h: number }
  readonly onSelectWorkspace?: (workspaceId: string) => void
  readonly onSetSeed?: (seed: number) => void; readonly onRerollSeed?: () => void
  readonly onOpenProp: (prop: 'doorplate' | GovernancePropKind) => void
  readonly onZoomChange: (zoom: 1 | 2) => void; readonly onResetCamera: () => void
  readonly onFocusLobby: () => void; readonly onSelectWing: (wing: WorldWingPlan) => void
  readonly onOpenRoomDrawer: (workspaceId: string) => void
}

const DOCK_PROPS: readonly { id: 'doorplate' | GovernancePropKind; label: string; icon: string }[] = [
  { id: 'doorplate', label: '门牌簿', icon: UI_SKIN_URLS.team },
  { id: 'ledger', label: '规章册', icon: UI_SKIN_URLS.checklist },
  { id: 'notebook', label: '备忘手账', icon: UI_SKIN_URLS.star },
  { id: 'corkboard', label: '体检板', icon: UI_SKIN_URLS.chart },
  { id: 'cabinet', label: '机要柜', icon: UI_SKIN_URLS.gear },
]
const DAY_PIPS = [0, 1, 2, 3, 4, 5] as const
const STATUS_ZH: Record<StatusKind | 'idle', string> = {
  working: '执行中', needsDecision: '待拍板', stuck: '受阻', done: '已就绪', idle: '空闲',
}

interface RowRun { readonly v: number; readonly u0: number; readonly u1: number }
export function computeMinimapWidth(world: Pick<OfficeWorldPlan, 'buildingCols' | 'buildingRows'>): number {
  return Math.min(320, Math.max(220, Math.round(148 * (world.buildingCols / Math.max(1, world.buildingRows)))))
}
function mergeRowRuns(cells: readonly { u: number; v: number }[]): RowRun[] {
  const byV = new Map<number, number[]>()
  for (const c of cells) { const list = byV.get(c.v) ?? []; list.push(c.u); byV.set(c.v, list) }
  const runs: RowRun[] = []
  for (const [v, us] of byV) {
    const sorted = [...new Set(us)].sort((a, b) => a - b)
    let start = sorted[0]!, prev = start
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === prev + 1) { prev = sorted[i]!; continue }
      runs.push({ v, u0: start, u1: prev + 1 }); start = prev = sorted[i]!
    }
    runs.push({ v, u0: start, u1: prev + 1 })
  }
  return runs
}

export function GameHud({
  online, activeWorkspaceId, world, actors, roomStats, screenStates, workingCount, subagentTotal = 0, camera,
  dialogCollapsed, secretaryMood, secretaryPortraitSrc, gateBlocked, seed = 1, allWorkspaces, spriteImages, spriteVersion,
  viewport, onSelectWorkspace, onSetSeed, onRerollSeed,
  onOpenProp, onZoomChange, onResetCamera, onFocusLobby, onSelectWing, onOpenRoomDrawer,
}: GameHudProps) {
  const [seedDraft, setSeedDraft] = useState(String(seed)), [tod, setTod] = useState(() => getTimeOfDayProfile())
  useEffect(() => { setSeedDraft(String(seed)) }, [seed])
  useEffect(() => { const t = setInterval(() => setTod(getTimeOfDayProfile()), 60_000); return () => clearInterval(t) }, [])
  const commitSeed = () => {
    const n = Number.parseInt(seedDraft, 10)
    if (Number.isInteger(n) && n >= 1) { const cl = Math.min(999999, n); setSeedDraft(String(cl)); if (cl !== seed) onSetSeed?.(cl) }
    else setSeedDraft(String(seed))
  }
  const rosterWorkspaces: readonly WorkspaceWingSpec[] = allWorkspaces ?? world.wings.filter(w => w.kind === 'studio' && w.workspaceId).map(w => ({ id: w.workspaceId!, title: w.title }))
  void spriteVersion
  const roomVariants = resolveRoomVariantMap(rosterWorkspaces.map(w => w.id), actors, screenStates, world.wings)
  const jumpToRoom = (roomId: string) => {
    if (onSelectWorkspace) onSelectWorkspace(roomId)
    else { const w = world.wings.find(x => x.workspaceId === roomId); if (w) onSelectWing(w) }
  }
  const attentionRooms = rosterWorkspaces.filter(ws => roomStats[ws.id]?.status === 'needsDecision' || roomStats[ws.id]?.status === 'stuck')
  const nextAttention = attentionRooms.length > 0 ? attentionRooms[(attentionRooms.findIndex(w => w.id === activeWorkspaceId) + 1) % attentionRooms.length]! : null
  const secStatus: StatusKind = gateBlocked ? 'needsDecision' : secretaryMood === 'working' ? 'working' : 'done'
  const vpRect = viewport && viewport.w > 0 && viewport.h > 0 ? (() => {
    const pts = [[0, 0], [viewport.w, 0], [viewport.w, viewport.h], [0, viewport.h]].map(([x, y]) => screenToWorldIso(x!, y!, world, camera))
    const u0 = Math.max(0, Math.min(...pts.map(p => p.u))), u1 = Math.min(world.buildingCols, Math.max(...pts.map(p => p.u)) + 1)
    const v0 = Math.max(0, Math.min(...pts.map(p => p.v))), v1 = Math.min(world.buildingRows, Math.max(...pts.map(p => p.v)) + 1)
    return u1 > u0 && v1 > v0 ? { u0, u1, v0, v1 } : null
  })() : null

  const mapW = computeMinimapWidth(world)

  return (
    <>
      <div title={`${new Date().toTimeString().slice(0, 5)} · ${tod.label}（快捷键：/ 输入，1/2 缩放，Space 居中，WASD 移动）`} style={{
        ...NINE_SLICE_PANEL, position: 'absolute', top: 10, left: 12, zIndex: 12,
        padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 7,
      }}>
        <img src={UI_SKIN_URLS.sun} alt="" width={20} height={20} style={{ display: 'block', imageRendering: 'pixelated' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }} aria-label="昼夜进度">
          {DAY_PIPS.map(i => (
            <span key={i} style={{
              width: 6, height: 6, display: 'inline-block',
              background: i < tod.pipCount ? OFFICE_THEME.borderGold : OFFICE_THEME.borderWood,
              border: `1px solid ${OFFICE_THEME.outline}`,
            }} />
          ))}
        </div>
        <span style={{ fontSize: 11, color: OFFICE_THEME.parchmentSoft }}>{tod.label}</span>
        <span style={{ width: 1, height: 14, background: OFFICE_THEME.borderWood }} />
        <img src={UI_SKIN_URLS.calendar} alt="" width={16} height={16} style={{ display: 'block', imageRendering: 'pixelated' }} />
        <strong style={{ color: OFFICE_THEME.borderGold, fontSize: 12 }}>{activeWorkspaceId}</strong>
      </div>

      <div style={{ position: 'absolute', top: 10, right: 12, zIndex: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ ...NINE_SLICE_PANEL, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span title={online ? 'SSE 在线' : '连接中'} style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', background: online ? OFFICE_THEME.done : OFFICE_THEME.needsDecision, border: `1px solid ${OFFICE_THEME.outline}` }} />
          <img src={UI_SKIN_URLS.team} alt="" width={16} height={16} style={{ display: 'block', imageRendering: 'pixelated' }} />
          <span style={{ fontSize: 11 }}>{workingCount > 0 ? `${workingCount} 工作中${subagentTotal > 0 ? ` · +${subagentTotal} 子代理` : ''}` : `${rosterWorkspaces.length} 房待命`}</span>
        </div>

        {nextAttention && (
          <NineSliceButton variant="danger" ariaLabel="跳至待处理房间" title={`点击轮巡待处理房间：${nextAttention.id}`}
            onClick={() => jumpToRoom(nextAttention.id)} style={{ padding: '5px 9px', fontSize: 11 }}>
            {attentionRooms.length} 待处理
          </NineSliceButton>
        )}

        <div style={{ ...NINE_SLICE_PANEL, padding: '3px 6px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <img src={UI_SKIN_URLS.zoom} alt="" width={16} height={16} style={{ display: 'block', imageRendering: 'pixelated' }} />
          <NineSliceButton ariaLabel="全楼视角" title="全览一屏视野 (快捷键 1)" active={camera.zoom <= 1.01} onClick={() => onZoomChange(1)} style={{ padding: '3px 8px', fontFamily: PIXEL_MONO_FONT, fontSize: 11 }}>1×</NineSliceButton>
          <NineSliceButton ariaLabel="近景视角" title="近景细节视野 (快捷键 2)" active={camera.zoom > 1.01} onClick={() => onZoomChange(2)} style={{ padding: '3px 8px', fontFamily: PIXEL_MONO_FONT, fontSize: 11 }}>2×</NineSliceButton>
          <NineSliceButton variant="ghost" ariaLabel="重置镜头" title="居中全园 (快捷键 Space)" onClick={onResetCamera} style={{ padding: '3px 8px', fontSize: 11 }}>居中</NineSliceButton>
          <span style={{ width: 1, height: 16, background: OFFICE_THEME.borderWood, margin: '0 2px' }} />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: OFFICE_THEME.parchmentSoft }}>
            <span style={{ fontFamily: PIXEL_MONO_FONT }}>#</span>
            <input className="dsh-px-input" aria-label="布局种子编号" title="输入正整数种子 (1-999999) 回车切换" value={seedDraft}
              onChange={(e) => setSeedDraft(e.target.value)} onBlur={commitSeed} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) commitSeed() }}
              style={{ width: 42, padding: '2px 4px', fontSize: 11, fontFamily: PIXEL_MONO_FONT, textAlign: 'center', background: OFFICE_THEME.bgDeep, color: OFFICE_THEME.inkCream, border: `1px solid ${OFFICE_THEME.borderWood}`, borderRadius: 2 }} />
          </label>
          <NineSliceButton variant="ghost" ariaLabel="切换布局种子" title="随机生成新肉鸽房型与家居布局" onClick={onRerollSeed} style={{ padding: '3px 8px', fontSize: 11 }}>随机</NineSliceButton>
        </div>
      </div>

      <div className="dsh-roster-scroll" style={{
        ...NINE_SLICE_PANEL, position: 'absolute', top: 62, left: 12, width: 84, zIndex: 12,
        maxHeight: dialogCollapsed ? 'calc(100vh - 236px)' : 'calc(100vh - 296px)', overflowY: 'auto', overflowX: 'hidden',
        padding: '8px 4px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
          <MugshotSlot src={secretaryPortraitSrc} alt="秘书头像" status={secStatus} title="秘书总台（点击定位并展开对话）" onClick={onFocusLobby} />
          <span style={{ fontSize: 11, color: OFFICE_THEME.borderGold, fontWeight: 700 }}>总台</span>
        </div>

        {rosterWorkspaces.map(ws => {
          const roomId = ws.id, active = roomId === activeWorkspaceId, stat = roomStats[roomId] ?? { count: 0, status: 'idle' }
          const wing = world.wings.find(w => w.workspaceId === roomId), variantIdx = roomVariants.get(roomId)
          const mugshotSrc = spriteImages && variantIdx !== undefined ? (buildVariantMugshotUrl(variantIdx, spriteImages) ?? UI_SKIN_URLS.mugshotWorker) : UI_SKIN_URLS.mugshotWorker
          return (
            <div key={roomId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, width: '100%' }}>
              <MugshotSlot src={mugshotSrc} alt={`房间-${roomId}`} status={stat.status} active={active} badgeCount={stat.count} accentColor={wing?.themeHex}
                dossierAriaLabel={`查看房间卷宗-${roomId}`} onOpenDossier={() => onOpenRoomDrawer(roomId)}
                title={`${roomId} · ${STATUS_ZH[stat.status]} (${stat.count}工单)｜单击定位，双击或点右上角标看卷宗`}
                onClick={() => jumpToRoom(roomId)} onDoubleClick={() => onOpenRoomDrawer(roomId)} />
              <span title={roomId} style={{ fontSize: 11, maxWidth: 74, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: active ? OFFICE_THEME.borderGold : OFFICE_THEME.inkCream, fontWeight: active ? 700 : 500 }}>{roomId}</span>
            </div>
          )
        })}
      </div>

      {dialogCollapsed && (
        <div role="region" aria-label="园区小地图" style={{
          ...NINE_SLICE_PANEL, position: 'absolute', left: 12, bottom: 12, width: mapW, height: 148, zIndex: 12, padding: 3,
        }}>
          <img src={UI_SKIN_URLS.compassN} alt="" width={18} height={18} style={{ position: 'absolute', top: -8, left: -8, zIndex: 2, imageRendering: 'pixelated', pointerEvents: 'none' }} />
          <img src={UI_SKIN_URLS.compassStar} alt="" width={18} height={18} style={{ position: 'absolute', right: -8, bottom: -8, zIndex: 2, imageRendering: 'pixelated', pointerEvents: 'none' }} />
          <div style={{ position: 'relative', width: '100%', height: '100%', background: OFFICE_THEME.bgDeep, overflow: 'hidden' }}>
            {world.corridorCells?.length ? mergeRowRuns(world.corridorCells).map((run, idx) => (
              <div key={`cor-${idx}`} title="返回秘书总台" onClick={onFocusLobby} style={{
                position: 'absolute', background: OFFICE_THEME.woodDark, cursor: 'pointer',
                left: `${(run.u0 / world.buildingCols) * 100}%`, top: `${(run.v / world.buildingRows) * 100}%`,
                width: `${((run.u1 - run.u0) / world.buildingCols) * 100}%`, height: `${(1 / world.buildingRows) * 100}%`,
              }} />
            )) : (
              <div title="返回秘书总台" onClick={onFocusLobby} style={{
                position: 'absolute', background: OFFICE_THEME.woodDark, cursor: 'pointer',
                left: `${(world.corridorRect.u / world.buildingCols) * 100}%`, top: `${(world.corridorRect.v / world.buildingRows) * 100}%`,
                width: `${(world.corridorRect.w / world.buildingCols) * 100}%`, height: `${(world.corridorRect.h / world.buildingRows) * 100}%`,
              }} />
            )}
            <span style={{
              position: 'absolute', transform: 'translateX(-50%)', width: 0, height: 0,
              left: `${((world.mainEntrance.u + 0.5) / world.buildingCols) * 100}%`,
              top: `${((world.corridorRect.v + world.corridorRect.h) / world.buildingRows) * 100}%`,
              marginTop: -6, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderBottom: `5px solid ${OFFICE_THEME.borderGold}`, pointerEvents: 'none',
            }} />

            {world.wings.map(wing => {
              const isStudio = wing.kind === 'studio', isActive = Boolean(wing.workspaceId && wing.workspaceId === activeWorkspaceId)
              const bg = wing.vacant ? '#3A2E28' : (wing.themeHex ?? (isStudio ? OFFICE_THEME.woodWarm : '#4A6A50'))
              const hasCells = Boolean(wing.cells?.length), stroke = isActive ? OFFICE_THEME.borderGold : OFFICE_THEME.borderWood
              return (
                <button key={wing.id} type="button" aria-label={`小地图-${wing.workspaceId ?? wing.id}`} title={wing.workspaceId ? `${wing.workspaceId} (${wing.title})` : wing.title}
                  onClick={() => onSelectWing(wing)} style={{
                    position: 'absolute', padding: 0, cursor: 'pointer', boxSizing: 'border-box',
                    left: `${(wing.rect.u / world.buildingCols) * 100}%`, top: `${(wing.rect.v / world.buildingRows) * 100}%`,
                    width: `${(wing.rect.w / world.buildingCols) * 100}%`, height: `${(wing.rect.h / world.buildingRows) * 100}%`,
                    background: hasCells ? 'transparent' : bg, border: hasCells ? 'none' : `${isActive ? 2 : 1}px solid ${stroke}`,
                    filter: hasCells ? `drop-shadow(0 0 ${isActive ? 2 : 1}px ${stroke})` : undefined,
                  }}>
                  {hasCells && mergeRowRuns(wing.cells!).map((run, idx) => (
                    <span key={`${wing.id}-r-${idx}`} style={{
                      position: 'absolute', pointerEvents: 'none', background: bg,
                      left: `${((run.u0 - wing.rect.u) / Math.max(1, wing.rect.w)) * 100}%`, top: `${((run.v - wing.rect.v) / Math.max(1, wing.rect.h)) * 100}%`,
                      width: `${((run.u1 - run.u0) / Math.max(1, wing.rect.w)) * 100}%`, height: `${(1.06 / Math.max(1, wing.rect.h)) * 100}%`,
                    }} />
                  ))}
                  {wing.suites.map((suite, idx) => (
                    <span key={`${wing.id}-s-${idx}`} style={{
                      position: 'absolute', left: `${((suite.anchor.u - wing.rect.u) / Math.max(1, wing.rect.w)) * 100}%`, top: `${((suite.anchor.v - wing.rect.v) / Math.max(1, wing.rect.h)) * 100}%`,
                      width: 6, height: 4, background: OFFICE_THEME.woodDark, border: `1px solid ${OFFICE_THEME.outline}`, transform: 'translate(-50%, -50%)', pointerEvents: 'none',
                    }} />
                  ))}
                </button>
              )
            })}

            {actors.filter(a => a.lifecycle !== 'removed').map(actor => {
              const st = actor.assignedSuiteId ? screenStates?.[actor.assignedSuiteId] : undefined
              const color = actor.role === 'secretary' ? OFFICE_THEME.borderGold : st && st !== 'off' ? statusPipColor(st) : gateBlocked || actor.lifecycle === 'leaving' ? OFFICE_THEME.needsDecision : OFFICE_THEME.working
              return <span key={actor.id} style={{ position: 'absolute', width: 5, height: 5, borderRadius: '50%', background: color, border: `1px solid ${OFFICE_THEME.outline}`, left: `${(actor.u / world.buildingCols) * 100}%`, top: `${(actor.v / world.buildingRows) * 100}%`, transform: 'translate(-50%, -50%)', pointerEvents: 'none' }} />
            })}
            {vpRect && (
              <span style={{
                position: 'absolute', pointerEvents: 'none', boxSizing: 'border-box',
                left: `${(vpRect.u0 / world.buildingCols) * 100}%`, top: `${(vpRect.v0 / world.buildingRows) * 100}%`,
                width: `${((vpRect.u1 - vpRect.u0) / world.buildingCols) * 100}%`, height: `${((vpRect.v1 - vpRect.v0) / world.buildingRows) * 100}%`,
                border: `1px solid ${OFFICE_THEME.inkCream}`, opacity: 0.78,
              }} />
            )}
          </div>
        </div>
      )}

      <div style={{
        ...NINE_SLICE_PANEL, position: 'absolute', right: 12,
        top: dialogCollapsed ? 'auto' : 58, bottom: dialogCollapsed ? 12 : 'auto',
        zIndex: 21, padding: '4px 5px', display: 'flex', alignItems: 'center', gap: 4,
      }}>
        {DOCK_PROPS.map(p => (
          <NineSliceButton key={p.id} variant="ghost" iconSrc={p.icon} iconSize={20} label={p.label} column
            onClick={() => onOpenProp(p.id)} style={{ padding: '4px 6px', fontSize: 10, minWidth: 48 }} />
        ))}
      </div>
    </>
  )
}
