import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'
import { activate } from './support/doctorKit'

// The fleet strip over several lanes of Multi-Stream, and the Doctor noticing a producer change its payload format.

let server: http.Server
let base = ''

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
        if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
        res.writeHead(200, headers)
        let n = 0
        const drift = req.url?.startsWith('/drift')
        const timer = setInterval(() => {
            if (drift && n >= 36) { clearInterval(timer); return } // then nothing more, the connection stays open
            // the first 20 orders have id, price and qty; from the 21st the price is gone and a currency is new
            const payload = !drift || n < 20 ? { id: n, price: 9.5, qty: 2 } : { id: n, qty: 2, currency: 'EUR' }
            res.write(`id: ${n}\nevent: order\ndata: ${JSON.stringify(payload)}\n\n`)
            n++
        }, 60)
        req.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => { server.closeAllConnections(); server.close() })

async function connect(page: Page, path: string) {
    await page.getByTestId('url-input').fill(`${base}${path}`)
    await activate(page.getByTestId('connect-button'))
    await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10_000 })
}

test.describe('Payload format change', () => {
    test('the Doctor reports a field that went and one that came, with the honest limits', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await connect(page, '/drift')
        await page.getByTestId('doctor-toggle').click()
        const finding = page.locator('[data-testid="doctor-finding"][data-finding-key="schema.drift:order"]')
        await expect(finding).toBeVisible({ timeout: 25_000 })
        await expect(finding).toContainText('Payload format changed: order')
        await expect(finding).toContainText('1 field gone (price)')
        await expect(finding).toContainText('1 field new (currency)')
        await expect(finding).toContainText('Likely:')
        await expect(finding).toContainText('structure of JSON payloads')
    })

    test('a stream whose payload keeps its format gets no such finding', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await connect(page, '/steady')
        await expect(page.getByTestId('event-row').first()).toBeVisible()
        await page.getByTestId('doctor-toggle').click()
        await expect.poll(async () => Number((await page.getByTestId('doctor-health').innerText()).match(/(\d+) events/)?.[1] ?? 0), { timeout: 15_000 }).toBeGreaterThan(30)
        await expect(page.locator('[data-finding-key^="schema.drift"]')).toHaveCount(0)
    })

    test('with the structure switched off nothing is compared, and the check says it was not evaluated', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await connect(page, '/drift')
        await page.getByTestId('doctor-toggle').click()
        await page.getByTestId('doctor-tab-captures').click()
        await page.getByTestId('privacy-shapes').uncheck()
        // it applies to streams started after the change: stop, and connect again
        await page.getByRole('button', { name: 'Stop' }).click()
        await connect(page, '/drift')
        await page.getByTestId('doctor-tab-findings').click()
        await expect.poll(async () => Number((await page.getByTestId('doctor-health').innerText()).match(/(\d+) events/)?.[1] ?? 0), { timeout: 15_000 }).toBeGreaterThan(30)
        await expect(page.locator('[data-finding-key^="schema.drift"]')).toHaveCount(0)
        await page.getByText(/What was checked/).click()
        await expect(page.getByText('Payload shape drift')).toBeVisible()
        await expect(page.getByText(/No event carried a payload shape/)).toBeVisible()
    })
})

test.describe('Fleet strip', () => {
    async function twoLanes(page: Page) {
        await page.goto('/')
        await page.getByRole('button', { name: 'Multi-Stream', exact: true }).click()
        for (const [name, path] of [['orders', '/steady'], ['prices', '/drift']] as const) {
            await page.getByLabel('Stream name').fill(name)
            await page.getByLabel('Stream URL').fill(`${base}${path}`)
            await page.getByRole('button', { name: 'Add', exact: true }).click()
        }
        for (let i = 1; i <= 2; i++) {
            await page.getByRole('button', { name: 'Connect', exact: true }).first().click()
            await expect(page.getByText(`${i}/2 live`)).toBeVisible({ timeout: 15_000 })
        }
        await page.getByTestId('doctor-toggle').click()
        await expect(page.getByTestId('fleet-strip')).toBeVisible()
    }

    test('shows the lanes together: how many, the events, the rate, and what is open', async ({ page }) => {
        test.setTimeout(80_000)
        await twoLanes(page)
        await expect(page.getByTestId('fleet-lanes')).toContainText('2')
        await expect(page.getByTestId('fleet-lanes')).toContainText('open')
        await expect.poll(async () => Number((await page.getByTestId('fleet-events').innerText()).match(/\d[\d,]*/)?.[0].replace(/,/g, '') ?? 0), { timeout: 20_000 }).toBeGreaterThan(40)
        await expect(page.getByTestId('fleet-events')).toContainText('events/s')
        // the lane that changed its payload format shows up as the fleet's open finding
        await expect(page.getByTestId('fleet-open-findings')).toContainText('warning', { timeout: 30_000 })
        const rows = page.getByTestId('fleet-table').getByRole('row')
        await page.getByText('Per lane').click()
        await expect(rows).toHaveCount(3)
        await expect(rows.nth(1)).toContainText('orders')
        await expect(rows.nth(2)).toContainText('prices')
    })

    test('saves a summary file of counts and lane names', async ({ page }) => {
        test.setTimeout(80_000)
        await twoLanes(page)
        const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('fleet-save').click()])
        expect(file.suggestedFilename()).toBe('sse-fleet.json')
        const parsed = JSON.parse(fs.readFileSync((await file.path())!, 'utf8'))
        expect(parsed).toMatchObject({ schemaVersion: 1, lanes: 2 })
        expect(parsed.perLane.map((l: { name: string }) => l.name)).toEqual(expect.arrayContaining(['orders', 'prices']))
        expect(JSON.stringify(parsed)).not.toContain('http')
    })

    test('has no accessibility violations', async ({ page }) => {
        test.setTimeout(80_000)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await twoLanes(page)
        await page.getByText('Per lane').click()
        const results = await new AxeBuilder({ page }).include('[data-testid="fleet-strip"]').analyze()
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    })
})
