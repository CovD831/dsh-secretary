/** Statistical RSI workbench, TemperatureScaler ECE calibration, LOO ablation, sealed holdout opener, and F1 pixel proof card. */
import { useState, type FormEvent } from 'react'
import type { ApiRequest, ApiResponse } from '../app/api.ts'
import type { FourWayAttribution } from '../rsi/types.ts'
import { usePoll } from './api.ts'
import { Button, Input, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, LoadState, Section } from './widgets.tsx'

const ATTRIBUTIONS: readonly FourWayAttribution[] = ['missing_rule', 'wrong_rule', 'unmeasurable', 'rule_conflict']
const DEFAULT_ABLATION_CASES: ApiRequest<'POST rsi/ablation'>['body']['cases'] = [
  { id: 'ab-1', family: 'paths', point: 'verify.changed-paths', expectedOutcome: 'defect', input: { sessionDiffs: ['.env'], gitDirtyPaths: ['.env'], untrackedPaths: [], allowedPaths: ['src/**'] } },
  { id: 'ab-2', family: 'paths', point: 'verify.changed-paths', expectedOutcome: 'clean', input: { sessionDiffs: ['src/app.ts'], gitDirtyPaths: ['src/app.ts'], untrackedPaths: [], allowedPaths: ['src/**'] } },
]
const DEFAULT_HOLDOUT_CASES: ApiRequest<'POST rsi/holdout'>['body']['cases'] = [
  { id: 'h-1', family: 'f1', expectedOutcome: 'defect', input: { sessionDiffs: ['.env'], gitDirtyPaths: ['.env'], untrackedPaths: [], allowedPaths: ['src/**'] } },
  { id: 'h-2', family: 'f2', expectedOutcome: 'clean', input: { sessionDiffs: ['src/a.ts'], gitDirtyPaths: ['src/a.ts'], untrackedPaths: [], allowedPaths: ['src/**'] } },
  { id: 'h-3', family: 'f3', expectedOutcome: 'defect', input: { sessionDiffs: ['secrets.json'], gitDirtyPaths: ['secrets.json'], untrackedPaths: [], allowedPaths: ['src/**'] } },
  { id: 'h-4', family: 'f4', expectedOutcome: 'clean', input: { sessionDiffs: ['src/b.ts'], gitDirtyPaths: ['src/b.ts'], untrackedPaths: [], allowedPaths: ['src/**'] } },
]

const pct = (v: number | undefined, fallback: string) => v === undefined ? fallback : `${(v * 100).toFixed(1)}%`

