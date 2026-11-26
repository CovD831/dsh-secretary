/** 纯函数前置脱敏器，阻止密钥与凭据写入 SQLite 或 Git 分片。 */
import type { SpineDraft } from './types.ts'

export const REDACTED = '[REDACTED]'

export interface RedactResult<T> { value: T; redacted: string[] }

const SENSITIVE_WORDS = new Set(['secret', 'secrets', 'password', 'passwd', 'authorization', 'apikey', 'credential', 'credentials', 'cookie'])
const FORCE_SUBTREE_WORDS = new Set(['secret', 'secrets', 'password', 'passwd', 'authorization', 'apikey', 'credential', 'credentials', 'cookie'])
const ASSIGN_KEY = String.raw`(?:[a-z0-9_-]*(?:secret(?:_?(?:key|value))?|token(?:_?value)?|password|passwd|cookie|authorization|api[-_]?key))\b`

const VALUE_RULES: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bsk-(?:proj-|ant-api\d*-|live_|test_)?[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9+/=_-]{16,}\b/g, REDACTED],
  [/\bt-g[0-9A-Za-z._-]{20,}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED],
  [/(https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/)(?!\[REDACTED\])[^\s"'`<>]+/gi, `$1${REDACTED}`],
  [/\b(https?:\/\/)(?!\[REDACTED\])([^\s/:@]+):([^\s/@]+)@/gi, `$1${REDACTED}@`],
  [/\b(Bearer\s+)(?!\[REDACTED\])([A-Za-z0-9._~+/=-]{8,})/gi, `$1${REDACTED}`],
  [new RegExp(`(["']?)\\b(${ASSIGN_KEY})\\1(\\s*=\\s*)(?!["']?\\[REDACTED\\])(?:"[^"\\n]+"|'[^'\\n]+'|[^\\s,;'"\`&}\\]]+)`, 'gi'), `$1$2$1$3${REDACTED}`],
]

const COLON_SECRET_RE = new RegExp(
  `(["']?)\\b(${ASSIGN_KEY})\\1(\\s*:\\s*)(?!["']?\\[REDACTED\\])("[^"\\n]+"|'[^'\\n]+'|Basic\\s+[A-Za-z0-9+/=]{4,}|[^\\s,;'"\`}\\]]{3,})`,
  'gi',
)

function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function isSensitiveKey(key: string): { sensitive: boolean; forceSubtree: boolean } {
  const words = splitKeyWords(key)
  if (!words.length) return { sensitive: false, forceSubtree: false }
  const last = words[words.length - 1]!
  const adjacent = (a: string, b: string) => words.some((w, i) => w === a && words[i + 1] === b)
  const keyPair = adjacent('api', 'key') || adjacent('private', 'key') || adjacent('access', 'key')
    || adjacent('encrypt', 'key') || adjacent('signing', 'key')
  const sensitive = words.some(w => SENSITIVE_WORDS.has(w)) || last === 'token' || adjacent('token', 'value') || keyPair
  const forceSubtree = words.some(w => FORCE_SUBTREE_WORDS.has(w)) || last === 'token' || keyPair
  return { sensitive, forceSubtree }
}

function scrubString(text: string): string {
  let out = text
  for (const [pattern, replacement] of VALUE_RULES) out = out.replace(pattern, replacement)
  return out.replace(COLON_SECRET_RE, (_m, q: string, key: string, sep: string, val: string) =>
    `${q}${key}${q}${sep}${val.startsWith('"') ? `"${REDACTED}"` : val.startsWith("'") ? `'${REDACTED}'` : REDACTED}`)
}

function walk(val: unknown, path: string, force: boolean, redacted: string[], seen: WeakSet<object>): unknown {
  if (val === null || val === undefined || typeof val === 'boolean') return val
  if (typeof val === 'number' || typeof val === 'bigint') {
    if (!force) return val
    redacted.push(path || '(root)')
    return REDACTED
  }
  if (typeof val === 'string') {
    if (val === REDACTED) return val
    if (force && val.length > 0) {
      redacted.push(path || '(root)')
      return REDACTED
    }
    const cleaned = scrubString(val)
    if (cleaned !== val) redacted.push(path || '(root)')
    return cleaned
  }
  if (val instanceof Date || typeof val !== 'object') return val
  if (seen.has(val)) return '[Circular]'
  seen.add(val)
  try {
    if (Array.isArray(val)) return val.map((item, i) => walk(item, `${path}[${i}]`, force, redacted, seen))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(val)) {
      const nextPath = path ? `${path}.${k}` : k
      const { sensitive, forceSubtree } = isSensitiveKey(k)
      const isLeaf = v === null || v === undefined || typeof v !== 'object'
      out[k] = walk(v, nextPath, force || (isLeaf ? sensitive : forceSubtree), redacted, seen)
    }
    return out
  } finally {
    seen.delete(val)
  }
}

export function redactValue<T>(value: T, path = ''): RedactResult<T> {
  const redacted: string[] = []
  const cleaned = walk(value, path, false, redacted, new WeakSet()) as T
  return { value: cleaned, redacted }
}

export function redactDraft<P>(draft: SpineDraft<P>): { draft: SpineDraft<P>; redacted: string[] } {
  const redacted: string[] = []
  const seen = new WeakSet<object>()
  const source = walk(draft.source, 'source', false, redacted, seen) as SpineDraft<P>['source']
  const evidence = walk(draft.evidence, 'evidence', false, redacted, seen) as SpineDraft<P>['evidence']
  const payload = walk(draft.payload, 'payload', false, redacted, seen) as P
  const merged = draft.redacted?.length ? [...new Set([...draft.redacted, ...redacted])] : redacted
  return {
    draft: { ...draft, source, evidence, payload, ...(merged.length ? { redacted: merged } : {}) },
    redacted: merged,
  }
}
