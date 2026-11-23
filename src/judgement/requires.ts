export interface RequiresAuditResult {
  readonly ok: boolean
  readonly missing: readonly string[]
  readonly present: readonly string[]
}

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/** 沿点路径读取 `ctx` 字段；`undefined` 视为缺失，`null / false / 0 / ''` 视为已提供有效值。 */
export function readPath(ctx: unknown, path: string): unknown {
  if (path === '') return ctx
  let cursor: unknown = ctx
  for (const segment of path.split('.')) {
    if (segment === '' || FORBIDDEN_PATH_SEGMENTS.has(segment)) return undefined
    if (cursor === null || typeof cursor !== 'object') return undefined
    if (!Object.hasOwn(cursor, segment)) {
      const value = (cursor as Record<string, unknown>)[segment]
      // 仅允许普通字段/getter 读取，屏蔽继承自 Object.prototype 的方法名。
      if (Object.hasOwn(Object.prototype, segment) || typeof value === 'function') return undefined
      cursor = value
      continue
    }
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/** 核对 `requires` 声明的每条点路径在 `ctx` 上是否均已提供（非 `undefined`）。 */
export function auditRequires(ctx: unknown, requires: readonly string[]): RequiresAuditResult {
  const missing: string[] = []
  const present: string[] = []
  for (const path of requires) {
    if (readPath(ctx, path) === undefined) missing.push(path)
    else present.push(path)
  }
  return { ok: missing.length === 0, missing, present }
}