/** Studio view for L1-L13 backfill, 4-way attribution, calibration ECE, LOO ablation, sealed holdout, and F1 pixel proof. */
export function StudioRsi() {
  const { t, call, notify } = usePanel()
  const { data, error, reload } = usePoll(() => Promise.all([call('GET rsi/workbench'), call('GET pixel-office/proof')]), [])

  const [ablationJson, setAblationJson] = useState(() => JSON.stringify(DEFAULT_ABLATION_CASES, null, 2))
  const [ablationRes, setAblationRes] = useState<ApiResponse<'POST rsi/ablation'>>()
  const [candidateId, setCandidateId] = useState('candidate-v1')
  const [point, setPoint] = useState('verify.changed-paths')
  const [holdoutRes, setHoldoutRes] = useState<ApiResponse<'POST rsi/holdout'>>()

  const runAblation = useAction(async () => {
    const cases = JSON.parse(ablationJson) as ApiRequest<'POST rsi/ablation'>['body']['cases']
    setAblationRes(await call('POST rsi/ablation', { body: { cases } }))
  })

  const runHoldout = async (event: FormEvent) => {
    event.preventDefault()
    if (!candidateId.trim() || !point.trim()) return
    try {
      const res = await call('POST rsi/holdout', { body: { candidateId: candidateId.trim(), point: point.trim(), cases: DEFAULT_HOLDOUT_CASES } })
      setHoldoutRes(res)
      if (!res.ok) notify(res.reason)
      else await reload()
    } catch (failure) { notify(errorText(failure)) }
  }

  if (!data) return <LoadState error={error} loading />
  const [wb, proof] = data
  const { snapshot, scaler, calibration, openedHoldouts } = wb
  const unm = t('studio.rsi.unmeasured')

  return <>
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('studio.rsi.labelsTitle')} count={snapshot.eventCount} icon="hash">
      <div className="dt-stats">
        {Object.entries(snapshot.labelCounts).map(([label, cnt]) => <span key={label} className="dt-stat">
          <span className="dt-stat-label dt-mono">{label}</span><span className="dt-stat-value">{cnt}</span>
        </span>)}
      </div>
    </Section>
    <Section title={t('studio.rsi.attrTitle')} icon="filter">
      <table className="dt-table">
        <thead><tr>
          <th>{t('sec.attribution')}</th><th>count</th>
          <th>{t('studio.rsi.perTicket', { total: snapshot.attribution.totalTickets })}</th>
          <th>{t('studio.rsi.perTool', { total: snapshot.attribution.totalToolExecutions })}</th>
        </tr></thead>
        <tbody>{ATTRIBUTIONS.map(a => <tr key={a}>
          <td>{t(`sec.attr.${a}`)}</td>
          <td>{snapshot.attribution.counts[a]}</td>
          <td>{pct(snapshot.attribution.ratePerTicket[a], unm)}</td>
          <td>{pct(snapshot.attribution.ratePerToolExecution[a], unm)}</td>
        </tr>)}</tbody>
      </table>
    </Section>
    <Section title={t('studio.rsi.draftsTitle')} count={snapshot.candidateDrafts.length} icon="plus">
      {snapshot.candidateDrafts.length ? <ul className="dt-list dt-cards">{snapshot.candidateDrafts.map(d => <li key={d.id} className="dt-card">
        <div className="dt-row-title"><span className="dt-mono">{d.id}</span><Tag tone="info">{d.point}</Tag><Tag tone="outline">{d.stage ?? 'shadow'}</Tag></div>
        <p className="dt-hint">{d.intent}</p>
      </li>)}</ul> : <Hint>{t('studio.rsi.draftsEmpty')}</Hint>}
    </Section>
    <Section title={t('studio.rsi.calibrationTitle')} icon="decision">
      <div className="dt-row-meta">
        <Tag tone={scaler.fitted ? 'success' : 'neutral'}>T={scaler.temperature.toFixed(3)} · b={scaler.bias.toFixed(3)}</Tag>
        <span>samples {scaler.sampleCount} · loss {scaler.lossBefore.toFixed(3)} → {scaler.lossAfter.toFixed(3)}</span>
        <Tag tone={calibration.state === 'measured' ? 'info' : 'warning'}>
          ECE: {calibration.ece !== undefined ? calibration.ece.toFixed(4) : unm}
        </Tag>
      </div>
      {calibration.bins.length > 0 && <table className="dt-table">
        <thead><tr><th>bin</th><th>range</th><th>count</th><th>avgConf</th><th>empirical</th></tr></thead>
        <tbody>{calibration.bins.map(b => <tr key={b.binIndex}>
          <td>{b.binIndex}</td><td>[{b.lower.toFixed(1)}, {b.upper.toFixed(1)}]</td><td>{b.count}</td>
          <td>{b.avgConfidence.toFixed(3)}</td><td>{b.empiricalRate.toFixed(3)}</td>
        </tr>)}</tbody>
      </table>}
    </Section>
    <Section title={t('studio.rsi.ablationTitle')} icon="play"
      action={<Button variant="primary" size="sm" disabled={runAblation.busy} onClick={() => { void runAblation.run() }}>{t('studio.rsi.runAblation')}</Button>}>
      <label className="dt-field">
        <span className="dt-field-head">{t('studio.rsi.ablationCases')}</span>
        <textarea className="dt-textarea dt-mono" rows={3} aria-label={t('studio.rsi.ablationCases')} value={ablationJson} onChange={e => setAblationJson(e.target.value)} />
      </label>
      {ablationRes && <div className="dt-card">
        <div className="dt-row-meta">
          <span>cases {ablationRes.baseline.totalCases} · catches {ablationRes.baseline.catches} · netBenefit {ablationRes.baseline.netBenefit.toFixed(2)}</span>
          <Tag tone="warning">{t('studio.rsi.redundant')}: {ablationRes.redundantGateIds.join(', ') || t('empty')}</Tag>
          <Tag tone="danger">{t('studio.rsi.harmful')}: {ablationRes.harmfulGateIds.join(', ') || t('empty')}</Tag>
        </div>
        {ablationRes.impacts.length > 0 && <table className="dt-table">
          <thead><tr><th>gateId</th><th>stage</th><th>evals</th><th>uniqueCatches</th><th>deltaBenefit</th></tr></thead>
          <tbody>{ablationRes.impacts.map(i => <tr key={i.gateId}>
            <td className="dt-mono">{i.gateId}</td><td>{i.stage}</td><td>{i.evaluations}</td><td>{i.uniqueCatches}</td><td>{i.deltaBenefit.toFixed(2)}</td>
          </tr>)}</tbody>
        </table>}
      </div>}
    </Section>
    <Section title={t('studio.rsi.holdoutTitle')} icon="shield">
      <form className="dt-card" onSubmit={e => { void runHoldout(e) }}>
        <div className="dt-grid2">
          <label className="dt-field"><span className="dt-field-head">{t('studio.rsi.candidateId')}</span>
            <Input aria-label={t('studio.rsi.candidateId')} value={candidateId} onChange={e => setCandidateId(e.target.value)} /></label>
          <label className="dt-field"><span className="dt-field-head">{t('studio.rsi.point')}</span>
            <Input aria-label={t('studio.rsi.point')} value={point} onChange={e => setPoint(e.target.value)} /></label>
        </div>
        <div className="dt-actions">
          <Button type="submit" variant="outline" size="sm">{t('studio.rsi.openHoldout')}</Button>
          {Object.entries(openedHoldouts).map(([id, at]) => <Tag key={id} tone="outline">{id} @ {at.slice(0, 10)}</Tag>)}
        </div>
        {holdoutRes && <p className={holdoutRes.ok ? 'dt-hint' : 'dt-error'}>
          {holdoutRes.ok ? `${holdoutRes.result.verdict} (promoted=${String(holdoutRes.result.promoted)}): ${holdoutRes.result.reason}` : holdoutRes.reason}
        </p>}
      </form>
    </Section>
    <Section title={t('studio.rsi.pixelTitle')} icon="external">
      <div className="dt-row-meta">
        <Tag tone="info">{proof.workspaceId}</Tag><Tag tone="outline">seed {proof.seed}</Tag>
        <Tag tone="outline">{proof.width}×{proof.height}</Tag><Tag tone="outline">{proof.paletteColors} colors</Tag>
      </div>
      <iframe className="dt-pixel-frame" title={t('studio.rsi.pixelTitle')} sandbox="allow-scripts" srcDoc={proof.html} />
    </Section>
  </>
}
