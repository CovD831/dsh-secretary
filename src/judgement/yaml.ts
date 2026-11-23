const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_YAML_DEPTH = 16

function nullRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

function assertSafeKey(key: string): string {
  if (key === '' || FORBIDDEN_KEYS.has(key)) throw new Error(`YAML/JSON 禁止危险或空键名 "${key}"`)
  return key
}

function scanOutsideQuotes(text: string, onChar: (ch: string, i: number) => boolean | void): void {
  let quote: '"' | "'" | undefined
  let depth = 0
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quote === '"') {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') quote = undefined
      continue
    }
    if (quote === "'") {
      if (ch === "'") { if (text[i + 1] === "'") { i += 1; continue } quote = undefined }
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
    else if (depth === 0 && onChar(ch, i) === false) break
  }
}

function stripComment(line: string): string {
  let cut = line.length
  scanOutsideQuotes(line, (ch, i) => { if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) { cut = i; return false } })
  return line.slice(0, cut)
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let start = 0
  scanOutsideQuotes(text, (ch, i) => { if (ch === ',') { parts.push(text.slice(start, i)); start = i + 1 } })
  return [...parts, text.slice(start)]
}

function findTopColon(text: string): number {
  let found = -1
  scanOutsideQuotes(text, (ch, i) => { if (ch === ':') { found = i; return false } })
  return found
}

function parseScalar(raw: string, depth = 0): unknown {
  if (depth > MAX_YAML_DEPTH) throw new Error(`YAML 嵌套深度超过上限 (${MAX_YAML_DEPTH})`)
  const s = raw.trim()
  if (s === '' || s === 'null' || s === '~') return null
  if (s === 'true' || s === 'false') return s === 'true'
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s.slice(1, -1).replace(/\\(["\\])/g, '$1')
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'")
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    return inner === '' ? [] : splitTopLevel(inner).map(item => parseScalar(item, depth + 1))
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim()
    const obj = nullRecord()
    if (inner === '') return obj
    for (const pair of splitTopLevel(inner)) {
      const idx = findTopColon(pair)
      if (idx <= 0) throw new Error(`无效内联对象项 "${pair.trim()}"`)
      const key = assertSafeKey(pair.slice(0, idx).trim().replace(/^['"]|['"]$/g, ''))
      obj[key] = parseScalar(pair.slice(idx + 1), depth + 1)
    }
    return obj
  }
  return s
}

interface YamlLine { indent: number; text: string }

function parseYamlLines(lines: readonly YamlLine[], start: number, baseIndent: number, depth = 0): [unknown, number] {
  if (depth > MAX_YAML_DEPTH) throw new Error(`YAML 嵌套深度超过上限 (${MAX_YAML_DEPTH})`)
  if (start >= lines.length) return [nullRecord(), start]
  if (lines[start]!.text.startsWith('- ') || lines[start]!.text === '-') {
    const arr: unknown[] = []
    let i = start
    while (i < lines.length && lines[i]!.indent === baseIndent && (lines[i]!.text.startsWith('- ') || lines[i]!.text === '-')) {
      const rest = lines[i]!.text.slice(1).trim()
      if (rest === '' && i + 1 < lines.length && lines[i + 1]!.indent > baseIndent) {
        const [nested, next] = parseYamlLines(lines, i + 1, lines[i + 1]!.indent, depth + 1)
        arr.push(nested); i = next
      } else if (rest !== '' && findTopColon(rest) > 0 && !rest.startsWith('{') && !rest.startsWith('"') && !rest.startsWith("'")) {
        const end = (() => { let j = i + 1; while (j < lines.length && lines[j]!.indent > baseIndent) j += 1; return j })()
        const childIndent = i + 1 < end ? lines[i + 1]!.indent : baseIndent + 2
        const [obj] = parseYamlLines([{ indent: childIndent, text: rest }, ...lines.slice(i + 1, end)], 0, childIndent, depth + 1)
        arr.push(obj); i = end
      } else { arr.push(rest === '' ? null : parseScalar(rest, depth + 1)); i += 1 }
    }
    return [arr, i]
  }
  const obj = nullRecord()
  let i = start
  while (i < lines.length && lines[i]!.indent >= baseIndent) {
    const cur = lines[i]!
    if (cur.indent > baseIndent) throw new Error(`YAML 缩进错误："${cur.text}"`)
    const colon = findTopColon(cur.text)
    if (colon <= 0) throw new Error(`YAML 键值语法错误："${cur.text}"`)
    const key = assertSafeKey(cur.text.slice(0, colon).trim().replace(/^['"]|['"]$/g, ''))
    const rest = cur.text.slice(colon + 1).trim()
    if ((rest === '|' || rest === '>') && i + 1 < lines.length && lines[i + 1]!.indent > baseIndent) {
      const block: string[] = []
      i += 1
      while (i < lines.length && lines[i]!.indent > baseIndent) { block.push(lines[i]!.text); i += 1 }
      obj[key] = block.join(rest === '|' ? '\n' : ' ')
    } else if (rest !== '') {
      obj[key] = parseScalar(rest, depth + 1); i += 1
    } else if (i + 1 < lines.length && lines[i + 1]!.indent > baseIndent) {
      const [nested, next] = parseYamlLines(lines, i + 1, lines[i + 1]!.indent, depth + 1)
      obj[key] = nested; i = next
    } else { obj[key] = nullRecord(); i += 1 }
  }
  return [obj, i]
}

function sanitizeJsonValue(val: unknown, depth = 0): unknown {
  if (depth > MAX_YAML_DEPTH) throw new Error(`JSON 嵌套深度超过上限 (${MAX_YAML_DEPTH})`)
  if (Array.isArray(val)) return val.map(v => sanitizeJsonValue(v, depth + 1))
  if (val && typeof val === 'object') {
    const safe = nullRecord()
    for (const [k, v] of Object.entries(val)) safe[assertSafeKey(k)] = sanitizeJsonValue(v, depth + 1)
    return safe
  }
  return val
}

/** 安全解析 YAML/JSON frontmatter（使用无原型对象、拦截原型污染键并限制嵌套深度）。 */
export function parseFrontmatterData(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error('frontmatter 内容为空')
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON frontmatter 必须为对象')
    return sanitizeJsonValue(parsed) as Record<string, unknown>
  }
  const lines = raw.split(/\r?\n/).map(stripComment).filter(l => l.trim() !== '').map(l => ({ indent: l.length - l.trimStart().length, text: l.trim() }))
  if (lines.length === 0) throw new Error('YAML frontmatter 内容为空')
  const [parsed] = parseYamlLines(lines, 0, lines[0]!.indent)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('YAML frontmatter 顶层必须为键值对象')
  return parsed as Record<string, unknown>
}
