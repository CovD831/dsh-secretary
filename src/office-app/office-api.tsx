/** 独立像素办公室前端共用同源 API 调用器、SSE 实时流订阅器与 46 色冻结色板器物模态框壳。 */
import { type CSSProperties, type ReactNode, useEffect } from 'react'
import type { Api, ApiRequest, ApiResponse } from '../app/api.ts'

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

export function subscribeOfficeStream(onMessage: (msg: OfficeRealtimeMessage) => void): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  const es = new EventSource('/orchestrator/api/events/stream')
  const forward = (event: string) => (ev: MessageEvent) => {
    try { onMessage({ event, data: JSON.parse(String(ev.data)) as Record<string, unknown> }) } catch { /* ignore malformed frame */ }
  }
  for (const name of ['ready', 'spine', 'ruling.queued', 'ruling.decided', 'domain', 'message']) {
    es.addEventListener(name, forward(name) as EventListener)
  }
  return () => { es.close() }
}

const FRAME_STYLE: Record<'walnut' | 'parchment' | 'cork', CSSProperties> = {
  walnut: { background: OFFICE_THEME.bgPanel, color: OFFICE_THEME.inkCream, border: `2px solid ${OFFICE_THEME.borderWood}`, boxShadow: `inset 0 0 0 1px ${OFFICE_THEME.borderGold}` },
  parchment: { background: OFFICE_THEME.parchment, color: OFFICE_THEME.inkDark, border: `2px solid ${OFFICE_THEME.woodDark}`, boxShadow: `inset 0 0 0 1px ${OFFICE_THEME.woodMid}` },
  cork: { background: '#7C5A3E', color: OFFICE_THEME.inkCream, border: `3px solid ${OFFICE_THEME.woodDark}`, boxShadow: `inset 0 0 0 1px ${OFFICE_THEME.borderGold}` },
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
      position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(26,20,18,0.72)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        ...FRAME_STYLE[variant], width: '100%', maxWidth: width, maxHeight: '84vh',
        borderRadius: 4, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px',
          borderBottom: `1px solid ${variant === 'parchment' ? OFFICE_THEME.woodMid : OFFICE_THEME.borderGold}`,
        }}>
          <div>
            <strong style={{ fontSize: 16, letterSpacing: 0.5 }}>{title}</strong>
            {subtitle && <span style={{ marginLeft: 10, fontSize: 12, opacity: 0.82 }}>{subtitle}</span>}
          </div>
          <button type="button" aria-label="关闭器物面板" onClick={onClose} style={{
            background: OFFICE_THEME.woodDark, color: OFFICE_THEME.inkCream, border: `1px solid ${OFFICE_THEME.borderGold}`,
            borderRadius: 3, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
          }}>收起 [ESC]</button>
        </div>
        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>{children}</div>
      </div>
    </div>
  )
}
