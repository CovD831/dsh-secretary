/** 左下 384×480 秘书立绘与底部硬角金线唯一对话框：日常对话态与单栈待裁拍板态切换。 */
import { type RefObject, useMemo, useState } from 'react'
import type { AvatarPackSummary } from '../app/avatar-pipeline.ts'
import type { FourWayAttribution, RulingDecision, RulingItem, RulingOrigin } from '../app/ruling-queue.ts'
import type { SecretaryExpression, SecretaryFeedEntry } from '../app/tools/secretary-core.ts'
import { OFFICE_THEME } from './office-api.tsx'

export interface NpcDialogProps {
  readonly feed: readonly SecretaryFeedEntry[]
  readonly activeRuling: RulingItem | null
  readonly pendingCount: number
  readonly avatar: AvatarPackSummary | null
  readonly hasWorkingTickets: boolean
  readonly gateBlocked: boolean
  readonly inputRef?: RefObject<HTMLInputElement>
  readonly onSendMessage: (text: string) => Promise<void>
  readonly onDecideRuling: (input: {
    id: string
    decision: RulingDecision
    optionId?: string
    attribution?: FourWayAttribution
    note?: string
    captureAsRule?: boolean
  }) => Promise<void>
  readonly onOpenHandover: (entry: SecretaryFeedEntry) => void
}

const ORIGIN_LABELS: Record<RulingOrigin, string> = {
  secretary_ask: '秘书请示',
  dsh_approval: '沙箱越界审批',
  system_escalation: '系统熔断 / 未知副作用',
}

const ATTRIBUTIONS: readonly { value: FourWayAttribution; label: string }[] = [
  { value: 'missing_rule', label: '缺规则 (missing_rule)' },
  { value: 'wrong_rule', label: '错规则 (wrong_rule)' },
  { value: 'unmeasurable', label: '不可测 (unmeasurable)' },
  { value: 'rule_conflict', label: '规则冲突 (rule_conflict)' },
]

export function resolveSecretaryMood(
  activeRuling: RulingItem | null,
  gateBlocked: boolean,
  hasWorkingTickets: boolean,
  feed: readonly SecretaryFeedEntry[],
): SecretaryExpression {
  if (activeRuling || gateBlocked) return 'concerned'
  if (hasWorkingTickets) return 'working'
  for (let i = feed.length - 1; i >= 0; i--) {
    const entry = feed[i]!
    if (entry.role === 'secretary' && entry.expression) return entry.expression
  }
  return 'neutral'
}

