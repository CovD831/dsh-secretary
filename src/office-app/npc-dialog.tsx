/** 左下 384×480 秘书立绘与底部 9-Slice 铆钉木金对话框：日常对话态与单栈待裁拍板态切换。 */
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import type { AvatarPackSummary } from '../app/avatar-pipeline.ts'
import type { FourWayAttribution, RulingDecision, RulingItem, RulingOrigin } from '../app/ruling-queue.ts'
import type { SecretaryExpression, SecretaryFeedEntry } from '../app/tools/secretary-core.ts'
import { OFFICE_THEME } from './office-api.tsx'
import { NINE_SLICE_PANEL, NINE_SLICE_SLOT, PIXEL_UI_FONT, nineSliceButtonStyle } from './ui-skin.tsx'

export interface NpcDialogProps {
  readonly feed: readonly SecretaryFeedEntry[]
  readonly activeRuling: RulingItem | null
  readonly pendingCount: number
  readonly avatar: AvatarPackSummary | null
  readonly hasWorkingTickets: boolean
  readonly gateBlocked: boolean
  readonly secretaryThinking?: boolean
  readonly pendingBossText?: string | null
  readonly collapsed?: boolean
  readonly collapsedLeft?: number
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
  readonly onExpand?: () => void
  readonly onCollapse?: () => void
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
  secretaryThinking = false,
): SecretaryExpression {
  if (activeRuling || gateBlocked) return 'concerned'
  if (secretaryThinking || hasWorkingTickets) return 'working'
  for (let i = feed.length - 1; i >= 0; i--) {
    const entry = feed[i]!
    if (entry.role === 'secretary' && entry.expression) return entry.expression
  }
  return 'neutral'
}

