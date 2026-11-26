/** 四大场景治理器物浮层总入口（规章册 / 皮质备忘手账 / 软木体检板 / 机要文件柜），由 Phase O4 填充完整器物实现。 */
import { DiegeticModal } from './office-api.tsx'

export type GovernancePropKind = 'ledger' | 'notebook' | 'corkboard' | 'cabinet'

export interface PropsDrawerProps {
  readonly activeProp: GovernancePropKind | null
  readonly onClose: () => void
  readonly onChanged?: () => void
}

export function PropsDrawer({ activeProp, onClose }: PropsDrawerProps) {
  if (!activeProp) return null
  return (
    <DiegeticModal open title={activeProp} onClose={onClose}>
      <p>加载器物内容中…</p>
    </DiegeticModal>
  )
}
