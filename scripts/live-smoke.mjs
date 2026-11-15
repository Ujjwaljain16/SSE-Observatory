// An end-to-end smoke test of a DEPLOYED SSE Observatory (the hosted demo or a preview), driven through a real browser.
//
//   node scripts/live-smoke.mjs [--base https://sse-observatory.vercel.app] [--stream https://stream.wikimedia.org/v2/stream/recentchange] [--headed]
//
// It needs nothing from this repository's dev servers: the fixture servers listen on localhost and the hosted proxy refuses private addresses
// (rightly), so the stream is a public one. What it checks, in order: the app loads and shows the version of package.json; a stream connects through
// the server proxy and events arrive; the Stream Doctor opens and reads the stream (its health strip, every tab); raw values are labelled and a copy
// asks first; a report is exported and downloaded and holds no secret-looking value; the proxy refuses a private target and a missing one; the mock API
// is off (as on the hosted demo); the documentation site and its main pages load. It changes nothing on the site. Exit code 0 when everything held, 1 when
// something did not. Run it after a deploy, with the machine on a normal network.

import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && !process.argv[i + 1]?.startsWith('--') ? process.argv[i + 1] : fallback }
const BASE = String(arg('base', 'https://sse-observatory.vercel.app')).replace(/\/$/, '')
const STREAM = arg('stream', 'https://stream.wikimedia.org/v2/stream/recentchange')
const HEADED = process.argv.includes('--headed')
const root = path.resolve(import.meta.dirname, '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

const results = []
const step = async (name, fn) => {
    const started = Date.now()
    try { await fn(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`ok    ${name} (${Date.now() - started} ms)`) } catch (error) {
        const message = String(error?.message ?? error).split('\n').slice(0, 4).join(' | ')
        results.push({ name, ok: false, ms: Date.now() - started, message }); console.log(`FAIL  ${name}: ${message}`)
    }
}
const must = (condition, message) => { if (!condition) throw new Error(message) }

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'chrome', headless: !HEADED }).catch(() => chromium.launch({ headless: !HEADED }))
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 900 } })
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => undefined)
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message ?? e)))

console.log(`live smoke test of ${BASE}\nstream: ${STREAM}\nexpected version: ${VERSION}\n`)

await step('the app loads and shows its version', async () => {
    const response = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    must(response && response.status() === 200, `status ${response?.status()}`)
    await page.getByTestId('url-input').waitFor({ timeout: 30_000 })
    await page.getByText(`v${VERSION}`).first().waitFor({ timeout: 10_000 })
})

await step('a stream connects through the server proxy and events arrive', async () => {
    const proxy = page.getByRole('switch', { name: 'Use server proxy' })
    if ((await proxy.getAttribute('aria-checked')) !== 'true') await proxy.click()
    await page.getByTestId('url-input').fill(STREAM)
    await page.getByTestId('connect-button').click()
    await page.getByTestId('connection-status').getByText('Connected', { exact: false }).waitFor({ timeout: 30_000 })
    await page.getByText(/\b[1-9]\d* events? captured/).first().waitFor({ timeout: 30_000 })
})

await step('the Stream Doctor opens and reads the live stream', async () => {
    await page.getByTestId('doctor-toggle').click()
    const panel = page.getByTestId('doctor-panel').first()
    await panel.waitFor({ timeout: 15_000 })
    const strip = page.getByTestId('doctor-health')
    await strip.waitFor({ timeout: 15_000 })
    const text = await strip.innerText()
    must(/open/i.test(text), `the health strip does not say the connection is open: ${text.slice(0, 160)}`)
    must(/proxy/i.test(text), 'the strip does not mention the proxy (its heartbeats should be recognised)')
    const note = await panel.innerText()
    must(/not proof|could not look|checked/i.test(note), 'the Doctor does not say what was and was not checked')
})

await step('every Doctor tab opens without an error', async () => {
    for (const name of ['Findings', 'Request', 'Flow', 'Timeline', 'Sequence', 'Captures', 'Profile']) {
        const tab = page.getByRole('tab', { name, exact: true }).or(page.getByRole('button', { name, exact: true })).first()
        await tab.click({ timeout: 10_000 })
        await page.waitForTimeout(250)
        const failed = await page.getByText(/something went wrong|unexpected error/i).count()
        must(failed === 0, `the ${name} tab shows an error`)
    }
})

await step('the Timeline numbers the connection and shows the retry counter apart', async () => {
    await page.getByRole('tab', { name: 'Timeline', exact: true }).or(page.getByRole('button', { name: 'Timeline', exact: true })).first().click()
    const table = page.getByTestId('timeline-table')
    await table.waitFor({ timeout: 10_000 })
    const headers = (await table.getByRole('columnheader').allInnerTexts()).map((h) => h.trim())
    must(headers[0] === 'Connection' && headers[1] === 'Retry', `unexpected headers: ${headers.slice(0, 3).join(', ')}`)
    must((await table.getByRole('rowheader').first().innerText()).trim() === '#1', 'the first row is not #1')
})

