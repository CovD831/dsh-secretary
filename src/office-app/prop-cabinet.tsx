/** 墙角《机要文件柜》：三抽屉切换（工作区档案 / 沙箱审批与熔断锁 / 秘书形象 46 色 AI 量化管线）。 */
import { type CSSProperties, type FormEvent, useCallback, useEffect, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { AvatarPackSummary } from '../app/avatar-pipeline.ts'
import type { IsolationTier } from '../judgement/types.ts'
import type { ApprovalMode } from '../policy.ts'
import { DiegeticModal, OFFICE_THEME, officeCall } from './office-api.tsx'
import { DIEGETIC_DARK_INPUT, DIEGETIC_WALNUT_CARD, nineSliceButtonStyle } from './ui-skin.tsx'

type DrawerTab = 'workspaces' | 'executor' | 'avatars'
type WorkspaceItem = NonNullable<ApiResponse<'GET settings'>['blocks']['workspaces']['value']>[number]
const ISOLATIONS: readonly IsolationTier[] = ['I1', 'I2', 'I3', 'I4', 'I5']
const APPROVAL_MODES: readonly ApprovalMode[] = ['always-ask', 'smart-auto', 'full-trust']

const boxStyle: CSSProperties = { ...DIEGETIC_WALNUT_CARD, padding: 10 }
const inputStyle: CSSProperties = DIEGETIC_DARK_INPUT
const btnStyle = (active = false): CSSProperties => nineSliceButtonStyle(active)

/** 墙角《机要文件柜》：胡桃木档案风，严禁提供任何本地图片上传框。 */
export function PropCabinet({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged?: () => void }) {
  const [tab, setTab] = useState<DrawerTab>('workspaces')
  const [settings, setSettings] = useState<ApiResponse<'GET settings'> | null>(null)
  const [models, setModels] = useState<ApiResponse<'GET models'> | null>(null)
  const [paused, setPaused] = useState(false)
  const [avatars, setAvatars] = useState<{ activeId: string; items: AvatarPackSummary[] }>({ activeId: '', items: [] })
  const [wsList, setWsList] = useState<WorkspaceItem[]>([])
  const [execDraft, setExecDraft] = useState({ approvalMode: '' as '' | ApprovalMode, maxWorkers: '3', maxTurns: '', maxStallTurns: '', maxTokens: '', provider: '', model: '' })
  const [avName, setAvName] = useState('')
  const [avPrompt, setAvPrompt] = useState('')
  const [avSeed, setAvSeed] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDelIdx, setConfirmDelIdx] = useState<number | null>(null)
  const [wsDirty, setWsDirty] = useState(false)
  const [execDirty, setExecDirty] = useState(false)

  const load = useCallback(async () => {
    try {
      const [st, md, av, proj] = await Promise.all([
        officeCall('GET settings'), officeCall('GET models'), officeCall('GET avatars'), officeCall('GET projection/state'),
      ])
      setSettings(st); setModels(md); setAvatars(av); setPaused(proj.avatar.paused)
      setWsList(st.blocks.workspaces.value ?? [])
      setWsDirty(false); setExecDirty(false); setConfirmDelIdx(null)
      const ex = st.blocks.executor.value
      setExecDraft({
        approvalMode: ex.approvalMode ?? '', maxWorkers: String(ex.maxWorkers),
        maxTurns: ex.maxTurns !== undefined ? String(ex.maxTurns) : '',
        maxStallTurns: ex.maxStallTurns !== undefined ? String(ex.maxStallTurns) : '',
        maxTokens: ex.maxTokens !== undefined ? String(ex.maxTokens) : '',
        provider: ex.model?.provider ?? '', model: ex.model?.model ?? '',
      })
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) }
  }, [])

  useEffect(() => { if (open) void load() }, [open, load])

  const editWs = (idx: number, patch: Partial<WorkspaceItem>) => {
    setWsDirty(true); setWsList(p => p.map((x, i) => i === idx ? { ...x, ...patch } : x))
  }
  const editExec = (patch: Partial<typeof execDraft>) => {
    setExecDirty(true); setExecDraft(d => ({ ...d, ...patch }))
  }

  const saveWorkspaces = async (e: FormEvent) => {
    e.preventDefault()
    if (!settings) return
    setBusy(true); setNotice('')
    try {
      await officeCall('PUT settings/:block', { block: 'workspaces', body: { value: wsList, revision: settings.blocks.workspaces.revision } })
      setWsDirty(false); setConfirmDelIdx(null); setNotice('工作区档案已保存'); await load(); onChanged?.()
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const saveExecutor = async (e: FormEvent) => {
    e.preventDefault()
    if (!settings) return
    setBusy(true); setNotice('')
    try {
      const cur = settings.blocks.executor.value
      const opt = (v: string) => v.trim() ? Number(v) : undefined
      const value = {
        ...cur,
        maxWorkers: Number(execDraft.maxWorkers) || cur.maxWorkers,
        model: execDraft.provider.trim() || execDraft.model.trim() ? { provider: execDraft.provider.trim(), model: execDraft.model.trim() } : null,
        approvalMode: execDraft.approvalMode || undefined,
        maxTurns: opt(execDraft.maxTurns), maxStallTurns: opt(execDraft.maxStallTurns), maxTokens: opt(execDraft.maxTokens),
      }
      await officeCall('PUT settings/:block', { block: 'executor', body: { value, revision: settings.blocks.executor.revision } })
      setExecDirty(false); setNotice('沙箱审批与熔断锁已保存'); await load(); onChanged?.()
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const togglePause = async () => {
    setBusy(true); setNotice('')
    try {
      const res = await officeCall('POST executor/pause', { body: { paused: !paused } })
      setPaused(res.paused); setNotice(res.paused ? '全局执行器已暂停' : '全局执行器已恢复'); onChanged?.()
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const selectAvatar = async (avatarId: string) => {
    setBusy(true); setNotice('')
    try {
      const res = await officeCall('POST avatars/select', { body: { avatarId } })
      setAvatars(prev => ({ ...prev, activeId: res.activeId })); setNotice(`已切换秘书形象：${res.activeId}`); onChanged?.()
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const generateAvatar = async (e: FormEvent) => {
    e.preventDefault()
    if (!avName.trim() || !avPrompt.trim()) return
    setBusy(true); setNotice('')
    try {
      const seed = avSeed.trim() ? Number(avSeed) : undefined
      const res = await officeCall('POST avatars/generate', { body: { name: avName.trim(), prompt: avPrompt.trim(), ...(seed !== undefined ? { seed } : {}) } })
      setNotice(res.ok ? `已生成并量化入库：${res.pack?.name ?? avName}` : (res.error ?? '生成失败'))
      if (res.ok) { setAvName(''); setAvPrompt(''); setAvSeed(''); await load(); onChanged?.() }
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const switchTab = (next: DrawerTab) => { setTab(next); setNotice(''); setConfirmDelIdx(null) }
  const modelOptions = models?.groups.find(g => g.id === execDraft.provider)?.models ?? models?.groups.flatMap(g => g.models) ?? []

  return (
    <DiegeticModal open={open} title="机要文件柜" subtitle="墙角 · 工作区、沙箱熔断与秘书形象管线" variant="walnut" width={920} onClose={onClose}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button type="button" className="dsh-px-btn" style={btnStyle(tab === 'workspaces')} onClick={() => switchTab('workspaces')}>工作区档案{wsDirty ? ' ●' : ''}</button>
        <button type="button" className="dsh-px-btn" style={btnStyle(tab === 'executor')} onClick={() => switchTab('executor')}>沙箱审批与熔断锁{execDirty ? ' ●' : ''}</button>
        <button type="button" className="dsh-px-btn" style={btnStyle(tab === 'avatars')} onClick={() => switchTab('avatars')}>秘书形象定制</button>
      </div>
      {notice && <p style={{ ...DIEGETIC_WALNUT_CARD, backgroundColor: '#3A2E28', margin: '0 0 10px', fontSize: 12 }}>{notice}</p>}

      {tab === 'workspaces' && (
        <form onSubmit={e => { void saveWorkspaces(e) }} style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="dsh-px-btn" style={btnStyle()} onClick={() => { setWsDirty(true); setConfirmDelIdx(null); setWsList(prev => [...prev, { id: `ws-${prev.length + 1}`, repository: settings?.environment.root ?? '', baseBranch: 'main', branchPrefix: 'agent/', isolation: 'I2' }]) }}>新增工作区</button>
            <button type="submit" className="dsh-px-btn" disabled={busy} style={nineSliceButtonStyle(false, busy, 'gold')}>{wsDirty ? '保存工作区档案 ● 未保存' : '保存工作区档案'}</button>
          </div>
          {wsList.map((ws, idx) => (
            <div key={idx} style={{ ...boxStyle, display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>#{idx + 1} {ws.id}</strong>
                {confirmDelIdx === idx ? (
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="dsh-px-btn" onClick={() => { setWsList(prev => prev.filter((_, i) => i !== idx)); setConfirmDelIdx(null); setWsDirty(true) }} style={nineSliceButtonStyle(false, false, 'danger')}>确认删除？</button>
                    <button type="button" className="dsh-px-btn" onClick={() => setConfirmDelIdx(null)} style={btnStyle()}>取消</button>
                  </span>
                ) : (
                  <button type="button" className="dsh-px-btn" onClick={() => setConfirmDelIdx(idx)} style={nineSliceButtonStyle(false, false, 'danger')}>删除</button>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr', gap: 6 }}>
                <input aria-label={`工作区ID-${idx}`} style={inputStyle} value={ws.id} onChange={e => editWs(idx, { id: e.target.value })} placeholder="id" />
                <input aria-label={`仓库路径-${idx}`} style={inputStyle} value={ws.repository} onChange={e => editWs(idx, { repository: e.target.value })} placeholder="/abs/repo" />
                <input aria-label={`基础分支-${idx}`} style={inputStyle} value={ws.baseBranch} onChange={e => editWs(idx, { baseBranch: e.target.value })} placeholder="main" />
                <input aria-label={`分支前缀-${idx}`} style={inputStyle} value={ws.branchPrefix} onChange={e => editWs(idx, { branchPrefix: e.target.value })} placeholder="agent/" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '100px 150px 1fr 1fr 1fr', gap: 6 }}>
                <select aria-label={`隔离等级-${idx}`} style={inputStyle} value={ws.isolation} onChange={e => editWs(idx, { isolation: e.target.value as IsolationTier })}>
                  {ISOLATIONS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <select aria-label={`审批模式-${idx}`} style={inputStyle} value={ws.approvalMode ?? ''} onChange={e => editWs(idx, { approvalMode: (e.target.value || undefined) as ApprovalMode | undefined })}>
                  <option value="">继承全局</option>
                  {APPROVAL_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <input aria-label={`CoW路径-${idx}`} style={inputStyle} value={(ws.cowPaths ?? []).join(' ')} onChange={e => editWs(idx, { cowPaths: e.target.value.split(/[\s,]+/).filter(Boolean) })} placeholder="cowPaths" />
                <input aria-label={`验证命令-${idx}`} style={inputStyle} value={(ws.verifyCommands ?? []).join('; ')} onChange={e => editWs(idx, { verifyCommands: e.target.value.split(';').map(s => s.trim()).filter(Boolean) })} placeholder="verifyCommands" />
                <input aria-label={`准备命令-${idx}`} style={inputStyle} value={ws.prepare ?? ''} onChange={e => editWs(idx, { prepare: e.target.value || undefined })} placeholder="prepare" />
              </div>
            </div>
          ))}
        </form>
      )}

      {tab === 'executor' && (
        <form onSubmit={e => { void saveExecutor(e) }} style={{ ...boxStyle, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>全局执行器状态：<strong>{paused ? '已暂停' : '运行中'}</strong></span>
            <button type="button" className="dsh-px-btn" disabled={busy} style={nineSliceButtonStyle(false, busy, paused ? 'approve' : 'danger')} onClick={() => { void togglePause() }}>{paused ? '恢复执行器' : '暂停执行器'}</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            <label style={{ fontSize: 11 }}>审批模式
              <select aria-label="全局审批模式" style={inputStyle} value={execDraft.approvalMode} onChange={e => editExec({ approvalMode: e.target.value as '' | ApprovalMode })}>
                <option value="">默认</option>{APPROVAL_MODES.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 11 }}>并发上限 maxWorkers
              <input aria-label="并发上限" type="number" style={inputStyle} value={execDraft.maxWorkers} onChange={e => editExec({ maxWorkers: e.target.value })} />
            </label>
            <label style={{ fontSize: 11 }}>熔断轮次 maxTurns
              <input aria-label="熔断轮次" type="number" style={inputStyle} value={execDraft.maxTurns} onChange={e => editExec({ maxTurns: e.target.value })} />
            </label>
            <label style={{ fontSize: 11 }}>停滞阈值 maxStallTurns
              <input aria-label="停滞阈值" type="number" style={inputStyle} value={execDraft.maxStallTurns} onChange={e => editExec({ maxStallTurns: e.target.value })} />
            </label>
            <label style={{ fontSize: 11 }}>Token 熔断 maxTokens
              <input aria-label="Token熔断" type="number" style={inputStyle} value={execDraft.maxTokens} onChange={e => editExec({ maxTokens: e.target.value })} />
            </label>
            <label style={{ fontSize: 11 }}>模型 Provider / Model ({models?.groups.length ?? 0} 组)
              <div style={{ display: 'flex', gap: 4 }}>
                <input aria-label="模型Provider" list="dsh-model-providers" style={inputStyle} placeholder="provider" value={execDraft.provider} onChange={e => editExec({ provider: e.target.value })} />
                <input aria-label="模型名称" list="dsh-model-names" style={inputStyle} placeholder="model" value={execDraft.model} onChange={e => editExec({ model: e.target.value })} />
              </div>
            </label>
          </div>
          <datalist id="dsh-model-providers">{models?.groups.map(g => <option key={g.id} value={g.id} label={g.name} />)}</datalist>
          <datalist id="dsh-model-names">{modelOptions.map(m => <option key={m.id} value={m.id} label={m.name} />)}</datalist>
          <div><button type="submit" className="dsh-px-btn" disabled={busy} style={nineSliceButtonStyle(false, busy, 'gold')}>{execDirty ? '保存沙箱与熔断配置 ● 未保存' : '保存沙箱与熔断配置'}</button></div>
        </form>
      )}

      {tab === 'avatars' && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {avatars.items.map(pack => (
              <div key={pack.id} style={{ ...boxStyle, outline: avatars.activeId === pack.id ? `2px solid ${OFFICE_THEME.borderGold}` : 'none' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <img
                    src={pack.portraitUrls.neutral}
                    alt={`${pack.name} 预览`}
                    width={40}
                    height={40}
                    style={{ display: 'block', imageRendering: 'pixelated', border: `1px solid ${OFFICE_THEME.borderWood}`, flexShrink: 0 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                      <strong>{pack.name}</strong>
                      <span style={{ fontSize: 10 }}>
                        {pack.provider === 'remote-ai' ? '远程生图' : pack.provider === 'local-remix' ? '本地色板重混' : '预置'} · {pack.quantized ? '46色已量化' : '未量化'}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.8 }}>outOfPalette: {pack.outOfPaletteCount}</div>
                  </div>
                </div>
                <button type="button" className="dsh-px-btn" disabled={busy || avatars.activeId === pack.id} style={btnStyle(avatars.activeId === pack.id)} onClick={() => { void selectAvatar(pack.id) }}>
                  {avatars.activeId === pack.id ? '当前启用' : '启用此形象'}
                </button>
              </div>
            ))}
          </div>
          <form onSubmit={e => { void generateAvatar(e) }} style={{ ...boxStyle, display: 'grid', gap: 8 }}>
            <strong style={{ fontSize: 13 }}>定制新秘书形象（AI 生图 · 自动套用 46 色胡桃木像素管线量化入库，禁传本地图片）</strong>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 120px', gap: 8 }}>
              <input aria-label="形象名称" required style={inputStyle} placeholder="形象名称 name" value={avName} onChange={e => setAvName(e.target.value)} />
              <input aria-label="外观描述词" required style={inputStyle} placeholder="外观/服饰描述词 prompt" value={avPrompt} onChange={e => setAvPrompt(e.target.value)} />
              <input aria-label="随机种子" type="number" style={inputStyle} placeholder="seed (可选)" value={avSeed} onChange={e => setAvSeed(e.target.value)} />
            </div>
            <div><button type="submit" className="dsh-px-btn" disabled={busy} style={nineSliceButtonStyle(false, busy, 'gold')}>生成并量化入库</button></div>
          </form>
        </div>
      )}
    </DiegeticModal>
  )
}
