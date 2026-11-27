/** 像素办公室全局键盘快捷键（/ 聚焦发话、1/2 切换缩放、Space/0 居中、WASD/方向键漫游、Esc 收起对话）。 */
import { useEffect } from 'react'

export interface StageHotkeyHandlers {
  readonly hasModal: boolean
  readonly dialogCanCollapse: boolean
  readonly onCollapseDialog: () => void
  readonly onFocusInput: () => void
  readonly onZoom: (zoom: 1 | 2) => void
  readonly onReset: () => void
  readonly onPan: (dx: number, dy: number) => void
}

const PAN_STEP = 96

export function useStageHotkeys(handlers: StageHotkeyHandlers): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toUpperCase()
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      if (e.key === 'Escape') {
        if (!handlers.hasModal && handlers.dialogCanCollapse) { e.preventDefault(); handlers.onCollapseDialog() }
        return
      }
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/') { e.preventDefault(); handlers.onFocusInput() }
      else if (e.key === '1') handlers.onZoom(1)
      else if (e.key === '2') handlers.onZoom(2)
      else if (e.key === ' ' || e.key === '0') { e.preventDefault(); handlers.onReset() }
      else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') { e.preventDefault(); handlers.onPan(0, PAN_STEP) }
      else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') { e.preventDefault(); handlers.onPan(0, -PAN_STEP) }
      else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { e.preventDefault(); handlers.onPan(PAN_STEP, 0) }
      else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { e.preventDefault(); handlers.onPan(-PAN_STEP, 0) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handlers])
}
