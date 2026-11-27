/** 秘书手边《皮质备忘手账》：真实感三指标、M1-M3 手写批注纠偏、工单原文便利贴审批与 M6 待办提醒。 */
import { type CSSProperties, type FormEvent, useCallback, useEffect, useState } from 'react'
import type { MemoryStudioEntryRow, MemoryStudioView } from '../app/governance-ops.ts'
import type { M2Kind } from '../memory/types.ts'
import type { NotebookProjectionView } from '../projection/types.ts'
import { DiegeticModal, OFFICE_THEME, officeCall } from './office-api.tsx'
import { DIEGETIC_LIGHT_INPUT, DIEGETIC_PARCHMENT_CARD, nineSliceButtonStyle } from './ui-skin.tsx'

const M2_KINDS: readonly M2Kind[] = ['preference', 'veto', 'shared_event', 'internal_moniker', 'correction_repair']
const toSlug = (raw: string, fallback: string): string =>
  raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 64) || fallback

const pageStyle: CSSProperties = { ...DIEGETIC_PARCHMENT_CARD, padding: 10 }
const inputStyle: CSSProperties = DIEGETIC_LIGHT_INPUT
const btnStyle = (primary = false): CSSProperties => nineSliceButtonStyle(primary)

/** 秘书手边《皮质备忘手账》：双栏羊皮纸手账，严禁直写 M4。 */
export function PropNotebook({ open, activeWorkspaceId, onClose, onChanged }: { open: boolean; activeWorkspaceId?: string; onClose: () => void; onChanged?: () => void }) {
  const [data, setData] = useState<{ studio: MemoryStudioView; notebook: NotebookProjectionView } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [layer, setLayer] = useState<'m1' | 'm2' | 'm3'>('m2')
  const [statement, setStatement] = useState('')
  const [topicKey, setTopicKey] = useState('')
  const [m2Kind, setM2Kind] = useState<M2Kind | ''>('')
  const [workspaceKey, setWorkspaceKey] = useState('')
  const [slug, setSlug] = useState('')
  const [resident, setResident] = useState(false)
  const [overrideTombstone, setOverrideTombstone] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [studio, notebook] = await Promise.all([officeCall('GET memory/studio'), officeCall('GET projection/notebook')])
      setData({ studio, notebook }); setError('')
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])

  useEffect(() => { if (open) void load() }, [open, load])

  const submitDirect = async (e: FormEvent) => {
    e.preventDefault()
    if (!statement.trim() || busy) return
    setBusy(true); setNotice('')
    try {
      const resolvedSlug = toSlug(slug || topicKey, 'notes')
      const resolvedWs = toSlug(workspaceKey, 'default')
      const res = await officeCall('POST memory/direct', {
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
        setStatement(''); setNotice(`手写批注已落盘 (#${res.sourceRef.seq})`)
        await load(); onChanged?.()
      } else { setNotice(res.writeResult.detail) }
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const decidePatch = async (index: number, decision: 'approve' | 'dismiss') => {
    setBusy(true); setNotice('')
    try {
      const res = await officeCall('POST memory/patches/:index', { index: String(index), body: { decision } })
      setNotice(res.ok ? `便利贴 #${index} 已${decision === 'approve' ? '准入归档' : '撕掉忽略'}` : (res.reason ?? '操作失败'))
      if (res.ok) { await load(); onChanged?.() }
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const tombstoneEntry = async (row: MemoryStudioEntryRow) => {
    setBusy(true); setNotice('')
    try {
      const parts = row.relPath.replace(/\.md$/, '').split('/')
      const target = row.layer === 'm3' && parts[1] && parts[2]
        ? { layer: 'm3' as const, workspaceKey: parts[1], slug: parts[2] }
        : row.layer === 'm1' && parts[1] ? { layer: 'm1' as const, slug: parts[1] } : { layer: row.layer }
      const res = await officeCall('POST memory/entries/:id/tombstone', { id: row.entry.id, body: { ...target, reason: 'notebook manual tombstone' } })
      setNotice(res.ok ? `条目 ${row.entry.id} 已作废归档` : (res.reason ?? '作废失败'))
      if (res.ok) { await load(); onChanged?.() }
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const runDreamNow = async () => {
    setBusy(true); setNotice('')
    try {
      const res = await officeCall('POST memory/dream', { body: { force: true } })
      setNotice(`梦境整理结束：+${res.accepted} 条新记忆、M4 +${res.promotedM4}、常驻降级 ${res.demotedResident}`)
      await load(); onChanged?.()
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const m13 = data ? data.studio.entries.filter(r => r.layer === 'm1' || r.layer === 'm2' || r.layer === 'm3') : []
  const nbItems = data ? [...data.notebook.groups.pending, ...data.notebook.groups.asked, ...data.notebook.groups.resolved] : []

  return (
    <DiegeticModal open={open} title="皮质备忘手账" subtitle="秘书手边 · M1–M3 批注与 M6 待办账本" variant="parchment" width={940} onClose={onClose}>
      {error && <p style={{ color: '#9E2F2C', margin: '0 0 8px' }}>加载失败：{error}</p>}
      {notice && <p style={{ ...DIEGETIC_PARCHMENT_CARD, backgroundColor: OFFICE_THEME.parchment, margin: '0 0 10px', fontSize: 12 }}>{notice}</p>}
      {!data ? <p>摊开皮质手账中…</p> : <>
        <div style={{ ...DIEGETIC_PARCHMENT_CARD, backgroundColor: OFFICE_THEME.parchment, display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 12, fontSize: 12, alignItems: 'center' }}>
          <span>重复提问率：<strong>{(data.studio.metrics.repeatQuestionRate * 100).toFixed(1)}%</strong> ({data.studio.metrics.repeatQuestions}/{data.studio.metrics.totalQuestions})</span>
          <span>误召回数：<strong>{data.studio.metrics.falseRecallCount}</strong></span>
          <span>周纠偏数：<strong>{data.studio.metrics.weeklyCorrectedMemories}</strong> ({data.studio.metrics.windowDays}d)</span>
          <button type="button" className="dsh-px-btn" disabled={busy} style={{ ...btnStyle(false), marginLeft: 'auto' }} onClick={() => { void runDreamNow() }}>整理梦境</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={pageStyle}>
            <strong style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>左页 · M1–M3 记忆条与手写批注纠偏</strong>
            <form onSubmit={e => { void submitDirect(e) }} style={{ display: 'grid', gap: 6, marginBottom: 10, paddingBottom: 10, borderBottom: `1px dashed ${OFFICE_THEME.woodMid}` }}>
              <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr', gap: 6 }}>
                <select aria-label="记忆层级" style={inputStyle} value={layer} onChange={e => {
                  const next = e.target.value as 'm1' | 'm2' | 'm3'
                  setLayer(next)
                  if (next === 'm3' && !workspaceKey.trim() && activeWorkspaceId) setWorkspaceKey(activeWorkspaceId)
                }}>
                  <option value="m2">m2</option><option value="m1">m1</option><option value="m3">m3</option>
                </select>
                <input aria-label="主题键" style={inputStyle} placeholder="topicKey" value={topicKey} onChange={e => setTopicKey(e.target.value)} />
                <select aria-label="M2 类型" style={{ ...inputStyle, display: layer === 'm2' ? undefined : 'none' }} value={m2Kind} onChange={e => setM2Kind(e.target.value as M2Kind | '')}>
                  <option value="">m2Kind (可选)</option>
                  {M2_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
              </div>
              <textarea aria-label="批注内容" required rows={2} style={inputStyle} placeholder="手写批注纠偏内容…" value={statement} onChange={e => setStatement(e.target.value)} />
              <div style={{ display: layer === 'm2' ? 'none' : 'grid', gridTemplateColumns: layer === 'm3' ? '1fr 1fr' : '1fr', gap: 6 }}>
                <input aria-label="工作区键" style={{ ...inputStyle, display: layer === 'm3' ? undefined : 'none' }} placeholder="workspaceKey (m3)" value={workspaceKey} onChange={e => setWorkspaceKey(e.target.value)} />
                <input aria-label="条目标识" style={{ ...inputStyle, display: layer === 'm1' || layer === 'm3' ? undefined : 'none' }} placeholder="slug (m1/m3)" value={slug} onChange={e => setSlug(e.target.value)} />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 11 }}>
                <label><input type="checkbox" checked={resident} onChange={e => setResident(e.target.checked)} /> 常驻 resident</label>
                <label><input type="checkbox" checked={overrideTombstone} onChange={e => setOverrideTombstone(e.target.checked)} /> 覆写墓碑</label>
                <button type="submit" className="dsh-px-btn" disabled={busy || !statement.trim()} style={{ ...nineSliceButtonStyle(false, busy || !statement.trim(), 'gold'), marginLeft: 'auto' }}>落笔归档</button>
              </div>
            </form>
            <div style={{ maxHeight: 240, overflowY: 'auto', display: 'grid', gap: 6 }}>
              {m13.length === 0 ? <span style={{ fontSize: 12, opacity: 0.75 }}>暂无 M1–M3 实体记忆。</span> : m13.map(row => (
                <div key={row.entry.id} style={{ ...DIEGETIC_PARCHMENT_CARD, backgroundColor: OFFICE_THEME.parchment, padding: 6, fontSize: 11 }}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 2, alignItems: 'center' }}>
                    <strong>[{row.layer}]</strong>
                    <span>{row.entry.topicKey ?? row.entry.m2Kind ?? row.entry.scope}</span>
                    {row.entry.resident && <span>★常驻</span>}
                    {row.entry.validTo && <span style={{ color: '#9E2F2C' }}>已墓碑</span>}
                    <span style={{ marginLeft: 'auto', opacity: 0.75 }}>#{row.entry.sourceRef.seq}</span>
                    {!row.entry.validTo && <button type="button" className="dsh-px-btn" disabled={busy} style={{ ...btnStyle(false), padding: '1px 6px', fontSize: 10 }} onClick={() => { void tombstoneEntry(row) }}>作废</button>}
                  </div>
                  <div>{row.entry.statement}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={pageStyle}>
            <strong style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>右页 · 工单原文便利贴审批 ({data.studio.pendingPatches.length})</strong>
            <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
              {data.studio.pendingPatches.length === 0 ? <span style={{ fontSize: 12, opacity: 0.75 }}>暂无待审批便利贴。</span> : data.studio.pendingPatches.map((p, idx) => (
                <div key={`${p.targetRelPath}-${idx}`} style={{ ...DIEGETIC_PARCHMENT_CARD, backgroundColor: OFFICE_THEME.parchment, outline: `2px solid ${OFFICE_THEME.borderGold}`, padding: 8, fontSize: 11 }}>
                  <div style={{ opacity: 0.8, marginBottom: 3 }}>[{p.layer}] {p.targetRelPath} · #{p.sourceRef.seq}</div>
                  {p.verbatimQuote && <blockquote style={{ margin: '0 0 4px', paddingLeft: 6, borderLeft: `2px solid ${OFFICE_THEME.woodDark}`, opacity: 0.9 }}>{p.verbatimQuote}</blockquote>}
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{p.statement}</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="dsh-px-btn" disabled={busy} style={nineSliceButtonStyle(false, busy, 'approve')} onClick={() => { void decidePatch(idx, 'approve') }}>准入归档</button>
                    <button type="button" className="dsh-px-btn" disabled={busy} style={btnStyle(false)} onClick={() => { void decidePatch(idx, 'dismiss') }}>撕掉忽略</button>
                  </div>
                </div>
              ))}
            </div>
            <strong style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>M6 待办与到期提醒</strong>
            <div style={{ fontSize: 11, marginBottom: 6 }}>
              pending {data.notebook.counts.pending} · asked {data.notebook.counts.asked} · resolved {data.notebook.counts.resolved} · 到期 {data.notebook.counts.dueReminders}
            </div>
            <div style={{ maxHeight: 160, overflowY: 'auto', display: 'grid', gap: 4 }}>
              {nbItems.length === 0 ? <span style={{ fontSize: 11, opacity: 0.75 }}>暂无 M6 待办或到期提醒。</span> : nbItems.map(item => (
                <div key={item.id} style={{ ...DIEGETIC_PARCHMENT_CARD, backgroundColor: OFFICE_THEME.parchment, padding: 6, fontSize: 11 }}>
                  <span>[{item.status}/{item.kind}] {item.question}</span>
                  {item.due && <strong style={{ marginLeft: 6, color: '#9E2F2C' }}>已到期</strong>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </>}
    </DiegeticModal>
  )
}
