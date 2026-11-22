import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const out = process.argv[2]
const playwrightPath = process.env.DSH_PLAYWRIGHT ?? '/Users/abab/pw/node_modules/playwright'
const require = createRequire(import.meta.url)
const { chromium } = require(playwrightPath)
const url = (await readFile(`${out}/web.stdout.log`, 'utf8')).match(/http:\/\/[^\s]+/)?.[0]
if (!url) throw new Error('隔离启动日志没有 URL')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  const responses = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('response', response => {
    if (response.url().includes('dsh-secretary')) {
      responses.push({ status: response.status(), url: response.url().replace(/([?&](?:token|rev)=)[^&]+/g, '$1已隐藏') })
    }
  })
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 })
  await page.getByRole('heading', { name: 'dsh-secretary', exact: true }).waitFor({ timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('#secretary-events')?.textContent?.includes('secretary_dispatch'), null, { timeout: 30000 }).catch(async error => {
    await page.screenshot({ path: `${out}/client-failure.png`, fullPage: true })
    await writeFile(`${out}/browser-failure.json`, JSON.stringify({ errors, responses, text: await page.locator('body').innerText() }, null, 2))
    throw error
  })
  const notice = page.getByRole('button', { name: 'Continue', exact: true })
  if (await notice.isVisible().catch(() => false)) {
    await notice.click()
    await notice.waitFor({ state: 'hidden' })
  }
  assert.deepEqual(errors, [])
  assert.ok(responses.some(item => item.status === 200 && item.url.includes('dsh-secretary/client.js')))
  await page.screenshot({ path: `${out}/client.png`, fullPage: true })
  await writeFile(`${out}/browser.json`, JSON.stringify({ errors, responses }, null, 2))
  console.log('client 资产 200；默认主面板和派发只读投影已实测。')
} finally {
  await browser.close()
}
