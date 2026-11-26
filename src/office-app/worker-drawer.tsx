/** 《工作区门牌簿》与《工位工牌卡 & 现场终端卷宗》抽屉组件。 */
import { useEffect, useRef, useState } from 'react'
import type { TicketTranscriptView } from '../app/transcript-reader.ts'
import type { SettingsView } from '../app/views/settings.ts'
import type { TicketListView } from '../app/views/tickets.ts'
import { DiegeticModal, OFFICE_THEME, officeCall } from './office-api.tsx'

export type WorkerDrawerMode = 'doorplate' | 'worker' | null
type TicketItem = TicketListView['items'][number]

export interface WorkerDrawerProps {
  readonly mode: WorkerDrawerMode
  readonly workspaceId: string
  readonly settings: SettingsView | null
  readonly tickets: readonly TicketItem[]
  readonly allTickets?: readonly TicketItem[]
  readonly selectedTicketId: string | null
  readonly streamTick: number
  readonly onSelectWorkspace: (workspaceId: string) => void
  readonly onSelectTicket: (ticketId: string) => void
  readonly onChanged: () => void
  readonly onClose: () => void
}

function countRoomTickets(pool: readonly TicketItem[], roomId: string, repo?: string): number {
  if (roomId === 'default') return pool.filter(t => !t.workspace || t.workspace === 'default').length
  return pool.filter(t => t.workspace === roomId || (!t.workspace && Boolean(repo) && Boolean(t.directory?.startsWith(repo!)))).length
}

const KIND_COLOR: Record<string, string> = {
  tool_call: OFFICE_THEME.working,
  tool_result: OFFICE_THEME.done,
  gate: OFFICE_THEME.needsDecision,
  spine: OFFICE_THEME.borderGold,
  assistant: OFFICE_THEME.inkCream,
  user: OFFICE_THEME.stuck,
}

