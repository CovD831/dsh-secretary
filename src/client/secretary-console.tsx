/** Secretary console: desktop message bus, live secretary feed with handover/dispatch cards, single-item ruling queue, and avatar/schedule state. */
import { useEffect, useState, type FormEvent } from 'react'
import type { FourWayAttribution, RulingDecision, RulingItem } from '../app/ruling-queue.ts'
import type { SecretaryExpression, SecretaryFeedEntry } from '../app/tools/secretary-core.ts'
import { usePoll } from './api.ts'
import { Button, Input, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, LoadState, Section, SessionButton, When } from './widgets.tsx'

const EXPR_ICON: Readonly<Record<SecretaryExpression, string>> = { neutral: '🙂', working: '🛠️', happy: '✨', concerned: '⚠️' }
const ATTRIBUTIONS: readonly FourWayAttribution[] = ['missing_rule', 'wrong_rule', 'unmeasurable', 'rule_conflict']

function RulingCard({ item, pendingCount, onDecided }: {
  item: RulingItem | null; pendingCount: number; onDecided: () => Promise<void>
}) {
  const { t, call, notify } = usePanel()
  const [optionId, setOptionId] = useState('')
  const [attribution, setAttribution] = useState<FourWayAttribution | ''>('')
  const [note, setNote] = useState('')
  const [captureAsRule, setCaptureAsRule] = useState(false)

  useEffect(() => {
    setOptionId(item?.options.find(o => o.recommended)?.id ?? item?.options[0]?.id ?? '')
    setAttribution('')
    setNote('')
    setCaptureAsRule(false)
  }, [item?.id])

  const decide = useAction(async (decision: RulingDecision) => {
    if (!item) return
    const res = await call('POST rulings/:id/decide', {
      id: item.id,
      body: {
        decision,
        ...(optionId ? { optionId } : {}),
        ...(attribution ? { attribution } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        captureAsRule,
      },
    })
    if (!res.ok) { notify(res.reason ?? t('requestFailed', { status: 400 })); return }
    notify(t('sec.ruledOk'))
  }, { reload: onDecided })

  return <Section title={t('sec.rulingTitle')} icon="decision"
    badge={<Tag tone={pendingCount > 0 ? 'warning' : 'quiet'}>{t('sec.pendingCount', { count: pendingCount })}</Tag>}>
    {!item ? <Hint>{t('sec.rulingEmpty')}</Hint> : <div className="dt-card">
      <div className="dt-row-meta">
        <Tag tone={item.kind === 'secretary_ask' ? 'info' : 'warning'}>{t(`sec.rulingKind.${item.kind}`)}</Tag>
        {item.ticketId && <Tag tone="neutral">{item.ticketId}</Tag>}
        {item.workspace && <Tag tone="outline">{item.workspace}</Tag>}
        {item.toolName && <Tag tone="outline">{item.toolName}</Tag>}
        {item.escalationType && <Tag tone="danger">{item.escalationType}</Tag>}
        <When at={item.createdAt} />
      </div>
      <p className="dt-event-text">{item.question}</p>
      {item.options.length > 0 && <div className="dt-option-list">
        {item.options.slice(0, 3).map(opt => <button key={opt.id} type="button" className="dt-option"
          data-selected={optionId === opt.id || undefined} aria-pressed={optionId === opt.id}
          onClick={() => setOptionId(opt.id)}>
          <span className="dt-row-title">
            <span>{opt.label}</span>
            {opt.recommended && <Tag tone="info">{t('sec.recommended')}</Tag>}
          </span>
          <span className="dt-hint">{opt.consequence}</span>
        </button>)}
      </div>}
      <div className="dt-grid2">
        <label className="dt-field">
          <span className="dt-field-head">{t('sec.attribution')}</span>
          <select className="dt-select" aria-label={t('sec.attribution')} value={attribution}
            onChange={e => setAttribution(e.target.value as FourWayAttribution | '')}>
            <option value="">{t('sec.attributionNone')}</option>
            {ATTRIBUTIONS.map(a => <option key={a} value={a}>{t(`sec.attr.${a}`)}</option>)}
          </select>
        </label>
        <label className="dt-field">
          <span className="dt-field-head">{t('sec.note')}</span>
          <Input aria-label={t('sec.note')} value={note} placeholder={t('sec.notePlaceholder')}
            onChange={e => setNote(e.target.value)} />
        </label>
      </div>
      <div className="dt-actions">
        <label className="dt-checkbox">
          <input type="checkbox" checked={captureAsRule} onChange={e => setCaptureAsRule(e.target.checked)} />
          <span>{t('sec.captureAsRule')}</span>
        </label>
        <span className="dt-filter-gap" />
        <Button variant="primary" size="sm" disabled={decide.busy} onClick={() => { void decide.run('approve') }}>{t('sec.approve')}</Button>
        <Button variant="outline" size="sm" disabled={decide.busy} onClick={() => { void decide.run('revise') }}>{t('sec.revise')}</Button>
        <Button variant="outline" size="sm" disabled={decide.busy} onClick={() => { void decide.run('reject') }}>{t('sec.reject')}</Button>
      </div>
    </div>}
  </Section>
}

function FeedItem({ entry }: { entry: SecretaryFeedEntry }) {
  const { t, navigate } = usePanel()
  const expr = entry.expression ?? 'neutral'
  return <li className="dt-event">
    <div className="dt-row-meta">
      <Tag tone={entry.role === 'boss' ? 'neutral' : 'info'}>{t(`sec.role.${entry.role}`)}</Tag>
      {entry.kind === 'say' && <Tag tone="outline">{EXPR_ICON[expr]} {t(`sec.expr.${expr}`)}</Tag>}
      {entry.ticketId && <span className="dt-mono">{entry.ticketId}</span>}
      {entry.sourceRef && <span className="dt-mono">#{entry.sourceRef.seq}</span>}
      <When at={entry.at} />
    </div>
    {entry.kind === 'handover' && entry.handover ? <details className="dt-drawer" open>
      <summary className="dt-row-title">{entry.handover.conclusion}</summary>
      <dl className="dt-kv">
        <dt>{t('sec.conclusion')}</dt><dd>{entry.handover.conclusion}</dd>
        <dt>{t('sec.reason')}</dt><dd>{entry.handover.reason}</dd>
        <dt>{t('sec.impact')}</dt><dd>{entry.handover.impact}</dd>
        {entry.handover.evidenceRefs.length > 0 && <>
          <dt>{t('sec.evidence')}</dt>
          <dd className="dt-actions">{entry.handover.evidenceRefs.map(ref => <Tag key={ref} tone="outline">{ref}</Tag>)}</dd>
        </>}
      </dl>
    </details> : <p className="dt-event-text">{entry.text}</p>}
    {entry.kind === 'dispatch' && entry.ticketId && <div className="dt-actions">
      <SessionButton variant="outline" sessionId={`worker-${entry.ticketId}`} label={t('sec.openWorker')} />
      <Button variant="ghost" size="sm" onClick={() => navigate({ page: 'execution', id: entry.ticketId! })}>{t('sec.openTicket')}</Button>
    </div>}
  </li>
}

/** Main Secretary workspace tab combining direct bus input, ruling queue, live feed, and projection status. */
export function SecretaryConsole() {
  const { t, call, notify } = usePanel()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const feed = usePoll(() => call('GET secretary/feed'), [])
  const rulings = usePoll(() => call('GET rulings'), [])
  const proj = usePoll(() => call('GET projection/state'), [])

  const reloadAll = async () => { await Promise.all([feed.reload(), rulings.reload(), proj.reload()]) }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    try {
      const res = await call('POST secretary/messages', { body: { text: trimmed } })
      setText('')
      notify(t('sec.sent', { received: res.received }))
      await reloadAll()
    } catch (failure) { notify(errorText(failure)) } finally { setSending(false) }
  }

  const activeRuling = rulings.data?.active ?? feed.data?.activeRuling ?? null
  const pendingCount = rulings.data?.pendingCount ?? feed.data?.pendingCount ?? 0
  const avatar = proj.data?.avatar
  const isEn = t('lang') === 'en'
  const items = [...(feed.data?.items ?? [])].reverse()

  return <>
    <LoadState error={feed.error ?? rulings.error ?? proj.error} loading={!feed.data && !rulings.data} />
    <Section title={t('sec.inputTitle')} icon="message">
      <form className="dt-actions" onSubmit={e => { void submit(e) }}>
        <Input style={{ flex: 1 }} aria-label={t('sec.inputTitle')} value={text} placeholder={t('sec.inputPlaceholder')}
          onChange={e => setText(e.target.value)} />
        <Button type="submit" variant="primary" size="sm" disabled={sending || !text.trim()}>{t('sec.send')}</Button>
      </form>
    </Section>
    <RulingCard item={activeRuling} pendingCount={pendingCount} onDecided={reloadAll} />
    {avatar && <Section title={t('sec.statusTitle')} icon="user">
      <div className="dt-row-meta">
        <Tag tone={avatar.posture === 'alert_fault' ? 'danger' : avatar.posture === 'raising_hand' ? 'warning' : 'info'}>
          {t(`sec.posture.${avatar.posture}`)}
        </Tag>
        <Tag tone="neutral">{t(`sec.zone.${avatar.zone}`)}</Tag>
        <Tag tone="outline">{avatar.shift}</Tag>
        {avatar.bark && <span>{isEn ? avatar.bark.textEn : avatar.bark.textZh} (#{avatar.bark.sourceRef.seq})</span>}
      </div>
      {avatar.deviation && <p className="dt-banner dt-danger">{avatar.deviation.summary}</p>}
      {proj.data?.schedule.length ? <ul className="dt-plain-list">
        {proj.data.schedule.map(s => <li key={s.id} className="dt-row-meta">
          <Tag tone="outline">{s.window}</Tag><span>{isEn ? s.titleEn : s.titleZh}</span>
          <span className="dt-count">{s.count}</span>
        </li>)}
      </ul> : <Hint>{t('sec.scheduleEmpty')}</Hint>}
    </Section>}
    <Section title={t('sec.feedTitle')} count={items.length} icon="inbox">
      {items.length ? <ul className="dt-timeline">{items.map(entry => <FeedItem key={entry.id} entry={entry} />)}</ul>
        : <Hint>{t('sec.feedEmpty')}</Hint>}
    </Section>
  </>
}
