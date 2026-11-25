/** Multi-workspace isolation, repository, CoW, approval tier, and verification settings panel. */
import type { IsolationTier } from '../judgement/types.ts'
import type { ApprovalMode } from '../policy.ts'
import { LIMITS } from '../limits.ts'
import type { Settings } from './api.ts'
import { Button, Icon, Input } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { Field, Fields, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Hint } from './widgets.tsx'

type WorkspaceSaved = NonNullable<Settings['workspaces']>[number]

interface WorkspaceDraft {
  id: string
  repository: string
  baseBranch: string
  branchPrefix: string
  isolation: IsolationTier
  approvalMode: '' | ApprovalMode
  cowPaths: string
  verifyCommands: string
  prepare: string
  source: string
}

const ISOLATIONS: readonly IsolationTier[] = ['I1', 'I2', 'I3', 'I4', 'I5']
const APPROVAL_MODES: readonly ApprovalMode[] = ['always-ask', 'smart-auto', 'full-trust']

const toDraft = (w: WorkspaceSaved): WorkspaceDraft => ({
  id: w.id, repository: w.repository, baseBranch: w.baseBranch, branchPrefix: w.branchPrefix,
  isolation: w.isolation, approvalMode: w.approvalMode ?? '',
  cowPaths: (w.cowPaths ?? []).join(' '), verifyCommands: (w.verifyCommands ?? []).join('\n'),
  prepare: w.prepare ?? '', source: w.source ?? '',
})

const fromDraft = (w: WorkspaceDraft): WorkspaceSaved => {
  const cowPaths = w.cowPaths.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  const verifyCommands = w.verifyCommands.split('\n').map(s => s.trim()).filter(Boolean)
  return {
    id: w.id.trim(), repository: w.repository.trim(), baseBranch: w.baseBranch.trim(), branchPrefix: w.branchPrefix.trim(),
    isolation: w.isolation,
    ...(w.source.trim() ? { source: w.source.trim() } : {}),
    ...(w.prepare.trim() ? { prepare: w.prepare } : {}),
    ...(w.approvalMode ? { approvalMode: w.approvalMode } : {}),
    ...(cowPaths.length ? { cowPaths } : {}),
    ...(verifyCommands.length ? { verifyCommands } : {}),
  }
}

/** Settings block editor for `workspaces` (`PUT settings/workspaces`). */
export function WorkspacesSettings() {
  const { t } = usePanel()
  const { blocks } = useSettings().settings
  const saved = (blocks.workspaces.value ?? []).map(toDraft)
  const draft = useBlockDraft('workspaces', saved, blocks.workspaces.revision, items => items.map(fromDraft))
  const list = draft.value
  const update = (idx: number, patch: Partial<WorkspaceDraft>) =>
    draft.edit(list.map((item, i) => i === idx ? { ...item, ...patch } : item))
  const addWorkspace = () => draft.edit([...list, {
    id: `ws-${list.length + 1}`, repository: '', baseBranch: 'main', branchPrefix: 'agent/',
    isolation: 'I2', approvalMode: '', cowPaths: '', verifyCommands: '', prepare: '', source: '',
  }])

  return <form className="dt-form" onSubmit={e => { void draft.submit(e) }}>
    <Hint>{t('ws.intro')}</Hint>
    <div className="dt-actions">
      <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />} onClick={addWorkspace}>{t('ws.add')}</Button>
    </div>
    <Fields disabled={draft.busy}>
      {!list.length ? <Hint>{t('ws.empty')}</Hint> : list.map((ws, idx) => <div key={idx} className="dt-card">
        <div className="dt-card-head">
          <span className="dt-row-title dt-mono">{ws.id || `#${idx + 1}`}</span>
          <Button variant="ghost" size="sm" icon={<Icon name="trash" size={14} />}
            onClick={() => draft.edit(list.filter((_, i) => i !== idx))}>{t('ws.remove')}</Button>
        </div>
        <div className="dt-grid2">
          <Field label={t('ws.id')}>
            <Input className="dt-mono" required value={ws.id} placeholder="app-main" spellCheck={false}
              onChange={e => update(idx, { id: e.target.value })} />
          </Field>
          <Field label={t('ws.repository')}>
            <Input className="dt-mono" required value={ws.repository} placeholder="/srv/repos/app" spellCheck={false}
              onChange={e => update(idx, { repository: e.target.value })} />
          </Field>
        </div>
        <div className="dt-grid2">
          <Field label={t('ws.baseBranch')}>
            <Input className="dt-mono" required value={ws.baseBranch} placeholder="main" spellCheck={false}
              onChange={e => update(idx, { baseBranch: e.target.value })} />
          </Field>
          <Field label={t('ws.branchPrefix')}>
            <Input className="dt-mono" value={ws.branchPrefix} placeholder="agent/" spellCheck={false}
              onChange={e => update(idx, { branchPrefix: e.target.value })} />
          </Field>
        </div>
        <div className="dt-grid2">
          <Field label={t('ws.isolation')}>
            <select className="dt-select" value={ws.isolation} onChange={e => update(idx, { isolation: e.target.value as IsolationTier })}>
              {ISOLATIONS.map(tier => <option key={tier} value={tier}>{tier}</option>)}
            </select>
          </Field>
          <Field label={t('ws.approvalMode')}>
            <select className="dt-select" value={ws.approvalMode} onChange={e => update(idx, { approvalMode: e.target.value as '' | ApprovalMode })}>
              <option value="">{t('approvalMode.inherit')}</option>
              {APPROVAL_MODES.map(mode => <option key={mode} value={mode}>{t(`approvalMode.${mode}`)}</option>)}
            </select>
          </Field>
        </div>
        <Field label={t('ws.cowPaths')}>
          <Input className="dt-mono" value={ws.cowPaths} placeholder="node_modules .next" spellCheck={false}
            onChange={e => update(idx, { cowPaths: e.target.value })} />
        </Field>
        <Field label={t('ws.verifyCommands')}>
          <textarea className="dt-textarea dt-mono" rows={2} value={ws.verifyCommands} placeholder="pnpm test" spellCheck={false}
            onChange={e => update(idx, { verifyCommands: e.target.value })} />
        </Field>
        <Field label={t('ws.prepare')}>
          <Input className="dt-mono" maxLength={LIMITS.prepareCommand} value={ws.prepare} spellCheck={false}
            onChange={e => update(idx, { prepare: e.target.value })} />
        </Field>
      </div>)}
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}
