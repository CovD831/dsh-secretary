/** 羊皮纸质感《三段式公文纸》浮层：呈现结论 / 理由 / 影响与 M0 溯源印章。 */
import type { SecretaryFeedEntry } from '../app/tools/secretary-core.ts'
import { DiegeticModal, OFFICE_THEME } from './office-api.tsx'

export interface HandoverSheetProps {
  readonly entry: SecretaryFeedEntry | null
  readonly onClose: () => void
}

export function HandoverSheet({ entry, onClose }: HandoverSheetProps) {
  const handover = entry?.handover
  if (!entry || !handover) return null

  const sections = [
    { heading: '【结论】', body: handover.conclusion },
    { heading: '【理由】', body: handover.reason },
    { heading: '【影响】', body: handover.impact },
  ] as const

  return (
    <DiegeticModal
      open
      variant="parchment"
      title="三段式公文纸"
      subtitle={entry.at}
      width={720}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {sections.map(sec => (
          <section key={sec.heading} style={{
            padding: '10px 12px',
            borderLeft: `3px solid ${OFFICE_THEME.woodDark}`,
            background: 'rgba(255,255,255,0.22)',
          }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 14, color: OFFICE_THEME.woodDark }}>{sec.heading}</h3>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{sec.body}</p>
          </section>
        ))}

        <div style={{
          paddingTop: 10, borderTop: `1px dashed ${OFFICE_THEME.woodMid}`,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <strong style={{ fontSize: 12, color: OFFICE_THEME.woodDark }}>M0 溯源印章：</strong>
          {handover.evidenceRefs.length > 0 ? handover.evidenceRefs.map(ref => (
            <span key={ref} style={{
              background: OFFICE_THEME.woodDark, color: OFFICE_THEME.parchment,
              border: `1px solid ${OFFICE_THEME.borderGold}`, borderRadius: 2, padding: '2px 8px', fontSize: 12,
            }}>
              {ref}
            </span>
          )) : <span style={{ fontSize: 12, opacity: 0.7 }}>无附加溯源印章</span>}
        </div>
      </div>
    </DiegeticModal>
  )
}
