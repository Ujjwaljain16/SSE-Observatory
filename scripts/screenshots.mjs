// Regenerates the README screenshots in public/screenshots from a running dev stack.
//
//   terminal 1:  npm run dev
//   terminal 2:  node test-servers/demo-server.js
//   terminal 3:  node test-servers/test-multistream-server.js
//   then:        node scripts/screenshots.mjs        (BROWSER_CHANNEL=chrome to use an installed Chrome)

import { chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/screenshots')
const APP = process.env.APP_URL ?? 'http://localhost:3001'
const DEMO = 'http://localhost:4010/demo'

const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'dark' })
const newPage = async () => {
    const page = await context.newPage()
    await page.addInitScript(() => localStorage.setItem('sse-theme', 'dark'))
    await page.goto(APP)
    return page
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) })
// A viewport as tall as the page, so fixed elements (the timeline bar) sit at the bottom like they do for a user
// instead of landing in the middle of a full-page capture.
const tallShot = async (page, name) => {
    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    await page.setViewportSize({ width: 1360, height: Math.min(height, 3400) })
    await page.waitForTimeout(800)
    await shot(page, name)
}

// 1. Monitor mode: a live stream
{
    const page = await newPage()
    await page.getByTestId('url-input').fill(DEMO)
    await page.getByTestId('connect-button').click()
    await page.getByTestId('event-row').first().waitFor()
    await page.waitForTimeout(6000)
    await tallShot(page, 'monitor-mode.png')

    // 2. Event stream: filter, schema and the pattern alert from the error burst
    await page.getByTestId('search-input').fill('')
    await page.getByRole('button', { name: /Schema/ }).click()
    await page.getByRole('button', { name: /Patterns/ }).click()
    await page.waitForTimeout(1500)
    await page.waitForTimeout(500)
    await tallShot(page, 'event-stream.png')
    await page.close()
}

// 3. Multi-stream: three lanes
{
    const page = await newPage()
    await page.getByRole('button', { name: 'Multi-Stream', exact: true }).click()
    const lanes = [['Users', 'http://localhost:4003/stream-a'], ['Payments', 'http://localhost:4003/stream-b'], ['System', 'http://localhost:4003/stream-c']]
    for (const [name, url] of lanes) {
        await page.getByLabel('Stream name').fill(name)
        await page.getByLabel('Stream URL').fill(url)
        await page.getByRole('button', { name: 'Add', exact: true }).click()
    }
    for (const button of await page.locator('button[title="Connect"]').all()) await button.click()
    await page.getByTestId('event-row').first().waitFor()
    await page.waitForTimeout(7000)
    await tallShot(page, 'multi-stream.png')
    await page.close()
}

// 4. Mock server: a recording being served
{
    const page = await newPage()
    const events = Array.from({ length: 120 }, (_, i) => ({
        id: String(i + 1),
        type: ['order_created', 'payment_succeeded', 'inventory_updated'][i % 3],
        data: JSON.stringify({ traceId: `tr-${100 + Math.floor(i / 4)}`, amount: +(20 + (i * 7) % 180).toFixed(2) }),
        deltaMs: 150,
    }))
    await page.getByRole('button', { name: 'Mock Server', exact: true }).click()
    await page.locator('input[type="file"]').setInputFiles({ name: 'checkout-incident.sse-record', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: '1.0', events })) })
    await page.getByText('120 events loaded').waitFor()
    await page.getByRole('button', { name: '1x', exact: true }).click()
    await page.getByRole('button', { name: 'Start Mock Server', exact: true }).click()
    await page.getByText(/session=[0-9a-f-]{36}/).first().waitFor()
    await page.waitForTimeout(500)
    await shot(page, 'mock-server.png')
    await page.close()
}

await browser.close()
console.log('screenshots written to', OUT)
