/** 独立回环专属像素办公室 HTTP + SSE 服务：同源 API 分发、静态资产安全托管与实时治理事件推送。 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve } from 'node:path'
import { packagePath } from '../infra/paths.ts'
import { redactValue } from '../spine/redact.ts'
import { createApiDispatcher, isLoopbackHostHeader, type HttpHost } from './http.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const OFFICE_SHELL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DSH Pixel Office</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/office-app.js"></script>
</body>
</html>`

export interface OfficeStreamEvent {
  type: string
  data: unknown
}

function sendStaticFile(res: ServerResponse, rootDir: string, relPath: string): void {
  const clean = relPath.replace(/^\/+/, '')
  if (!clean || clean.includes('\0') || clean.split('/').some(seg => seg === '..' || seg === '.')) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
    return
  }
  const candidate = resolve(rootDir, clean)
  if (!existsSync(candidate) || !existsSync(rootDir)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  let realRoot: string, realTarget: string
  try {
    realRoot = realpathSync(rootDir)
    realTarget = realpathSync(candidate)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
    return
  }
  const mime = MIME[extname(realTarget).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(readFileSync(realTarget))
}

/** 独立像素办公室回环 HTTP+SSE 服务器，仅绑定 127.0.0.1 并复用全套 `/orchestrator/api/*` 路由。 */
export class OfficeServer {
  private server: Server | undefined
  private boundPort = 0
  private readonly clients = new Set<ServerResponse>()
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private readonly dispatch: (req: IncomingMessage, res: ServerResponse, port: number | undefined) => Promise<void>

  constructor(private readonly options: { host: HttpHost; onError?: (error: unknown) => void }) {
    this.dispatch = createApiDispatcher(options.host)
  }

  port(): number { return this.boundPort }

  async start(port: number): Promise<number> {
    if (this.server) return this.boundPort
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(err => {
        this.options.onError?.(err)
        if (!res.headersSent) { res.writeHead(500); res.end('Internal Error') }
      })
    })
    await new Promise<void>((resolveStart, rejectStart) => {
      server.once('error', rejectStart)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', rejectStart)
        resolveStart()
      })
    })
    this.server = server
    this.boundPort = (server.address() as AddressInfo).port
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) {
        try { res.write(': heartbeat\n\n') } catch { this.clients.delete(res) }
      }
    }, 15_000)
    this.heartbeat.unref()
    return this.boundPort
  }

  broadcast(event: OfficeStreamEvent): void {
    if (this.clients.size === 0) return
    const payload = JSON.stringify(redactValue(event.data).value)
    const frame = `event: ${event.type}\ndata: ${payload}\n\n`
    for (const res of this.clients) {
      try { res.write(frame) } catch { this.clients.delete(res) }
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined }
    for (const res of this.clients) {
      try { res.end(); res.destroy() } catch { /* ignore */ }
    }
    this.clients.clear()
    const srv = this.server
    this.server = undefined
    this.boundPort = 0
    if (!srv) return
    await new Promise<void>(resolveClose => { srv.close(() => resolveClose()) })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    if (pathname === '/orchestrator/api/events/stream') {
      this.handleSse(req, res)
      return
    }
    if (pathname.startsWith('/orchestrator/api/')) {
      await this.dispatch(req, res, this.boundPort)
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end(); return
    }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(OFFICE_SHELL_HTML)
      return
    }
    if (pathname === '/office-app.js') {
      sendStaticFile(res, packagePath('lib', 'office'), 'office-app.js')
      return
    }
    if (pathname.startsWith('/assets/')) {
      sendStaticFile(res, packagePath('assets'), pathname.slice('/assets/'.length))
      return
    }
    if (pathname.startsWith('/avatar-assets/')) {
      const rest = pathname.slice('/avatar-assets/'.length)
      const slash = rest.indexOf('/')
      const id = slash > 0 ? rest.slice(0, slash) : ''
      const file = slash > 0 ? rest.slice(slash + 1) : ''
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) { res.writeHead(403); res.end('Forbidden'); return }
      sendStaticFile(res, join(this.options.host.machine.stateDir, 'avatars', id), file)
      return
    }
    res.writeHead(404); res.end('Not Found')
  }

  private handleSse(req: IncomingMessage, res: ServerResponse): void {
    const host = req.headers.host
    const origin = req.headers.origin
    if (!isLoopbackHostHeader(host, this.boundPort) || (origin !== undefined && origin !== `http://${host}`)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Same-origin loopback request required' }))
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    })
    const gov = this.options.host.governance
    const readyPayload = {
      headSeq: gov?.latestSpineSeq() ?? 0,
      pendingRulings: gov?.rulings.active().pendingCount ?? 0,
    }
    res.write(`event: ready\ndata: ${JSON.stringify(readyPayload)}\n\n`)
    this.clients.add(res)
    req.on('close', () => { this.clients.delete(res) })
  }
}
