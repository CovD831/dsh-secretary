/** Deposits governance studio: admission status, gate trigger/verdict statistics, safe stage ladder controls, and LEDGER.md viewer. */
import { useState } from 'react'
import type { DiscoveredDepositRecord, Stage } from '../judgement/index.ts'
import type { DepositProjectionItem } from '../projection/types.ts'
import { usePoll } from './api.ts'
import { Button, DisclosureRow, Icon, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, LoadState, Section } from './widgets.tsx'

const STAGES: readonly Stage[] = ['shadow', 'observe', 'enforce', 'retired']

interface MergedDeposit {
  readonly id: string
  readonly kind?: string
  readonly point?: string
  readonly signal?: string
  readonly stage: Stage
  readonly enforce: boolean
  readonly admitted: boolean
  readonly status?: string
  readonly casesCount: number
  readonly stats: DepositProjectionItem['stats']
  readonly error?: string
}

function mergeDeposits(
  projItems: readonly DepositProjectionItem[],
  records: readonly DiscoveredDepositRecord[],
): MergedDeposit[] {
  const byId = new Map<string, MergedDeposit>()
  const empty = { triggers: 0, allow: 0, deny: 0, unmeasured: 0 }
  for (const p of projItems) {
    byId.set(p.id, {
      id: p.id, kind: p.kind, point: p.point, stage: p.stage ?? 'shadow', enforce: Boolean(p.enforce),
      admitted: p.admitted, casesCount: p.casesCount, stats: p.stats,
      ...(p.violations?.length ? { error: p.violations.map(v => v.reason).join('; ') } : {}),
    })
  }
  for (const r of records) {
    const prev = byId.get(r.id)
    byId.set(r.id, {
      id: r.id, kind: r.kind ?? prev?.kind, point: r.point ?? prev?.point, signal: r.signal,
      stage: r.stage, enforce: r.enforce, admitted: r.status !== 'rejected' && r.status !== 'failed-cases',
      status: r.status, casesCount: r.casesCount, stats: prev?.stats ?? empty,
      ...(r.error ?? prev?.error ? { error: r.error ?? prev?.error } : {}),
    })
  }
  return [...byId.values()]
}

/** Studio view for all deposit packages, stage transitions, and read-only LEDGER.md projection. */
export function StudioDeposits() {
  const { t, call, notify } = usePanel()
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const { data, error, reload } = usePoll(() => Promise.all([call('GET projection/deposits'), call('GET deposits/ledger')]), [])

  const transition = useAction(async (id: string, toStage: Stage) => {
    const res = await call('POST deposits/:id/stage', { id, body: { toStage } })
    if (!res.ok) { notify(res.reason); return }
    notify(t('studio.dep.stageChanged', { id, stage: toStage }))
  }, { reload })

  if (!data) return <LoadState error={error} loading />
  const [proj, ledger] = data
  const items = mergeDeposits(proj.items, ledger.records)

  return <>
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('studio.dep.summary')} icon="shield">
      <div className="dt-stats">
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.dep.total')}</span><span className="dt-stat-value">{Math.max(proj.total, items.length)}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.dep.admitted')}</span><span className="dt-stat-value">{proj.admittedCount || items.filter(i => i.admitted).length}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.dep.triggers')}</span><span className="dt-stat-value">{proj.totalTriggers}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.dep.allow')}</span><span className="dt-stat-value">{proj.allowCount}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.dep.deny')}</span><span className="dt-stat-value">{proj.denyCount}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('studio.dep.unmeasured')}</span><span className="dt-stat-value">{proj.unmeasuredCount}</span></span>
      </div>
    </Section>
    <Section title={t('studio.dep.list')} count={items.length} icon="queue">
      {items.length ? <ul className="dt-list dt-cards">{items.map(item => {
        const counterLocked = item.kind === 'counter-rule'
        return <li key={item.id} className="dt-card">
          <div className="dt-row-title">
            <span className="dt-mono">{item.id}</span>
            {item.kind && <Tag tone="neutral">{item.kind}</Tag>}
            <Tag tone={item.stage === 'enforce' ? 'success' : item.stage === 'retired' ? 'quiet' : 'info'}>{item.stage}</Tag>
            {item.status && <Tag tone={item.admitted ? 'outline' : 'danger'}>{item.status}</Tag>}
            {counterLocked && <Tag tone="warning">{t('studio.dep.counterLocked')}</Tag>}
          </div>
          <div className="dt-row-meta">
            {(item.point || item.signal) && <span className="dt-mono">{item.point ?? item.signal}</span>}
            <span>{t('studio.dep.cases', { count: item.casesCount })}</span>
            <span>triggers {item.stats.triggers} · allow {item.stats.allow} · deny {item.stats.deny} · unmeasured {item.stats.unmeasured}</span>
          </div>
          {item.error && <p className="dt-error">{item.error}</p>}
          <div className="dt-actions">
            {STAGES.map(stage => <Button key={stage} size="sm" variant={item.stage === stage ? 'primary' : 'outline'}
              disabled={transition.busy || item.stage === stage || (counterLocked && stage === 'enforce')}
              title={counterLocked && stage === 'enforce' ? t('studio.dep.counterLocked') : undefined}
              onClick={() => { void transition.run(item.id, stage) }}>{stage}</Button>)}
          </div>
        </li>
      })}</ul> : <Hint>{t('studio.dep.empty')}</Hint>}
    </Section>
    <DisclosureRow icon={<Icon name="review" />} title={t('studio.dep.ledgerTitle')} open={ledgerOpen} onToggle={() => setLedgerOpen(!ledgerOpen)}>
      <div className="dt-disclosure-body"><pre className="dt-pre">{ledger.markdown}</pre></div>
    </DisclosureRow>
  </>
}
