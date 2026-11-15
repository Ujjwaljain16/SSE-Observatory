import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type Locator, type Page } from '@playwright/test'

// First-use polish (issue 81): the URL field survives a reload, the event list header says what the cap hides, and the floating
// playback bar does not sit on top of the toolbar. A small local server that starts with the test.

let server: http.Server
let base = ''
let connections = 0

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'X-Accel-Buffering': 'no' }
        if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
        connections++
        res.writeHead(200, headers)
        if (req.url?.startsWith('/burst')) {
            // 1,250 events at once (more than the 1,000 the page keeps), then quiet
            let out = ''
            for (let n = 0; n < 1250; n++) out += `id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`
            res.write(out)
            return
        }
        let n = 0
        const timer = setInterval(() => { res.write(`id: ${n}\nevent: tick\ndata: {"n":${n++}}\n\n`) }, 200)
        req.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => { server.closeAllConnections(); server.close() })

async function connect(page: Page, url: string) {
    await page.getByTestId('url-input').fill(url)
    await page.getByTestId('connect-button').click()
    await expect(page.getByTestId('connection-status')).toContainText('Connected', { timeout: 10_000 })
}

test.describe('The URL is remembered', () => {
    test('a reload keeps the address in the field, without the token, and does not connect by itself', async ({ page }) => {
        await page.goto('/')
        await page.getByTestId('token-input').fill('SECRET-BEARER-TOKEN')
        await connect(page, `${base}/steady`)
        const before = connections

        await page.reload()
        await expect(page.getByTestId('url-input')).toHaveValue(`${base}/steady`)
        await expect(page.getByTestId('token-input')).toHaveValue('')
        await expect(page.getByTestId('connection-status')).toContainText('Disconnected')
        await expect(page.getByTestId('connect-button')).toBeEnabled() // ready for one click, not connected yet
        await expect(page.getByTestId('connection-status')).toContainText('Disconnected') // still, after the page had time to act
        expect(connections).toBe(before)

        const stored = await page.evaluate(() => Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join('\n'))
        expect(stored).not.toContain('SECRET-BEARER-TOKEN')
    })

    test('an address that carries a credential is not remembered', async ({ page }) => {
        await page.goto('/')
        await connect(page, `${base}/steady?token=abc123`)
        await page.reload()
        await expect(page.getByTestId('url-input')).toHaveValue('')
        const stored = await page.evaluate(() => Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join('\n'))
        expect(stored).not.toContain('abc123')
    })
})

test.describe('The event list header', () => {
    test('says how many of all the events the list holds once the cap is reached', async ({ page }) => {
        await page.goto('/')
        await connect(page, `${base}/burst`)
        await expect(page.getByTestId('event-count')).toHaveText('newest 1,000 of 1,250 events', { timeout: 15_000 })
    })

    test('says plainly how many were captured while nothing has been pushed out', async ({ page }) => {
        await page.goto('/')
        await connect(page, `${base}/steady`)
        await expect(page.getByTestId('event-count')).toHaveText(/^\d+ events captured$/)
    })
})

// A button is covered when something else is on top of it at its own centre (the floating playback bar, for one).
const coveredBy = (button: Locator) => button.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { inView: r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight, covered: !(hit !== null && (el === hit || el.contains(hit))), hit: hit?.outerHTML.slice(0, 90) ?? null }
})
const toolbar = (page: Page) => [page.getByRole('button', { name: /^Patterns/ }), page.getByTestId('doctor-toggle'), page.getByRole('button', { name: /^Interceptors/ })]

test.describe('The playback bar', () => {
    test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' }) // the bar slides in: measure it where it settles
        await page.setViewportSize({ width: 1360, height: 900 })
        await page.goto('/')
        await expect(page.getByTestId('doctor-toggle')).toBeVisible()
    })

    test('does not sit on the Patterns, Doctor and Interceptors row when the page first loads at 1360x900', async ({ page }) => {
        for (const button of toolbar(page)) {
            await expect(async () => {
                const seen = await coveredBy(button)
                expect(seen, `${await button.textContent()} is covered by ${seen.hit}`).toMatchObject({ inView: true, covered: false })
            }).toPass({ timeout: 5_000 })
        }
    })

    test('does not cover the row, or the footer, once the page is scrolled to the end', async ({ page }) => {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        for (const button of toolbar(page)) {
            await button.scrollIntoViewIfNeeded()
            const seen = await coveredBy(button)
            expect(seen, `${await button.textContent()} is covered by ${seen.hit}`).toMatchObject({ covered: false })
        }
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        const box = (await page.getByText(/Built with React/).boundingBox())!
        const barTop = (await page.getByRole('button', { name: /Pause Stream|Resume Stream/ }).boundingBox())!.y
        expect(box.y + box.height, 'the last line of the page ends above the playback bar').toBeLessThan(barTop)
    })
})
