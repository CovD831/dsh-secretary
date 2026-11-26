import { execFile } from 'node:child_process'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { resolveDeployment, type Machine } from '../src/deployment.ts'
import {
  exchangeGithubAppManifestCode,
  getInstallationAccessToken,
  loadGithubAppCredentials,
  runGhAppProxy,
  saveGithubAppCredentials,
  signGithubAppJwt,
  writeGhAppWrapper,
} from '../src/infra/github-app.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf } from '../src/app/source-context.ts'
import { githubKind, pollRound } from '../src/sources/github.ts'
import { mentions } from '../src/sources/github-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

const exec = promisify(execFile)
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const SCRIPT_PATH = join(process.cwd(), 'scripts', 'setup-github-app.mjs')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'p5-gh-app-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('GitHub App JWT & credentials', () => {
  it('signs RS256 JWTs verifiable with the corresponding public key', () => {
    const now = 1_760_000_000
    const jwt = signGithubAppJwt(12345, PRIVATE_PEM, now)
    const [h, p, sig] = jwt.split('.')
    expect(h && p && sig).toBeTruthy()
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8'))
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(payload).toEqual({ iat: now - 60, exp: now + 540, iss: '12345' })
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(PUBLIC_PEM, sig!, 'base64url')
    expect(ok).toBe(true)
  })

  it('exchanges manifest code, saves 0600 credentials without pem in app.json, rejects symlinks, and caches/refreshes installation tokens', async () => {
    let tokenCounter = 0
    const calls: string[] = []
    const server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`)
      if (req.method === 'POST' && req.url === '/app-manifests/code-123/conversions') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 42, slug: 'dsh-maint', name: 'DSH Maint', pem: PRIVATE_PEM, html_url: 'https://github.com/apps/dsh-maint' }))
        return
      }
      if (req.method === 'GET' && req.url === '/repos/acme/widgets/installation') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 99, permissions: { contents: 'write', pull_requests: 'write' } }))
        return
      }
      if (req.method === 'POST' && req.url === '/app/installations/99/access_tokens') {
        tokenCounter += 1
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          token: `ghs_mock_${tokenCounter}`,
          expires_at: new Date(1_760_000_000_000 + 3600_000).toISOString(),
          permissions: { contents: 'write', pull_requests: 'write' },
        }))
        return
      }
      if (req.method === 'GET' && req.url === '/users/dsh-maint%5Bbot%5D') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ login: 'dsh-maint[bot]', id: 777, type: 'Bot' }))
        return
      }
      res.writeHead(404).end('Not Found')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as { port: number }
      const apiBase = `http://127.0.0.1:${port}`
      const creds = await exchangeGithubAppManifestCode('code-123', apiBase)
      const appDir = join(dir, 'app-creds')
      await saveGithubAppCredentials(appDir, { ...creds, repo: 'acme/widgets' })

      expect(statSync(appDir).mode & 0o777).toBe(0o700)
      expect(statSync(join(appDir, 'app.json')).mode & 0o777).toBe(0o600)
      expect(statSync(join(appDir, 'private-key.pem')).mode & 0o777).toBe(0o600)
      expect(readFileSync(join(appDir, 'app.json'), 'utf8')).not.toContain('BEGIN RSA PRIVATE KEY')

      const loaded = await loadGithubAppCredentials(appDir)
      expect(loaded.appId).toBe(42)
      expect(loaded.slug).toBe('dsh-maint')

      const t1 = await getInstallationAccessToken(appDir, 'acme/widgets', { nowMs: 1_760_000_000_000 })
      expect(t1.token).toBe('ghs_mock_1')
      expect(t1.botUser).toEqual({ login: 'dsh-maint[bot]', id: 777, type: 'Bot' })
      expect(statSync(join(appDir, 'token-cache.json')).mode & 0o777).toBe(0o600)

      const beforeCacheCount = calls.length
      const t2 = await getInstallationAccessToken(appDir, 'acme/widgets', { nowMs: 1_760_000_000_000 + 1800_000 })
      expect(t2.token).toBe('ghs_mock_1')
      expect(calls.length).toBe(beforeCacheCount)

      const t3 = await getInstallationAccessToken(appDir, 'acme/widgets', { nowMs: 1_760_000_000_000 + 3400_000 })
      expect(t3.token).toBe('ghs_mock_2')
      expect(calls.length).toBeGreaterThan(beforeCacheCount)

      // Symlink rejection
      const linkDir = join(dir, 'link-creds')
      symlinkSync(appDir, linkDir)
      await expect(loadGithubAppCredentials(linkDir)).rejects.toThrow(/symlink/i)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('runs gh-app wrapper for api user, auth git-credential, and passthrough gh', async () => {
    const appDir = join(dir, 'cli-app')
    const binDir = join(dir, 'fake-bin')
    mkdirSync(binDir, { recursive: true })
    const fakeGh = join(binDir, 'gh')
    writeFileSync(fakeGh, '#!/bin/sh\necho "TOKEN=$GH_TOKEN CONFIG=$GH_CONFIG_DIR ARGS=$*"\n')
    chmodSync(fakeGh, 0o755)

    const server = createServer((req, res) => {
      if (req.url === '/repos/acme/widgets/installation') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 10 }))
      } else if (req.url === '/app/installations/10/access_tokens') {
        res.writeHead(201, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ token: 'ghs_subproc_token', expires_at: new Date(Date.now() + 3600_000).toISOString() }))
      } else if (req.url === '/users/dsh-maint%5Bbot%5D') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ login: 'dsh-maint[bot]', id: 88, type: 'Bot' }))
      } else {
        res.writeHead(404).end()
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as { port: number }
      await saveGithubAppCredentials(appDir, { appId: 7, slug: 'dsh-maint', apiBase: `http://127.0.0.1:${port}`, pem: PRIVATE_PEM, repo: 'acme/widgets' })
      const wrapper = await writeGhAppWrapper(appDir, { scriptPath: SCRIPT_PATH, repo: 'acme/widgets' })

      const { stdout: userOut } = await exec(wrapper, ['api', 'user'])
      expect(JSON.parse(userOut)).toEqual({ login: 'dsh-maint[bot]', id: 88, type: 'Bot' })

      const credRes = await runGhAppProxy(appDir, ['auth', 'git-credential', 'get'], { stdinText: 'protocol=https\nhost=github.com\n\n' })
      expect(credRes.stdout).toContain('username=x-access-token')
      expect(credRes.stdout).toContain('password=ghs_subproc_token')

      const { stdout: ghOut } = await exec(wrapper, ['issue', 'list'], { env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` } })
      expect(ghOut).toContain('TOKEN=ghs_subproc_token')
      expect(ghOut).toContain(`CONFIG=${join(appDir, 'gh-empty-config')}`)
      expect(ghOut).toContain('ARGS=issue list')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('GitHub App kernel compatibility', () => {
  it('resolveDeployment sets app: true for [bot] accounts and keeps ordinary users unchanged', async () => {
    const binDir = join(dir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const makeGh = (name: string, userJson: string) => {
      const file = join(binDir, name)
      writeFileSync(file, `#!/bin/sh\ncase "$*" in\n  "api user") echo '${userJson}' ;;\n  "api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":true}' ;;\n  *) exit 1 ;;\nesac\n`)
      chmodSync(file, 0o755)
      return file
    }
    const probe = async (argv: string[]) => (await exec(argv[0]!, argv.slice(1))).stdout
    const machine: Machine = testMachine({ stateDir: join(dir, 'state') })

    const appDep = await resolveDeployment(machine, { repository: 'acme/widgets', cli: makeGh('gh-app', '{"login":"dsh-maint[bot]","id":7,"type":"Bot"}') }, probe, binDir)
    expect(appDep.github).toEqual({ cli: join(binDir, 'gh-app'), login: 'dsh-maint[bot]', noreply: '7+dsh-maint[bot]@users.noreply.github.com', app: true })

    const userDep = await resolveDeployment(machine, { repository: 'acme/widgets', cli: makeGh('gh-user', '{"login":"Agent-Bot","id":7}') }, probe, binDir)
    expect(userDep.github).toEqual({ cli: join(binDir, 'gh-user'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(userDep.github).not.toHaveProperty('app')
  })

  it('mentions matches @slug[bot] and @slug without false-matching @slug-other', () => {
    expect(mentions('hi @dsh-maint[bot], please check', 'dsh-maint[bot]')).toBe(true)
    expect(mentions('hi @dsh-maint, please check', 'dsh-maint[bot]')).toBe(true)
    expect(mentions('hi @DSH-MAINT please check', 'dsh-maint[bot]')).toBe(true)
    expect(mentions('hi @dsh-maint-other please check', 'dsh-maint[bot]')).toBe(false)
    expect(mentions('hi @dsh-maint[other] please check', 'dsh-maint[bot]')).toBe(false)
    expect(mentions('email a@dsh-maint', 'dsh-maint[bot]')).toBe(false)
  })

  it('pollRound in GitHub App mode skips /notifications and admits @slug Issues even with observeIssues=false', async () => {
    const store = new Store(join(dir, 'db.sqlite'))
    const settings = SettingsSchema.parse({
      policy: { sources: { github: { allowed: [{ id: 'alice' }] } } },
      eval: { mode: 'auto' },
      sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: '/bin/false', observeIssues: false, observePulls: false, observeComments: false } } },
    })
    store.saveSettings(settings)
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(githubKind)
    const deployment = testDeployment({ github: { cli: '/bin/false', login: 'dsh-maint[bot]', noreply: '7+dsh-maint[bot]@users.noreply.github.com', app: true } })
    const assessor: Assessor = { request: vi.fn(async () => {}) }
    const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
    const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const received: { trigger: Trigger; res: string }[] = []
    const receive = async (trigger: Trigger) => {
      const res = engine.receive(trigger)
      engine.evaluateDue()
      received.push({ trigger, res })
      return res
    }
    const ctx = sourceContextOf({ store, engine, outbox, commands, sources, deployment, ready: Promise.resolve(), configured: () => true, receive }, githubKind)

    const future = new Date(Date.now() + 60_000).toISOString()
    const reads: string[] = []
    vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
      const rawPath = args[1] ?? ''
      reads.push(rawPath)
      const path = rawPath.split('?')[0]!
      const body = path === 'repos/acme/widgets/issues'
        ? [
            { id: 1, number: 10, title: 'Mentioned', body: '@dsh-maint please fix', state: 'open', created_at: future, updated_at: future, html_url: 'https://github.com/acme/widgets/issues/10', user: { login: 'alice', type: 'User' } },
            { id: 2, number: 11, title: 'Unmentioned', body: 'just a note', state: 'open', created_at: future, updated_at: future, html_url: 'https://github.com/acme/widgets/issues/11', user: { login: 'alice', type: 'User' } },
          ]
        : []
      return `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}`
    })

    const interval = await pollRound(ctx)
    expect(interval).toBe(60)
    expect(reads.some(r => r.startsWith('notifications'))).toBe(false)
    expect(reads.some(r => r.startsWith('repos/acme/widgets/issues?'))).toBe(true)
    expect(assessor.request).toHaveBeenCalledTimes(1)
    expect(received.filter(r => r.trigger.addressed === 'mention').map(r => r.trigger.meta.number)).toEqual([10])
    expect(board.all.github).toMatchObject({ state: 'ready', detail: 'GitHub App mode (repository streams); next poll ≥ 60s' })
    store.close()
  })
})