export function NpcDialog({
  feed, activeRuling, pendingCount, avatar, hasWorkingTickets, gateBlocked, inputRef,
  onSendMessage, onDecideRuling, onOpenHandover,
}: NpcDialogProps) {
  const [draft, setDraft] = useState('')
  const [selectedOption, setSelectedOption] = useState<string | undefined>(undefined)
  const [note, setNote] = useState('')
  const [attribution, setAttribution] = useState<FourWayAttribution>('missing_rule')
  const [captureAsRule, setCaptureAsRule] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mood = resolveSecretaryMood(activeRuling, gateBlocked, hasWorkingTickets, feed)
  const portraitSrc = avatar?.portraitUrls[mood] ?? `/assets/f1-proof/portrait_${mood}.png`
  const latestSay = useMemo(() => [...feed].reverse().find(e => e.role === 'secretary'), [feed])
  const latestHandover = useMemo(() => [...feed].reverse().find(e => e.kind === 'handover' && e.handover), [feed])
  const effectiveOption = selectedOption ?? activeRuling?.options.find(o => o.recommended)?.id ?? activeRuling?.options[0]?.id

  const handleSend = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true); setError(null)
    try {
      await onSendMessage(text)
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const handleDecide = async (decision: RulingDecision) => {
    if (!activeRuling || busy) return
    setBusy(true); setError(null)
    try {
      await onDecideRuling({
        id: activeRuling.id,
        decision,
        optionId: effectiveOption,
        attribution,
        note: note.trim() || undefined,
        captureAsRule,
      })
      setNote(''); setSelectedOption(undefined); setCaptureAsRule(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  return (
    <div style={{ position: 'relative', width: '100%', zIndex: 15 }}>
      {historyOpen && (
        <div role="region" aria-label="对话历史" style={{
          position: 'absolute', right: 24, bottom: '100%', marginBottom: 8, width: 520, maxHeight: 280,
          overflowY: 'auto', background: OFFICE_THEME.bgPanel, color: OFFICE_THEME.inkCream,
          border: `2px solid ${OFFICE_THEME.borderWood}`, boxShadow: `inset 0 0 0 1px ${OFFICE_THEME.borderGold}`,
          borderRadius: 4, padding: 12, fontSize: 12, zIndex: 25,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <strong>历史回看 ({feed.length})</strong>
            <button type="button" onClick={() => setHistoryOpen(false)} style={{
              background: OFFICE_THEME.woodDark, color: OFFICE_THEME.inkCream, border: `1px solid ${OFFICE_THEME.borderGold}`,
              borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11,
            }}>收起</button>
          </div>
          {feed.length === 0 ? <p style={{ opacity: 0.7 }}>暂无对话记录。</p> : feed.slice(-20).map(item => (
            <div key={item.id} style={{ padding: '6px 0', borderBottom: `1px solid ${OFFICE_THEME.borderWood}` }}>
              <span style={{ color: OFFICE_THEME.borderGold, marginRight: 6 }}>
                [{item.role === 'boss' ? '老板' : '秘书'}]
              </span>
              <span>{item.text}</span>
              {item.handover && (
                <button type="button" onClick={() => onOpenHandover(item)} style={{
                  marginLeft: 8, background: OFFICE_THEME.parchment, color: OFFICE_THEME.inkDark,
                  border: `1px solid ${OFFICE_THEME.woodDark}`, borderRadius: 2, padding: '1px 6px', cursor: 'pointer', fontSize: 11,
                }}>公文纸</button>
              )}
            </div>
          ))}
        </div>
      )}

      <img
        src={portraitSrc} alt={`秘书立绘 (${mood})`} data-mood={mood} width={384} height={480}
        style={{ position: 'absolute', left: 24, bottom: 16, width: 384, height: 480, imageRendering: 'pixelated', pointerEvents: 'none', zIndex: 20 }}
      />
      <div style={{
        background: OFFICE_THEME.bgPanel, color: OFFICE_THEME.inkCream,
        border: `2px solid ${OFFICE_THEME.borderWood}`, boxShadow: `inset 0 0 0 1px ${OFFICE_THEME.borderGold}`,
        borderRadius: 4, minHeight: 220, padding: '16px 24px 16px 432px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {activeRuling ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ background: OFFICE_THEME.needsDecision, color: '#fff', padding: '2px 8px', borderRadius: 3, fontSize: 12, fontWeight: 700 }}>
                {ORIGIN_LABELS[activeRuling.kind]}{activeRuling.toolName ? ` · ${activeRuling.toolName}` : ''}
              </span>
              <span style={{ background: OFFICE_THEME.woodDark, color: OFFICE_THEME.borderGold, border: `1px solid ${OFFICE_THEME.borderGold}`, padding: '2px 8px', borderRadius: 3, fontSize: 12 }}>
                待办 {pendingCount}
              </span>
              <strong style={{ fontSize: 16, flex: 1 }}>{activeRuling.question}</strong>
            </div>
            {activeRuling.options.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                {activeRuling.options.slice(0, 3).map(opt => {
                  const active = effectiveOption === opt.id
                  return (
                    <button key={opt.id} type="button" onClick={() => setSelectedOption(opt.id)} style={{
                      textAlign: 'left', padding: '8px 10px', borderRadius: 3, cursor: 'pointer',
                      background: active ? OFFICE_THEME.woodMid : OFFICE_THEME.bgDeep, color: OFFICE_THEME.inkCream,
                      border: `1px solid ${active ? OFFICE_THEME.borderGold : OFFICE_THEME.borderWood}`,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700 }}>
                        <span>{opt.label}</span>
                        {opt.recommended && <span style={{ color: OFFICE_THEME.borderGold, fontSize: 11 }}>★ 推荐</span>}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.82, marginTop: 2 }}>{opt.consequence}</div>
                    </button>
                  )
                })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="text" aria-label="裁决附言" placeholder="可选：补充裁决附言或修正要求…" value={note} onChange={e => setNote(e.target.value)}
                style={{ flex: 1, minWidth: 180, background: OFFICE_THEME.bgDeep, color: OFFICE_THEME.inkCream, border: `1px solid ${OFFICE_THEME.borderWood}`, borderRadius: 3, padding: '6px 10px', fontSize: 13 }} />
              <select aria-label="四分类归因" value={attribution} onChange={e => setAttribution(e.target.value as FourWayAttribution)}
                style={{ background: OFFICE_THEME.bgDeep, color: OFFICE_THEME.inkCream, border: `1px solid ${OFFICE_THEME.borderWood}`, borderRadius: 3, padding: '6px 8px', fontSize: 12 }}>
                {ATTRIBUTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={captureAsRule} onChange={e => setCaptureAsRule(e.target.checked)} />
                <span>沉淀为规则</span>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" disabled={busy} onClick={() => void handleDecide('approve')} style={{ background: OFFICE_THEME.done, color: OFFICE_THEME.inkDark, border: 'none', borderRadius: 3, padding: '6px 14px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>批准</button>
                <button type="button" disabled={busy} onClick={() => void handleDecide('revise')} style={{ background: OFFICE_THEME.stuck, color: OFFICE_THEME.inkDark, border: 'none', borderRadius: 3, padding: '6px 14px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>打回修改</button>
                <button type="button" disabled={busy} onClick={() => void handleDecide('reject')} style={{ background: OFFICE_THEME.needsDecision, color: '#fff', border: 'none', borderRadius: 3, padding: '6px 14px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>否决</button>
              </div>
              <button type="button" onClick={() => setHistoryOpen(v => !v)} style={{ background: OFFICE_THEME.woodDark, color: OFFICE_THEME.inkCream, border: `1px solid ${OFFICE_THEME.borderGold}`, borderRadius: 3, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}>历史回看 ({feed.length})</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 18, lineHeight: 1.5, minHeight: 54 }}>
              {latestSay?.text ?? '老板好，办公室已就绪。点按场景器物可查阅卷宗，或直接在此吩咐任务。'}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 'auto' }}>
              <input ref={inputRef} type="text" aria-label="向秘书发话" placeholder="直接吩咐秘书调度或询问进度…" value={draft}
                onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void handleSend() }}
                style={{ flex: 1, minWidth: 240, background: OFFICE_THEME.bgDeep, color: OFFICE_THEME.inkCream, border: `1px solid ${OFFICE_THEME.borderGold}`, borderRadius: 3, padding: '8px 12px', fontSize: 14 }} />
              <button type="button" disabled={busy || !draft.trim()} onClick={() => void handleSend()} style={{ background: OFFICE_THEME.borderGold, color: OFFICE_THEME.inkDark, border: 'none', borderRadius: 3, padding: '8px 16px', fontWeight: 700, cursor: 'pointer', fontSize: 14 }}>发送</button>
              {latestHandover && (
                <button type="button" onClick={() => onOpenHandover(latestHandover)} style={{ background: OFFICE_THEME.parchment, color: OFFICE_THEME.inkDark, border: `1px solid ${OFFICE_THEME.woodDark}`, borderRadius: 3, padding: '8px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>展开三段式公文纸</button>
              )}
              <button type="button" onClick={() => setHistoryOpen(v => !v)} style={{ background: OFFICE_THEME.woodDark, color: OFFICE_THEME.inkCream, border: `1px solid ${OFFICE_THEME.borderGold}`, borderRadius: 3, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}>历史回看 ({feed.length})</button>
            </div>
          </>
        )}
        {error && <div style={{ color: OFFICE_THEME.needsDecision, fontSize: 12 }}>{error}</div>}
      </div>
    </div>
  )
}
