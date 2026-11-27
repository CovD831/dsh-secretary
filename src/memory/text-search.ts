/** 中英文统一分词与 FTS5 精确/降级查询构造（消除单汉字 OR 噪音，统一词法覆盖率门）。 */

/** 提取中英文检索词元：连续 ≥2 汉字仅切二元词（不再散出单字），孤立单字保留。 */
export function tokenizeForSearch(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens = new Set<string>()
  for (const m of lower.matchAll(/[a-z0-9_-]{2,}/g)) {
    tokens.add(m[0]!)
    for (const part of m[0]!.split(/[_-]+/)) {
      if (part.length >= 3) tokens.add(part)
    }
  }
  const hanRuns = lower.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of hanRuns) {
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      tokens.add(run.slice(i, i + 2))
    }
  }
  return [...tokens]
}

const escapeFtsToken = (t: string): string => `"${t.replace(/"/g, '""')}"`

/** 构造 FTS5 双段查询：优先严格 AND，候选不足时再用 OR 配合覆盖率阈值降级。 */
export function buildSmartFtsQueries(tokens: readonly string[]): {
  readonly primary?: string
  readonly fallback?: string
} {
  const uniq = [...new Set(tokens.map(t => t.trim()).filter(Boolean))].slice(0, 16)
  if (uniq.length === 0) return {}
  const quoted = uniq.map(escapeFtsToken)
  if (quoted.length === 1) return { primary: quoted[0]! }
  return {
    primary: quoted.join(' AND '),
    fallback: quoted.join(' OR '),
  }
}

/** 计算 `haystackLower` 命中了多少个检索词元，以及是否满足最小覆盖率要求。 */
export function scoreTokenCoverage(
  tokens: readonly string[],
  haystackLower: string,
  queryLower: string,
  minRatio = 0.4,
): { readonly hits: number; readonly score: number; readonly enough: boolean } {
  if (tokens.length === 0) {
    const subHit = queryLower.length >= 2 && haystackLower.includes(queryLower)
    return { hits: subHit ? 1 : 0, score: subHit ? 3 : 0, enough: subHit }
  }
  let hits = 0
  let score = 0
  for (const tok of tokens) {
    if (haystackLower.includes(tok)) {
      hits += 1
      score += tok.length > 1 ? 2 : 1
    }
  }
  const subMatch = queryLower.length >= 2 && haystackLower.includes(queryLower)
  if (subMatch) score += 3
  const required = Math.max(1, Math.ceil(tokens.length * minRatio))
  return { hits, score, enough: subMatch || hits >= required }
}
