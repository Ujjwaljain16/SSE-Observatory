import http from 'node:http'
import type { AddressInfo } from 'node:net'
import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'

// How events are shown: highlighted JSON, the tree, the raw lines, repeats folded into one row, the event rate, the type chart, and the
// Doctor's request inspector. Local servers that start with the test.

let server: http.Server
let base = ''

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'X-Accel-Buffering': 'no' }
        if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
        res.writeHead(200, headers)
        let n = 0
        const repeat = req.url?.startsWith('/repeat')
        const limit = req.url?.startsWith('/few') ? 4 : Infinity // then nothing more, so rows stop moving
        const timer = setInterval(() => {
            if (n >= limit) { clearInterval(timer); return }
            if (repeat) {
                // five identical heartbeats, then a different event, again and again
                if (n % 6 === 5) res.write(`id: ${n}\nevent: update\ndata: {"n":${n}}\n\n`)
                else res.write(`id: ${n}\nevent: ping\ndata: pong\n\n`)
            } else {
                res.write(`id: ${n}\nevent: tick\ndata: {"n":${n},"user":{"name":"ada","tags":["a","b"]},"ok":true,"none":null}\n\n`)
            }
            n++
        }, 100)
        req.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => { server.closeAllConnections(); server.close() })

async function connect(page: Page, path: string) {
    await page.getByTestId('url-input').fill(`${base}${path}`)
    await page.getByTestId('connect-button').click()
    await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10_000 })
}

test.describe('Viewing events', () => {
    test('shows a JSON payload with syntax colours, and the text is unchanged', async ({ page }) => {
        await page.goto('/')
        await connect(page, '/steady')
        const first = page.getByTestId('event-row').first()
        const json = first.getByTestId('json-highlighted')
        await expect(json).toBeVisible()
        await expect(json).toContainText('"user"')
        // keys, strings, numbers and literals are separate spans
        expect(await json.locator('span').count()).toBeGreaterThan(8)
        await expect(json).toContainText('"ada"')
    })

    test('a tree lets a nested object be folded and opened', async ({ page }) => {
        await page.goto('/')
        await connect(page, '/few')
        await expect(page.getByTestId('event-row')).toHaveCount(4) // all four are in, so the first row stops changing
        const row = page.getByTestId('event-row').first()
        await row.getByTestId('view-tree').click()
        const tree = row.getByTestId('json-tree')
        await expect(tree).toContainText('ada')
        const user = tree.getByRole('button', { name: /user/ }).first()
        await expect(user).toHaveAttribute('aria-expanded', 'true')
        await user.click()
        await expect(user).toHaveAttribute('aria-expanded', 'false')
        await expect(tree).not.toContainText('ada')
        await user.click()
        await expect(tree).toContainText('ada')
    })

    test('raw lines show the event as its own lines, and say they are not the wire bytes', async ({ page }) => {
        await page.goto('/')
        await connect(page, '/few')
        await expect(page.getByTestId('event-row')).toHaveCount(4) // all four are in, so the first row stops changing
        const row = page.getByTestId('event-row').first()
        await row.getByTestId('view-raw').click()
        await expect(row.getByTestId('raw-lines')).toContainText('"user"')
        await expect(row).toContainText('not the wire bytes')
        await row.getByTestId('view-json').click()
        await expect(row.getByTestId('json-highlighted')).toBeVisible()
    })

    test('the view of one row does not change another row', async ({ page }) => {
        await page.goto('/')
        await connect(page, '/few')
        await expect(page.getByTestId('event-row')).toHaveCount(4)
        await page.getByTestId('event-row').nth(1).getByTestId('view-raw').click()
        await expect(page.getByTestId('event-row').nth(1).getByTestId('raw-lines')).toBeVisible()
        await expect(page.getByTestId('event-row').nth(2).getByTestId('json-highlighted')).toBeVisible()
    })

    test('shows how fast events arrive', async ({ page }) => {
        await page.goto('/')
        await connect(page, '/steady')
        const rate = page.getByTestId('event-rate')
        await expect(rate).toBeVisible()
        // about 10 a second from the server; allow a wide band for a busy machine
        await expect(async () => {
            const n = Number((await rate.innerText()).split(' ')[0])
            expect(n).toBeGreaterThan(2)
            expect(n).toBeLessThan(15)
        }).toPass({ timeout: 10_000 })
    })

    test('folds identical neighbours into one row, and keeps the event that differs', async ({ page }) => {
        await page.goto('/')
        await connect(page, '/repeat')
        await expect(async () => expect(await page.getByTestId('event-row').count()).toBeGreaterThan(5)).toPass({ timeout: 10_000 })
        await expect(page.getByTestId('repeat-count')).toHaveCount(0)

        await page.getByTestId('collapse-repeats').check()
        await expect(page.getByTestId('repeat-count').first()).toContainText('identical')
        await expect(page.getByTestId('collapsed-count')).toBeVisible()
        // the update events are never folded into the pings around them
        await expect(page.getByTestId('event-row').filter({ hasText: 'update' }).first()).toBeVisible()

        await page.getByTestId('collapse-repeats').uncheck()
        await expect(page.getByTestId('repeat-count')).toHaveCount(0)
    })

    test('remembers the choice to fold repeats', async ({ page }) => {
        await page.goto('/')
        await connect(page, '/repeat')
        await page.getByTestId('collapse-repeats').check()
        await page.reload()
        await connect(page, '/repeat')
        await expect(page.getByTestId('collapse-repeats')).toBeChecked()
    })

    test('charts the event types in the stats panel', async ({ page }) => {
        await page.goto('/')
        await connect(page, '/repeat')
        await expect(async () => expect(await page.getByTestId('event-row').count()).toBeGreaterThan(8)).toPass({ timeout: 10_000 })
        await page.getByRole('button', { name: 'Stats' }).click()
        const chart = page.getByTestId('type-chart')
        await expect(chart).toBeVisible()
        await expect(chart.getByTestId('type-row')).toHaveCount(2)
        await expect(chart).toContainText('ping')
        await expect(chart).toContainText('update')
    })
})

