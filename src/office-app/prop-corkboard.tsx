/** 后墙《体检与校准软木板》：L1-L13 摩擦标签网格、四分类归因、Rung 1 候选草案、TemperatureScaler/ECE、LOO 消融与 Holdout 开封。 */
import { type CSSProperties, type FormEvent, useCallback, useEffect, useState } from 'react'
import type { ApiRequest, ApiResponse } from '../app/api.ts'
import type { RsiWorkbenchView } from '../app/governance-ops.ts'
import type { FourWayAttribution } from '../rsi/types.ts'
import { DiegeticModal, OFFICE_THEME, officeCall } from './office-api.tsx'
import { DIEGETIC_LIGHT_INPUT, DIEGETIC_PARCHMENT_CARD, nineSliceButtonStyle } from './ui-skin.tsx'

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

const pinCard: CSSProperties = { ...DIEGETIC_PARCHMENT_CARD, padding: 10 }
const inputStyle: CSSProperties = { ...DIEGETIC_LIGHT_INPUT, fontSize: 11 }
const btnStyle: CSSProperties = nineSliceButtonStyle(false, false, 'gold')
const pct = (v: number | undefined) => v === undefined ? 'unmeasured' : `${(v * 100).toFixed(1)}%`

/** 后墙《体检与校准软木板》：4 张软木钉板卡片展示在线体检、ECE 校准与 LOO/Holdout 实证。 */
export function PropCorkboard({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged?: () => void }) {
  const [wb, setWb] = useState<RsiWorkbenchView | null>(null)
  const [error, setError] = useState('')
  const [ablationJson, setAblationJson] = useState(() => JSON.stringify(DEFAULT_ABLATION_CASES, null, 2))
  const [ablationRes, setAblationRes] = useState<ApiResponse<'POST rsi/ablation'>>()
  const [candidateId, setCandidateId] = useState('candidate-v1')
  const [point, setPoint] = useState('verify.changed-paths')
  const [holdoutRes, setHoldoutRes] = useState<ApiResponse<'POST rsi/holdout'>>()
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (mode?: 'production' | 'e2e') => {
    try {
      setWb(mode ? await officeCall('GET rsi/workbench', { query: { mode } }) : await officeCall('GET rsi/workbench'))
      setError('')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])

  useEffect(() => { if (open) void load() }, [open, load])

  const runAblation = async () => {
    setBusy(true); setError('')
    try {
      const cases = JSON.parse(ablationJson) as ApiRequest<'POST rsi/ablation'>['body']['cases']
      setAblationRes(await officeCall('POST rsi/ablation', { body: { cases } }))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const runHoldout = async (e: FormEvent) => {
    e.preventDefault()
    if (!candidateId.trim() || !point.trim()) return
    setBusy(true); setError('')
    try {
      const res = await officeCall('POST rsi/holdout', { body: { candidateId: candidateId.trim(), point: point.trim(), cases: DEFAULT_HOLDOUT_CASES } })
      setHoldoutRes(res)
      if (res.ok) { await load(); onChanged?.() }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  return (
    <DiegeticModal open={open} title="体检与校准软木板" subtitle="后墙 · L1–L13 摩擦、ECE 校准与 LOO/Holdout 实证" variant="cork" width={940} onClose={onClose}>
      {error && <p style={{ ...DIEGETIC_PARCHMENT_CARD, backgroundColor: '#9E2F2C', color: OFFICE_THEME.inkCream, margin: '0 0 10px', fontSize: 12 }}>{error}</p>}
      {!wb ? <p>读取软木板钉卡中…</p> : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={pinCard}>
            <strong style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>钉卡 1 · M0 自然回填 L1–L13 摩擦标签 ({wb.snapshot.eventCount} 条)</strong>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, fontSize: 11 }}>
              {Object.entries(wb.snapshot.labelCounts).map(([label, cnt]) => (
                <div key={label} style={{ background: OFFICE_THEME.parchment, padding: '3px 6px', border: `1px solid ${OFFICE_THEME.woodMid}` }}>
                  <code>{label}</code>: <strong>{cnt}</strong>
                </div>
              ))}
            </div>
          </div>
          <div style={pinCard}>
            <strong style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>钉卡 2 · 四分类归因与双分母比率</strong>
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
              <thead><tr><th align="left">归因</th><th align="right">计数</th><th align="right">每工单({wb.snapshot.attribution.totalTickets})</th><th align="right">每工具({wb.snapshot.attribution.totalToolExecutions})</th></tr></thead>
              <tbody>{ATTRIBUTIONS.map(a => (
                <tr key={a}>
                  <td><code>{a}</code></td><td align="right">{wb.snapshot.attribution.counts[a]}</td>
                  <td align="right">{pct(wb.snapshot.attribution.ratePerTicket[a])}</td>
                  <td align="right">{pct(wb.snapshot.attribution.ratePerToolExecution[a])}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div style={pinCard}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>钉卡 3 · 根因前筛 · 候选草案 &amp; ECE</strong>
              <button type="button" className="dsh-px-btn" style={{ ...btnStyle, fontSize: 10, padding: '2px 6px' }} onClick={() => { void load(wb.collectionMode === 'production' ? 'e2e' : 'production') }}>
                {wb.collectionMode === 'production' ? '切至 E2E 前筛' : '切至 3日生产档'}
              </button>
            </div>
            {(wb.routedClusters?.length ?? 0) > 0 && (
              <div style={{ display: 'grid', gap: 3, marginBottom: 6, fontSize: 10 }}>
                {wb.routedClusters!.slice(0, 6).map(({ cluster: c, decision }) => (
                  <div key={c.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 4, background: OFFICE_THEME.parchment, border: `1px solid ${OFFICE_THEME.woodMid}`, padding: '2px 5px' }}>
                    <span><code>{c.key}</code> (seen={c.refs.length}{c.explainedSymptoms.length > 0 ? `, 折叠=${c.explainedSymptoms.length}` : ''})</span>
                    <strong style={{ color: decision.tier === 'human_spec_ruling' ? OFFICE_THEME.needsDecision : OFFICE_THEME.inkDark }}>{decision.tier}</strong>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 11, marginBottom: 6 }}>
              T={wb.scaler.temperature.toFixed(3)} · b={wb.scaler.bias.toFixed(3)} · samples {wb.scaler.sampleCount} · ECE: <strong>{wb.calibration.ece !== undefined ? wb.calibration.ece.toFixed(4) : 'unmeasured'}</strong>
            </div>
            {wb.calibration.bins.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6, fontSize: 10 }}>
                {wb.calibration.bins.map(b => (
                  <span key={b.binIndex} style={{ background: OFFICE_THEME.parchment, border: `1px solid ${OFFICE_THEME.woodMid}`, padding: '2px 5px' }}>
                    #{b.binIndex} [{b.lower.toFixed(1)},{b.upper.toFixed(1)}] n={b.count} emp={b.empiricalRate.toFixed(2)}
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: 'grid', gap: 4 }}>
              {wb.snapshot.candidateDrafts.length === 0 ? <span style={{ fontSize: 11, opacity: 0.75 }}>暂无 Seen&gt;=3 候选草案。</span> : wb.snapshot.candidateDrafts.map(d => (
                <button key={d.id} type="button" className="dsh-px-btn" title="点击带入右侧 Holdout 验证"
                  onClick={() => { setCandidateId(d.id); setPoint(d.point) }}
                  style={{ background: OFFICE_THEME.parchment, border: `1px solid ${OFFICE_THEME.borderGold}`, padding: '4px 6px', fontSize: 11, textAlign: 'left', color: OFFICE_THEME.inkDark, cursor: 'pointer', width: '100%' }}>
                  <strong>{d.id}</strong> [{d.point}] ({d.stage ?? 'shadow'}): {d.intent}
                </button>
              ))}
            </div>
          </div>
          <div style={pinCard}>
            <strong style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>钉卡 4 · LOO 消融与密封 Holdout 验证</strong>
            <textarea aria-label="LOO 消融样例" rows={3} style={{ ...inputStyle, fontFamily: 'monospace', marginBottom: 6 }} value={ablationJson} onChange={e => setAblationJson(e.target.value)} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <button type="button" className="dsh-px-btn" disabled={busy} style={btnStyle} onClick={() => { void runAblation() }}>运行全注册表消融 (LOO)</button>
              {ablationRes && <span style={{ fontSize: 11 }}>cases {ablationRes.baseline.totalCases} · catches {ablationRes.baseline.catches} · net {ablationRes.baseline.netBenefit.toFixed(2)}</span>}
            </div>
            {ablationRes && (
              <div style={{ fontSize: 11, background: OFFICE_THEME.parchment, border: `1px solid ${OFFICE_THEME.woodMid}`, padding: 6, marginBottom: 8 }}>
                冗余：{ablationRes.redundantGateIds.join(', ') || '无'} · 有害：{ablationRes.harmfulGateIds.join(', ') || '无'}
              </div>
            )}
            <form onSubmit={e => { void runHoldout(e) }} style={{ display: 'grid', gap: 6, paddingTop: 8, borderTop: `1px dashed ${OFFICE_THEME.woodMid}` }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <input aria-label="候选规则 ID" style={inputStyle} value={candidateId} onChange={e => setCandidateId(e.target.value)} placeholder="candidateId" />
                <input aria-label="挂载点" style={inputStyle} value={point} onChange={e => setPoint(e.target.value)} placeholder="point" />
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button type="submit" className="dsh-px-btn" disabled={busy} style={btnStyle}>开封密封 Holdout 验证</button>
                <span style={{ fontSize: 10 }}>已开封：{Object.keys(wb.openedHoldouts).length}</span>
              </div>
              {holdoutRes && (
                <div style={{ fontSize: 11, background: OFFICE_THEME.parchment, border: `1px solid ${OFFICE_THEME.woodMid}`, padding: 6 }}>
                  {holdoutRes.ok ? `${holdoutRes.result.verdict} (promoted=${String(holdoutRes.result.promoted)}): ${holdoutRes.result.reason}` : holdoutRes.reason}
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </DiegeticModal>
  )
}
