import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'

// The Stream Doctor panel against streams that behave in known ways. The servers are local and start with the test, so
// nothing here depends on the repository's other test servers.

// Built at run time so this file holds no secret-shaped text.
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXZhbHVlLW5vdC1yZWFs'].join('.')
const OPAQUE = 'q7Zr4KpX9vLm2NcB8wTy5HsJ3dFg6A1e'

let server: http.Server
let base = ''

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
        if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
        res.writeHead(200, headers)
        res.write(': open\n\n')
        if (req.url?.startsWith('/seq')) {
            const skip = new URL(req.url, 'http://x').searchParams.get('run') === '2' ? 4 : -1
            let k = 0
            const t = setInterval(() => {
                if (k === skip) k++
                res.write(`id: ${k}\nevent: tick\ndata: {"seq":${k},"ts":${1_700_000_000_000 + k * 250}}\n\n`)
                k++
            }, 250)
            req.on('close', () => clearInterval(t))
            return
        }
        if (req.url?.startsWith('/leaky')) res.write(`: debug auth ${JWT}\n\n: session ${OPAQUE}\n\n`)
        let n = 0
        const limit = req.url?.startsWith('/silent') ? 12 : req.url?.startsWith('/leaky') ? 4 : Infinity
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

    test.describe('export', () => {
        async function openExport(page: Page, path: string) {
            await page.goto('/')
            await connect(page, path)
            await openDoctor(page)
            await page.getByTestId('doctor-export').click()
            await expect(page.getByTestId('export-dialog')).toBeVisible()
        }
        const download = async (page: Page) => {
            const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-download').click()])
            return { name: file.suggestedFilename(), text: fs.readFileSync((await file.path())!, 'utf8') }
        }

        test('a shared report has the secrets replaced, and the scan says what is left', async ({ page }) => {
            test.setTimeout(60_000)
            await openExport(page, '/leaky')
            const dialog = page.getByTestId('export-dialog')
            await expect(page.getByTestId('export-redaction')).toContainText('replaced')
            await expect(dialog.getByLabel(/Preview of/)).not.toContainText(JWT)

            // A token that matches no known secret format is kept by redaction, so the scan flags it and sharing waits for a person.
            await expect(page.getByTestId('export-residual')).toBeVisible()
            await expect(page.getByTestId('export-residual')).not.toContainText(OPAQUE)
            await expect(page.getByTestId('export-download')).toBeDisabled()
            await page.getByTestId('export-ack').check()
            await expect(page.getByTestId('export-download')).toBeEnabled()
            const file = await download(page)
            expect(file.name).toMatch(/\.report\.md$/)
            expect(file.text).not.toContain(JWT)
        })

        test('the full local capture is the recording as it is, and needs an acknowledgement', async ({ page }) => {
            test.setTimeout(60_000)
            await openExport(page, '/leaky')
            await page.getByLabel(/Full local capture/).check()
            await expect(page.getByRole('note')).toContainText('not redacted')
            await expect(page.getByTestId('export-download')).toBeDisabled()
            await page.getByTestId('export-ack').check()
            const file = await download(page)
            expect(file.name).toMatch(/\.local\.sse-capture$/)
            expect(file.text).toContain(JWT)
            expect(JSON.parse(file.text.split('\n')[0]!).kind).toBe('local-full')
        })

        test('a capture to share downloads as sanitized, and a scenario downloads valid JSON', async ({ page }) => {
            test.setTimeout(60_000)
            await openExport(page, '/leaky')
            await page.getByLabel(/Capture to share/).check()
            await page.getByTestId('export-ack').check()
            const capture = await download(page)
            expect(capture.text).not.toContain(JWT)
            expect(JSON.parse(capture.text.split('\n')[0]!).kind).toBe('sanitized')

            await page.getByLabel(/Test scenario/).check()
            await page.getByTestId('export-ack').check()
            const scenario = await download(page)
            expect(scenario.text).not.toContain(JWT)
            expect(JSON.parse(scenario.text).version).toBe(1)
        })

        test('Escape closes it and focus goes back to the button', async ({ page }) => {
            await openExport(page, '/steady')
            await page.keyboard.press('Escape')
            await expect(page.getByTestId('export-dialog')).toHaveCount(0)
            await expect(page.getByTestId('doctor-export')).toBeFocused()
        })

        test('finds the smallest capture that still shows a finding', async ({ page }) => {
            test.setTimeout(80_000)
            await page.goto('/')
            await connect(page, '/silent')
            await openDoctor(page)
            await expect(page.locator('[data-testid="doctor-finding"][data-finding-key^="stall"]')).toBeVisible({ timeout: 25_000 })
            await page.getByTestId('doctor-export').click()
            await page.getByLabel(/Smallest capture/).check()
            await page.getByRole('button', { name: 'Find the smallest capture' }).click()
            await expect(page.getByTestId('export-dialog').getByText(/Reduced from/)).toBeVisible({ timeout: 30_000 })
        })

        test('has no accessibility violations while open (A and AA)', async ({ page }) => {
            test.setTimeout(60_000)
            await page.emulateMedia({ reducedMotion: 'reduce' })
            await openExport(page, '/leaky')
            await page.waitForTimeout(400)
            const results = await new AxeBuilder({ page }).include('[data-testid="export-dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
            const found = results.violations.map((v) => `${v.id} (${v.impact}) ${v.help} e.g. ${v.nodes[0]?.target.join(' ')}`)
            expect(found, found.join('\n')).toEqual([])
        })
    })

    test.describe('profile and sequence', () => {
        async function startSeq(page: Page, run: string) {
            await page.getByTestId('url-input').fill(`${base}/seq?run=${run}`)
            await page.getByTestId('connect-button').click()
            await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10_000 })
        }

        test('says plainly that ids which merely count up prove nothing, and offers to declare them', async ({ page }) => {
            test.setTimeout(60_000)
            await page.goto('/')
            await startSeq(page, '1')
            await openDoctor(page)
            await page.getByTestId('doctor-tab-sequence').click()
            await page.waitForTimeout(2500)
            await expect(page.getByTestId('sequence-trust')).toContainText('Not declared')
            await expect(page.getByTestId('sequence-trust')).toContainText('hint, not a check')
            await expect(page.getByRole('button', { name: 'Declare the sequence' })).toBeVisible()
        })

        test('declare the sequence from a suggested field, reconnect, and see the gap in both views', async ({ page }) => {
            test.setTimeout(90_000)
            await page.goto('/')
            await startSeq(page, '1')
            await openDoctor(page)
            await page.waitForTimeout(3000)

            // the profile tab lists the fields of recent events, the counter first
            await page.getByTestId('doctor-tab-profile').click()
            const suggestions = page.getByTestId('profile-suggestions')
            await expect(suggestions).toContainText('$.seq')
            await expect(suggestions).toContainText('counts up by one')
            await page.getByTestId('use-seq-$.seq').click()
            await expect(page.getByTestId('profile-field')).toHaveValue('$.seq')
            await page.getByTestId('profile-save').click()
            await expect(page.getByTestId('profile-message')).toContainText('Saved: sequence $.seq (consecutive)')
            await expect(page.getByTestId('profile-message')).toContainText('reconnect')
            expect(await page.evaluate(() => localStorage.getItem('sse.doctor.profile'))).toContain('"field":"$.seq"')

            // a new connection records the numbers; this run skips number 4
            await page.getByRole('button', { name: 'Stop' }).click()
            await startSeq(page, '2')
            await page.getByTestId('doctor-tab-sequence').click()
            await expect(page.getByTestId('sequence-trust')).toContainText('Declared')
            const anomalies = page.getByTestId('sequence-anomalies')
            await expect(anomalies).toBeVisible({ timeout: 20_000 })
            await expect(anomalies).toContainText('after a gap')
            await expect(anomalies.getByRole('row', { name: /after a gap/ })).toContainText('4')

            // the rule agrees, once the reorder window has passed
            await page.getByTestId('doctor-tab-findings').click()
            await expect(page.locator('[data-testid="doctor-finding"][data-finding-key="seq.integrity:gap"]')).toBeVisible({ timeout: 20_000 })
        })

        test('refuses a profile that cannot be used, in plain words, and keeps the last good one', async ({ page }) => {
            await page.goto('/')
            await openDoctor(page)
            await page.getByText('Set up a profile before connecting').click()
            await page.getByText('Edit as JSON').click()
            await page.getByTestId('profile-json').fill('{ "sequence": { "policy": "sometimes" }, "delivery": "maybe" }')
            await page.getByRole('button', { name: 'Apply JSON' }).click()
            const errors = page.getByTestId('profile-errors')
            await expect(errors).toContainText('sequence.policy')
            await expect(errors).toContainText('delivery')
            expect(await page.evaluate(() => localStorage.getItem('sse.doctor.profile'))).toBeNull()

            await page.getByTestId('profile-json').fill('{ "sequence": { "useSseId": true, "policy": "monotonic" }, "delivery": "exactly_once" }')
            await page.getByRole('button', { name: 'Apply JSON' }).click()
            await expect(page.getByTestId('profile-message')).toContainText('sequence in the SSE id (monotonic), exactly once')
            await page.reload()
            expect(await page.evaluate(() => localStorage.getItem('sse.doctor.profile'))).toContain('"exactly_once"')
        })

        test('the tabs work from the keyboard', async ({ page }) => {
            test.setTimeout(60_000)
            await page.goto('/')
            await startSeq(page, '1')
            await openDoctor(page)
            const findings = page.getByTestId('doctor-tab-findings')
            await expect(findings).toHaveAttribute('aria-selected', 'true')
            await findings.focus()
            await page.keyboard.press('ArrowRight')
            await expect(page.getByTestId('doctor-tab-sequence')).toHaveAttribute('aria-selected', 'true')
            await expect(page.getByTestId('doctor-tab-sequence')).toBeFocused()
            await page.keyboard.press('End')
            await expect(page.getByTestId('doctor-tab-profile')).toHaveAttribute('aria-selected', 'true')
            await page.keyboard.press('Home')
            await expect(findings).toHaveAttribute('aria-selected', 'true')
            // only the selected tab is a tab stop
            await expect(page.getByTestId('doctor-tab-profile')).toHaveAttribute('tabindex', '-1')
        })

        test('has no accessibility violations on the sequence and profile tabs (A and AA)', async ({ page }) => {
            test.setTimeout(90_000)
            await page.emulateMedia({ reducedMotion: 'reduce' })
            await page.goto('/')
            await startSeq(page, '1')
            await openDoctor(page)
            await page.waitForTimeout(3000)
            const check = async (label: string) => {
                await page.waitForTimeout(400)
                const results = await new AxeBuilder({ page }).include('[data-testid="doctor-panel"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
                const found = results.violations.map((v) => `${label}: ${v.id} (${v.impact}) ${v.help} e.g. ${v.nodes[0]?.target.join(' ')}`)
                expect(found, found.join('\n')).toEqual([])
            }
            await page.getByTestId('doctor-tab-sequence').click()
            await check('sequence')
            await page.getByTestId('doctor-tab-profile').click()
            await check('profile')
        })
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
