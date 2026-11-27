/** 整数像素立体斜角游戏 HUD 皮肤原语、语义按键体系与角色半身头像卡槽（严格 46 色契约）。 */
import type { CSSProperties, ReactNode } from 'react'
import type { StatusKind } from './catalog.ts'
import { OFFICE_THEME } from './office-api.tsx'

export const PIXEL_UI_FONT = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif"
export const PIXEL_MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace'

export type ButtonVariant = 'wood' | 'active' | 'gold' | 'approve' | 'warn' | 'danger' | 'parchment' | 'ghost'

interface VariantTokens {
  readonly bg: string; readonly top: string; readonly bot: string; readonly border: string
  readonly color: string; readonly bold?: boolean; readonly lightInk?: boolean; readonly ghost?: boolean
}

const BTN_TOKENS: Record<ButtonVariant, VariantTokens> = {
  wood: { bg: OFFICE_THEME.woodDark, top: OFFICE_THEME.woodMid, bot: '#2C211B', border: OFFICE_THEME.outline, color: OFFICE_THEME.inkCream, lightInk: true },
  active: { bg: OFFICE_THEME.woodWarm, top: OFFICE_THEME.borderGold, bot: OFFICE_THEME.woodDark, border: OFFICE_THEME.borderGold, color: OFFICE_THEME.inkCream, bold: true, lightInk: true },
  gold: { bg: OFFICE_THEME.borderGold, top: OFFICE_THEME.inkCream, bot: OFFICE_THEME.woodWarm, border: OFFICE_THEME.outline, color: OFFICE_THEME.inkDark, bold: true },
  approve: { bg: OFFICE_THEME.done, top: OFFICE_THEME.inkCream, bot: '#247A42', border: OFFICE_THEME.outline, color: OFFICE_THEME.inkDark, bold: true },
  warn: { bg: OFFICE_THEME.stuck, top: OFFICE_THEME.inkCream, bot: '#A86A17', border: OFFICE_THEME.outline, color: OFFICE_THEME.inkDark, bold: true },
  danger: { bg: '#9E2F2C', top: OFFICE_THEME.needsDecision, bot: '#3B2A22', border: OFFICE_THEME.outline, color: OFFICE_THEME.inkCream, bold: true, lightInk: true },
  parchment: { bg: OFFICE_THEME.parchment, top: OFFICE_THEME.inkCream, bot: '#9C8069', border: OFFICE_THEME.woodDark, color: OFFICE_THEME.inkDark, bold: true },
  ghost: { bg: '#2C211B', top: OFFICE_THEME.borderWood, bot: OFFICE_THEME.outline, border: OFFICE_THEME.borderWood, color: OFFICE_THEME.inkCream, lightInk: true, ghost: true },
}

export function PixelUiStyles() {
  return (
    <style>{`
      .dsh-px-btn { transition: filter 80ms steps(2), transform 60ms steps(2), box-shadow 60ms steps(2); }
      .dsh-px-btn:hover:not(:disabled) { filter: brightness(1.12); }
      .dsh-px-btn:active:not(:disabled) { transform: translateY(2px); box-shadow: inset 0 2px 0 #1A1412, 0 0 0 #1A1412 !important; }
      .dsh-px-ghost:hover:not(:disabled) { background: #4A3428 !important; border-color: #C9A46A !important; }
      .dsh-px-slot { transition: filter 80ms steps(2), transform 60ms steps(2), border-color 80ms steps(2); }
      .dsh-px-slot:hover { filter: brightness(1.1); transform: translateY(-1px); border-color: #C9A46A !important; }
      .dsh-px-slot:active { transform: translateY(1px); }
      .dsh-px-btn:focus-visible, .dsh-px-slot:focus-visible, .dsh-px-input:focus-visible { outline: 2px solid #F2A93B; outline-offset: 1px; }
      .dsh-roster-scroll::-webkit-scrollbar { width: 4px; }
      .dsh-roster-scroll::-webkit-scrollbar-thumb { background: #6B4A32; border-radius: 2px; }
    `}</style>
  )
}

export const NINE_SLICE_PANEL: CSSProperties = {
  backgroundColor: OFFICE_THEME.bgPanel,
  border: `2px solid ${OFFICE_THEME.outline}`,
  borderRadius: 4,
  boxShadow: `inset 0 0 0 2px #5A463A, inset 0 2px 0 2px ${OFFICE_THEME.woodWarm}, 0 3px 0 ${OFFICE_THEME.outline}`,
  boxSizing: 'border-box',
  imageRendering: 'pixelated',
  fontFamily: PIXEL_UI_FONT,
  fontSize: 12,
  color: OFFICE_THEME.inkCream,
  textShadow: `0 1px 0 ${OFFICE_THEME.outline}`,
}

