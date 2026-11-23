import type {
  CapsuleSection, ContextCapsule, DroppedCapsuleItem, MatchedPitfall, PitfallNote, SliceResult,
} from './types.ts'

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function matchesKey(haystack: string, haystackLower: string, key: string, wordBoundary: boolean): boolean {
  const k = key.trim()
  if (k === '') return false
  if (!wordBoundary) return haystackLower.includes(k.toLowerCase())
  const left = /^[a-zA-Z0-9_]/.test(k) ? '(?<![a-zA-Z0-9_])' : ''
  const right = /[a-zA-Z0-9_]$/.test(k) ? '(?![a-zA-Z0-9_])' : ''
  return new RegExp(`${left}${escapeRe(k)}${right}`, 'i').test(haystack)
}

/** SillyTavern 式确定性触发匹配：支持主 triggerKeys + AND 全中 + NOT 排除。 */
export function matchPitfalls(haystack: string, notes: readonly PitfallNote[]): MatchedPitfall[] {
  const haystackLower = haystack.toLowerCase()
  const matched: MatchedPitfall[] = []
  const seen = new Set<string>()
  for (const note of notes) {
    if (seen.has(note.id)) continue
    const wb = note.wordBoundary === true
    const primary = note.triggerKeys.filter(k => matchesKey(haystack, haystackLower, k, wb))
    if (primary.length === 0) continue
    if (note.andKeys && note.andKeys.some(k => !matchesKey(haystack, haystackLower, k, wb))) continue
    if (note.notKeys && note.notKeys.some(k => matchesKey(haystack, haystackLower, k, wb))) continue
    seen.add(note.id)
    matched.push({ ...note, matchedKeys: primary })
  }
  return matched
}

export function buildCapsuleSections(slice: SliceResult): CapsuleSection[] {
  const sections: CapsuleSection[] = []
  const push = (kind: CapsuleSection['kind'], label: string, text: string) => {
    sections.push({ kind, label, text, bytes: Buffer.byteLength(text, 'utf8') })
  }
  for (const p of slice.matchedPitfalls) push('pitfall', `pitfall:${p.id}`, `## 隐性坑 [${p.id}] (命中: ${p.matchedKeys.join(', ')})\n${p.content}`)
  for (const imp of slice.importedSignatures) push('import-signature', `import:${imp.sourceFile}`, `## 1-Hop 导出签名: ${imp.sourceFile}\n${imp.signatures.join('\n')}`)
  for (const tgt of slice.targetContents) push('target', `target:${tgt.file}`, `## 目标文件: ${tgt.file}\n${tgt.content}`)
  if (slice.callSites.length > 0) push('call-site', 'call-sites', `## 全仓调用点 (${slice.callSites.length})\n${slice.callSites.map(c => `${c.file}:${c.line}: ${c.text}`).join('\n')}`)
  if (slice.relatedTests.length > 0) push('related-test', 'related-tests', `## 关联测试 (${slice.relatedTests.length})\n${slice.relatedTests.join('\n')}`)
  return sections
}

export function measureSectionsBytes(sections: readonly CapsuleSection[]): number {
  if (sections.length === 0) return 0
  return sections.reduce((sum, s) => sum + s.bytes, 0) + (sections.length - 1) * 2
}

/** 按预算组装上下文胶囊；超预算绝不静默丢弃，返回显式 overflow 与 droppedItems 账单。 */
export function assembleCapsule(slice: SliceResult, budgetBytes: number): ContextCapsule {
  const all = buildCapsuleSections(slice)
  const kept: CapsuleSection[] = []
  const dropped: DroppedCapsuleItem[] = []
  let usedBytes = 0
  for (const sec of all) {
    const sep = kept.length > 0 ? 2 : 0
    if (usedBytes + sep + sec.bytes <= budgetBytes) {
      kept.push(sec)
      usedBytes += sep + sec.bytes
    } else {
      dropped.push({ kind: sec.kind, label: sec.label, bytes: sec.bytes, reason: 'budget-exceeded' })
    }
  }
  const text = kept.map(s => s.text).join('\n\n')
  return {
    overflow: dropped.length > 0,
    budgetBytes,
    usedBytes: Buffer.byteLength(text, 'utf8'),
    text,
    sections: kept,
    matchedPitfalls: slice.matchedPitfalls,
    droppedItems: dropped,
    metrics: slice.metrics,
  }
}