test.describe('Request inspector', () => {
    const openRequestTab = async (page: Page) => {
        await page.getByTestId('doctor-toggle').click()
        await page.getByRole('tab', { name: 'Request' }).click()
        await expect(page.getByTestId('doctor-request')).toBeVisible()
    }

    test('through the app proxy it shows the proxy request, says so, and lists the proxy tags', async ({ page }) => {
        await page.goto('/')
        await connect(page, '/steady')
        await openRequestTab(page)
        const panel = page.getByTestId('doctor-request')
        await expect(panel.getByTestId('request-line')).toContainText('/api/sse')
        await expect(panel.getByTestId('request-proxy-note')).toContainText("the app's server proxy")
        await expect(panel.getByRole('table', { name: /Response headers/ })).toContainText('x-sse-proxy')
        await expect(panel).toContainText('text/event-stream')
        await expect(panel).toContainText('First event')
        await expect(panel).toContainText('Values are never recorded')
    })

    test('direct to the stream it shows the stream URL, the kept headers and the time to each stage', async ({ page }) => {
        await page.goto('/')
        await page.getByRole('switch', { name: 'Use server proxy' }).click()
        await connect(page, '/steady')
        await openRequestTab(page)
        const panel = page.getByTestId('doctor-request')
        await expect(panel.getByTestId('request-line')).toContainText('GET')
        await expect(panel.getByTestId('request-line')).toContainText('/steady')
        await expect(panel.getByTestId('request-proxy-note')).toHaveCount(0)
        await expect(panel.getByRole('table', { name: /Response headers/ })).toContainText('cache-control')
        await expect(panel).toContainText('Response headers')
        await expect(panel).toContainText('First bytes')
    })

    test('has no accessibility violations with the viewers and the inspector open', async ({ page }) => {
        // The "NEW" badge on the newest row pulses; axe measures it mid-pulse at half opacity. With reduced motion it does not pulse.
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto('/')
        await connect(page, '/few')
        await expect(page.getByTestId('event-row')).toHaveCount(4)
        await page.getByTestId('event-row').first().getByTestId('view-tree').click()
        await openRequestTab(page)
        const results = await new AxeBuilder({ page }).include('[data-testid="doctor-panel"]').include('[data-testid="event-row"]').analyze()
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    })
})