export const NINE_SLICE_SLOT: CSSProperties = {
  backgroundColor: OFFICE_THEME.bgDeep,
  border: `2px solid ${OFFICE_THEME.borderWood}`,
  borderRadius: 3,
  boxShadow: `inset 0 2px 0 ${OFFICE_THEME.outline}, 0 1px 0 #5A463A`,
  boxSizing: 'border-box',
  imageRendering: 'pixelated',
}

export const DIEGETIC_PARCHMENT_CARD: CSSProperties = {
  backgroundColor: OFFICE_THEME.inkCream,
  border: `2px solid ${OFFICE_THEME.woodMid}`,
  borderRadius: 3,
  boxShadow: `inset 0 1px 0 ${OFFICE_THEME.inkCream}, 0 2px 0 #9C8069`,
  boxSizing: 'border-box',
  color: OFFICE_THEME.inkDark,
  fontFamily: PIXEL_UI_FONT,
  padding: '8px 10px',
  textShadow: 'none',
}

export const DIEGETIC_WALNUT_CARD: CSSProperties = {
  ...NINE_SLICE_SLOT,
  borderRadius: 3,
  boxShadow: `inset 0 1px 0 #3A2E28, 0 2px 0 ${OFFICE_THEME.outline}`,
  color: OFFICE_THEME.inkCream,
  fontFamily: PIXEL_UI_FONT,
  padding: '8px 10px',
}

export const DIEGETIC_LIGHT_INPUT: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '5px 8px',
  backgroundColor: OFFICE_THEME.inkCream,
  color: OFFICE_THEME.inkDark,
  border: `2px solid ${OFFICE_THEME.woodMid}`,
  borderRadius: 3,
  boxShadow: 'inset 0 1px 0 #9C8069',
  fontFamily: PIXEL_UI_FONT,
  fontSize: 12,
}

export const DIEGETIC_DARK_INPUT: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '5px 8px',
  backgroundColor: OFFICE_THEME.bgDeep,
  color: OFFICE_THEME.inkCream,
  border: `2px solid ${OFFICE_THEME.borderWood}`,
  borderRadius: 3,
  boxShadow: `inset 0 1px 0 ${OFFICE_THEME.outline}`,
  fontFamily: PIXEL_UI_FONT,
  fontSize: 12,
}

export function statusPipColor(status: StatusKind | 'idle'): string {
  if (status === 'needsDecision') return OFFICE_THEME.needsDecision
  if (status === 'stuck') return OFFICE_THEME.stuck
  if (status === 'working') return OFFICE_THEME.working
  if (status === 'done') return OFFICE_THEME.done
  return OFFICE_THEME.borderWood
}

export function nineSliceButtonStyle(active = false, disabled = false, variant?: ButtonVariant): CSSProperties {
  const t = BTN_TOKENS[variant ?? (active ? 'active' : 'wood')]
  return {
    background: t.bg,
    color: t.color,
    border: `2px solid ${t.border}`,
    borderRadius: 3,
    boxShadow: t.ghost
      ? `inset 0 1px 0 ${t.top}, 0 1px 0 ${OFFICE_THEME.outline}`
      : `inset 0 2px 0 ${t.top}, inset 0 -2px 0 ${t.bot}, 0 2px 0 ${OFFICE_THEME.outline}`,
    boxSizing: 'border-box',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontFamily: PIXEL_UI_FONT,
    fontSize: 12,
    fontWeight: t.bold ? 700 : 500,
    textShadow: t.lightInk ? `0 1px 0 ${OFFICE_THEME.outline}` : 'none',
    padding: '4px 9px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    lineHeight: 1.15,
  }
}

export interface NineSliceButtonProps {
  readonly active?: boolean; readonly disabled?: boolean; readonly variant?: ButtonVariant
  readonly iconSrc?: string; readonly iconSize?: number; readonly label?: string; readonly column?: boolean
  readonly ariaLabel?: string; readonly title?: string; readonly style?: CSSProperties; readonly onClick?: () => void
  readonly children?: ReactNode
}

