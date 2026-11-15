import http from 'node:http'
import type { AddressInfo } from 'node:net'
import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'

// The Doctor's Flow tab: events arriving, the page processing them, and where the connection was made again.

let server: http.Server
let base = ''

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
        if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
        res.writeHead(200, headers)
        const drop = req.url?.startsWith('/drop')
        const last = Number(req.headers['last-event-id'] ?? -1)
        let n = last + 1
        let sent = 0
        res.write('retry: 200\n\n')
        const timer = setInterval(() => {
            if (drop && last < 0 && sent === 15) { clearInterval(timer); res.end(); return }
            res.write(`id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`)
            n++
            sent++
        }, 40)
        req.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => { server.closeAllConnections(); server.close() })

async function openFlow(page: Page, path: string) {
    await page.goto('/')
    await page.getByTestId('url-input').fill(`${base}${path}`)
    await page.getByTestId('connect-button').click()
    await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('doctor-toggle').click()
    await page.getByTestId('doctor-tab-flow').click()
    await expect(page.getByTestId('doctor-flow')).toBeVisible()
}

test.describe('Flow tab', () => {
    test('draws the events as they arrive and says in words what was measured and what was not', async ({ page }) => {
        test.setTimeout(60_000)
        await openFlow(page, '/steady')
        const flow = page.getByTestId('doctor-flow')
        await expect(flow.getByRole('img')).toHaveAccessibleName(/Flow of \d+ events over/, { timeout: 15_000 })
        const summary = page.getByTestId('flow-summary')
        await expect(summary).toContainText('events arrived over')
        await expect(summary).toContainText('The time between events was')
        await expect(summary).toContainText('Not measured: when the producer created or wrote each event')
    })

    test('reports how long the page took to process events, from the page\'s own samples', async ({ page }) => {
        test.setTimeout(60_000)
        await openFlow(page, '/steady')
        await expect(page.getByTestId('flow-summary')).toContainText('The page processed them in', { timeout: 20_000 })
        await expect(page.getByTestId('flow-summary')).toContainText('waited')
    })

    test('marks where the connection was made again', async ({ page }) => {
        test.setTimeout(60_000)
        await openFlow(page, '/drop')
        await expect(page.getByTestId('doctor-flow').getByText('reconnected')).toBeVisible({ timeout: 20_000 })
    })

    test('has no accessibility violations', async ({ page }) => {
        test.setTimeout(60_000)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await openFlow(page, '/steady')
        await expect(page.getByTestId('flow-summary')).toContainText('The page processed them in', { timeout: 20_000 })
        const results = await new AxeBuilder({ page }).include('[data-testid="doctor-flow"]').analyze()
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    })
})
