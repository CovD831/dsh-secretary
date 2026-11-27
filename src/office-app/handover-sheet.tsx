/** 羊皮纸质感《三段式公文纸》浮层：呈现结论 / 理由 / 影响与 M0 溯源印章。 */
import { useEffect, useState } from 'react'
import type { SecretaryFeedEntry } from '../app/tools/secretary-core.ts'
import type { SpineEnvelope } from '../spine/types.ts'
import { DiegeticModal, OFFICE_THEME, officeCall } from './office-api.tsx'
import { DIEGETIC_PARCHMENT_CARD, nineSliceButtonStyle } from './ui-skin.tsx'

export interface HandoverSheetProps {
  readonly entry: SecretaryFeedEntry | null
  readonly onClose: () => void
}

function parseRefSeq(ref: string): number | null {
  const m = /^(?:(?:m0:|seq:)?#?)(\d+)$/i.exec(ref.trim())
  const seq = m ? Number(m[1]) : NaN
  return Number.isInteger(seq) && seq > 0 ? seq : null
}

export function HandoverSheet({ entry, onClose }: HandoverSheetProps) {
  const [selectedRef, setSelectedRef] = useState<string | null>(null)
  const [verified, setVerified] = useState<SpineEnvelope | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  useEffect(() => {
    setSelectedRef(null); setVerified(null); setVerifyError(null)
  }, [entry?.id])

  const handover = entry?.handover
  if (!entry || !handover) return null

  const inspectRef = async (ref: string) => {
    const trimmed = ref.trim()
    setSelectedRef(ref); setVerified(null); setVerifyError(null)
    const seq = parseRefSeq(trimmed)
    setVerifying(true)
    try {
      let ev: SpineEnvelope | null = null
      if (seq !== null) {
        const res = await officeCall('GET projection/spine', { query: { sinceSeq: seq - 1, limit: 1 } })
        ev = res.items.find(item => item.seq === seq) ?? null
      } else {
        const res = await officeCall('GET projection/spine', { query: { limit: 200, tail: '1' } })
        ev = res.items.find(item => item.id === trimmed) ?? null
      }
      if (!ev) setVerifyError(`未核验 (unmeasured)：M0 事件脊未命中精确信封 "${trimmed}"`)
      else setVerified(ev)
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err))
    } finally { setVerifying(false) }
  }

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
            ...DIEGETIC_PARCHMENT_CARD,
            padding: '10px 12px',
            borderLeft: `4px solid ${OFFICE_THEME.woodDark}`,
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
            <button key={ref} type="button" className="dsh-px-btn" onClick={() => { void inspectRef(ref) }} style={{
              ...nineSliceButtonStyle(selectedRef === ref),
              color: OFFICE_THEME.parchment, padding: '2px 8px', fontSize: 12,
            }}>
              {ref}
            </button>
          )) : <span style={{ fontSize: 12, opacity: 0.7 }}>无附加溯源印章</span>}
        </div>
        {selectedRef && (
          <div style={{
            ...DIEGETIC_PARCHMENT_CARD,
            backgroundColor: OFFICE_THEME.parchment,
            padding: '8px 10px', fontSize: 12,
          }}>
            {verifying && <span>核验 M0 原始信封中…</span>}
            {verifyError && <span style={{ color: OFFICE_THEME.needsDecision }}>{verifyError}</span>}
            {verified && (
              <div>
                <strong>M0 原始信封核验：</strong>
                <span>seq={verified.seq} / id={verified.id} / type={verified.type} / taint={verified.taint} / at={verified.at}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </DiegeticModal>
  )
}