export function NineSliceButton({
  active = false, disabled = false, variant, iconSrc, iconSize = 18, label, column = false,
  ariaLabel, title, style, onClick, children,
}: NineSliceButtonProps) {
  const cls = variant === 'ghost' ? 'dsh-px-btn dsh-px-ghost' : 'dsh-px-btn'
  return (
    <button
      type="button" className={cls} disabled={disabled} aria-label={ariaLabel} title={title} onClick={onClick}
      style={{ ...nineSliceButtonStyle(active, disabled, variant), flexDirection: column ? 'column' : 'row', gap: column ? 2 : 5, ...style }}
    >
      {iconSrc && <img src={iconSrc} alt="" width={iconSize} height={iconSize} style={{ display: 'block', imageRendering: 'pixelated', flexShrink: 0 }} />}
      {label && <span>{label}</span>}
      {children}
    </button>
  )
}

export interface MugshotSlotProps {
  readonly src: string; readonly alt: string; readonly status: StatusKind | 'idle'
  readonly active?: boolean; readonly title?: string; readonly badgeCount?: number; readonly accentColor?: string
  readonly dossierAriaLabel?: string; readonly onOpenDossier?: () => void
  readonly onClick?: () => void; readonly onDoubleClick?: () => void
}

export function MugshotSlot({
  src, alt, status, active = false, title, badgeCount, accentColor,
  dossierAriaLabel, onOpenDossier, onClick, onDoubleClick,
}: MugshotSlotProps) {
  return (
    <div style={{ position: 'relative', width: 48, height: 48 }}>
      <button
        type="button" className="dsh-px-slot" title={title} onClick={onClick} onDoubleClick={onDoubleClick}
        style={{
          ...NINE_SLICE_SLOT, position: 'relative', width: 48, height: 48, padding: 0, cursor: 'pointer',
          overflow: 'hidden', borderColor: active ? OFFICE_THEME.borderGold : OFFICE_THEME.borderWood,
          boxShadow: active ? `0 0 0 1px ${OFFICE_THEME.outline}, inset 0 1px 0 ${OFFICE_THEME.borderGold}` : NINE_SLICE_SLOT.boxShadow,
        }}
      >
        {accentColor && (
          <span style={{ position: 'absolute', left: 2, right: 2, top: 1, height: 3, background: accentColor, pointerEvents: 'none' }} />
        )}
        <img
          src={src} alt={alt} width={32} height={32}
          style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover', objectPosition: 'center top', imageRendering: 'pixelated' }}
        />
      </button>
      {dossierAriaLabel && onOpenDossier ? (
        <button
          type="button" className="dsh-px-btn" aria-label={dossierAriaLabel} title={`打开「${alt.replace(/^房间-/, '')}」工位卷宗`}
          onClick={onOpenDossier}
          style={{
            position: 'absolute', top: -5, right: -5, minWidth: 18, height: 17, padding: '0 4px',
            background: badgeCount && badgeCount > 0 ? OFFICE_THEME.borderGold : '#3A2E28',
            color: badgeCount && badgeCount > 0 ? OFFICE_THEME.inkDark : OFFICE_THEME.parchment,
            border: `1px solid ${badgeCount && badgeCount > 0 ? OFFICE_THEME.outline : OFFICE_THEME.borderGold}`,
            borderRadius: 3, boxShadow: `0 1px 0 ${OFFICE_THEME.outline}`, cursor: 'pointer',
            fontFamily: PIXEL_MONO_FONT, fontSize: 10, lineHeight: '15px', fontWeight: 700, textAlign: 'center',
          }}
        >
          {badgeCount && badgeCount > 0 ? badgeCount : '≡'}
        </button>
      ) : typeof badgeCount === 'number' && badgeCount > 0 ? (
        <span style={{
          position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 3px',
          background: OFFICE_THEME.borderGold, color: OFFICE_THEME.inkDark, border: `1px solid ${OFFICE_THEME.outline}`,
          borderRadius: 3, fontFamily: PIXEL_MONO_FONT, fontSize: 10, lineHeight: '14px', fontWeight: 700, textAlign: 'center', pointerEvents: 'none',
        }}>{badgeCount}</span>
      ) : null}
      <span style={{
        position: 'absolute', right: -3, bottom: -3, width: 11, height: 11, borderRadius: '50%',
        background: statusPipColor(status), border: `2px solid ${OFFICE_THEME.outline}`, boxSizing: 'border-box', pointerEvents: 'none',
      }} />
    </div>
  )
}
