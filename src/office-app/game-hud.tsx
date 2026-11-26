/** 9-Slice 铆钉木金游戏 HUD：顶部双岛栏、左侧窄条半身像轨、左下罗盘小地图与右下 5 图标器物坞。 */
import type { SecretaryExpression } from '../app/tools/secretary-core.ts'
import type { StatusKind } from './catalog.ts'
import { UI_SKIN_URLS } from './diorama-catalog.ts'
import type { OfficeActor } from './iso-engine.ts'
import { OFFICE_THEME } from './office-api.tsx'
import type { GovernancePropKind } from './props-drawer.tsx'
import { MugshotSlot, NINE_SLICE_PANEL, NineSliceButton } from './ui-skin.tsx'
import type { OfficeCamera, OfficeWorldPlan, WorldWingPlan } from './world-types.ts'

export interface RoomHudStat {
  readonly count: number
  readonly status: StatusKind | 'idle'
}

export interface GameHudProps {
  readonly online: boolean
  readonly activeWorkspaceId: string
  readonly world: OfficeWorldPlan
  readonly actors: readonly OfficeActor[]
  readonly roomStats: Record<string, RoomHudStat>
  readonly workingCount: number
  readonly camera: OfficeCamera
  readonly dialogCollapsed: boolean
  readonly secretaryMood: SecretaryExpression
  readonly secretaryPortraitSrc: string
  readonly gateBlocked: boolean
  readonly seed?: number
  readonly onRerollSeed?: () => void
  readonly onOpenProp: (prop: 'doorplate' | GovernancePropKind) => void
  readonly onZoomChange: (zoom: 1 | 2) => void
  readonly onResetCamera: () => void
  readonly onFocusLobby: () => void
  readonly onSelectWing: (wing: WorldWingPlan) => void
  readonly onOpenRoomDrawer: (workspaceId: string) => void
}

const DOCK_PROPS: readonly { id: 'doorplate' | GovernancePropKind; label: string; icon: string }[] = [
  { id: 'doorplate', label: '门牌簿', icon: UI_SKIN_URLS.team },
  { id: 'ledger', label: '规章册', icon: UI_SKIN_URLS.checklist },
  { id: 'notebook', label: '备忘手账', icon: UI_SKIN_URLS.star },
  { id: 'corkboard', label: '体检板', icon: UI_SKIN_URLS.chart },
  { id: 'cabinet', label: '机要柜', icon: UI_SKIN_URLS.sprout },
]

const DAY_PIPS = [0, 1, 2, 3, 4, 5] as const

