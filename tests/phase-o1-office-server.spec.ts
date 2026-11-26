import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listAvatarPacks, processAndStoreAvatarPack, selectAvatarPack,
} from '../src/app/avatar-pipeline.ts'
import { generateAvatarPackViaProvider } from '../src/app/avatar-provider.ts'
import { GovernanceRuntime } from '../src/app/governance.ts'
import type { HttpHost } from '../src/app/http.ts'
import { OfficeServer } from '../src/app/office-server.ts'
import { Store } from '../src/app/store.ts'
import { readTicketTranscript } from '../src/app/transcript-reader.ts'
import type { Ticket } from '../src/core/model.ts'
import { auditPaletteBuffer, decodePngRgba, encodePngRgba } from '../src/pixel-office/index.ts'

const dirs: string[] = []
const stores: Store[] = []
const servers: OfficeServer[] = []

afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  while (stores.length) stores.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const makeDir = () => { const d = mkdtempSync(join(tmpdir(), 'office-o1-')); dirs.push(d); return d }

function makeTicket(id: string): Ticket {
  const now = '2026-11-26T01:00:00.000Z'
  return {
    id, title: `Ticket ${id}`, decisionId: `dec-${id}`,
    mandate: { strength: 'explicit', policyVersion: '1', basis: { via: 'addressed', addressed: 'mention' }, actor: { source: 'github', id: 'u1' }, scope: 'repo' },
    channels: [], assignments: [{ id: `a-${id}`, state: 'running', createdAt: now, startedAt: now }],
    inputs: [], undelivered: [], createdAt: now, updatedAt: now, origin: { triggerId: `tr-${id}`, triggerIds: [`tr-${id}`] },
  }
}

function makeTestPng(width: number, height: number, fillCenter = true): Buffer {
  const rgba = new Uint8Array(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = 255; rgba[p * 4 + 1] = 255; rgba[p * 4 + 2] = 255; rgba[p * 4 + 3] = 255
  }
  if (fillCenter) {
    const x0 = Math.floor(width / 4), x1 = Math.floor((width * 3) / 4)
    const y0 = Math.floor(height / 4), y1 = Math.floor((height * 3) / 4)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4
        // Deliberately use a bright status-like blue to verify non-status quantization clamps it to 38 non-status colors.
        rgba[i] = 47; rgba[i + 1] = 168; rgba[i + 2] = 224; rgba[i + 3] = 255
      }
    }
  }
  return Buffer.from(encodePngRgba(rgba, width, height))
}

function makeHost(stateDir: string, store: Store, governance: GovernanceRuntime): HttpHost {
  return {
    store,
    governance,
    ready: Promise.resolve(),
    machine: {
      stateDir,
      promptMaxChars: { get: () => 100000 } as never,
      admissionContextMaxPages: { get: () => 10 } as never,
      admissionContextTimeoutMs: { get: () => 15000 } as never,
    },
    executor: { activeCount: () => 0 },
    health: {},
    masterId: 'master-1',
    configured: () => false,
    sources: { instances: () => [] } as never,
    links: () => () => undefined,
    ticketEnvironment: () => [],
    checkSetup: () => {},
    requestPass: () => {},
    models: async () => ({ default: { provider: 'mock', model: 'm' }, routableProviders: [], failures: [], groups: [] }),
  } as unknown as HttpHost
}

