/** 木金框像素经营游戏 HUD：顶部全局状态与镜头栏、左侧编队栏、左下楼层雷达小地图。 */
import type { SecretaryExpression } from '../app/tools/secretary-core.ts'
import type { StatusKind } from './catalog.ts'
import type { OfficeActor } from './iso-engine.ts'
import { OFFICE_THEME } from './office-api.tsx'
import type { GovernancePropKind } from './props-drawer.tsx'
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
  readonly onOpenProp: (prop: 'doorplate' | GovernancePropKind) => void
  readonly onZoomChange: (zoom: 1 | 2) => void
  readonly onResetCamera: () => void
  readonly onFocusLobby: () => void
  readonly onSelectWing: (wing: WorldWingPlan) => void
  readonly onOpenRoomDrawer: (workspaceId: string) => void
}

const PILL_PROPS: readonly { id: 'doorplate' | GovernancePropKind; label: string }[] = [
  { id: 'doorplate', label: '门牌簿' },
  { id: 'ledger', label: '规章册' },
  { id: 'notebook', label: '备忘手账' },
  { id: 'corkboard', label: '体检板' },
  { id: 'cabinet', label: '机要柜' },
]

const PANEL_STYLE = {
  background: OFFICE_THEME.bgPanel,
  border: `2px solid ${OFFICE_THEME.borderWood}`,
  boxShadow: `inset 0 0 0 1px ${OFFICE_THEME.borderGold}`,
  borderRadius: 4,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  color: OFFICE_THEME.inkCream,
} as const

const BTN_STYLE = {
  background: OFFICE_THEME.woodDark,
  color: OFFICE_THEME.inkCream,
  border: `1px solid ${OFFICE_THEME.borderGold}`,
  borderRadius: 3,
  padding: '2px 8px',
  cursor: 'pointer',
  fontSize: 12,
} as const

function statusDotColor(status: StatusKind | 'idle'): string {
  if (status === 'needsDecision') return OFFICE_THEME.needsDecision
  if (status === 'working') return OFFICE_THEME.working
  if (status === 'done') return OFFICE_THEME.done
  return OFFICE_THEME.borderWood
}