interface RowRun { readonly v: number; readonly u0: number; readonly u1: number }
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
  online, activeWorkspaceId, world, actors, roomStats, workingCount, camera,
  dialogCollapsed, secretaryMood, secretaryPortraitSrc, gateBlocked, seed = 1, onRerollSeed,
  onOpenProp, onZoomChange, onResetCamera, onFocusLobby, onSelectWing, onOpenRoomDrawer,
}: GameHudProps) {
  const studioWings = world.wings.filter(w => w.kind === 'studio')
  const workspaceWings = studioWings.filter(w => Boolean(w.workspaceId))
  const secStatus: StatusKind = gateBlocked
    ? 'needsDecision'
    : secretaryMood === 'working' ? 'working' : 'done'

  return (
    <>
      <div style={{
        ...NINE_SLICE_PANEL, position: 'absolute', top: 10, left: 12, zIndex: 12,
        padding: '2px 8px', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <img src={UI_SKIN_URLS.sun} alt="" width={22} height={22} style={{ display: 'block', imageRendering: 'pixelated' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }} aria-label="昼夜进度">
          {DAY_PIPS.map(i => (
            <span key={i} style={{
              width: 6, height: 6, display: 'inline-block',
              background: i < 4 ? OFFICE_THEME.borderGold : OFFICE_THEME.borderWood,
              border: `1px solid ${OFFICE_THEME.outline}`,
            }} />
          ))}
        </div>
        <span style={{ width: 1, height: 16, background: OFFICE_THEME.borderWood }} />
        <img src={UI_SKIN_URLS.calendar} alt="" width={18} height={18} style={{ display: 'block', imageRendering: 'pixelated' }} />
        <strong style={{ color: OFFICE_THEME.borderGold }}>{activeWorkspaceId}</strong>
      </div>

      <div style={{ position: 'absolute', top: 10, right: 12, zIndex: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ ...NINE_SLICE_PANEL, padding: '2px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <img src={UI_SKIN_URLS.coin} alt="" width={18} height={18} style={{ display: 'block', imageRendering: 'pixelated' }} />
          <span>{workingCount}/{studioWings.length}房</span>
          <span
            title={online ? 'SSE 在线' : '连接中'}
            style={{
              width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
              background: online ? OFFICE_THEME.done : OFFICE_THEME.needsDecision,
              border: `1px solid ${OFFICE_THEME.outline}`,
            }}
          />
        </div>

        <div style={{ ...NINE_SLICE_PANEL, padding: '2px 6px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <img src={UI_SKIN_URLS.zoom} alt="" width={18} height={18} style={{ display: 'block', imageRendering: 'pixelated' }} />
          <NineSliceButton ariaLabel="全楼视角" active={camera.zoom === 1} onClick={() => onZoomChange(1)}>1×</NineSliceButton>
          <NineSliceButton ariaLabel="近景视角" active={camera.zoom === 2} onClick={() => onZoomChange(2)}>2×</NineSliceButton>
          <NineSliceButton ariaLabel="重置镜头" onClick={onResetCamera}>居中</NineSliceButton>
          <NineSliceButton ariaLabel="切换布局种子" title="切换肉鸽房型与家居种子" onClick={onRerollSeed}>种子 #{seed}</NineSliceButton>
        </div>

        <NineSliceButton
          iconSrc={UI_SKIN_URLS.gear}
          iconSize={20}
          ariaLabel="机要设置"
          title="机要柜与设置"
          onClick={() => onOpenProp('cabinet')}
          style={{ padding: '4px 6px' }}
        />
      </div>

      <div style={{
        ...NINE_SLICE_PANEL, position: 'absolute', top: 72, left: 12, width: 76, zIndex: 12,
        padding: '4px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <MugshotSlot
            src={secretaryPortraitSrc}
            alt="秘书头像"
            status={secStatus}
            title="秘书总台"
            onClick={onFocusLobby}
          />
          <span style={{ fontSize: 10, color: OFFICE_THEME.borderGold, fontWeight: 700 }}>总台</span>
        </div>

        {workspaceWings.map(wing => {
          const roomId = wing.workspaceId!
          const active = roomId === activeWorkspaceId
          const stat = roomStats[roomId] ?? { count: 0, status: 'idle' }
          return (
            <div key={wing.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
              <MugshotSlot
                src={UI_SKIN_URLS.mugshotLead}
                alt={`房间-${roomId}`}
                status={stat.status}
                active={active}
                title={roomId}
                badgeCount={stat.count}
                onClick={() => onSelectWing(wing)}
              />
              <span title={roomId} style={{
                fontSize: 10, maxWidth: 46, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                color: active ? OFFICE_THEME.borderGold : OFFICE_THEME.inkCream, fontWeight: active ? 700 : 400,
              }}>
                {roomId}
              </span>
              <NineSliceButton
                ariaLabel={`查看房间卷宗-${roomId}`}
                onClick={() => onOpenRoomDrawer(roomId)}
                style={{ padding: '0 4px', fontSize: 10, borderWidth: 4 }}
              >
                卷宗
              </NineSliceButton>
            </div>
          )
        })}

        <NineSliceButton
          iconSrc={UI_SKIN_URLS.sprout}
          iconSize={18}
          title="扩建房间"
          ariaLabel="扩建房间"
          onClick={() => onOpenProp('cabinet')}
          style={{ width: 44, padding: '2px 4px' }}
        />
      </div>

      {dialogCollapsed && (
        <div role="region" aria-label="楼层小地图" style={{
          ...NINE_SLICE_PANEL, position: 'absolute', left: 12, bottom: 12, width: 224, height: 152,
          zIndex: 12, padding: 2,
        }}>
          <img
            src={UI_SKIN_URLS.compassN} alt="" width={20} height={20}
            style={{ position: 'absolute', top: -10, left: -10, zIndex: 2, imageRendering: 'pixelated', pointerEvents: 'none' }}
          />
          <img
            src={UI_SKIN_URLS.compassStar} alt="" width={20} height={20}
            style={{ position: 'absolute', right: -10, bottom: -10, zIndex: 2, imageRendering: 'pixelated', pointerEvents: 'none' }}
          />
          <div style={{ position: 'relative', width: '100%', height: '100%', background: OFFICE_THEME.bgDeep, overflow: 'hidden' }}>
            {world.corridorCells?.length ? mergeRowRuns(world.corridorCells).map((run, idx) => (
              <div key={`cor-${idx}`} style={{
                position: 'absolute', background: OFFICE_THEME.woodDark,
                left: `${(run.u0 / world.buildingCols) * 100}%`, top: `${(run.v / world.buildingRows) * 100}%`,
                width: `${((run.u1 - run.u0) / world.buildingCols) * 100}%`, height: `${(1 / world.buildingRows) * 100}%`,
              }} />
            )) : (
              <div style={{
                position: 'absolute', background: OFFICE_THEME.woodDark,
                left: `${(world.corridorRect.u / world.buildingCols) * 100}%`, top: `${(world.corridorRect.v / world.buildingRows) * 100}%`,
                width: `${(world.corridorRect.w / world.buildingCols) * 100}%`, height: `${(world.corridorRect.h / world.buildingRows) * 100}%`,
              }} />
            )}
            <span style={{
              position: 'absolute', transform: 'translateX(-50%)', width: 0, height: 0,
              left: `${((world.corridorRect.u + world.corridorRect.w / 2) / world.buildingCols) * 100}%`,
              top: `${((world.corridorRect.v + world.corridorRect.h) / world.buildingRows) * 100}%`,
              marginTop: -6, borderLeft: '4px solid transparent', borderRight: '4px solid transparent',
              borderBottom: `5px solid ${OFFICE_THEME.borderGold}`, pointerEvents: 'none',
            }} />

            {world.wings.map(wing => {
              const isStudio = wing.kind === 'studio'
              const isActive = Boolean(wing.workspaceId && wing.workspaceId === activeWorkspaceId)
              const bg = wing.themeHex ?? (isStudio ? OFFICE_THEME.woodWarm : '#4A6A50')
              const hasCells = Boolean(wing.cells?.length)
              const stroke = isActive ? OFFICE_THEME.borderGold : OFFICE_THEME.borderWood
              return (
                <button
                  key={wing.id} type="button"
                  aria-label={`小地图-${wing.workspaceId ?? wing.id}`}
                  onClick={() => onSelectWing(wing)}
                  style={{
                    position: 'absolute', padding: 0, cursor: 'pointer', boxSizing: 'border-box',
                    left: `${(wing.rect.u / world.buildingCols) * 100}%`,
                    top: `${(wing.rect.v / world.buildingRows) * 100}%`,
                    width: `${(wing.rect.w / world.buildingCols) * 100}%`,
                    height: `${(wing.rect.h / world.buildingRows) * 100}%`,
                    background: hasCells ? 'transparent' : bg,
                    border: hasCells ? 'none' : `${isActive ? 2 : 1}px solid ${stroke}`,
                    filter: hasCells ? `drop-shadow(0 0 ${isActive ? 2 : 1}px ${stroke})` : undefined,
                  }}
                >
                  {hasCells && mergeRowRuns(wing.cells!).map((run, idx) => (
                    <span key={`${wing.id}-r-${idx}`} style={{
                      position: 'absolute', pointerEvents: 'none', background: bg,
                      left: `${((run.u0 - wing.rect.u) / Math.max(1, wing.rect.w)) * 100}%`,
                      top: `${((run.v - wing.rect.v) / Math.max(1, wing.rect.h)) * 100}%`,
                      width: `${((run.u1 - run.u0) / Math.max(1, wing.rect.w)) * 100}%`,
                      height: `${(1.06 / Math.max(1, wing.rect.h)) * 100}%`,
                    }} />
                  ))}
                  {wing.suites.map((suite, idx) => (
                    <span key={`${wing.id}-s-${idx}`} style={{
                      position: 'absolute',
                      left: `${((suite.anchor.u - wing.rect.u) / Math.max(1, wing.rect.w)) * 100}%`,
                      top: `${((suite.anchor.v - wing.rect.v) / Math.max(1, wing.rect.h)) * 100}%`,
                      width: 7, height: 5,
                      background: OFFICE_THEME.woodDark,
                      border: `1px solid ${OFFICE_THEME.outline}`,
                      transform: 'translate(-50%, -50%)',
                      pointerEvents: 'none',
                    }} />
                  ))}
                </button>
              )
            })}

            {actors.filter(a => a.lifecycle !== 'removed').map(actor => {
              const color = actor.role === 'secretary'
                ? OFFICE_THEME.borderGold
                : (gateBlocked || actor.lifecycle === 'leaving' ? OFFICE_THEME.needsDecision : OFFICE_THEME.working)
              return (
                <span key={actor.id} style={{
                  position: 'absolute', width: 5, height: 5, borderRadius: '50%', background: color,
                  left: `${(actor.u / world.buildingCols) * 100}%`,
                  top: `${(actor.v / world.buildingRows) * 100}%`,
                  transform: 'translate(-50%, -50%)', pointerEvents: 'none',
                }} />
              )
            })}
          </div>
        </div>
      )}

      <div style={{
        ...NINE_SLICE_PANEL, position: 'absolute', right: 12, bottom: dialogCollapsed ? 12 : 232,
        zIndex: 21, padding: '2px 4px', display: 'flex', alignItems: 'center', gap: 4,
      }}>
        {DOCK_PROPS.map(p => (
          <NineSliceButton
            key={p.id}
            iconSrc={p.icon}
            iconSize={22}
            label={p.label}
            column
            onClick={() => onOpenProp(p.id)}
            style={{ padding: '2px 5px', fontSize: 10 }}
          />
        ))}
      </div>
    </>
  )
}
