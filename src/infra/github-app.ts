/** Zero-dependency GitHub App JWT, Manifest exchange, installation token cache, and `gh-app` proxy runtime. */
import { spawn } from 'node:child_process'
import { createSign } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'

export interface GithubAppCredentials {
  appId: number; slug: string; name: string; htmlUrl: string; apiBase: string; pem: string; repo?: string
}
export interface BotUser { login: string; id: number; type: string }
export interface InstallationTokenResult {
  token: string; expiresAt: string; botUser: BotUser; permissions: Record<string, string>
}
interface CachedToken extends InstallationTokenResult {}

const TOKEN_REFRESH_MARGIN_MS = 300_000
const DEFAULT_API_BASE = 'https://api.github.com'
const trimSlash = (url: string): string => url.replace(/\/+$/, '')
const b64url = (input: string | Buffer): string => Buffer.from(input).toString('base64url')

function ghHeaders(auth?: string): Record<string, string> {
  return { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-superagent', 'X-GitHub-Api-Version': '2022-11-28', ...(auth ? { Authorization: auth } : {}) }
}

async function assertNotSymlink(target: string): Promise<void> {
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error(`Refusing symlink path: ${target}`) }
  catch (err) { if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err }
}

async function ensureSecureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await assertNotSymlink(dir)
  await chmod(dir, 0o700)
}

async function writeSecureFile(file: string, content: string, mode = 0o600): Promise<void> {
  await assertNotSymlink(file)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, { encoding: 'utf8', mode })
  await chmod(tmp, mode)
  await rename(tmp, file)
}

function redactSecret(text: string): string {
  return text.replace(/(gh[psu]_[A-Za-z0-9_]+|-----BEGIN[\s\S]*?END[^-]*-----)/g, '[REDACTED]')
}

/** Sign a short-lived RS256 JWT for GitHub App authentication (`iat = now - 60`, `exp = now + 540`). */
export function signGithubAppJwt(appId: string | number, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) }))
  const unsigned = `${header}.${payload}`
  const sig = createSign('RSA-SHA256').update(unsigned).end().sign(privateKeyPem, 'base64url')
  return `${unsigned}.${sig}`
}

