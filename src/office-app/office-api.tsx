/** 独立像素办公室前端共用同源 API 调用器、SSE 实时流订阅器与 46 色冻结色板器物模态框壳。 */
import { type CSSProperties, type ReactNode, useEffect } from 'react'
import type { Api, ApiRequest, ApiResponse } from '../app/api.ts'
import { UI_SKIN_URLS } from './diorama-catalog.ts'

export const OFFICE_THEME = {
  bgDeep: '#201A18',
  bgPanel: '#302722',
  borderWood: '#4A3C34',
  borderGold: '#C9A46A',
  inkCream: '#E8DCCB',
  parchment: '#D9C4A8',
  parchmentSoft: '#BFA48C',
  inkDark: '#1A1412',
  woodDark: '#4A3428',
  woodMid: '#6B4A32',
  woodWarm: '#8A6242',
  outline: '#1A1412',
  working: '#2FA8E0',
  stuck: '#F2A93B',
  needsDecision: '#E8544E',
  done: '#3FCB6B',
} as const

export async function officeCall<K extends keyof Api>(
  route: K,
  ...request: {} extends ApiRequest<K> ? [request?: ApiRequest<K>] : [request: ApiRequest<K>]
): Promise<ApiResponse<K>> {
  const [method, pattern] = route.split(' ') as [string, string]
  const values = (request[0] ?? {}) as Record<string, unknown> & { query?: Record<string, unknown>; body?: unknown }
  const path = pattern.replace(/:(\w+)/g, (_m, name: string) => encodeURIComponent(String(values[name])))
  const query = Object.entries(values.query ?? {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  const url = `/orchestrator/api/${query ? `${path}?${query}` : path}`
  const headers: Record<string, string> = { 'x-orchestrator-request': '1' }
  const init: RequestInit = { method, headers }
  if (values.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(values.body)
  }
  const res = await fetch(url, init)
  const text = await res.text()
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!res.ok) {
    throw new Error(typeof data['error'] === 'string' ? data['error'] : `HTTP ${res.status}`)
  }
  return data as ApiResponse<K>
}

export interface OfficeRealtimeMessage {
  readonly event: string
  readonly data: Record<string, unknown>
}

export function subscribeOfficeStream(onMessage: (msg: OfficeRealtimeMessage) => void, onError?: () => void): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  const es = new EventSource('/orchestrator/api/events/stream')
  const forward = (event: string) => (ev: MessageEvent) => {
    try { onMessage({ event, data: JSON.parse(String(ev.data)) as Record<string, unknown> }) } catch { /* ignore malformed frame */ }
  }
  for (const name of ['ready', 'spine', 'ruling.queued', 'ruling.decided', 'domain', 'message', 'subagent']) {
    es.addEventListener(name, forward(name) as EventListener)
  }
  es.onerror = () => { onError?.() }
  return () => { es.close() }
}

const BODY_STYLE: Record<'walnut' | 'parchment' | 'cork', CSSProperties> = {
  walnut: { background: OFFICE_THEME.bgPanel, color: OFFICE_THEME.inkCream },
  parchment: { background: OFFICE_THEME.parchment, color: OFFICE_THEME.inkDark, border: `2px solid ${OFFICE_THEME.woodMid}` },
  cork: { background: '#7C5A3E', color: OFFICE_THEME.inkCream, border: `2px solid ${OFFICE_THEME.woodDark}` },
}

const MODAL_ICON: Record<'walnut' | 'parchment' | 'cork', string> = {
  walnut: UI_SKIN_URLS.gear,
  parchment: UI_SKIN_URLS.checklist,
  cork: UI_SKIN_URLS.chart,
}

export function DiegeticModal({
  open, title, subtitle, variant = 'walnut', width = 880, onClose, children,
}: {
  open: boolean; title: string; subtitle?: string; variant?: 'walnut' | 'parchment' | 'cork'; width?: number; onClose: () => void; children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div role="dialog" aria-label={title} onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(26, 20, 18, 0.76)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        backgroundColor: OFFICE_THEME.bgPanel, border: `2px solid ${OFFICE_THEME.outline}`, borderRadius: 4,
        boxShadow: `inset 0 0 0 2px #5A463A, inset 0 2px 0 2px ${OFFICE_THEME.woodWarm}, 0 6px 0 ${OFFICE_THEME.outline}`,
        color: OFFICE_THEME.inkCream, imageRendering: 'pixelated', boxSizing: 'border-box',
        width: '100%', maxWidth: width, maxHeight: '86vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px',
          borderBottom: `2px solid ${OFFICE_THEME.borderGold}`, background: OFFICE_THEME.bgDeep,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <img src={MODAL_ICON[variant]} alt="" width={20} height={20} style={{ display: 'block', imageRendering: 'pixelated' }} />
            <strong style={{ fontSize: 16, letterSpacing: 0.5, color: OFFICE_THEME.borderGold }}>{title}</strong>
            {subtitle && <span style={{ marginLeft: 4, fontSize: 12, color: OFFICE_THEME.parchmentSoft }}>{subtitle}</span>}
          </div>
          <button type="button" className="dsh-px-btn" aria-label="关闭器物面板" onClick={onClose} style={{
            background: OFFICE_THEME.woodDark, color: OFFICE_THEME.inkCream,
            border: `2px solid ${OFFICE_THEME.outline}`, borderRadius: 3,
            boxShadow: `inset 0 2px 0 ${OFFICE_THEME.woodMid}, inset 0 -2px 0 #2C211B, 0 2px 0 ${OFFICE_THEME.outline}`,
            padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
          }}>收起 [ESC]</button>
        </div>
        <div style={{ ...BODY_STYLE[variant], padding: 14, overflowY: 'auto', flex: 1 }}>{children}</div>
      </div>
    </div>
  )
}
