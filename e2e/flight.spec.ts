import http from 'node:http'
import type { AddressInfo } from 'node:net'
import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'

// The flight recorder: with the person's say-so, a copy of the recording is kept when the Doctor first reports an error, and at a bookmark.

let server: http.Server
let base = ''

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
        if (req.url?.startsWith('/html')) { res.writeHead(200, { 'Content-Type': 'text/html', ...cors }); res.end('<html>not a stream</html>'); return } // R01: an error
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...cors })
        let n = 0
        const timer = setInterval(() => { res.write(`id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`); n++ }, 200)
        req.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => { server.closeAllConnections(); server.close() })

async function connectDirect(page: Page, path: string) {
    await page.getByRole('switch', { name: 'Use server proxy' }).click() // direct, so the stream's own content type reaches the client
    await page.getByTestId('url-input').fill(`${base}${path}`)
    await page.getByTestId('connect-button').click()
}
const captures = async (page: Page) => {
    await page.getByTestId('doctor-toggle').click()
    await page.getByTestId('doctor-tab-captures').click()
}
const on = (page: Page) => page.addInitScript(() => localStorage.setItem('sse.flight.keep', '1'))

test.describe('Flight recorder', () => {
    test('keeps nothing on its own when it has not been turned on', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await connectDirect(page, '/html')
        await page.getByTestId('doctor-toggle').click()
        await expect(page.locator('[data-finding-key^="proto.content-type"]')).toBeVisible({ timeout: 20_000 })
        await page.getByTestId('doctor-tab-captures').click()
        await expect(page.getByTestId('flight-notice')).toHaveCount(0)
        await expect(page.getByTestId('capture-list')).toHaveCount(0)
    })

    test('keeps a copy when an error is first reported, says so, and does not repeat it', async ({ page }) => {
        test.setTimeout(60_000)
        await on(page)
        await page.goto('/')
        await connectDirect(page, '/html')
        await page.getByTestId('doctor-toggle').click()
        const notice = page.getByTestId('flight-notice')
        await expect(notice).toContainText('Kept a copy of the recording', { timeout: 25_000 })
        await expect(notice).toContainText('Flight recorder: ')
        await expect(notice).toContainText('in this browser only and not redacted')
        await page.getByTestId('doctor-tab-captures').click()
        const list = page.getByTestId('capture-list')
        await expect(list).toContainText('Flight recorder: ')
        await page.waitForTimeout(4000) // the same finding stays open: still one copy
        await expect(list.getByRole('row')).toHaveCount(2) // header and one copy
    })

    test('keeps a copy at a bookmark, named for it', async ({ page }) => {
        test.setTimeout(60_000)
        await on(page)
        await page.goto('/')
        await connectDirect(page, '/steady')
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10_000 })
        await page.getByTestId('doctor-toggle').click()
        await page.getByTestId('doctor-tab-timeline').click()
        await page.getByTestId('bookmark-label').fill('the odd moment')
        await page.getByTestId('bookmark-add').click()
        await expect(page.getByTestId('flight-notice')).toContainText('Flight recorder: the odd moment', { timeout: 10_000 })
        await page.getByTestId('doctor-tab-captures').click()
        await expect(page.getByTestId('capture-list')).toContainText('Flight recorder: the odd moment')
    })

    test('is switched on from the Privacy panel, and a copy is then kept', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await connectDirect(page, '/steady')
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10_000 })
        await captures(page)
        const box = page.getByTestId('privacy-flight')
        await expect(box).not.toBeChecked()
        await box.check()
        expect(await page.evaluate(() => localStorage.getItem('sse.flight.keep'))).toBe('1')
        await page.getByTestId('doctor-tab-timeline').click()
        await page.getByTestId('bookmark-add').click()
        await expect(page.getByTestId('flight-notice')).toContainText('Kept a copy', { timeout: 10_000 })
    })

    test('has no accessibility violations with the notice showing', async ({ page }) => {
        test.setTimeout(60_000)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await on(page)
        await page.goto('/')
        await connectDirect(page, '/html')
        await page.getByTestId('doctor-toggle').click()
        await expect(page.getByTestId('flight-notice')).toBeVisible({ timeout: 25_000 })
        const results = await new AxeBuilder({ page }).include('[data-testid="doctor-panel"]').analyze()
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    })
})
