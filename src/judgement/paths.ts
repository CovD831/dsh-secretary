type Prev = [never, 0, 1, 2, 3]
type IsIndexBag<T> = string extends keyof T ? true : number extends keyof T ? true : false
type HasNoMembers<T> = keyof T extends never ? true : false
type BuiltinLeaf = Date | RegExp | Error | { readonly size: number; has(key: never): boolean }

/** 递归展开类型 `T` 的点分路径联合（深度上限 3），由消费方 `Requires<C>` 直接剔除空串以避免别名塌缩。 */
export type PathsOf<T, Depth extends 0 | 1 | 2 | 3 = 3> = [Depth] extends [never]
  ? never
  : T extends string | number | boolean | bigint | symbol | null | undefined
    ? never
    : T extends readonly unknown[] | ((...args: never[]) => unknown) | BuiltinLeaf
      ? never
      : IsIndexBag<T> extends true
        ? ''
        : HasNoMembers<T> extends true
          ? ''
          : { [K in keyof T & string]: K | `${K}.${PathsOf<T[K], Prev[Depth]>}` }[keyof T & string]
