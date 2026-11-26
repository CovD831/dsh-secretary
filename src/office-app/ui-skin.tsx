/** 9-Slice 铆钉木金游戏 HUD 皮肤原语、像素图标按钮与角色半身头像卡槽。 */
import type { CSSProperties, ReactNode } from 'react'
import type { StatusKind } from './catalog.ts'
import { UI_SKIN_URLS } from './diorama-catalog.ts'
import { OFFICE_THEME } from './office-api.tsx'

export const NINE_SLICE_PANEL: CSSProperties = {
  borderStyle: 'solid',
  borderWidth: 14,
  borderImageSource: `url(${UI_SKIN_URLS.panel9Slice})`,
  borderImageSlice: '20 fill',
  borderImageRepeat: 'stretch',
  backgroundColor: OFFICE_THEME.bgPanel,
  boxSizing: 'border-box',
  imageRendering: 'pixelated',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  color: OFFICE_THEME.inkCream,
}

export const NINE_SLICE_SLOT: CSSProperties = {
  borderStyle: 'solid',
  borderWidth: 8,
  borderImageSource: `url(${UI_SKIN_URLS.slot9Slice})`,
  borderImageSlice: '14 fill',
  borderImageRepeat: 'stretch',
  backgroundColor: OFFICE_THEME.bgDeep,
  boxSizing: 'border-box',
  imageRendering: 'pixelated',
}

export function statusPipColor(status: StatusKind | 'idle'): string {
  if (status === 'needsDecision') return OFFICE_THEME.needsDecision
  if (status === 'stuck') return OFFICE_THEME.stuck
  if (status === 'working') return OFFICE_THEME.working
  if (status === 'done') return OFFICE_THEME.done
  return OFFICE_THEME.borderWood
}

export function nineSliceButtonStyle(active = false, disabled = false): CSSProperties {
  return {
    borderStyle: 'solid',
    borderWidth: 6,
    borderImageSource: `url(${active ? UI_SKIN_URLS.btnActive9Slice : UI_SKIN_URLS.btnIdle9Slice})`,
    borderImageSlice: '14 fill',
    borderImageRepeat: 'stretch',
    background: active ? OFFICE_THEME.woodMid : OFFICE_THEME.woodDark,
    color: OFFICE_THEME.inkCream,
    boxSizing: 'border-box',
    imageRendering: 'pixelated',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    padding: '2px 6px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  }
}

export interface NineSliceButtonProps {
  readonly active?: boolean; readonly disabled?: boolean; readonly iconSrc?: string; readonly iconSize?: number
  readonly label?: string; readonly column?: boolean; readonly ariaLabel?: string; readonly title?: string
  readonly style?: CSSProperties; readonly onClick?: () => void; readonly children?: ReactNode
}

export function NineSliceButton({
  active = false, disabled = false, iconSrc, iconSize = 18, label, column = false,
  ariaLabel, title, style, onClick, children,
}: NineSliceButtonProps) {
  return (
    <button
      type="button" disabled={disabled} aria-label={ariaLabel} title={title} onClick={onClick}
      style={{ ...nineSliceButtonStyle(active, disabled), flexDirection: column ? 'column' : 'row', gap: column ? 2 : 4, ...style }}
    >
      {iconSrc && <img src={iconSrc} alt="" width={iconSize} height={iconSize} style={{ display: 'block', imageRendering: 'pixelated', flexShrink: 0 }} />}
      {label && <span style={{ lineHeight: 1.1 }}>{label}</span>}
      {children}
    </button>
  )
}

export interface MugshotSlotProps {
  readonly src: string; readonly alt: string; readonly status: StatusKind | 'idle'
  readonly active?: boolean; readonly title?: string; readonly badgeCount?: number; readonly onClick?: () => void
}

export function MugshotSlot({ src, alt, status, active = false, title, badgeCount, onClick }: MugshotSlotProps) {
  return (
    <button
      type="button" title={title} onClick={onClick}
      style={{
        ...NINE_SLICE_SLOT, position: 'relative', width: 48, height: 48, padding: 0, cursor: 'pointer',
        overflow: 'visible', outline: active ? `2px solid ${OFFICE_THEME.borderGold}` : 'none',
      }}
    >
      <img
        src={src} alt={alt} width={32} height={32}
        style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover', objectPosition: 'center top', imageRendering: 'pixelated' }}
      />
      {typeof badgeCount === 'number' && badgeCount > 0 && (
        <span style={{
          position: 'absolute', top: -6, right: -6, minWidth: 14, height: 14, padding: '0 3px',
          background: OFFICE_THEME.woodDark, color: OFFICE_THEME.borderGold,
          border: `1px solid ${OFFICE_THEME.borderGold}`, borderRadius: 2,
          fontSize: 9, lineHeight: '12px', fontWeight: 700, textAlign: 'center',
        }}>{badgeCount}</span>
      )}
      <span style={{
        position: 'absolute', right: -4, bottom: -4, width: 10, height: 10, borderRadius: '50%',
        background: statusPipColor(status), border: `1px solid ${OFFICE_THEME.outline}`, boxSizing: 'border-box',
      }} />
    </button>
  )
}
