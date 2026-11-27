/** 零新 PNG：基于冻结 46 色板按部位（发型/上衣/肤色/眼镜）确定性衍生 8 套辨识度鲜明的工蜂与负责人像素外观。 */
export type CharBaseRole = 'worker' | 'lead'

export interface CharVariantSpec {
  readonly id: number
  readonly base: CharBaseRole
  readonly hairMap: Record<string, string>
  readonly outfitMap: Record<string, string>
  readonly skinMap?: Record<string, string>
  readonly glasses?: boolean
}

export const CHAR_VARIANTS: readonly CharVariantSpec[] = [
  { id: 0, base: 'worker', hairMap: {}, outfitMap: {} },
  { id: 1, base: 'lead', hairMap: {}, outfitMap: {} },
  { id: 2, base: 'worker', glasses: true,
    hairMap: { '#6B3A32': '#201A18', '#7A5438': '#2E2A2A', '#8F6046': '#4A4440', '#7A3A3A': '#2A2220', '#4A3428': '#201A18' },
    outfitMap: { '#4A6A50': '#3F5A78', '#3E4A44': '#2E2A2A', '#6E665E': '#6B7F96', '#4A3C34': '#201A18' } },
  { id: 3, base: 'lead',
    hairMap: { '#2E2A2A': '#7A5438', '#2A2220': '#8F6046', '#201A18': '#6B3A32' },
    outfitMap: { '#6B3A32': '#3F5A78', '#3B2A22': '#2E2A2A', '#4A3428': '#6B7F96', '#2C211B': '#201A18' },
    skinMap: { '#C9A46A': '#D8C0A8', '#A87A52': '#C09070' } },
  { id: 4, base: 'worker',
    hairMap: { '#6B3A32': '#6E665E', '#7A5438': '#8C8478', '#8F6046': '#C9C0B4', '#7A3A3A': '#6E665E', '#4A3428': '#4A4440' },
    outfitMap: { '#4A6A50': '#A87A52', '#3E4A44': '#6B4A32', '#6E665E': '#8A6242', '#4A3C34': '#4A3428' } },
  { id: 5, base: 'lead', glasses: true,
    hairMap: { '#2E2A2A': '#8F6046', '#2A2220': '#A87A52', '#201A18': '#7A5438' },
    outfitMap: { '#6B3A32': '#4A6A50', '#3B2A22': '#3E4A44', '#4A3428': '#3E4A44', '#2C211B': '#2C211B' } },
  { id: 6, base: 'worker',
    hairMap: { '#6B3A32': '#4A3428', '#7A5438': '#7A3A3A', '#8F6046': '#6B3A32', '#7A3A3A': '#6B3A32' },
    outfitMap: { '#4A6A50': '#BFA48C', '#3E4A44': '#7A6150', '#6E665E': '#D8D0C0', '#4A3C34': '#5A463A' },
    skinMap: { '#D8C0A8': '#C9A46A', '#C09070': '#A87A52' } },
  { id: 7, base: 'lead',
    hairMap: { '#2E2A2A': '#4A3428', '#2A2220': '#6B4A32', '#201A18': '#3B2A22' },
    outfitMap: { '#6B3A32': '#C9A46A', '#3B2A22': '#6B4A32', '#4A3428': '#8A6242', '#2C211B': '#4A3428' } },
]

const parseHex = (h: string): readonly [number, number, number] => [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)]
const toHex = (r: number, g: number, b: number): string => `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`
const canvasCache = new Map<string, HTMLCanvasElement>(), mugshotCache = new Map<string, string>()
const specOf = (idx: number) => CHAR_VARIANTS[((idx % CHAR_VARIANTS.length) + CHAR_VARIANTS.length) % CHAR_VARIANTS.length]!
const pickFree = (used: Set<number>, idx: number): number => {
  for (let k = 0; k < CHAR_VARIANTS.length && used.has(idx); k++) idx = (idx + 1) % CHAR_VARIANTS.length
  used.add(idx); return idx
}

export function workerVariantIndex(actorId: string, ticketId?: string, assignedSuiteId?: string): number {
  const key = ticketId || actorId; let h = 2166136261
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return ((h % CHAR_VARIANTS.length) + (assignedSuiteId?.endsWith('#nw') ? 3 : 0)) % CHAR_VARIANTS.length
}

export function assignActorVariants(actors: readonly { id: string; role: string; ticketId?: string; assignedSuiteId?: string }[]): Map<string, number> {
  const used = new Set<number>(), out = new Map<string, number>()
  for (const a of actors) if (a.role === 'worker') out.set(a.id, pickFree(used, workerVariantIndex(a.id, a.ticketId, a.assignedSuiteId)))
  return out
}