export function NpcDialog({
  feed, activeRuling, pendingCount, avatar, hasWorkingTickets, gateBlocked,
  secretaryThinking = false, pendingBossText = null, collapsed = false, collapsedLeft = 244, inputRef,
  onSendMessage, onDecideRuling, onOpenHandover, onExpand, onCollapse,
}: NpcDialogProps) {
  const [draft, setDraft] = useState('')
  const [selectedOption, setSelectedOption] = useState<string | undefined>(undefined)
  const [note, setNote] = useState('')
  const [attribution, setAttribution] = useState<FourWayAttribution>('missing_rule')
  const [captureAsRule, setCaptureAsRule] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dots, setDots] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const historyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setSelectedOption(undefined); setNote(''); setAttribution('missing_rule'); setCaptureAsRule(false)
  }, [activeRuling?.id])

  useEffect(() => {
    if (!historyOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation?.(); setHistoryOpen(false) } }
    const onDown = (e: globalThis.MouseEvent) => {
      const el = e.target as HTMLElement | null
      if (historyRef.current && !historyRef.current.contains(el) && !el?.closest?.('[data-history-toggle]')) setHistoryOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onDown) }
  }, [historyOpen])

  useEffect(() => {
    if (!secretaryThinking) { setDots(1); return }
    const t = setInterval(() => setDots(d => (d % 3) + 1), 380)
    return () => clearInterval(t)
  }, [secretaryThinking])

  useEffect(() => {
    if (historyOpen && historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight
  }, [historyOpen, feed.length])

  const mood = resolveSecretaryMood(activeRuling, gateBlocked, hasWorkingTickets, feed, secretaryThinking)
  const portraitSrc = avatar?.portraitUrls[mood] ?? `/assets/f1-proof/portrait_${mood}.png`
  const latestSayIdx = useMemo(() => {
    for (let i = feed.length - 1; i >= 0; i--) if (feed[i]!.role === 'secretary' && feed[i]!.kind !== 'memory_receipt') return i
    return -1
  }, [feed])
  const latestSay = latestSayIdx >= 0 ? feed[latestSayIdx] : undefined
  const repliedBossText = useMemo(() => {
    for (let i = latestSayIdx - 1; i >= 0; i--) {
      if (feed[i]!.kind === 'memory_receipt') continue
      return feed[i]!.role === 'boss' ? feed[i]!.text : null
    }
    return null
  }, [feed, latestSayIdx])
  const latestHandover = useMemo(() => [...feed].reverse().find(e => e.kind === 'handover' && e.handover), [feed])
  const effectiveOption = selectedOption ?? activeRuling?.options.find(o => o.recommended)?.id ?? activeRuling?.options[0]?.id
  const isNegativeApprovalOption = activeRuling?.kind !== 'secretary_ask'
    && /^(?:reject|deny|veto|block|opt[-_]?deny|opt[-_]?reject)$/i.test(effectiveOption?.trim() ?? '')
  const isCollapsed = Boolean(collapsed) && !activeRuling && !gateBlocked && !secretaryThinking
  const latestText = latestSay?.text ?? '老板好，办公室已就绪。点按场景器物可查阅卷宗，或直接在此吩咐任务。'

  const handleSend = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true); setError(null); setDraft('')
    try {
      await onSendMessage(text)
    } catch (err) {
      setDraft(text)
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const handleDecide = async (decision: RulingDecision) => {
    if (!activeRuling || busy) return
    setBusy(true); setError(null)
    try {
      await onDecideRuling({
        id: activeRuling.id, decision, optionId: effectiveOption, attribution,
        note: note.trim() || undefined, captureAsRule,
      })
      setNote(''); setSelectedOption(undefined); setCaptureAsRule(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }

  const panelBox = { ...NINE_SLICE_PANEL, display: 'flex' as const }
  const inputBox = {
    ...NINE_SLICE_SLOT, flex: 1, color: OFFICE_THEME.inkCream, padding: '6px 10px',
    fontFamily: PIXEL_UI_FONT, outline: 'none',
  }
  const btnIdle = nineSliceButtonStyle(false)
  const btnActive = nineSliceButtonStyle(true)
  const btnGold = nineSliceButtonStyle(false, busy || !draft.trim(), 'gold')
  const btnPaper = nineSliceButtonStyle(false, false, 'parchment')
  const btnApprove = nineSliceButtonStyle(false, busy, 'approve')
  const btnWarn = nineSliceButtonStyle(false, busy, 'warn')
  const btnDanger = nineSliceButtonStyle(false, busy, 'danger')

  return (
    <div style={isCollapsed ? { position: 'absolute', left: collapsedLeft, right: 298, bottom: 12, zIndex: 20 } : { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20 }}>
      {historyOpen && (
        <div ref={historyRef} role="region" aria-label="对话历史" style={{
          ...NINE_SLICE_PANEL, position: 'absolute', right: 24, bottom: '100%', marginBottom: 8, width: 520,
          maxHeight: 232, overflowY: 'auto', padding: 12, zIndex: 25,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ color: OFFICE_THEME.borderGold }}>历史回看 ({feed.length > 20 ? `最近 20 / 共 ${feed.length}` : feed.length})</strong>
            <button type="button" className="dsh-px-btn" onClick={() => setHistoryOpen(false)} style={btnIdle}>收起</button>
          </div>
          {feed.length === 0 ? <p style={{ opacity: 0.7 }}>暂无对话记录。</p> : feed.slice(-20).map(item => (
            <div key={item.id} style={{ padding: '6px 0', borderBottom: `1px solid ${OFFICE_THEME.borderWood}` }}>
              <span style={{ color: OFFICE_THEME.borderGold, marginRight: 6 }}>[{item.role === 'boss' ? '老板' : '秘书'}]</span>
              <span>{item.text}</span>
              {item.handover && (
                <button type="button" className="dsh-px-btn" onClick={() => onOpenHandover(item)} style={{ ...btnPaper, marginLeft: 8, padding: '2px 7px', fontSize: 11 }}>公文纸</button>
              )}
            </div>
          ))}
        </div>
      )}

      {isCollapsed ? (
        <div style={{ ...panelBox, minHeight: 54, padding: '6px 10px', alignItems: 'center', gap: 8 }}>
          <button type="button" className="dsh-px-slot" aria-label="展开秘书立绘" onClick={onExpand} style={{ ...NINE_SLICE_SLOT, padding: 0, cursor: 'pointer', flexShrink: 0, overflow: 'hidden' }}>
            <img src={portraitSrc} alt={`秘书立绘缩略 (${mood})`} data-mood={mood} width={40} height={40} style={{ display: 'block', imageRendering: 'pixelated' }} />
          </button>
          <div style={{ flex: '0 1 190px', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{latestText}</div>
          <input ref={inputRef} className="dsh-px-input" type="text" aria-label="向秘书发话" placeholder="直接吩咐秘书调度或询问进度…（按 / 快速输入）" value={draft}
            onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) void handleSend() }}
            style={{ ...inputBox, minWidth: 100, fontSize: 12 }} />
          <button type="button" className="dsh-px-btn" disabled={busy || !draft.trim()} onClick={() => void handleSend()} style={{ ...btnGold, fontSize: 12, padding: '5px 12px', flexShrink: 0 }}>发送</button>
          {latestHandover && <button type="button" className="dsh-px-btn" onClick={() => onOpenHandover(latestHandover)} style={{ ...btnPaper, fontSize: 11, flexShrink: 0 }}>展开三段式公文纸</button>}
          <button type="button" data-history-toggle="1" className="dsh-px-btn" onClick={() => setHistoryOpen(v => !v)} style={{ ...nineSliceButtonStyle(historyOpen), flexShrink: 0 }}>历史回看 ({feed.length})</button>
          <button type="button" className="dsh-px-btn" onClick={onExpand} style={{ ...btnActive, flexShrink: 0 }}>展开立绘</button>
        </div>
      ) : (
        <>
          <img src={portraitSrc} alt={`秘书立绘 (${mood})`} data-mood={mood} width={384} height={480}
            style={{ position: 'absolute', left: 24, bottom: 16, width: 384, height: 480, imageRendering: 'pixelated', pointerEvents: 'none', zIndex: 20 }} />
          <div style={{ ...panelBox, minHeight: 220, padding: '14px 20px 14px 424px', flexDirection: 'column', gap: 10 }}>
            {activeRuling ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ background: '#9E2F2C', color: OFFICE_THEME.inkCream, border: `1px solid ${OFFICE_THEME.needsDecision}`, padding: '2px 8px', borderRadius: 3, fontSize: 12, fontWeight: 700 }}>
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
                        <button key={opt.id} type="button" className="dsh-px-btn" onClick={() => setSelectedOption(opt.id)} style={{
                          ...NINE_SLICE_SLOT, textAlign: 'left', padding: '7px 10px', cursor: 'pointer', width: '100%',
                          background: active ? OFFICE_THEME.woodMid : OFFICE_THEME.bgDeep, color: OFFICE_THEME.inkCream,
                          borderColor: active ? OFFICE_THEME.borderGold : OFFICE_THEME.borderWood,
                          boxShadow: active ? `0 0 0 1px ${OFFICE_THEME.outline}, inset 0 1px 0 ${OFFICE_THEME.borderGold}` : NINE_SLICE_SLOT.boxShadow,
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700 }}>
                            <span>{opt.label}</span>
                            {opt.recommended && <span style={{ color: OFFICE_THEME.borderGold, fontSize: 11 }}>★ 推荐</span>}
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>{opt.consequence}</div>
                        </button>
                      )
                    })}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input className="dsh-px-input" type="text" aria-label="裁决附言" placeholder="可选：补充裁决附言或修正要求…" value={note} onChange={e => setNote(e.target.value)}
                    style={{ ...inputBox, minWidth: 180, fontSize: 13 }} />
                  <select aria-label="四分类归因" value={attribution} onChange={e => setAttribution(e.target.value as FourWayAttribution)}
                    style={{ ...NINE_SLICE_SLOT, color: OFFICE_THEME.inkCream, padding: '5px 8px', fontSize: 12 }}>
                    {ATTRIBUTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                    <input type="checkbox" checked={captureAsRule} onChange={e => setCaptureAsRule(e.target.checked)} />
                    <span>沉淀为规则</span>
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {isNegativeApprovalOption ? (
                      <button type="button" className="dsh-px-btn" disabled={busy} onClick={() => void handleDecide('reject')} style={{ ...btnDanger, fontSize: 13, padding: '6px 14px' }}>确认拦截</button>
                    ) : (
                      <button type="button" className="dsh-px-btn" disabled={busy} onClick={() => void handleDecide('approve')} style={{ ...btnApprove, fontSize: 13, padding: '6px 14px' }}>批准</button>
                    )}
                    <button type="button" className="dsh-px-btn" disabled={busy} onClick={() => void handleDecide('revise')} style={{ ...btnWarn, fontSize: 13, padding: '6px 14px' }}>打回修改</button>
                    {!isNegativeApprovalOption && <button type="button" className="dsh-px-btn" disabled={busy} onClick={() => void handleDecide('reject')} style={{ ...btnDanger, fontSize: 13, padding: '6px 14px' }}>否决</button>}
                  </div>
                  <button type="button" data-history-toggle="1" className="dsh-px-btn" onClick={() => setHistoryOpen(v => !v)} style={nineSliceButtonStyle(historyOpen)}>历史回看 ({feed.length})</button>
                </div>
              </>
            ) : (
              <>
                {secretaryThinking && (
                  <div role="status" aria-label="秘书思考中" style={{
                    ...NINE_SLICE_SLOT, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                    flexWrap: 'wrap', padding: '5px 10px', fontSize: 13,
                  }}>
                    <span>
                      <strong style={{ color: OFFICE_THEME.borderGold }}>你：</strong>
                      <span>「{pendingBossText ?? '刚发送指令'}」</span>
                    </span>
                    <span style={{ color: OFFICE_THEME.working, fontWeight: 700 }}>秘书正在思考回应 {'·'.repeat(dots)}</span>
                  </div>
                )}
                {!secretaryThinking && repliedBossText && (
                  <div style={{ fontSize: 12, color: OFFICE_THEME.borderGold, opacity: 0.9 }}>
                    回应「{repliedBossText.length > 44 ? `${repliedBossText.slice(0, 44)}…` : repliedBossText}」：
                  </div>
                )}
                <div style={{ fontSize: 17, lineHeight: 1.55, minHeight: 46, opacity: secretaryThinking ? 0.72 : 1 }}>{latestText}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 'auto' }}>
                  <input ref={inputRef} className="dsh-px-input" type="text" aria-label="向秘书发话" placeholder="直接吩咐秘书调度或询问进度…（按 / 快速输入）" value={draft}
                    onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) void handleSend() }}
                    style={{ ...inputBox, minWidth: 240, fontSize: 13 }} />
                  <button type="button" className="dsh-px-btn" disabled={busy || !draft.trim()} onClick={() => void handleSend()} style={{ ...btnGold, fontSize: 13, padding: '6px 16px' }}>发送</button>
                  {latestHandover && (
                    <button type="button" className="dsh-px-btn" onClick={() => onOpenHandover(latestHandover)} style={{ ...btnPaper, fontSize: 12, padding: '6px 11px' }}>展开三段式公文纸</button>
                  )}
                  <button type="button" data-history-toggle="1" className="dsh-px-btn" onClick={() => setHistoryOpen(v => !v)} style={{ ...nineSliceButtonStyle(historyOpen), fontSize: 12, padding: '6px 11px' }}>历史回看 ({feed.length})</button>
                  {onCollapse && (
                    <button type="button" className="dsh-px-btn" onClick={onCollapse} style={{ ...btnActive, fontSize: 12, padding: '6px 11px' }}>收起巡视</button>
                  )}
                </div>
              </>
            )}
            {error && <div style={{ color: OFFICE_THEME.needsDecision, fontSize: 12 }}>{error}</div>}
          </div>
        </>
      )}
    </div>
  )
}
