#!/usr/bin/env node
/** Local one-click GitHub App Manifest registration wizard, verifier, and `gh-app` CLI proxy entrypoint. */
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  exchangeGithubAppManifestCode,
  loadGithubAppCredentials,
  runGhAppProxy,
  saveGithubAppCredentials,
  writeGhAppWrapper,
} from '../src/infra/github-app.ts'

const execFileAsync = promisify(execFile)
const SCRIPT_PATH = fileURLToPath(import.meta.url)

function parseArgs(argv) {
  const sep = argv.indexOf('--')
  const own = sep >= 0 ? argv.slice(0, sep) : argv
  const passthrough = sep >= 0 ? argv.slice(sep + 1) : []
  const opts = { outDir: resolve(process.cwd(), '.local', 'github-app'), port: 0, apiBase: 'https://api.github.com', githubBase: 'https://github.com' }
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]
    if (arg === '--gh-app') opts.ghApp = true
    else if (arg === '--verify') opts.verify = true
    else if (arg === '--repo') opts.repo = own[++i]
    else if (arg === '--org') opts.org = own[++i]
    else if (arg === '--app-name') opts.appName = own[++i]
    else if (arg === '--out-dir') opts.outDir = resolve(own[++i])
    else if (arg === '--port') opts.port = Number(own[++i])
    else if (arg === '--api-base') opts.apiBase = own[++i].replace(/\/+$/, '')
    else if (arg === '--github-base') opts.githubBase = own[++i].replace(/\/+$/, '')
  }
  return { opts, passthrough }
}

const htmlEscape = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function renderSetupPage({ actionUrl, manifestJson, appName, repo }) {
  return `<!doctype html><meta charset="utf-8"><title>创建 GitHub App</title>
<body style="font-family:system-ui;max-width:640px;margin:48px auto;line-height:1.6">
<h2>一键注册 GitHub App（免个人 Token）</h2>
<p>目标仓库：<code>${htmlEscape(repo)}</code> · 应用名：<code>${htmlEscape(appName)}</code></p>
<form method="post" action="${htmlEscape(actionUrl)}">
<input type="hidden" name="manifest" value="${htmlEscape(manifestJson)}">
<button type="submit" style="padding:10px 18px;font-size:16px;cursor:pointer">前往 GitHub 创建 App</button>
</form></body>`
}

function renderDonePage({ slug, htmlUrl, outDir, repo }) {
  const installUrl = `${htmlUrl.replace(/\/+$/, '')}/installations/new`
  const verifyCmd = `node ${SCRIPT_PATH} --verify --out-dir ${outDir} --repo ${repo}`
  return `<!doctype html><meta charset="utf-8"><title>GitHub App 创建成功</title>
<body style="font-family:system-ui;max-width:680px;margin:48px auto;line-height:1.6">
<h2>GitHub App 已创建：<code>${htmlEscape(slug)}[bot]</code></h2>
<p>凭据已安全保存至 <code>${htmlEscape(outDir)}</code>（权限 0600），包装器已生成：<code>${htmlEscape(join(outDir, 'bin', 'gh-app'))}</code></p>
<p><a href="${htmlEscape(installUrl)}" target="_blank">点击此处将 App 安装到仓库 ${htmlEscape(repo)}</a></p>
<p>安装完成后运行自检命令：</p>
<pre>${htmlEscape(verifyCmd)}</pre></body>`
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function runVerify(opts) {
  if (!opts.repo) throw new Error('--verify requires --repo <owner/name>')
  const wrapper = join(opts.outDir, 'bin', 'gh-app')
  const { stdout: userOut } = await execFileAsync(wrapper, ['api', 'user'])
  const user = JSON.parse(userOut)
  const { stdout: repoOut } = await execFileAsync(wrapper, ['api', `repos/${opts.repo}`, '--jq', '{name: .full_name, push: .permissions.push}'])
  const access = JSON.parse(repoOut)
  if (!access.push) throw new Error(`@${user.login} lacks push access to ${access.name ?? opts.repo}`)
  console.log(`OK: @${user.login} has push access to ${access.name ?? opts.repo}`)
}

async function runWizard(opts) {
  if (!opts.repo) throw new Error('--repo <owner/name> is required')
  const state = randomBytes(16).toString('hex')
  const appName = opts.appName ?? `dsh-${opts.repo.replace(/[^A-Za-z0-9-]/g, '-')}`.slice(0, 32)
  const server = createServer(async (req, res) => {
    try {
      const port = server.address().port
      if (req.headers.host !== `127.0.0.1:${port}`) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden')
        return
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (req.method === 'GET' && url.pathname === '/') {
        const manifest = {
          name: appName,
          url: `${opts.githubBase}/${opts.repo}`,
          redirect_url: `http://127.0.0.1:${port}/callback`,
          public: false,
          default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', checks: 'read', statuses: 'read', metadata: 'read' },
        }
        const actionUrl = opts.org
          ? `${opts.githubBase}/organizations/${encodeURIComponent(opts.org)}/settings/apps/new?state=${state}`
          : `${opts.githubBase}/settings/apps/new?state=${state}`
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderSetupPage({ actionUrl, manifestJson: JSON.stringify(manifest), appName, repo: opts.repo }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/callback') {
        const code = url.searchParams.get('code')
        const gotState = url.searchParams.get('state') ?? ''
        const stateOk = gotState.length === state.length && timingSafeEqual(Buffer.from(gotState), Buffer.from(state))
        if (!code || !stateOk) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Invalid state or missing code')
          return
        }
        const creds = await exchangeGithubAppManifestCode(code, opts.apiBase)
        await saveGithubAppCredentials(opts.outDir, { ...creds, repo: opts.repo })
        await writeGhAppWrapper(opts.outDir, { scriptPath: SCRIPT_PATH, repo: opts.repo })
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderDonePage({ slug: creds.slug, htmlUrl: creds.htmlUrl, outDir: opts.outDir, repo: opts.repo }))
        setImmediate(() => server.close())
        return
      }
      res.writeHead(404).end('Not Found')
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(err instanceof Error ? err.message : String(err))
    }
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(opts.port, '127.0.0.1', resolveListen)
  })
  const { port } = server.address()
  console.log(`GitHub App 注册向导已启动：http://127.0.0.1:${port}/`)
  console.log(`凭据输出目录：${opts.outDir}`)
  await new Promise(resolveClose => server.once('close', resolveClose))
  const saved = await loadGithubAppCredentials(opts.outDir)
  console.log(`已保存 @${saved.slug}[bot] (App ID ${saved.appId}) 至 ${opts.outDir}`)
}

const { opts, passthrough } = parseArgs(process.argv.slice(2))
if (opts.ghApp) {
  const stdinText = passthrough[0] === 'auth' && passthrough[1] === 'git-credential' ? await readStdin() : ''
  const result = await runGhAppProxy(opts.outDir, passthrough, { repo: opts.repo, stdinText })
  if (result.stdout) process.stdout.write(result.stdout)
  process.exit(result.code)
} else if (opts.verify) {
  await runVerify(opts)
} else {
  await runWizard(opts)
}