/** Exchange a one-time GitHub App Manifest `code` for App credentials and private key PEM. */
export async function exchangeGithubAppManifestCode(
  code: string,
  apiBase = DEFAULT_API_BASE,
  fetchFn: typeof fetch = fetch,
): Promise<GithubAppCredentials> {
  const base = trimSlash(apiBase)
  const res = await fetchFn(`${base}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: ghHeaders() })
  if (!res.ok) throw new Error(`Manifest exchange failed (HTTP ${res.status}): ${redactSecret(await res.text())}`)
  const data = (await res.json()) as Record<string, unknown>
  if (typeof data.id !== 'number' || typeof data.slug !== 'string' || typeof data.pem !== 'string' || typeof data.html_url !== 'string') {
    throw new Error('Manifest exchange returned incomplete GitHub App payload')
  }
  return { appId: data.id, slug: data.slug, name: typeof data.name === 'string' && data.name ? data.name : data.slug, htmlUrl: data.html_url, apiBase: base, pem: data.pem }
}

/** Persist GitHub App metadata (`0600`) and private key PEM (`0600`) in a `0700` directory, rejecting symlinks. */
export async function saveGithubAppCredentials(
  dir: string,
  creds: { appId: number; slug: string; name?: string; htmlUrl?: string; apiBase?: string; pem: string; repo?: string },
): Promise<void> {
  await ensureSecureDir(dir)
  const meta = {
    appId: creds.appId,
    slug: creds.slug,
    name: creds.name ?? creds.slug,
    htmlUrl: creds.htmlUrl ?? '',
    apiBase: trimSlash(creds.apiBase ?? DEFAULT_API_BASE),
    ...(creds.repo ? { repo: creds.repo } : {}),
  }
  await writeSecureFile(join(dir, 'app.json'), JSON.stringify(meta, null, 2) + '\n', 0o600)
  await writeSecureFile(join(dir, 'private-key.pem'), creds.pem, 0o600)
}

/** Load GitHub App metadata and private key PEM from `dir`, rejecting symlinks. */
export async function loadGithubAppCredentials(dir: string): Promise<GithubAppCredentials> {
  await assertNotSymlink(dir)
  const appPath = join(dir, 'app.json')
  const pemPath = join(dir, 'private-key.pem')
  await assertNotSymlink(appPath)
  await assertNotSymlink(pemPath)
  const meta = JSON.parse(await readFile(appPath, 'utf8')) as Record<string, unknown>
  const pem = await readFile(pemPath, 'utf8')
  if (typeof meta.appId !== 'number' || typeof meta.slug !== 'string' || !pem.trim()) {
    throw new Error(`Invalid GitHub App credentials in ${dir}`)
  }
  return {
    appId: meta.appId,
    slug: meta.slug,
    name: typeof meta.name === 'string' ? meta.name : meta.slug,
    htmlUrl: typeof meta.htmlUrl === 'string' ? meta.htmlUrl : '',
    apiBase: typeof meta.apiBase === 'string' && meta.apiBase ? trimSlash(meta.apiBase) : DEFAULT_API_BASE,
    pem,
    ...(typeof meta.repo === 'string' && meta.repo ? { repo: meta.repo } : {}),
  }
}

/** Return a cached or freshly minted Installation Access Token for `repository`, refreshing >5m before expiry. */
export async function getInstallationAccessToken(
  dir: string,
  repository: string,
  options: { fetchFn?: typeof fetch; nowMs?: number } = {},
): Promise<InstallationTokenResult> {
  const fetchFn = options.fetchFn ?? fetch
  const nowMs = options.nowMs ?? Date.now()
  const creds = await loadGithubAppCredentials(dir)
  const cachePath = join(dir, 'token-cache.json')
  await assertNotSymlink(cachePath)
  let cache: Record<string, CachedToken> = {}
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, CachedToken> } catch { cache = {} }
  const cached = cache[repository]
  const expectedLogin = `${creds.slug}[bot]`
  if (cached && Date.parse(cached.expiresAt) - nowMs > TOKEN_REFRESH_MARGIN_MS && cached.botUser?.login === expectedLogin && typeof cached.botUser.id === 'number') {
    return cached
  }
  const jwt = signGithubAppJwt(creds.appId, creds.pem, Math.floor(nowMs / 1000))
  const instRes = await fetchFn(`${creds.apiBase}/repos/${repository}/installation`, { headers: ghHeaders(`Bearer ${jwt}`) })
  if (instRes.status === 404) {
    const installHint = creds.htmlUrl ? `${trimSlash(creds.htmlUrl)}/installations/new` : 'GitHub App 安装页面'
    throw new Error(`GitHub App 尚未安装到仓库 ${repository}，请先前往 ${installHint} 安装并授权该仓库`)
  }
  if (!instRes.ok) throw new Error(`Failed to query installation for ${repository} (HTTP ${instRes.status})`)
  const inst = (await instRes.json()) as { id: number; permissions?: Record<string, string> }
  const tokRes = await fetchFn(`${creds.apiBase}/app/installations/${inst.id}/access_tokens`, { method: 'POST', headers: ghHeaders(`Bearer ${jwt}`) })
  if (!tokRes.ok) throw new Error(`Failed to mint installation token for ${repository} (HTTP ${tokRes.status})`)
  const tok = (await tokRes.json()) as { token: string; expires_at: string; permissions?: Record<string, string> }
  let botUser: BotUser | undefined
  const userRes = await fetchFn(`${creds.apiBase}/users/${encodeURIComponent(expectedLogin)}`, { headers: ghHeaders(`Bearer ${tok.token}`) })
  if (userRes.ok) {
    const u = (await userRes.json()) as { login?: string; id?: number; type?: string }
    if (typeof u.login === 'string' && typeof u.id === 'number') botUser = { login: u.login, id: u.id, type: u.type ?? 'Bot' }
  }
  if (!botUser) {
    const appRes = await fetchFn(`${creds.apiBase}/app`, { headers: ghHeaders(`Bearer ${jwt}`) })
    const app = appRes.ok ? ((await appRes.json()) as { id?: number }) : {}
    botUser = { login: expectedLogin, id: typeof app.id === 'number' ? app.id : creds.appId, type: 'Bot' }
  }
  const result: InstallationTokenResult = { token: tok.token, expiresAt: tok.expires_at, botUser, permissions: tok.permissions ?? inst.permissions ?? {} }
  cache[repository] = result
  await writeSecureFile(cachePath, JSON.stringify(cache, null, 2) + '\n', 0o600)
  return result
}

const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** Generate `<outDir>/bin/gh-app` (`0755`) wrapper delegating to `setup-github-app.mjs --gh-app`. */
export async function writeGhAppWrapper(outDir: string, options: { scriptPath: string; repo?: string }): Promise<string> {
  const binDir = join(outDir, 'bin')
  await ensureSecureDir(binDir)
  const wrapperPath = join(binDir, 'gh-app')
  const repoArg = options.repo ? ` --repo ${shQuote(options.repo)}` : ''
  const script = `#!/bin/sh\nset -eu\nexec ${shQuote(process.execPath)} ${shQuote(options.scriptPath)} --gh-app --out-dir ${shQuote(outDir)}${repoArg} -- "$@"\n`
  await writeSecureFile(wrapperPath, script, 0o755)
  return wrapperPath
}

function findRealGh(pathEnv: string, excludeDir: string): string {
  for (const dir of pathEnv.split(delimiter)) {
    if (!isAbsolute(dir) || dir === excludeDir) continue
    const candidate = join(dir, 'gh')
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } } catch { /* continue */ }
  }
  throw new Error('gh is not an executable file on PATH')
}