export function GameHud({
  online, activeWorkspaceId, world, actors, roomStats, workingCount, camera,
  dialogCollapsed, secretaryMood, secretaryPortraitSrc, gateBlocked,
  onOpenProp, onZoomChange, onResetCamera, onFocusLobby, onSelectWing, onOpenRoomDrawer,
}: GameHudProps) {
  const studioWings = world.wings.filter(w => w.kind === 'studio')
  const workspaceWings = studioWings.filter(w => Boolean(w.workspaceId))
  const courtyardWings = world.wings.filter(w => w.kind === 'courtyard')
  const secColor = gateBlocked
    ? OFFICE_THEME.needsDecision
    : secretaryMood === 'working' ? OFFICE_THEME.working : OFFICE_THEME.done

  return (
    <>
      <div style={{
        position: 'absolute', top: 10, left: 12, right: 12, zIndex: 12,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', pointerEvents: 'none',
      }}>
        <div style={{ ...PANEL_STYLE, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'auto' }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
            background: online ? OFFICE_THEME.done : OFFICE_THEME.needsDecision,
          }} title={online ? 'SSE 在线' : '连接中'} />
          <span style={{ background: OFFICE_THEME.woodDark, color: OFFICE_THEME.borderGold, padding: '1px 6px', borderRadius: 2, fontSize: 11 }}>
            ☀ 值守中
          </span>
          <strong style={{ color: OFFICE_THEME.borderGold }}>{activeWorkspaceId}</strong>
          <span style={{ opacity: 0.85 }}>
            房间 {studioWings.length} · 庭院 {courtyardWings.length} · 在岗 {workingCount}
          </span>
        </div>

        <div style={{ ...PANEL_STYLE, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'auto' }}>
          {PILL_PROPS.map(p => (
            <button key={p.id} type="button" onClick={() => onOpenProp(p.id)} style={BTN_STYLE}>
              {p.label}
            </button>
          ))}
        </div>

        <div style={{ ...PANEL_STYLE, padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'auto' }}>
          <button
            type="button" aria-label="全楼视角" onClick={() => onZoomChange(1)}
            style={{ ...BTN_STYLE, background: camera.zoom === 1 ? OFFICE_THEME.woodMid : OFFICE_THEME.woodDark }}
          >1× 全楼</button>
          <button
            type="button" aria-label="近景视角" onClick={() => onZoomChange(2)}
            style={{ ...BTN_STYLE, background: camera.zoom === 2 ? OFFICE_THEME.woodMid : OFFICE_THEME.woodDark }}
          >2× 近景</button>
          <button type="button" aria-label="重置镜头" onClick={onResetCamera} style={BTN_STYLE}>居中</button>
        </div>
      </div>

      <div style={{
        position: 'absolute', top: 58, left: 12, zIndex: 12, width: 204,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <button type="button" onClick={onFocusLobby} style={{
          ...PANEL_STYLE, padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 8,
          cursor: 'pointer', textAlign: 'left', width: '100%',
        }}>
          <img
            src={secretaryPortraitSrc} alt="秘书头像" width={28} height={28}
            style={{ imageRendering: 'pixelated', border: `1px solid ${OFFICE_THEME.borderGold}`, flexShrink: 0 }}
          />
          <span style={{ flex: 1, fontWeight: 700 }}>秘书总台</span>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: secColor, flexShrink: 0 }} />
        </button>

        {workspaceWings.map(wing => {
          const roomId = wing.workspaceId!
          const active = roomId === activeWorkspaceId
          const stat = roomStats[roomId] ?? { count: 0, status: 'idle' }
          return (
            <div key={wing.id} style={{
              ...PANEL_STYLE,
              background: active ? OFFICE_THEME.woodMid : OFFICE_THEME.bgPanel,
              boxShadow: `inset 0 0 0 1px ${active ? OFFICE_THEME.borderGold : OFFICE_THEME.borderWood}`,
              padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <button type="button" onClick={() => onSelectWing(wing)} style={{
                flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: OFFICE_THEME.inkCream,
                padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left',
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusDotColor(stat.status), flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 700 }}>
                  {roomId}
                </span>
                <span style={{ opacity: 0.8, fontSize: 11, flexShrink: 0 }}>{stat.count} 单</span>
              </button>
              <button
                type="button" aria-label={`查看房间卷宗-${roomId}`}
                onClick={() => onOpenRoomDrawer(roomId)}
                style={{ ...BTN_STYLE, padding: '1px 6px', fontSize: 11, flexShrink: 0 }}
              >卷宗</button>
            </div>
          )
        })}

        {courtyardWings.length > 0 && (
          <button type="button" onClick={() => onOpenProp('cabinet')} style={{
            ...PANEL_STYLE, padding: '6px 8px', cursor: 'pointer', textAlign: 'center',
            color: OFFICE_THEME.borderGold, fontWeight: 700,
          }}>+ 扩建房间</button>
        )}
      </div>

      {dialogCollapsed && (
        <div role="region" aria-label="楼层小地图" style={{
          ...PANEL_STYLE, position: 'absolute', left: 12, bottom: 12, width: 204, height: 132,
          zIndex: 12, padding: 6, boxSizing: 'border-box',
        }}>
          <div style={{
            position: 'relative', width: '100%', height: '100%',
            background: OFFICE_THEME.bgDeep, border: `1px solid ${OFFICE_THEME.borderWood}`, overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute',
              left: `${(world.corridorRect.u / world.buildingCols) * 100}%`,
              top: `${(world.corridorRect.v / world.buildingRows) * 100}%`,
              width: `${(world.corridorRect.w / world.buildingCols) * 100}%`,
              height: `${(world.corridorRect.h / world.buildingRows) * 100}%`,
              background: '#7A3A3A',
            }} />
            {world.wings.map(wing => {
              const isStudio = wing.kind === 'studio'
              const isActive = Boolean(wing.workspaceId && wing.workspaceId === activeWorkspaceId)
              return (
                <button
                  key={wing.id} type="button"
                  aria-label={`小地图-${wing.workspaceId ?? wing.id}`}
                  onClick={() => onSelectWing(wing)}
                  style={{
                    position: 'absolute', padding: 0, cursor: 'pointer',
                    left: `${(wing.rect.u / world.buildingCols) * 100}%`,
                    top: `${(wing.rect.v / world.buildingRows) * 100}%`,
                    width: `${(wing.rect.w / world.buildingCols) * 100}%`,
                    height: `${(wing.rect.h / world.buildingRows) * 100}%`,
                    background: isStudio ? '#8A6242' : '#4A6A50',
                    border: isActive ? `2px solid ${OFFICE_THEME.borderGold}` : `1px solid ${OFFICE_THEME.borderWood}`,
                    boxSizing: 'border-box',
                  }}
                />
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
    </>
  )
}