export function WorkerDrawer({
  mode, workspaceId, settings, tickets, allTickets, selectedTicketId, streamTick,
  onSelectWorkspace, onSelectTicket, onChanged, onClose,
}: WorkerDrawerProps) {
  const [transcript, setTranscript] = useState<TicketTranscriptView | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  const activeTicket = tickets.find(t => t.id === selectedTicketId) ?? tickets[0] ?? null
  const activeId = activeTicket?.id ?? null
  const stageText = activeTicket ? ('action' in activeTicket ? `${activeTicket.stage}/${activeTicket.action}` : activeTicket.stage) : ''

  useEffect(() => {
    if (mode !== 'worker' || !activeId) { setTranscript(null); return }
    let cancelled = false
    setLoading(true); setError(null)
    void officeCall('GET tickets/:id/transcript', { id: activeId, query: { limit: 80 } })
      .then(res => { if (!cancelled) setTranscript(res) })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [mode, activeId, streamTick])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [transcript])

  if (!mode) return null

  if (mode === 'doorplate') {
    const configured = settings?.blocks.workspaces.value ?? []
    const defaultRepo = settings?.environment.root ?? '主工作区'
    const rooms = [
      { id: 'default', repository: defaultRepo, isolation: '默认主室' },
      ...configured.map(w => ({ id: w.id, repository: w.repository, isolation: w.isolation })),
    ]
    return (
      <DiegeticModal open variant="walnut" title="工作区门牌簿" subtitle="点击切换当前房间" width={680} onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rooms.map(room => {
            const current = room.id === workspaceId
            const roomCount = countRoomTickets(allTickets ?? tickets, room.id, room.repository)
            return (
              <button key={room.id} type="button" onClick={() => { onSelectWorkspace(room.id); onClose() }} style={{
                textAlign: 'left', padding: '12px 14px', borderRadius: 4, cursor: 'pointer',
                background: current ? OFFICE_THEME.woodMid : OFFICE_THEME.bgDeep, color: OFFICE_THEME.inkCream,
                border: `1px solid ${current ? OFFICE_THEME.borderGold : OFFICE_THEME.borderWood}`,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
              }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{room.id}</div>
                  <div style={{ fontSize: 12, opacity: 0.78, marginTop: 2 }}>{room.repository}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    background: OFFICE_THEME.bgPanel, border: `1px solid ${OFFICE_THEME.borderWood}`,
                    padding: '2px 8px', borderRadius: 3, fontSize: 12,
                  }}>{roomCount} 工单</span>
                  <span style={{
                    background: OFFICE_THEME.woodDark, border: `1px solid ${OFFICE_THEME.borderGold}`,
                    padding: '2px 8px', borderRadius: 3, fontSize: 12,
                  }}>{room.isolation}</span>
                  {current && <span style={{ color: OFFICE_THEME.borderGold, fontSize: 12, fontWeight: 700 }}>当前房间</span>}
                </div>
              </button>
            )
          })}
        </div>
      </DiegeticModal>
    )
  }

  const runAction = async (kind: 'retry' | 'stop') => {
    if (!activeTicket || busy) return
    setBusy(true); setError(null)
    try {
      if (kind === 'retry') await officeCall('POST tickets/:id/retry', { id: activeTicket.id })
      else await officeCall('POST tickets/:id/stop', { id: activeTicket.id })
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  return (
    <DiegeticModal
      open
      variant="walnut"
      title="工位工牌卡 & 现场终端卷宗"
      subtitle={activeTicket ? `${activeTicket.id} · ${stageText}` : '暂无活跃工单'}
      width={920}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {tickets.length > 1 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {tickets.map(t => (
              <button key={t.id} type="button" onClick={() => onSelectTicket(t.id)} style={{
                background: t.id === activeTicket?.id ? OFFICE_THEME.woodMid : OFFICE_THEME.bgDeep,
                color: OFFICE_THEME.inkCream, border: `1px solid ${t.id === activeTicket?.id ? OFFICE_THEME.borderGold : OFFICE_THEME.borderWood}`,
                borderRadius: 3, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
              }}>{t.title || t.id}</button>
            ))}
          </div>
        )}

        {activeTicket ? (
          <div style={{
            background: OFFICE_THEME.bgDeep, border: `1px solid ${OFFICE_THEME.borderWood}`,
            borderRadius: 4, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
          }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 15 }}>{activeTicket.title}</strong>
                <span style={{
                  background: OFFICE_THEME.woodDark, color: OFFICE_THEME.borderGold,
                  border: `1px solid ${OFFICE_THEME.borderGold}`, borderRadius: 3, padding: '2px 8px', fontSize: 11,
                }}>{stageText}</span>
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.85 }}>
                {activeTicket.summary || activeTicket.note?.text || '工蜂正在执行任务…'}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" disabled={busy || !activeTicket.actions.retry} onClick={() => void runAction('retry')} style={{
                background: OFFICE_THEME.stuck, color: OFFICE_THEME.inkDark, border: 'none', borderRadius: 3,
                padding: '6px 12px', fontWeight: 700, cursor: activeTicket.actions.retry ? 'pointer' : 'not-allowed',
                opacity: activeTicket.actions.retry ? 1 : 0.45, fontSize: 12,
              }}>重试</button>
              <button type="button" disabled={busy || !activeTicket.actions.stop} onClick={() => void runAction('stop')} style={{
                background: OFFICE_THEME.needsDecision, color: '#fff', border: 'none', borderRadius: 3,
                padding: '6px 12px', fontWeight: 700, cursor: activeTicket.actions.stop ? 'pointer' : 'not-allowed',
                opacity: activeTicket.actions.stop ? 1 : 0.45, fontSize: 12,
              }}>停止</button>
            </div>
          </div>
        ) : <p style={{ opacity: 0.75 }}>当前工作区暂无工单。</p>}

        <div ref={logRef} aria-label="现场终端卷宗" style={{
          background: OFFICE_THEME.bgDeep, color: OFFICE_THEME.inkCream,
          border: `1px solid ${OFFICE_THEME.borderGold}`, borderRadius: 4,
          padding: 12, height: 320, overflowY: 'auto', fontSize: 12, lineHeight: 1.5,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}>
          {loading && !transcript && <div>读取现场终端卷宗中…</div>}
          {error && <div style={{ color: OFFICE_THEME.needsDecision }}>{error}</div>}
          {transcript && (transcript.entries?.length ?? 0) === 0 && <div style={{ opacity: 0.7 }}>暂无脱敏终端轨迹。</div>}
          {transcript?.entries.map(entry => (
            <div key={entry.id} style={{ padding: '4px 0', borderBottom: `1px solid ${OFFICE_THEME.borderWood}` }}>
              <span style={{ opacity: 0.6, marginRight: 8 }}>{entry.at}</span>
              <span style={{ color: KIND_COLOR[entry.kind] ?? OFFICE_THEME.inkCream, fontWeight: 700, marginRight: 8 }}>
                [{entry.kind}]
              </span>
              <span>{entry.summary}</span>
              {entry.detail && (
                <pre style={{ margin: '4px 0 0 16px', opacity: 0.8, whiteSpace: 'pre-wrap', fontSize: 11 }}>{entry.detail}</pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </DiegeticModal>
  )
}
