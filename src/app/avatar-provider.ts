/** 秘书形象生图源调度：自定义回调、远程 AI 生图与无头本地 38 色非状态色板重混。 */
import { readFileSync } from 'node:fs'
import { packagePath } from '../infra/paths.ts'
import {
  decodePngRgba, encodePngRgba, PALETTE_GROUPS, type SecretaryMood,
} from '../pixel-office/index.ts'
import {
  processAndStoreAvatarPack, type AvatarPackSummary, type AvatarProviderKind,
} from './avatar-pipeline.ts'

const MOODS: readonly SecretaryMood[] = ['neutral', 'working', 'happy', 'concerned']

export interface GenerateAvatarInput {
  stateDir: string
  id: string
  name: string
  prompt: string
  seed?: number
  model?: string
  endpoint?: string
  apiKey?: string
  now?: () => Date
  generator?: (opts: { prompt: string; mood: SecretaryMood; seed: number }) => Promise<Buffer>
}

function hashPromptSeed(prompt: string, seed: number): number {
  let h = 0x811c9dc5 ^ (seed >>> 0)
  for (let i = 0; i < prompt.length; i++) {
    h ^= prompt.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function hexToRgb(hex: string): readonly [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function buildRemixMap(prompt: string, seed: number): Map<number, readonly [number, number, number]> {
  const h = hashPromptSeed(prompt, seed)
  const groups: readonly (readonly string[])[] = [
    PALETTE_GROUPS.clothing,
    PALETTE_GROUPS.skinHair.slice(3),
    ['#C9A46A', '#E8DCCB', '#8A6242', '#6B4A32'],
  ]
  const map = new Map<number, readonly [number, number, number]>()
  groups.forEach((group, gi) => {
    const shift = ((h >>> (gi * 5)) % Math.max(1, group.length - 1)) + 1
    group.forEach((hex, idx) => {
      const [sr, sg, sb] = hexToRgb(hex)
      const targetHex = group[(idx + shift) % group.length]!
      map.set((sr << 16) | (sg << 8) | sb, hexToRgb(targetHex))
    })
  })
  return map
}

function remixLocalPortraits(prompt: string, seed: number): Record<SecretaryMood, Buffer> {
  const remixMap = buildRemixMap(prompt, seed)
  const out = {} as Record<SecretaryMood, Buffer>
  for (const mood of MOODS) {
    const src = decodePngRgba(readFileSync(packagePath('assets', 'f1-proof', `portrait_${mood}.png`)))
    const rgba = new Uint8Array(src.rgba)
    for (let i = 0; i < rgba.length; i += 4) {
      if ((rgba[i + 3] ?? 0) < 128) continue
      const key = (rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!
      const next = remixMap.get(key)
      if (next) {
        rgba[i] = next[0]
        rgba[i + 1] = next[1]
        rgba[i + 2] = next[2]
      }
    }
    out[mood] = Buffer.from(encodePngRgba(rgba, src.width, src.height))
  }
  return out
}

/** 按运行时凭据调度远程生图或本地确定性色板重混，并经 46 色核验入库。 */
export async function generateAvatarPackViaProvider(input: GenerateAvatarInput): Promise<AvatarPackSummary> {
  const seed = input.seed ?? 20261126
  const apiKey = input.apiKey ?? process.env.DSH_AVATAR_IMAGE_API_KEY?.trim()
  const endpoint = input.endpoint ?? (
    process.env.DSH_AVATAR_IMAGE_URL?.trim() || 'https://api.openai.com/v1/images/generations'
  )
  let model = input.model ?? (process.env.DSH_AVATAR_IMAGE_MODEL?.trim() || 'gpt-image-1')
  let provider: AvatarProviderKind = 'remote-ai'
  let rawPortraits = {} as Record<SecretaryMood, Buffer>

  if (input.generator) {
    for (const mood of MOODS) rawPortraits[mood] = await input.generator({ prompt: input.prompt, mood, seed })
  } else if (apiKey) {
    for (const mood of MOODS) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model,
          prompt: `${input.prompt}, pixel art bust portrait, ${mood} expression, flat white background`,
          size: '768x960',
          response_format: 'b64_json',
        }),
      })
      if (!res.ok) throw new Error(`生图请求失败 (${res.status})`)
      const json = await res.json() as { data?: { b64_json?: string }[] }
      const b64 = json.data?.[0]?.b64_json
      if (!b64) throw new Error('生图响应缺少 b64_json')
      rawPortraits[mood] = Buffer.from(b64, 'base64')
    }
  } else {
    provider = 'local-remix'
    model = 'local-palette-remix-v1'
    rawPortraits = remixLocalPortraits(input.prompt, seed)
  }

  return processAndStoreAvatarPack({
    stateDir: input.stateDir, id: input.id, name: input.name, prompt: input.prompt,
    model, provider, seed, rawPortraits,
    ...(input.now ? { now: input.now } : {}),
  })
}
