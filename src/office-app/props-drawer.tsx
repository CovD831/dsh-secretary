/** 四大场景治理器物浮层总入口：根据 activeProp 调度《门禁规章册》《皮质备忘手账》《软木体检板》《机要文件柜》。 */
import { PropCabinet } from './prop-cabinet.tsx'
import { PropCorkboard } from './prop-corkboard.tsx'
import { PropLedger } from './prop-ledger.tsx'
import { PropNotebook } from './prop-notebook.tsx'

export type GovernancePropKind = 'ledger' | 'notebook' | 'corkboard' | 'cabinet'

export interface PropsDrawerProps {
  readonly activeProp: GovernancePropKind | null
  readonly onClose: () => void
  readonly onChanged?: () => void
}

/** 调度对应器物浮层并在写操作成功后通知宿主刷新投影。 */
export function PropsDrawer({ activeProp, onClose, onChanged }: PropsDrawerProps) {
  if (!activeProp) return null
  if (activeProp === 'ledger') return <PropLedger open onClose={onClose} onChanged={onChanged} />
  if (activeProp === 'notebook') return <PropNotebook open onClose={onClose} onChanged={onChanged} />
  if (activeProp === 'corkboard') return <PropCorkboard open onClose={onClose} onChanged={onChanged} />
  return <PropCabinet open onClose={onClose} onChanged={onChanged} />
}