await step('raw values are labelled, and a copy asks first and copies nothing on cancel', async () => {
    await page.getByText('Raw values — as received, not redacted.').first().waitFor({ timeout: 10_000 })
    const copy = page.getByRole('button', { name: /^Copy$/ }).first()
    await copy.waitFor({ timeout: 10_000 })
    await page.evaluate(() => navigator.clipboard.writeText('sentinel-before'))
    await copy.click()
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: /Copy a raw value/i })).first()
    await dialog.waitFor({ timeout: 5_000 })
    // the stream keeps arriving under the open warning; it used to close itself within a second on a fast stream (found by this script on 2026-11-15)
    await page.waitForTimeout(3_000)
    must(await dialog.isVisible(), 'the warning closed itself while the stream kept arriving')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    must((await page.evaluate(() => navigator.clipboard.readText())) === 'sentinel-before', 'Cancel changed the clipboard')
})

await step('a report is exported, downloads, and holds no secret-looking value', async () => {
    await page.getByTestId('doctor-export').click()
    await page.getByTestId('export-dialog').waitFor({ timeout: 10_000 })
    const redaction = page.getByTestId('export-redaction')
    if (await redaction.count()) await redaction.first().waitFor({ timeout: 10_000 })
    const ack = page.getByTestId('export-ack')
    if (await ack.count()) await ack.check().catch(() => undefined)
    const download = page.getByTestId('export-download')
    await download.waitFor({ timeout: 10_000 })
    must(await download.isEnabled(), 'the download button stays disabled')
    const [file] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), download.click()])
    const text = fs.readFileSync(await file.path(), 'utf8')
    must(text.length > 200, `the download is only ${text.length} bytes`)
    must(!/(bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,})/i.test(text), 'the export holds a token-shaped value')
    await page.keyboard.press('Escape')
})

await step('the stream stops on request', async () => {
    const stop = page.getByRole('button', { name: /^Stop$/ }).first()
    await stop.click({ timeout: 10_000 })
    await page.getByTestId('connection-status').getByText(/Disconnected/i).waitFor({ timeout: 15_000 })
})

await step('the server proxy refuses a private target and a missing one', async () => {
    const statuses = await page.evaluate(async () => {
        const get = async (u) => { const r = await fetch(u); await r.text().catch(() => ''); return r.status }
        return [await get('/api/sse'), await get('/api/sse?url=' + encodeURIComponent('http://127.0.0.1:1/')), await get('/api/sse?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data/'))]
    })
    must(statuses[0] === 400, `a request without a target answered ${statuses[0]}, not 400`)
    must(statuses[1] >= 400 && statuses[1] < 500, `a loopback target answered ${statuses[1]}`)
    must(statuses[2] >= 400 && statuses[2] < 500, `a cloud-metadata target answered ${statuses[2]}`)
})

await step('the mock API is off on the hosted demo, with a clear message', async () => {
    const r = await page.evaluate(async () => { const x = await fetch('/api/mock/stream?n=3'); return [x.status, await x.text()] })
    must(r[0] === 404 && /disabled/i.test(r[1]), `answered ${r[0]}: ${r[1].slice(0, 80)}`)
})

for (const [pathName, expectText] of [
    ['/docs/', /SSE Observatory/i],
    ['/docs/guide/getting-started', /Getting Started|Install/i],
    ['/docs/guide/stream-doctor', /Stream Doctor/i],
    ['/docs/guide/cli', /sse-doctor/i],
    ['/docs/guide/cli-ci', /scenario/i],
    ['/docs/guide/whats-new', new RegExp(`${VERSION.replace(/\./g, '\\.')}`)],
    ['/docs/technical/limitations', /limitation/i],
    ['/docs/technical/testing-campaign', /campaign/i],
]) {
    await step(`the documentation page ${pathName} loads`, async () => {
        const r = await page.goto(`${BASE}${pathName}`, { waitUntil: 'domcontentloaded' })
        must(r && r.status() === 200, `status ${r?.status()}`)
        const body = await page.locator('body').innerText()
        must(expectText.test(body), `the page does not mention ${expectText}`)
    })
}

await step('the app raised no uncaught error during the run', async () => {
    must(pageErrors.length === 0, `${pageErrors.length} uncaught error(s): ${pageErrors.slice(0, 2).join(' | ')}`)
})

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} of ${results.length} checks passed against ${BASE}`)
if (failed.length > 0) { for (const f of failed) console.log(`  FAILED: ${f.name}: ${f.message}`); process.exit(1) }