function inferRepo(args: string[], explicit?: string, env: NodeJS.ProcessEnv = process.env, fallback?: string): string {
  const fromEnv = env.DSH_GITHUB_APP_REPO?.trim() || env.DSH_SUPERAGENT_GITHUB_REPOSITORY?.trim()
  if (explicit) return explicit
  if (fromEnv) return fromEnv
  if (args[0] === 'api') {
    const m = /^\/?repos\/([^/]+\/[^/]+)/.exec(args[1] ?? '')
    if (m) return m[1]!
  }
  if (fallback) return fallback
  throw new Error('Repository is required for gh-app (--repo or DSH_SUPERAGENT_GITHUB_REPOSITORY)')
}

/** Execute `gh-app` proxy subcommands: `api user`, `auth git-credential`, or passthrough `gh` with `GH_TOKEN`. */
export async function runGhAppProxy(
  outDir: string,
  args: string[],
  options: { repo?: string; env?: NodeJS.ProcessEnv; stdinText?: string; fetchFn?: typeof fetch } = {},
): Promise<{ code: number; stdout?: string }> {
  const env = options.env ?? process.env
  const creds = await loadGithubAppCredentials(outDir)
  if (args[0] === 'api' && args[1] === 'user') {
    const repo = inferRepo(args, options.repo, env, creds.repo)
    const { botUser } = await getInstallationAccessToken(outDir, repo, { fetchFn: options.fetchFn })
    return { code: 0, stdout: `${JSON.stringify({ login: botUser.login, id: botUser.id, type: botUser.type })}\n` }
  }
  if (args[0] === 'auth' && args[1] === 'git-credential') {
    if (args[2] !== 'get') return { code: 0 }
    const kv = Object.fromEntries((options.stdinText ?? '').split(/\r?\n/).map(l => l.split('=', 2)).filter(p => p.length === 2))
    const expectedHost = creds.apiBase === DEFAULT_API_BASE ? 'github.com' : new URL(creds.apiBase).hostname
    if (kv.protocol !== 'https' || (kv.host !== 'github.com' && kv.host !== expectedHost)) return { code: 0 }
    const repo = inferRepo(args, options.repo, env, creds.repo)
    const { token } = await getInstallationAccessToken(outDir, repo, { fetchFn: options.fetchFn })
    return { code: 0, stdout: `protocol=https\nhost=${kv.host}\nusername=x-access-token\npassword=${token}\n\n` }
  }
  const repo = inferRepo(args, options.repo, env, creds.repo)
  const { token } = await getInstallationAccessToken(outDir, repo, { fetchFn: options.fetchFn })
  const emptyConfig = join(outDir, 'gh-empty-config')
  await ensureSecureDir(emptyConfig)
  const ghBin = findRealGh(env.PATH ?? '', join(outDir, 'bin'))
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(ghBin, args, {
      stdio: 'inherit',
      env: { ...env, GH_TOKEN: token, GH_CONFIG_DIR: emptyConfig },
    })
    child.on('error', reject)
    child.on('close', exitCode => resolve(exitCode ?? 1))
  })
  return { code }
}