describe('Phase O1 OfficeServer, SSE, TranscriptReader & AvatarPipeline', () => {
  it('enforces loopback same-origin on API & SSE and streams live events cleanly before closing', async () => {
    const stateDir = makeDir()
    const store = new Store(join(stateDir, 'orchestrator.sqlite')); stores.push(store)
    let serverRef: OfficeServer | undefined
    let broadcastAt = 0
    const gov = new GovernanceRuntime({
      store, stateDir,
      onRulingQueued: item => { broadcastAt = Date.now(); serverRef?.broadcast({ type: 'ruling.queued', data: item }) },
    })
    const server = serverRef = new OfficeServer({ host: makeHost(stateDir, store, gov) })
    servers.push(server)
    const port = await server.start(0)
    expect(port).toBeGreaterThan(0)

    const evilApi = await fetch(`http://127.0.0.1:${port}/orchestrator/api/state`, {
      headers: { origin: 'http://evil.com', 'x-orchestrator-request': '1' },
    })
    expect(evilApi.status).toBe(403)

    const evilSse = await fetch(`http://127.0.0.1:${port}/orchestrator/api/events/stream`, {
      headers: { origin: 'http://evil.com' },
    })
    expect(evilSse.status).toBe(403)

    const okApi = await fetch(`http://127.0.0.1:${port}/orchestrator/api/state`, {
      headers: { origin: `http://127.0.0.1:${port}`, 'x-orchestrator-request': '1' },
    })
    expect(okApi.status).toBe(200)

    const ac = new AbortController()
    const sseRes = await fetch(`http://127.0.0.1:${port}/orchestrator/api/events/stream`, {
      headers: { origin: `http://127.0.0.1:${port}` },
      signal: ac.signal,
    })
    expect(sseRes.status).toBe(200)
    const reader = sseRes.body!.getReader()
    const decoder = new TextDecoder()

    const first = await reader.read()
    expect(decoder.decode(first.value)).toContain('event: ready')

    await gov.rulings.enqueue({
      kind: 'system_escalation', escalationType: 'unknown_side_effect', ticketId: 't-1',
      question: 'Confirm?', options: [{ id: 'ok', label: 'OK', consequence: 'continue', recommended: true }],
    })
    const second = await reader.read()
    const elapsed = Date.now() - broadcastAt
    const frame = decoder.decode(second.value)
    expect(frame).toContain('event: ruling.queued')
    expect(elapsed).toBeLessThan(200)
    ac.abort()
    await server.close()
    await gov.shutdown()
  })

  it('merges persistent session events with M0 spine events and redacts secrets', async () => {
    const stateDir = makeDir()
    const store = new Store(join(stateDir, 'orchestrator.sqlite')); stores.push(store)
    store.tickets.save(makeTicket('t99'))
    const gov = new GovernanceRuntime({ store, stateDir })
    gov.appender.append({
      id: 'gate-t99', at: '2026-11-26T01:02:00.000Z', stream: 'ticket:t99', type: 'gate.evaluated',
      source: { kind: 'system', ref: 'test' }, evidence: [], taint: 'trusted',
      payload: { ticketId: 't99', point: 'verify.rerun', verdict: { kind: 'allow' }, leak: 'sk-secret1234567890abcdef' },
    })

    const fakePersistence = {
      flush: async () => {},
      open: async () => ({
        read: async (offset: number) => offset > 0 ? { events: [] } : {
          events: [
            { seq: 1, time: Date.parse('2026-11-26T01:00:00.000Z'), type: 'user/message', data: { content: [{ type: 'text', text: 'use key sk-secret1234567890abcdef' }] } },
            { seq: 2, time: Date.parse('2026-11-26T01:01:00.000Z'), type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'running check' }, { type: 'toolCall', id: 'c1', name: 'bash' }] } } },
            { seq: 3, time: Date.parse('2026-11-26T01:01:30.000Z'), type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'token=sk-secret1234567890abcdef' }] } } },
          ],
        },
        [Symbol.asyncDispose]: async () => {},
      }),
    }
    const view = await readTicketTranscript({ ticketId: 't99', store, stateDir, persistence: fakePersistence as never })
    expect(view).toBeDefined()
    expect(view!.entries.map(e => e.kind)).toEqual(['user', 'assistant', 'tool_call', 'tool_result', 'gate'])
    expect(JSON.stringify(view)).not.toContain('sk-secret1234567890abcdef')
    expect(JSON.stringify(view)).toContain('[REDACTED]')
    await gov.shutdown()
  })

  it('validates avatar dimensions/moods, quantizes 2x white-bg portraits to 38 non-status colors, and selects pack', async () => {
    const stateDir = makeDir()
    const store = new Store(join(stateDir, 'orchestrator.sqlite')); stores.push(store)

    const badSize = makeTestPng(500, 600)
    expect(() => processAndStoreAvatarPack({
      stateDir, id: 'bad-size', name: 'Bad', prompt: 'p', model: 'm', seed: 1,
      rawPortraits: { neutral: badSize, working: badSize, happy: badSize, concerned: badSize },
    })).toThrow(/192×240/)

    const ok2x = makeTestPng(384, 480)
    expect(() => processAndStoreAvatarPack({
      stateDir, id: 'missing-mood', name: 'Missing', prompt: 'p', model: 'm', seed: 1,
      rawPortraits: { neutral: ok2x, working: ok2x, happy: ok2x },
    })).toThrow(/concerned/)

    const pack = await generateAvatarPackViaProvider({
      stateDir, id: 'custom-sec-01', name: '测试秘书', prompt: 'warm walnut secretary', seed: 42,
      generator: async () => ok2x,
    })
    expect(pack.outOfPaletteCount).toBe(0)
    expect(pack.statusPixels).toBe(0)
    expect(pack.semiTransparentCount).toBe(0)

    const outPng = decodePngRgba(readFileSync(join(stateDir, 'avatars', 'custom-sec-01', 'portrait', 'neutral.png')))
    expect(outPng.width).toBe(192)
    expect(outPng.height).toBe(240)
    const audit = auditPaletteBuffer(outPng.rgba, 192, 240, new Uint8Array(192 * 240))
    expect(audit.outOfPaletteCount).toBe(0)
    expect(audit.statusPixelsOutsideMask).toBe(0)
    expect(audit.semiTransparentCount).toBe(0)

    expect(selectAvatarPack(stateDir, store, 'custom-sec-01')).toEqual({ ok: true, activeId: 'custom-sec-01' })
    expect(listAvatarPacks(stateDir, store).activeId).toBe('custom-sec-01')
  })

  it('reads latest gate.evaluated deny event in readTicketTranscript when >5 events exist (B1)', async () => {
    const stateDir = makeDir()
    const store = new Store(join(stateDir, 'orchestrator.sqlite')); stores.push(store)
    store.tickets.save(makeTicket('t-gate8'))
    const gov = new GovernanceRuntime({ store, stateDir })
    for (let i = 1; i <= 8; i++) {
      gov.appender.append({
        id: `g-${i}`, at: `2026-11-26T01:0${i}:00.000Z`, stream: 'ticket:t-gate8', type: 'gate.evaluated',
        source: { kind: 'system', ref: 'test' }, evidence: [], taint: 'trusted',
        payload: { ticketId: 't-gate8', point: 'verify.rerun', verdict: { kind: i === 8 ? 'deny' : 'allow' } },
      })
    }
    const view = await readTicketTranscript({ ticketId: 't-gate8', store, stateDir, limit: 5 })
    expect(view).toBeDefined()
    expect(view!.entries.at(-1)?.summary).toContain('deny')
    await gov.shutdown()
  })

  it('serves real HTTP POST /orchestrator/api/avatars/generate via local-remix and remote-ai (B2)', async () => {
    const stateDir = makeDir()
    const store = new Store(join(stateDir, 'orchestrator.sqlite')); stores.push(store)
    const gov = new GovernanceRuntime({ store, stateDir })
    const server = new OfficeServer({ host: makeHost(stateDir, store, gov) })
    servers.push(server)
    const port = await server.start(0)

    const prevKey = process.env.DSH_AVATAR_IMAGE_API_KEY
    const prevOpenAi = process.env.OPENAI_API_KEY
    delete process.env.DSH_AVATAR_IMAGE_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const localRes = await fetch(`http://127.0.0.1:${port}/orchestrator/api/avatars/generate`, {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${port}`, 'x-orchestrator-request': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ name: '离线重混秘书', prompt: 'emerald vest glasses', seed: 7 }),
      })
      expect(localRes.status).toBe(200)
      const localBody = await localRes.json() as { ok: boolean; pack?: { id: string; provider?: string; outOfPaletteCount: number } }
      expect(localBody.ok).toBe(true)
      expect(localBody.pack?.provider).toBe('local-remix')
      expect(localBody.pack?.outOfPaletteCount).toBe(0)

      const origFetch = globalThis.fetch
      const ok2xB64 = makeTestPng(384, 480).toString('base64')
      process.env.DSH_AVATAR_IMAGE_API_KEY = 'sk-test-avatar-mock'
      vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes('127.0.0.1')) return origFetch(url, init)
        return new Response(JSON.stringify({ data: [{ b64_json: ok2xB64 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }))

      const remoteRes = await fetch(`http://127.0.0.1:${port}/orchestrator/api/avatars/generate`, {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${port}`, 'x-orchestrator-request': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ name: '远程生图秘书', prompt: 'navy coat', seed: 9 }),
      })
      expect(remoteRes.status).toBe(200)
      const remoteBody = await remoteRes.json() as { ok: boolean; pack?: { id: string; provider?: string; outOfPaletteCount: number } }
      expect(remoteBody.ok).toBe(true)
      expect(remoteBody.pack?.provider).toBe('remote-ai')
      expect(remoteBody.pack?.outOfPaletteCount).toBe(0)
    } finally {
      vi.unstubAllGlobals()
      if (prevKey !== undefined) process.env.DSH_AVATAR_IMAGE_API_KEY = prevKey; else delete process.env.DSH_AVATAR_IMAGE_API_KEY
      if (prevOpenAi !== undefined) process.env.OPENAI_API_KEY = prevOpenAi; else delete process.env.OPENAI_API_KEY
      await server.close()
      await gov.shutdown()
    }
  })
})