export function resolveRoomVariantMap(
  workspaceIds: readonly string[],
  actors: readonly { id: string; role: string; workspaceId?: string; lifecycle?: string; ticketId?: string; assignedSuiteId?: string }[],
  screenStates?: Record<string, string>,
  wings?: readonly { workspaceId?: string; suites: readonly { id: string }[] }[],
): Map<string, number> {
  const actorVars = assignActorVariants(actors), out = new Map<string, number>(), used = new Set<number>(), suiteToRoom = new Map<string, string>()
  if (wings) for (const w of wings) if (w.workspaceId) for (const s of w.suites) suiteToRoom.set(s.id, w.workspaceId)
  const roomOf = (a: { workspaceId?: string; assignedSuiteId?: string }) => a.workspaceId ?? (a.assignedSuiteId ? suiteToRoom.get(a.assignedSuiteId.split('#')[0]!) : undefined)
  const rank = (st?: string) => st === 'needsDecision' ? 0 : st === 'stuck' ? 1 : st === 'working' ? 2 : st === 'done' ? 3 : 4
  for (const wsId of workspaceIds) {
    const active = actors.filter((a) => a.role === 'worker' && roomOf(a) === wsId && a.lifecycle !== 'removed' && a.lifecycle !== 'leaving')
    if (!active.length) continue
    const lead = active.reduce((best, cur) => rank(cur.assignedSuiteId ? screenStates?.[cur.assignedSuiteId] : undefined) < rank(best.assignedSuiteId ? screenStates?.[best.assignedSuiteId] : undefined) ? cur : best)
    const idx = actorVars.get(lead.id)!; out.set(wsId, idx); used.add(idx)
  }
  for (const wsId of workspaceIds) if (!out.has(wsId)) out.set(wsId, pickFree(used, workerVariantIndex(`room-${wsId}`, wsId)))
  return out
}

function addGlassesBridge(d: Uint8ClampedArray, w: number, spec: CharVariantSpec): void {
  const skinSet = new Set(['#D8C0A8', '#C09070', '#C9A46A', '#A87A52'])
  const [br, bg, bb] = parseHex('#4A3C34')
  for (let row = 0; row < 2; row++) for (let col = 0; col < 4; col++) {
    const ox = col * 32, oy = row * 48
    for (let cy = 10; cy <= 14; cy++) {
      const eyes: number[] = []
      for (let cx = 6; cx < 26; cx++) {
        const i = ((oy + cy) * w + ox + cx) * 4, hx = toHex(d[i]!, d[i + 1]!, d[i + 2]!)
        if (d[i + 3]! > 128 && (hx === '#1A1412' || hx === '#201A18')) eyes.push(cx)
      }
      if (eyes.length === 2 && eyes[1]! - eyes[0]! >= 3 && eyes[1]! - eyes[0]! <= 6) {
        const left = eyes[0]!, right = eyes[1]!, mid = Math.floor((left + right) / 2)
        for (const gx of [left - 1, mid, ...(right - left > 4 ? [mid + 1] : []), right + 1]) {
          const gi = ((oy + cy) * w + ox + gx) * 4
          if (d[gi + 3]! > 128 && skinSet.has(toHex(d[gi]!, d[gi + 1]!, d[gi + 2]!))) {
            d[gi] = br; d[gi + 1] = bg; d[gi + 2] = bb
          }
        }
        if (spec.base === 'lead' || spec.base === 'worker') break
      }
    }
  }
}

export function buildVariantCanvas(variantIdx: number, images: Record<string, CanvasImageSource>): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  const spec = specOf(variantIdx), img = images[`char_${spec.base}`]
  if (!(img instanceof HTMLImageElement) || !img.complete || img.naturalWidth === 0) return null
  const cacheKey = `${spec.id}:${img.src}`, cached = canvasCache.get(cacheKey)
  if (cached) return cached
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight
  const ctx = cv.getContext('2d'); if (!ctx) return null; ctx.drawImage(img, 0, 0)
  if (Object.keys(spec.hairMap).length || Object.keys(spec.outfitMap).length || spec.skinMap || spec.glasses) {
    const idata = ctx.getImageData(0, 0, cv.width, cv.height), d = idata.data, hairMaxY = spec.base === 'lead' ? 11 : 15
    for (let y = 0; y < cv.height; y++) for (let x = 0, cy = y % 48; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4; if (d[i + 3]! < 128) continue
      const hex = toHex(d[i]!, d[i + 1]!, d[i + 2]!)
      const rep = (cy >= 1 && cy <= hairMaxY ? spec.hairMap[hex] : undefined) ?? (cy >= 17 && cy <= 29 ? spec.outfitMap[hex] : undefined) ?? (spec.skinMap && ((cy >= 7 && cy <= 16) || (cy >= 24 && cy <= 28)) ? spec.skinMap[hex] : undefined)
      if (rep) { const [r, g, b] = parseHex(rep); d[i] = r; d[i + 1] = g; d[i + 2] = b }
    }
    if (spec.glasses) addGlassesBridge(d, cv.width, spec); ctx.putImageData(idata, 0, 0)
  }
  canvasCache.set(cacheKey, cv); return cv
}

export function buildVariantMugshotUrl(variantIdx: number, images: Record<string, CanvasImageSource>): string | null {
  if (typeof document === 'undefined') return null
  const spec = specOf(variantIdx), baseImg = images[`char_${spec.base}`]
  const cacheKey = `${spec.id}:${baseImg instanceof HTMLImageElement ? baseImg.src : ''}`, cached = mugshotCache.get(cacheKey)
  if (cached) return cached
  const sheet = buildVariantCanvas(variantIdx, images); if (!sheet) return null
  const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32
  const ctx = cv.getContext('2d'); if (!ctx) return null
  ctx.imageSmoothingEnabled = false; ctx.drawImage(sheet, 0, 0, 32, 29, 0, 3, 32, 29)
  try {
    const url = typeof cv.toDataURL === 'function' ? cv.toDataURL('image/png') : ''
    if (!url.startsWith('data:image/png')) return null; mugshotCache.set(cacheKey, url); return url
  } catch { return null }
}
