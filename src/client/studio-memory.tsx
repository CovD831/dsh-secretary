/** Trustworthy memory and M6 attention notebook studio: believability metrics, M1-M4 table, user_direct writer, and quote patches. */
import { useState, type FormEvent } from 'react'
import type { MemoryStudioEntryRow } from '../app/governance-ops.ts'
import type { M2Kind } from '../memory/types.ts'
import { usePoll } from './api.ts'
import { Button, Input, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, LoadState, Section } from './widgets.tsx'

const M2_KINDS: readonly M2Kind[] = ['preference', 'veto', 'shared_event', 'internal_moniker', 'correction_repair']
const toSlug = (raw: string, fallback: string): string => {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 128)
  return s || fallback
}

function targetOfRow(row: MemoryStudioEntryRow): { layer: 'm1' | 'm2' | 'm3' | 'm4'; workspaceKey?: string; slug?: string } {
  const parts = row.relPath.replace(/\.md$/, '').split('/')
  if (row.layer === 'm3' && parts[1] && parts[2]) return { layer: 'm3', workspaceKey: parts[1], slug: parts[2] }
  if (row.layer === 'm1' && parts[1]) return { layer: 'm1', slug: parts[1] }
  return { layer: row.layer }
}

/** Studio view for M1-M4 memory entries, direct boss writes/corrections, verbatim patch approvals, and M6 attention ledger. */
export function StudioMemory() {
  const { t, call, notify } = usePanel()
  const { data, error, reload } = usePoll(() => Promise.all([call('GET memory/studio'), call('GET projection/notebook')]), [])

  const [layer, setLayer] = useState<'m1' | 'm2' | 'm3'>('m2')
  const [statement, setStatement] = useState('')
  const [topicKey, setTopicKey] = useState('')
  const [m2Kind, setM2Kind] = useState<M2Kind | ''>('')
  const [workspaceKey, setWorkspaceKey] = useState('')
  const [slug, setSlug] = useState('')
  const [resident, setResident] = useState(false)
  const [overrideTombstone, setOverrideTombstone] = useState(false)
  const [saving, setSaving] = useState(false)

  const decidePatch = useAction(async (index: number, decision: 'approve' | 'dismiss') => {
    const res = await call('POST memory/patches/:index', { index: String(index), body: { decision } })
    if (!res.ok) { notify(res.reason ?? t('requestFailed', { status: 400 })); return }
    notify(t('studio.mem.patchDone'))
  }, { reload })

  const tombstoneRow = useAction(async (row: MemoryStudioEntryRow) => {
    const target = targetOfRow(row)
    const res = await call('POST memory/entries/:id/tombstone', {
      id: row.entry.id, body: { ...target, reason: 'studio manual tombstone' },
    })
    if (!res.ok) { notify(res.reason ?? t('requestFailed', { status: 400 })); return }
    notify(t('studio.mem.tombstoneDone'))
  }, { reload })

  const triggerDream = useAction(async () => {
    const res = await call('POST memory/dream', { body: { force: true } })
    notify(t('studio.mem.dreamDone', { accepted: res.accepted, promotedM4: res.promotedM4, demotedResident: res.demotedResident }))
  }, { reload })

  const submitDirect = async (event: FormEvent) => {
    event.preventDefault()
    if (!statement.trim() || saving) return
    setSaving(true)
    try {
      const resolvedSlug = toSlug(slug || topicKey, 'notes')
      const resolvedWs = toSlug(workspaceKey, 'default')
      const res = await call('POST memory/direct', {
        body: {
          layer, statement: statement.trim(),
          ...(topicKey.trim() ? { topicKey: topicKey.trim() } : {}),
          ...(m2Kind ? { m2Kind } : {}),
          ...(layer === 'm3' ? { workspaceKey: resolvedWs, slug: resolvedSlug } : {}),
          ...(layer === 'm1' ? { slug: resolvedSlug } : {}),
          ...(resident ? { resident: true } : {}),
          ...(overrideTombstone ? { overrideTombstone: true } : {}),
        },
      })
      if (res.writeResult.kind === 'accepted') {
        notify(t('studio.mem.directAccepted', { seq: res.sourceRef.seq }))
        setStatement('')
        await reload()
      } else {
        notify(res.writeResult.detail)
      }
    } catch (failure) { notify(errorText(failure)) } finally { setSaving(false) }
  }

  if (!data) return <LoadState error={error} loading />
  const [studio, notebook] = data
  const { metrics } = studio
  const nbItems = [...notebook.groups.pending, ...notebook.groups.asked, ...notebook.groups.resolved]

  return <>
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('studio.mem.metricsTitle')} icon="decision">
      <div className="dt-stats">
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.mem.repeatRate')}</span><span className="dt-stat-value">{(metrics.repeatQuestionRate * 100).toFixed(1)}% ({metrics.repeatQuestions}/{metrics.totalQuestions})</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.mem.falseRecall')}</span><span className="dt-stat-value">{metrics.falseRecallCount}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.mem.weeklyCorrected')}</span><span className="dt-stat-value">{metrics.weeklyCorrectedMemories} ({metrics.windowDays}d)</span></span>
        <Button variant="outline" size="sm" disabled={triggerDream.busy} onClick={() => { void triggerDream.run() }}>{t('studio.mem.dreamRunNow')}</Button>
      </div>
      {studio.dreamStatus?.lastReport && <Hint>{studio.dreamStatus.lastReport.trigger}: {studio.dreamStatus.lastReport.status} (+{studio.dreamStatus.lastReport.accepted} / M4 +{studio.dreamStatus.lastReport.promotedM4})</Hint>}
    </Section>
    <Section title={t('studio.mem.directTitle')} icon="plus">
      <form className="dt-card" onSubmit={e => { void submitDirect(e) }}>
        <div className="dt-grid3">
          <label className="dt-field">
            <span className="dt-field-head">{t('studio.mem.layer')}</span>
            <select className="dt-select" aria-label={t('studio.mem.layer')} value={layer} onChange={e => setLayer(e.target.value as 'm1' | 'm2' | 'm3')}>
              <option value="m2">m2</option><option value="m1">m1</option><option value="m3">m3</option>
            </select>
          </label>
          <label className="dt-field">
            <span className="dt-field-head">{t('studio.mem.topicKey')}</span>
            <Input aria-label={t('studio.mem.topicKey')} value={topicKey} onChange={e => setTopicKey(e.target.value)} />
          </label>
          <label className="dt-field">
            <span className="dt-field-head">{t('studio.mem.m2Kind')}</span>
            <select className="dt-select" aria-label={t('studio.mem.m2Kind')} value={m2Kind} onChange={e => setM2Kind(e.target.value as M2Kind | '')}>
              <option value="">{t('studio.mem.m2KindNone')}</option>
              {M2_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
        </div>
        <div className="dt-grid3">
          <label className="dt-field">
            <span className="dt-field-head">{t('studio.mem.statement')}</span>
            <Input aria-label={t('studio.mem.statement')} required value={statement} placeholder={t('studio.mem.statementPlaceholder')} onChange={e => setStatement(e.target.value)} />
          </label>
          <label className="dt-field">
            <span className="dt-field-head">{t('studio.mem.workspaceKey')}</span>
            <Input aria-label={t('studio.mem.workspaceKey')} value={workspaceKey} placeholder="default" onChange={e => setWorkspaceKey(e.target.value)} />
          </label>
          <label className="dt-field">
            <span className="dt-field-head">{t('studio.mem.slug')}</span>
            <Input aria-label={t('studio.mem.slug')} value={slug} placeholder="notes" onChange={e => setSlug(e.target.value)} />
          </label>
        </div>
        <div className="dt-actions">
          <label className="dt-checkbox"><input type="checkbox" checked={resident} onChange={e => setResident(e.target.checked)} /><span>{t('studio.mem.resident')}</span></label>
          <label className="dt-checkbox"><input type="checkbox" checked={overrideTombstone} onChange={e => setOverrideTombstone(e.target.checked)} /><span>{t('studio.mem.overrideTombstone')}</span></label>
          <span className="dt-filter-gap" />
          <Button type="submit" variant="primary" size="sm" disabled={saving || !statement.trim()}>{t('studio.mem.submitDirect')}</Button>
        </div>
      </form>
    </Section>
    <Section title={t('studio.mem.patchesTitle')} count={studio.pendingPatches.length} icon="review">
      {studio.pendingPatches.length ? <ul className="dt-list dt-cards">{studio.pendingPatches.map((p, idx) => <li key={`${p.targetRelPath}-${idx}`} className="dt-card">
        <div className="dt-row-meta">
          <Tag tone="info">{p.layer}</Tag><span className="dt-mono">{p.targetRelPath}</span><span>#{p.sourceRef.seq}</span>
        </div>
        {p.verbatimQuote && <p className="dt-banner">{t('studio.mem.quote')}: {p.verbatimQuote}</p>}
        <p className="dt-event-text">{p.statement}</p>
        <div className="dt-actions">
          <Button variant="primary" size="sm" disabled={decidePatch.busy} onClick={() => { void decidePatch.run(idx, 'approve') }}>{t('studio.mem.approvePatch')}</Button>
          <Button variant="outline" size="sm" disabled={decidePatch.busy} onClick={() => { void decidePatch.run(idx, 'dismiss') }}>{t('studio.mem.dismissPatch')}</Button>
        </div>
      </li>)}</ul> : <Hint>{t('studio.mem.patchesEmpty')}</Hint>}
    </Section>
    <Section title={t('studio.mem.entriesTitle')} count={studio.entries.length} icon="inbox">
      {studio.entries.length ? <table className="dt-table">
        <thead><tr><th>{t('studio.mem.layer')}</th><th>{t('studio.mem.statement')}</th><th>{t('studio.mem.topicKey')}</th><th>ref</th><th /></tr></thead>
        <tbody>{studio.entries.map(row => <tr key={row.entry.id}>
          <td><Tag tone="neutral">{row.layer}</Tag> {row.entry.resident && <Tag tone="info">resident</Tag>} {row.entry.validTo && <Tag tone="danger">{t('studio.mem.tombstoned')}</Tag>}</td>
          <td>{row.entry.statement}</td>
          <td className="dt-mono">{row.entry.topicKey ?? row.entry.m2Kind ?? row.entry.scope}</td>
          <td className="dt-mono">#{row.entry.sourceRef.seq}</td>
          <td>{!row.entry.validTo && <Button variant="ghost" size="sm" disabled={tombstoneRow.busy} onClick={() => { void tombstoneRow.run(row) }}>{t('studio.mem.tombstoneBtn')}</Button>}</td>
        </tr>)}</tbody>
      </table> : <Hint>{t('studio.mem.entriesEmpty')}</Hint>}
    </Section>
    <Section title={t('studio.mem.notebookTitle')} count={notebook.counts.total} icon="clock">
      <div className="dt-stats">
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.mem.nbPending')}</span><span className="dt-stat-value">{notebook.counts.pending}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.mem.nbAsked')}</span><span className="dt-stat-value">{notebook.counts.asked}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.mem.nbResolved')}</span><span className="dt-stat-value">{notebook.counts.resolved}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.mem.nbDue')}</span><span className="dt-stat-value">{notebook.counts.dueReminders}</span></span>
      </div>
      {nbItems.length > 0 && <ul className="dt-list">{nbItems.map(item => <li key={item.id} className="dt-row">
        <div className="dt-row-main">
          <div className="dt-row-title">{item.question}</div>
          <div className="dt-row-meta"><Tag tone="neutral">{item.status}</Tag><Tag tone="outline">{item.kind}</Tag>{item.due && <Tag tone="warning">{t('studio.mem.dueTag')}</Tag>}</div>
        </div>
      </li>)}</ul>}
    </Section>
  </>
}
