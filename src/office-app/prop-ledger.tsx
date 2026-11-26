/** 前台《门禁规章册》器物面板：展示判据准入印章、阶段战绩、安全升阶控制与只读 LEDGER.md 卷轴。 */
import { type CSSProperties, useCallback, useEffect, useState } from 'react'
import type { DiscoveredDepositRecord, Stage } from '../judgement/index.ts'
import type { DepositProjectionItem, DepositsProjectionView } from '../projection/types.ts'
import { DiegeticModal, OFFICE_THEME, officeCall } from './office-api.tsx'

const STAGES: readonly Stage[] = ['shadow', 'observe', 'enforce', 'retired']

interface MergedRule {
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

function mergeRules(proj: readonly DepositProjectionItem[], records: readonly DiscoveredDepositRecord[]): MergedRule[] {
  const map = new Map<string, MergedRule>()
  const empty = { triggers: 0, allow: 0, deny: 0, unmeasured: 0 }
  for (const p of proj) {
    map.set(p.id, {
      id: p.id, kind: p.kind, point: p.point, stage: p.stage ?? 'shadow', enforce: Boolean(p.enforce),
      admitted: p.admitted, casesCount: p.casesCount, stats: p.stats,
      ...(p.violations?.length ? { error: p.violations.map(v => v.reason).join('; ') } : {}),
    })
  }
  for (const r of records) {
    const prev = map.get(r.id)
    map.set(r.id, {
      id: r.id, kind: r.kind ?? prev?.kind, point: r.point ?? prev?.point, signal: r.signal,
      stage: r.stage, enforce: r.enforce, admitted: r.status !== 'rejected' && r.status !== 'failed-cases',
      status: r.status, casesCount: r.casesCount, stats: prev?.stats ?? empty,
      ...(r.error ?? prev?.error ? { error: r.error ?? prev?.error } : {}),
    })
  }
  return [...map.values()]
}

const cardStyle: CSSProperties = {
  background: '#E8D8BE', border: `1px solid ${OFFICE_THEME.woodMid}`, borderRadius: 4, padding: 10, marginBottom: 8,
}
const stampStyle = (active: boolean, disabled = false): CSSProperties => ({
  padding: '3px 8px', borderRadius: 3, fontSize: 11, cursor: disabled ? 'not-allowed' : 'pointer',
  border: `1px solid ${active ? OFFICE_THEME.inkDark : OFFICE_THEME.woodMid}`,
  background: active ? OFFICE_THEME.woodDark : '#EFE3CE',
  color: active ? OFFICE_THEME.inkCream : OFFICE_THEME.inkDark,
  opacity: disabled && !active ? 0.45 : 1,
})

/** 前台《门禁规章册》：羊皮纸账册风格，支持阶段切换与反例规则 D5 禁升强制锁定。 */
export function PropLedger({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged?: () => void }) {
  const [data, setData] = useState<{ proj: DepositsProjectionView; records: readonly DiscoveredDepositRecord[]; markdown: string } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState('')
  const [ledgerOpen, setLedgerOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const [proj, ledger] = await Promise.all([officeCall('GET projection/deposits'), officeCall('GET deposits/ledger')])
      setData({ proj, records: ledger.records, markdown: ledger.markdown })
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { if (open) void load() }, [open, load])

  const changeStage = async (id: string, toStage: Stage) => {
    setBusyId(id); setNotice('')
    try {
      const res = await officeCall('POST deposits/:id/stage', { id, body: { toStage } })
      setNotice(res.ok ? `已将 ${id} 盖章切换至 ${toStage}` : res.reason)
      if (res.ok) { await load(); onChanged?.() }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally { setBusyId('') }
  }

  const items = data ? mergeRules(data.proj.items, data.records) : []

  return (
    <DiegeticModal open={open} title="门禁规章册" subtitle="前台 · 注册表真源与三态判据战绩" variant="parchment" onClose={onClose}>
      {error && <p style={{ color: '#9E2A2B', margin: '0 0 8px' }}>加载失败：{error}</p>}
      {notice && <p style={{ background: '#EFE3CE', border: `1px solid ${OFFICE_THEME.woodMid}`, padding: '6px 10px', margin: '0 0 10px', fontSize: 12 }}>{notice}</p>}
      {!data ? <p>翻阅规章册中…</p> : <>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '8px 10px', background: '#E5D1B3', border: `1px solid ${OFFICE_THEME.woodMid}`, borderRadius: 4, marginBottom: 12, fontSize: 12 }}>
          <span>总规章：<strong>{Math.max(data.proj.total, items.length)}</strong></span>
          <span>已准入：<strong>{data.proj.admittedCount || items.filter(i => i.admitted).length}</strong></span>
          <span>总触发：<strong>{data.proj.totalTriggers}</strong></span>
          <span>放行 allow：<strong>{data.proj.allowCount}</strong></span>
          <span>拦截 deny：<strong>{data.proj.denyCount}</strong></span>
          <span>不可测 unmeasured：<strong>{data.proj.unmeasuredCount}</strong></span>
        </div>
        {items.length === 0 ? <p style={{ opacity: 0.75 }}>暂无已注册规章。</p> : items.map(item => {
          const d5Locked = item.kind === 'counter-rule' || !item.enforce
          return (
            <div key={item.id} style={cardStyle}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <strong style={{ fontSize: 13 }}>{item.id}</strong>
                <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 3, background: item.admitted ? '#C8DEC4' : '#E7B9B5', border: `1px solid ${OFFICE_THEME.woodDark}` }}>
                  {item.admitted ? '已准入' : '未准入'}
                </span>
                <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 3, background: '#D5C0A1', border: `1px solid ${OFFICE_THEME.woodMid}` }}>
                  阶段：{item.stage}
                </span>
                {item.kind && <span style={{ fontSize: 11, opacity: 0.8 }}>{item.kind}</span>}
                {d5Locked && <span style={{ fontSize: 11, color: '#8A3B12', fontWeight: 700 }}>D5 宪法禁升强制</span>}
              </div>
              <div style={{ fontSize: 12, opacity: 0.88, marginBottom: 6 }}>
                挂载点：<code>{item.point ?? item.signal ?? '未指定'}</code> · 夹具 {item.casesCount} · triggers {item.stats.triggers} / allow {item.stats.allow} / deny {item.stats.deny} / unmeasured {item.stats.unmeasured}
              </div>
              {item.error && <p style={{ color: '#9E2A2B', fontSize: 11, margin: '0 0 6px' }}>{item.error}</p>}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {STAGES.map(stage => {
                  const locked = d5Locked && stage === 'enforce'
                  const disabled = busyId === item.id || item.stage === stage || locked
                  return (
                    <button key={stage} type="button" disabled={disabled} style={stampStyle(item.stage === stage, disabled)}
                      title={locked ? 'D5 宪法禁升强制' : `切换至 ${stage}`}
                      onClick={() => { void changeStage(item.id, stage) }}>
                      {stage}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
        <div style={{ marginTop: 12 }}>
          <button type="button" style={stampStyle(ledgerOpen)} onClick={() => setLedgerOpen(v => !v)}>
            {ledgerOpen ? '收起 LEDGER.md 原文卷轴' : '展开 LEDGER.md 原文卷轴'}
          </button>
          {ledgerOpen && <pre style={{ marginTop: 8, padding: 10, background: '#EFE3CE', border: `1px solid ${OFFICE_THEME.woodMid}`, borderRadius: 4, fontSize: 11, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>{data.markdown}</pre>}
        </div>
      </>}
    </DiegeticModal>
  )
}
