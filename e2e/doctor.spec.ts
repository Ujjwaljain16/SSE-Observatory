import http from 'node:http'
import type { AddressInfo } from 'node:net'
import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'

// The Stream Doctor panel against streams that behave in known ways. The servers are local and start with the test, so
// nothing here depends on the repository's other test servers.

let server: http.Server
let base = ''

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
        if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
        res.writeHead(200, headers)
        res.write(': open\n\n')
        let n = 0
        const limit = req.url?.startsWith('/silent') ? 12 : Infinity
        const timer = setInterval(() => {
            if (n >= limit) { clearInterval(timer); return } // then nothing more, and the connection stays open
            res.write(`id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`)
            n++
        }, 250)
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
}

const openDoctor = (page: Page) => page.getByTestId('doctor-toggle').click()

test.describe('Stream Doctor', () => {
    test('says what to do before any stream is connected', async ({ page }) => {
        await page.goto('/')
        await openDoctor(page)
        await expect(page.getByTestId('doctor-empty')).toContainText('Connect to a stream')
    })

    test('finds a stream that went silent, with evidence and honest limits', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await connect(page, '/silent')
        await openDoctor(page)

        const stall = page.locator('[data-testid="doctor-finding"][data-finding-key^="stall"]')
        await expect(stall).toBeVisible({ timeout: 25_000 })
        await expect(page.getByTestId('doctor-badge')).toBeVisible()
        await expect(page.getByTestId('doctor-toggle')).toHaveAccessibleName(/Doctor [0-9]+ open (warnings?|errors?)/)

        // The first finding is open: observed facts, then what is only inferred, then what this cannot tell.
        await expect(stall.getByRole('heading', { name: 'Observed' })).toBeVisible()
        await expect(stall.getByRole('heading', { name: 'Inferred, not measured' })).toBeVisible()
        await expect(stall.getByRole('heading', { name: 'Limits' })).toBeVisible()
        await expect(stall).toContainText('Likely:')

        // Evidence opens the raw record behind a claim.
        await stall.getByRole('button', { name: /record #\d+/ }).first().click()
        await expect(stall.locator('pre')).toContainText('"kind"')

        // The strip shows the live figures, and the connection is still open.
        const health = page.getByTestId('doctor-health')
        await expect(health).toContainText('open')
        await expect(health).toContainText('12 events')
    })

    test('a steady stream has no findings, and says that is not proof of health', async ({ page }) => {
        test.setTimeout(40_000)
        await page.goto('/')
        await connect(page, '/steady')
        await openDoctor(page)
        await page.waitForTimeout(6000)
        await expect(page.getByTestId('doctor-none')).toContainText('not proof')
        await expect(page.getByTestId('doctor-badge')).toHaveCount(0)
        // Checks that had nothing to look at are listed as such rather than left out.
        await page.getByText(/What was checked/).click()
        await expect(page.getByText('not evaluated').first()).toBeVisible()
    })

    test('works with the panel closed: the badge still appears', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await connect(page, '/silent')
        await expect(page.getByTestId('doctor-badge')).toBeVisible({ timeout: 25_000 })
        await expect(page.getByTestId('doctor-panel')).toHaveCount(0)
    })

    test('lanes each get a card, the worst one first', async ({ page }) => {
        test.setTimeout(80_000)
        await page.goto('/')
        await page.getByRole('button', { name: 'Multi-Stream', exact: true }).click()
        for (const [name, path] of [['calm', '/steady'], ['quiet', '/silent']] as const) {
            await page.getByLabel('Stream name').fill(name)
            await page.getByLabel('Stream URL').fill(`${base}${path}`)
            await page.getByRole('button', { name: 'Add', exact: true }).click()
        }
        // each click turns that lane's button into Disconnect, so the next lane's is the first Connect again
        for (let i = 1; i <= 2; i++) {
            await page.getByRole('button', { name: 'Connect', exact: true }).first().click()
            await expect(page.getByText(`${i}/2 live`)).toBeVisible({ timeout: 15_000 })
        }
        await openDoctor(page)
        const cards = page.getByTestId('doctor-lanes').getByTestId('doctor-panel')
        await expect(cards).toHaveCount(2)
        await expect(page.getByTestId('doctor-lanes').locator('[data-finding-key^="stall"]')).toBeVisible({ timeout: 30_000 })
        // The lane with the open warning is listed first.
        await expect(cards.first()).toContainText('quiet')
    })

    test('can be used from the keyboard alone', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await connect(page, '/silent')
        await page.getByTestId('doctor-toggle').focus()
        await page.keyboard.press('Enter')
        const stall = page.locator('[data-testid="doctor-finding"][data-finding-key^="stall"]')
        await expect(stall).toBeVisible({ timeout: 25_000 })
        const header = stall.getByRole('button').first()
        await expect(header).toHaveAttribute('aria-expanded', 'true') // the worst finding starts open
        await header.focus()
        await page.keyboard.press('Enter')
        await expect(header).toHaveAttribute('aria-expanded', 'false')
        await page.keyboard.press('Space')
        await expect(header).toHaveAttribute('aria-expanded', 'true')
        // Evidence is reachable with Tab and opens with Enter.
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')
        await expect(stall.locator('pre')).toBeVisible()
    })

    test('is exposed to assistive technology with structure, names, states and a quiet live region', async ({ page }) => {
        // A real screen reader is not run here. This checks what one is given: Chrome's accessibility tree for the panel.
        test.setTimeout(60_000)
        await page.goto('/')
        await connect(page, '/silent')
        await openDoctor(page)
        const stall = page.locator('[data-testid="doctor-finding"][data-finding-key^="stall"]')
        await expect(stall).toBeVisible({ timeout: 25_000 })
        const panel = page.getByTestId('doctor-panel')

        // Headings form an outline with no skipped level.
        const levels = await panel.locator('h1,h2,h3,h4,h5,h6').evaluateAll((hs) => hs.map((h) => Number(h.tagName[1])))
        expect(levels[0]).toBe(2)
        levels.forEach((level, i) => { if (i > 0) expect(level - levels[i - 1]!, 'heading levels: ' + levels.join(',')).toBeLessThanOrEqual(1) })

        // Each disclosure says whether it is open, and the figures are a labelled group of terms and values.
        await expect(stall.getByRole('button').first()).toHaveAttribute('aria-expanded', /true|false/)
        await expect(panel.getByRole('list', { name: 'Open findings' })).toBeVisible()
        await expect(panel.locator('dl[aria-label="Stream health"]')).toBeVisible()
        // Severity is in words, not only colour.
        await expect(stall).toContainText(/Error|Warning/)

        // The live region names the state and the counts, and does not change while the state does not.
        const live = panel.getByRole('status')
        await expect(live).toHaveText(/Connection open. [0-9]+ errors?, [0-9]+ warnings? open./)
        await page.waitForTimeout(1500)
        const mutations = await live.evaluate((el) => new Promise<number>((resolve) => {
            let n = 0
            const observer = new MutationObserver((list) => { n += list.length })
            observer.observe(el, { childList: true, characterData: true, subtree: true })
            setTimeout(() => { observer.disconnect(); resolve(n) }, 4000)
        }))
        expect(mutations, 'the live region must not change on every tick').toBe(0)
    })

    test('has no accessibility violations with findings open (A and AA)', async ({ page }) => {
        test.setTimeout(60_000)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.goto('/')
        await connect(page, '/silent')
        await openDoctor(page)
        await expect(page.locator('[data-testid="doctor-finding"][data-finding-key^="stall"]')).toBeVisible({ timeout: 25_000 })
        await page.waitForTimeout(600)
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
        const found = results.violations.map((v) => `${v.id} (${v.impact}) ${v.help} e.g. ${v.nodes[0]?.target.join(' ')}`)
        expect(found, found.join('\n')).toEqual([])
    })
})
