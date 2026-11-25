/** Governance studios shell switching between Deposits, Memory & M6 Notebook, and Statistical RSI + F1 Pixel Proof. */
import { SegmentedControl } from './controls.tsx'
import { usePanel } from './provider.tsx'
import type { StudioTab } from './route.ts'
import { StudioDeposits } from './studio-deposits.tsx'
import { StudioMemory } from './studio-memory.tsx'
import { StudioRsi } from './studio-rsi.tsx'

/** Segmented shell for the three governance studios (`deposits | memory | rsi`). */
export function StudiosPage({ tab }: { tab: StudioTab }) {
  const { t, navigate } = usePanel()
  const switchTab = (next: StudioTab) => navigate({ page: 'studios', query: next === 'deposits' ? undefined : { tab: next } }, true)
  return <>
    <SegmentedControl label={t('studio.tabsLabel')} value={tab} onChange={switchTab} options={[
      { value: 'deposits', label: t('studio.deposits') },
      { value: 'memory', label: t('studio.memory') },
      { value: 'rsi', label: t('studio.rsi') },
    ]} />
    {tab === 'deposits' ? <StudioDeposits /> : tab === 'memory' ? <StudioMemory /> : <StudioRsi />}
  </>
}
