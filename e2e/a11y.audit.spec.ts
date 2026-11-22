import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type Page } from '@playwright/test'
import { startFixtureServer, type FixtureServer } from '../src/fixtures/server'
import { ARTIFACTS } from '../src/doctor/artifacts'
import { connectDirect, openDoctor } from './support/doctorKit'
import { Audit, COMBOS, comboName, contrastOf, motionProblems, prepare, resizeProblems, settle, tabWalk, type Combo } from './support/a11yKit'

// The accessibility audit: a walk through every screen and state of the app, in the light and the dark theme, at a desktop width (1360 px)
// and a phone width (360 px). Each state is checked by axe (WCAG 2.0, 2.1 and 2.2, A and AA), by the browser's accessibility tree (every
// control has a name), and, in the states that matter most, by Tab (focus is visible and follows the page). Further tests check what is
// not a property of one state: that a modal keeps focus and gives it back, that reduced motion stops the animations, that text at 200%
// is not cut off, that the live regions are the polite or assertive ones they should be, and the contrast of status text.
//
// What this is not: a screen reader was not run. See docs/guide/accessibility.md for what is covered and for the manual checklist.
//
// AXE EXCLUSIONS: none. No rule is disabled and no element is excluded from a scan.

test.use({ actionTimeout: 20_000 }) // a step that cannot be done fails in seconds with what it was waiting for, not at the end of the test

const RECORDING = JSON.stringify({ version: '1.0', events: Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), type: i % 4 === 0 ? 'alert' : 'message', data: JSON.stringify({ n: i + 1 }), deltaMs: 20 })) })
// Built at run time so this file holds no secret-shaped text.
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXZhbHVlLW5vdC1yZWFs'].join('.')
const OPAQUE = 'q7Zr4KpX9vLm2NcB8wTy5HsJ3dFg6A1e'

let fx: FixtureServer
let server: http.Server
let base = ''
test.beforeAll(async () => {
    fx = await startFixtureServer({ port: 0 })
    server = http.createServer((req, res) => {
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
        if (req.url?.startsWith('/forbidden')) { res.writeHead(403, { ...cors, 'Content-Type': 'text/plain' }); res.end('no'); return }
        if (req.url?.startsWith('/bad')) { res.writeHead(502, { ...cors, 'Content-Type': 'text/plain' }); res.end('bad gateway'); return }
        res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write(': open\n\n')
        const leaky = req.url?.startsWith('/leaky')
        if (leaky) res.write(`: debug auth ${JWT}\n\n: session ${OPAQUE}\n\n`)
        let n = 0
        const timer = setInterval(() => {
            if (leaky && n >= 12) { clearInterval(timer); return } // then nothing more: the stall is a finding to export
            res.write(`id: ${n}\nevent: order\ndata: ${JSON.stringify({ id: n, price: 9.5, qty: 2, user: { name: 'ada' }, status: 'paid' })}\n\n`)
            n++
        }, leaky ? 250 : 400)
        req.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(async () => { server.closeAllConnections(); server.close(); await fx.close() })

const STALL = '[data-testid="doctor-finding"][data-finding-key^="stall"]'
const dialogFocus = (page: Page, selector: string) => page.evaluate((s) => document.querySelector(s)?.contains(document.activeElement) ?? false, selector)

/** Presses Tab until the focused element's text matches. */
async function tabToText(page: Page, text: RegExp, max = 120): Promise<void> {
    for (let i = 0; i < max; i++) {
        await page.keyboard.press('Tab')
        if (await page.evaluate(([s, flags]) => new RegExp(s!, flags).test((document.activeElement?.textContent ?? '').trim()), [text.source, text.flags])) return
    }
    throw new Error(`Tab did not reach an element with the text ${text} in ${max} presses`)
}

/** Presses Tab until the focus is on an element that matches, and fails with where it went if it never gets there. */
async function tabTo(page: Page, selector: string, max = 120): Promise<void> {
    for (let i = 0; i < max; i++) {
        await page.keyboard.press('Tab')
        if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector)) return
    }
    throw new Error(`Tab did not reach ${selector} in ${max} presses`)
}

for (const combo of COMBOS) {
    test.describe(`Audit, ${comboName(combo)}`, () => {
        test.beforeEach(async ({ page }) => {
            await prepare(page, combo)
            page.on('pageerror', (e) => console.log(`PAGEERROR ${e.message.slice(0, 300)}`))
        })

        test('landing page, saved profile and the Monitor panels', async ({ page }, info) => {
            test.setTimeout(240_000)
            const audit = new Audit(page, combo)
            await page.goto('/')
            await expect(page.getByTestId('url-input')).toBeVisible()
            await audit.state('landing page, nothing connected', { walk: true, motion: true })

            await page.getByTestId('url-input').fill(`${base}/steady`)
            await page.getByRole('button', { name: 'Save profile' }).click()
            await expect(page.getByRole('dialog', { name: 'Save profile' })).toBeVisible()
            await audit.state('save-profile form open', { walk: true })
            // tabbing out of the form closes it (it floats over the proxy switch, which would be focused out of sight): the walk went on past it
            await expect(page.getByRole('dialog', { name: 'Save profile' })).toHaveCount(0)
            await page.getByRole('button', { name: 'Save profile' }).click()
            await page.getByLabel('Profile name').fill('local')
            await page.getByRole('dialog', { name: 'Save profile' }).getByRole('button', { name: 'Save' }).click()
            await expect(page.getByRole('button', { name: 'local', exact: true })).toBeVisible()
            await audit.state('a saved profile tab')

            await connectDirect(page, `${base}/steady`)
            await expect(page.getByTestId('event-row').first()).toBeVisible()
            await audit.state('connected, events flowing (events list, JSON/CSV/Record export buttons)', { walk: true, motion: true })

            for (const name of ['Stats', 'Schema'] as const) {
                await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
                await audit.state(`${name} panel open`)
                await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
            }
            await page.getByRole('button', { name: /^Patterns/ }).click()
            await audit.state('Patterns panel, no rule')
            await page.getByRole('button', { name: 'Burst' }).click()
            await audit.state('Patterns: the add-rule form (burst)', { walk: true })
            await page.getByPlaceholder(/^Rule name/).fill('orders burst')
            await page.getByPlaceholder('Count').fill('3')
            await page.getByPlaceholder('Window (ms)').fill('2000')
            await page.getByRole('button', { name: 'Add Rule' }).click()
            await expect(page.getByLabel('Remove rule orders burst')).toBeVisible()
            await audit.state('Patterns panel with a rule')
            await page.getByRole('button', { name: /^Patterns/ }).click()

            await page.getByRole('button', { name: /^Interceptors/ }).click()
            await page.getByRole('button', { name: /^Add$/ }).first().click()
            await expect(page.getByLabel(/^Remove /).first()).toBeVisible()
            await audit.state('Interceptors panel with one added', { walk: true })
            await page.getByRole('button', { name: /^Interceptors/ }).click()

            await page.getByTestId('search-input').fill('no_such_text')
            await audit.state('a filter that matches nothing (empty events list)')
            await audit.finish(info)
        })

        test('Multi-Stream with lanes, the per-lane Doctor, and the Mock Server tab', async ({ page }, info) => {
            test.setTimeout(240_000)
            const audit = new Audit(page, combo)
            await page.goto('/')
            await page.getByRole('button', { name: 'Multi-Stream', exact: true }).click()
            await expect(page.getByLabel('Stream name')).toBeVisible()
            await audit.state('Multi-Stream, no lanes yet', { walk: true })
            for (const [name, path] of [['orders', '/steady'], ['prices', '/steady']] as const) {
                await page.getByLabel('Stream name').fill(name)
                await page.getByLabel('Stream URL').fill(`${base}${path}`)
                await page.getByRole('button', { name: 'Add', exact: true }).click()
            }
            await audit.state('Multi-Stream, two lanes added, not connected')
            for (let i = 1; i <= 2; i++) {
                await page.getByRole('button', { name: 'Connect', exact: true }).first().click()
                await expect(page.getByText(`${i}/2 live`)).toBeVisible({ timeout: 15_000 })
            }
            await audit.state('Multi-Stream, two lanes live', { walk: true, motion: true })
            await page.getByLabel('Stream name').fill('broken')
            await page.getByLabel('Stream URL').fill(`${base}/forbidden`)
            await page.getByRole('button', { name: 'Add', exact: true }).click()
            await page.getByRole('button', { name: 'Connect', exact: true }).first().click()
            await expect(page.getByRole('alert').filter({ hasText: 'HTTP 403' })).toBeVisible({ timeout: 15_000 })
            await audit.state('Multi-Stream, a lane whose connect failed')
            await page.getByTestId('doctor-toggle').click()
            await expect(page.getByTestId('fleet-strip')).toBeVisible()
            await audit.state('per-lane Doctor and the fleet strip', { walk: true })
            await page.getByText('Per lane').click()
            await audit.state('fleet strip, per-lane table open')
            await page.getByText('Profile for every stream').click()
            await audit.state('per-lane Doctor, the shared profile editor open')

            await page.getByRole('button', { name: 'Mock Server', exact: true }).click()
            await expect(page.getByRole('button', { name: 'Start Mock Server', exact: true })).toBeVisible()
            await audit.state('Mock Server tab, nothing loaded', { walk: true })
            await page.locator('input[type="file"]').setInputFiles({ name: 'demo.sse-record', mimeType: 'application/json', buffer: Buffer.from(RECORDING) })
            await expect(page.getByText('12 events loaded')).toBeVisible({ timeout: 10_000 })
            await audit.state('Mock Server tab, a recording loaded')
            await page.locator('input[type="file"]').setInputFiles({ name: 'broken.sse-record', mimeType: 'application/json', buffer: Buffer.from('not json') })
            await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 10_000 }).catch(() => undefined)
            await audit.state('Mock Server tab, a file that could not be read')
            await audit.finish(info)
        })

        test('the Doctor: every tab, a finding with its evidence, bookmarks, the Failure lab', async ({ page }, info) => {
            test.setTimeout(300_000)
            const audit = new Audit(page, combo)
            await page.goto('/')
            await connectDirect(page, fx.urlFor('f04-silent', { scale: 0.25 }))
            await openDoctor(page)
            const finding = page.locator(STALL)
            await expect(finding).toBeVisible({ timeout: 40_000 })
            await audit.state('Doctor, Findings tab: a finding open (observed, inferred, limits)', { walk: true, motion: true })
            await finding.getByRole('button', { name: /record #\d+/ }).first().click()
            await expect(finding.locator('pre')).toBeVisible()
            await audit.state('Doctor, a finding with an evidence chip opened (raw record)', { walk: true })
            await page.getByText(/What was checked/).click()
            await audit.state('Doctor, "What was checked" open')
            await finding.getByRole('button', { expanded: true }).first().click()
            await audit.state('Doctor, a finding collapsed')

            for (const id of ['request', 'flow', 'timeline', 'sequence'] as const) {
                await page.getByTestId(`doctor-tab-${id}`).click()
                await expect(page.getByTestId(`doctor-tab-${id}`)).toHaveAttribute('aria-selected', 'true')
                await audit.state(`Doctor tab: ${id}`, { walk: id === 'timeline' })
                if (id === 'timeline') {
                    await page.getByTestId('bookmark-label').fill('went quiet')
                    await audit.state('Doctor tab: timeline with the bookmark form filled')
                    await page.getByTestId('bookmark-add').click()
                    await expect(page.getByTestId('bookmark-list')).toContainText('went quiet')
                    await audit.state('Doctor tab: timeline with a bookmark added')
                }
            }
            await page.getByTestId('doctor-tab-captures').click()
            await expect(page.getByTestId('doctor-captures')).toBeVisible()
            await audit.state('Doctor tab: captures (library, open a file, compare)', { walk: true })
            await page.getByText('Failure lab').click()
            await expect(page.getByTestId('lab-entry').first()).toBeVisible({ timeout: 10_000 })
            await audit.state('Failure lab, the list of built-in streams')
            await page.getByRole('button', { name: 'Run the Doctor on f04-silent' }).click()
            const result = page.getByTestId('lab-result')
            await expect(result.getByTestId('lab-verdict')).toBeVisible()
            await expect(page.getByTestId('lab-announce')).toContainText('The Doctor ran on f04-silent') // focus stays on the button: the result is announced in words
            await audit.state('Failure lab, a result shown (faulty stream)', { walk: true })
            await page.getByTestId('lab-twin').click()
            await expect(result.getByTestId('lab-expectations')).toContainText('none appeared')
            await audit.state('Failure lab, the healthy twin shown')
            await page.getByTestId('lab-save').click()
            await expect(page.getByTestId('lab-notice')).toBeVisible()
            await audit.state('Failure lab, the notice after saving a capture')
            await page.getByTestId('doctor-tab-profile').click()
            await expect(page.getByTestId('doctor-profile')).toBeVisible()
            await audit.state('Doctor tab: profile editor', { walk: true })
            await page.getByText('Edit as JSON').click()
            await audit.state('Doctor tab: profile editor, the JSON editor open')
            await page.getByTestId('profile-json').fill('{ not json')
            await page.getByRole('button', { name: 'Apply JSON' }).click()
            await expect(page.getByTestId('profile-errors')).toBeVisible()
            await audit.state('Doctor tab: profile editor with a validation error')
            await audit.finish(info)
        })

        test('the Doctor: the export dialog (each kind, the residual warning) and the copy warning', async ({ page }, info) => {
            test.setTimeout(300_000)
            const audit = new Audit(page, combo)
            await page.goto('/')
            await connectDirect(page, `${base}/leaky`)
            await openDoctor(page)
            await expect(page.locator(STALL)).toBeVisible({ timeout: 40_000 })
            await page.getByTestId('doctor-export').click()
            const dialog = page.getByTestId('export-dialog')
            await expect(dialog).toBeVisible()
            await expect(dialog.getByLabel(/Preview of/)).toBeVisible()
            await audit.state('Export dialog, the default (Markdown report) with the residual warning', { walk: true })
            for (const a of ARTIFACTS) {
                await dialog.locator(`input[name="artifact"][value="${a.kind}"]`).check()
                if (a.kind === 'repro') {
                    await audit.state(`Export dialog: ${a.label}, before the search`)
                    await dialog.getByRole('button', { name: 'Find the smallest capture' }).click()
                    await expect(dialog.getByLabel(/Preview of/)).toBeVisible({ timeout: 40_000 })
                } else await expect(dialog.getByLabel(/Preview of/)).toBeVisible()
                const residual = await page.getByTestId('export-residual').count()
                await audit.state(`Export dialog: ${a.label}${residual > 0 ? ' (residual warning shown)' : a.shareable ? ' (scan found nothing)' : ' (not redacted note)'}`)
            }
            await dialog.locator('input[name="artifact"][value="report-md"]').check()
            await expect(page.getByTestId('export-residual')).toBeVisible()
            await page.getByTestId('export-ack').check()
            await audit.state('Export dialog, residual warning acknowledged (Download enabled)')
            await dialog.getByRole('button', { name: 'Close', exact: true }).first().click()
            await expect(dialog).toHaveCount(0)

            const row = page.getByTestId('event-row').first()
            await expect(row).toBeVisible()
            await row.getByRole('button', { name: 'Copy', exact: true }).click()
            await expect(page.getByTestId('raw-copy-dialog')).toBeVisible()
            await audit.state('Copy-warning dialog (raw value)', { walk: true })
            await page.getByTestId('raw-copy-cancel').click()
            await audit.finish(info)
        })

        test('errors (a 403, a retrying 502) and the empty Doctor', async ({ page }, info) => {
            test.setTimeout(200_000)
            const audit = new Audit(page, combo)
            await page.goto('/')
            await page.getByTestId('doctor-toggle').click()
            await expect(page.getByTestId('doctor-empty')).toBeVisible()
            await audit.state('empty Doctor (no stream yet)', { walk: true })
            await page.getByTestId('doctor-try-lab').click()
            await expect(page.getByTestId('lab-entry').first()).toBeVisible({ timeout: 10_000 })
            await audit.state('empty Doctor with the Failure lab opened')
            await page.getByRole('button', { name: 'Run the Doctor on f04-silent' }).click()
            await expect(page.getByTestId('lab-result').getByTestId('lab-verdict')).toBeVisible()
            await audit.state('empty Doctor, Failure lab result shown')
            await page.getByText('Set up a profile before connecting').click()
            await audit.state('empty Doctor, the profile editor opened')

            await connectDirect(page, `${base}/forbidden`, { waitConnected: false })
            await expect(page.getByRole('alert').filter({ hasText: 'HTTP 403' })).toBeVisible({ timeout: 15_000 })
            await audit.state('a connect refused with HTTP 403 (alert)', { walk: true })
            await connectDirect(page, `${base}/bad`, { waitConnected: false })
            await expect(page.getByTestId('connection-status')).toContainText('Retrying in', { timeout: 20_000 })
            await audit.state('retrying after an HTTP 502 (status, the retry countdown)', { motion: true })
            await page.getByTestId('connect-button').click() // Stop
            await audit.finish(info)
        })
    })
}

test.describe('Keyboard only', () => {
    test.beforeEach(async ({ page }) => { await prepare(page, COMBOS[0]!) })

    test('connect, open the Doctor, a finding and its evidence, the tabs and the export dialog, with no pointer', async ({ page }) => {
        test.setTimeout(120_000)
        await page.goto('/')
        await page.getByTestId('url-input').focus()
        await page.keyboard.type(fx.urlFor('f04-silent', { scale: 0.25 }))
        // the proxy switch is on by default and the fixture is on a loopback address, so it is turned off with the keyboard
        await tabTo(page, '[role=switch][aria-label="Use server proxy"]')
        await page.keyboard.press('Space')
        await expect(page.getByRole('switch', { name: 'Use server proxy' })).toHaveAttribute('aria-checked', 'false')
        await page.getByTestId('url-input').focus()
        await tabTo(page, '[data-testid=connect-button]')
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('connection-status')).toContainText('Connected', { timeout: 15_000 })
        await tabTo(page, '[data-testid=doctor-toggle]')
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('doctor-panel')).toBeVisible()
        const finding = page.locator(STALL)
        await expect(finding).toBeVisible({ timeout: 40_000 })

        // the finding is a disclosure button: Enter and Space both toggle it
        const head = finding.getByRole('button', { expanded: true }).first()
        await head.focus()
        await page.keyboard.press('Enter')
        await expect(finding.locator('button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'false')
        await page.keyboard.press('Space')
        await expect(finding.locator('button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'true')
        // evidence chips are buttons reached by Tab
        await tabToText(page, /^record #\d+/)
        await page.keyboard.press('Enter')
        await expect(finding.locator('pre')).toBeVisible()
        await tabTo(page, `${STALL} pre`) // the record can be scrolled and read with the keyboard
        expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toMatch(/^Raw record \d+/)

        // tabs: one tab stop, arrows, Home, End
        await page.getByTestId('doctor-tab-findings').focus()
        await page.keyboard.press('ArrowRight')
        await expect(page.getByTestId('doctor-tab-request')).toHaveAttribute('aria-selected', 'true')
        await expect(page.getByTestId('doctor-tab-request')).toBeFocused()
        await page.keyboard.press('End')
        await expect(page.getByTestId('doctor-tab-profile')).toBeFocused()
        await page.keyboard.press('ArrowRight') // wraps
        await expect(page.getByTestId('doctor-tab-findings')).toBeFocused()
        await page.keyboard.press('Home')
        await expect(page.getByTestId('doctor-tab-findings')).toHaveAttribute('aria-selected', 'true')
        await page.keyboard.press('Tab') // leaves the tab list for the panel: one tab stop for the list
        expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).not.toBe('tab')

        await tabTo(page, '[data-testid=doctor-export]')
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('export-dialog')).toBeVisible()
        expect(await dialogFocus(page, '[data-testid=export-dialog]')).toBe(true)
    })

    test('a modal keeps Tab inside, closes on Escape and gives focus back to what opened it', async ({ page }) => {
        test.setTimeout(120_000)
        await page.goto('/')
        await connectDirect(page, fx.urlFor('f04-silent', { scale: 0.25 }))
        await openDoctor(page)
        await expect(page.locator(STALL)).toBeVisible({ timeout: 40_000 })

        const trap = async (openerSel: string, dialogSel: string, closeByEscape = true) => {
            await page.locator(openerSel).first().focus()
            await page.keyboard.press('Enter')
            const dialog = page.locator(dialogSel)
            await expect(dialog).toBeVisible()
            expect(await dialogFocus(page, dialogSel), `${dialogSel}: focus moved into the dialog`).toBe(true)
            const count = await dialog.evaluate((d) => d.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').length)
            for (let i = 0; i < count + 3; i++) {
                await page.keyboard.press('Tab')
                expect(await dialogFocus(page, dialogSel), `${dialogSel}: Tab ${i + 1} left the dialog`).toBe(true)
            }
            for (let i = 0; i < count + 3; i++) {
                await page.keyboard.press('Shift+Tab')
                expect(await dialogFocus(page, dialogSel), `${dialogSel}: Shift+Tab ${i + 1} left the dialog`).toBe(true)
            }
            if (closeByEscape) {
                await page.keyboard.press('Escape')
                await expect(dialog).toHaveCount(0)
                await expect(page.locator(openerSel).first(), `${dialogSel}: focus goes back to what opened it`).toBeFocused()
            }
        }
        await trap('[data-testid=doctor-export]', '[data-testid=export-dialog]')
        await trap('[data-testid=event-row] button:text-is("Copy")', '[data-testid=raw-copy-dialog]')
    })

    test('the timeline strip is a slider the keyboard can move: Left steps to an older event, End goes back to the newest', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await connectDirect(page, `${base}/steady`)
        await expect.poll(() => page.getByTestId('event-row').count(), { timeout: 15_000 }).toBeGreaterThan(3)
        const strip = page.getByRole('slider', { name: 'Event timeline' })
        await strip.focus()
        await expect(strip).toHaveAttribute('aria-valuenow', '0')
        await page.keyboard.press('ArrowLeft')
        await expect(strip).not.toHaveAttribute('aria-valuenow', '0')
        await page.keyboard.press('End')
        await expect(strip).toHaveAttribute('aria-valuenow', '0')
    })

    test('the save-profile popover: Escape closes it and focus goes back to the Save button', async ({ page }) => {
        await page.goto('/')
        await page.getByTestId('url-input').fill(`${base}/steady`)
        const opener = page.getByRole('button', { name: 'Save profile' })
        await opener.focus()
        await page.keyboard.press('Enter')
        const dialog = page.getByRole('dialog', { name: 'Save profile' })
        await expect(dialog).toBeVisible()
        await expect(page.getByLabel('Profile name')).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await expect(opener, 'focus goes back to what opened it').toBeFocused()
    })
})

test.describe('Reduced motion', () => {
    test('with the preference on, nothing animates or transitions, in the states that have animation', async ({ page }) => {
        test.setTimeout(120_000)
        await prepare(page, COMBOS[0]!)
        const found: string[] = []
        const check = async (label: string) => { for (const p of await motionProblems(page)) found.push(`${label}: ${p}`) }
        await page.goto('/')
        await check('landing')
        await connectDirect(page, `${base}/bad`, { waitConnected: false })
        await expect(page.getByTestId('connection-status')).toContainText('Retrying in', { timeout: 20_000 })
        await check('retrying (spinner)')
        await page.getByTestId('connect-button').click()
        await connectDirect(page, `${base}/steady`)
        await expect(page.getByTestId('event-row').first()).toBeVisible()
        await check('connected (pulsing status dot, new rows)')
        await openDoctor(page)
        await check('Doctor open')
        await page.getByTestId('doctor-export').click()
        await expect(page.getByTestId('export-dialog')).toBeVisible()
        await check('export dialog')
        expect(found, found.join('\n')).toEqual([])
    })

    test('the check is not vacuous: without the preference the same page does animate', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await page.goto('/')
        await expect(page.getByTestId('url-input')).toBeVisible()
        expect((await motionProblems(page)).length).toBeGreaterThan(0)
    })
})

test.describe('Text at 200%', () => {
    // Chromium hides the content of a closed <details> with content-visibility, not display: none, so that content still has a box where it
    // would be, on top of what follows. Only checkVisibility() says it is not shown. The check reported the closed Failure lab's text as
    // overlapping the next heading (in CI's Chromium).
    test('the resize check ignores the content of a closed disclosure, and still sees a real overlap', async ({ page }) => {
        await page.setContent(`<main id="scope">
            <details><summary>Lab</summary><p>The built-in test streams, each a known fault</p></details>
            <h3>Privacy and retention</h3>
            <div style="position: relative; height: 40px"><span>one piece of text</span><span style="position: absolute; left: 0; top: 0">another on top</span></div>
        </main>`)
        const found = await resizeProblems(page, '#scope')
        expect(found.filter((f) => f.includes('built-in test streams')), found.join('\n')).toEqual([])
        expect(found.some((f) => f.startsWith('overlap: span "one piece of text"')), found.join('\n')).toBe(true)
    })

    for (const theme of ['light', 'dark'] as const) {
        test(`the Doctor and the export dialog are not cut off or overlapping at a 680 px viewport (200% of 1360), ${theme}`, async ({ page }) => {
            test.setTimeout(150_000)
            const combo: Combo = { theme, width: 680, height: 900 }
            await prepare(page, combo)
            await page.goto('/')
            await connectDirect(page, `${base}/leaky`)
            await openDoctor(page)
            await expect(page.locator(STALL)).toBeVisible({ timeout: 40_000 })
            await settle(page)
            const found: string[] = []
            const check = async (label: string, scope = '[data-testid=doctor-panel]') => { for (const p of await resizeProblems(page, scope)) found.push(`${label}: ${p}`) }
            await check('Findings (first finding open)')
            await page.locator(STALL).getByRole('button', { name: /record #\d+/ }).first().click()
            await check('Findings (evidence opened)')
            for (const id of ['request', 'flow', 'timeline', 'sequence', 'captures', 'profile']) {
                await page.getByTestId(`doctor-tab-${id}`).click()
                await settle(page)
                await check(`tab ${id}`)
            }
            await page.getByTestId('doctor-export').click()
            await expect(page.getByTestId('export-dialog')).toBeVisible()
            await settle(page)
            await check('export dialog', '[data-testid=export-dialog]')
            expect(found, found.join('\n')).toEqual([])
        })
    }
})

test.describe('Live regions and status contrast', () => {
    for (const theme of ['light', 'dark'] as const) {
        test(`the connection status is polite, a failure is an alert, the Doctor announces state changes only, and status text has 4.5:1 contrast, ${theme}`, async ({ page }) => {
            test.setTimeout(120_000)
            const combo: Combo = { theme, width: 1360, height: 900 }
            await prepare(page, combo)
            await page.goto('/')
            const status = page.getByTestId('connection-status')
            await expect(status).toHaveAttribute('role', 'status')
            await expect(status).toHaveAttribute('aria-live', 'polite')
            const low: string[] = []
            const ratio = async (label: string, locator: ReturnType<Page['locator']>) => {
                const c = await contrastOf(locator)
                if (c !== null && c.ratio < c.required) low.push(`${label}: ${c.ratio.toFixed(2)}:1, needs ${c.required}:1 (${c.backdrop})`)
                return c?.ratio ?? null
            }
            await ratio('"Disconnected"', status)
            await ratio('the page title (text painted by a gradient)', page.locator('h1'))

            await connectDirect(page, fx.urlFor('f04-silent', { scale: 0.25 }))
            await settle(page)
            await ratio('"Connected to ..."', status)
            await openDoctor(page)
            await expect(page.locator(STALL)).toBeVisible({ timeout: 40_000 })
            await settle(page)
            // every live region on the page: status/polite, or an alert. Nothing is assertive by accident.
            const regions = await page.evaluate(() => Array.from(document.querySelectorAll('[aria-live], [role=status], [role=alert], [role=log]')).map((e) => ({ role: e.getAttribute('role'), live: e.getAttribute('aria-live'), id: e.getAttribute('data-testid') ?? e.className.slice(0, 30) })))
            for (const r of regions) {
                const ok = (r.role === 'status' && (r.live === 'polite' || r.live === null)) || (r.role === 'alert' && (r.live === 'assertive' || r.live === null)) || (r.role === null && r.live === 'polite')
                expect(ok, `live region ${JSON.stringify(r)} should be polite (status) or an alert`).toBe(true)
            }
            // the Doctor's own region says how many open errors and warnings there are, once, as text (not the once-a-second figures)
            const announced = await page.locator('section[data-testid=doctor-panel] > [role=status].sr-only').first().innerText()
            expect(announced).toMatch(/warning|error|open|Connected|connect/i)
            const strip = page.getByTestId('doctor-health')
            for (const dd of await strip.locator('dd').all()) await ratio(`health strip "${(await dd.innerText()).trim().slice(0, 20)}"`, dd)
            for (const dt of await strip.locator('dt').all()) await ratio(`health strip label "${(await dt.innerText()).trim()}"`, dt)
            await ratio('finding severity and title', page.locator(`${STALL} button span.font-semibold`).first())
            await ratio('doctor summary', page.getByTestId('doctor-summary'))
            await page.getByTestId('connect-button').click() // Stop
            await ratio('"Disconnected" after Stop', status)

            await connectDirect(page, `${base}/bad`, { waitConnected: false })
            await expect(status).toContainText('Retrying in', { timeout: 20_000 })
            await ratio('"Retrying ..." status (red)', status)
            await page.getByTestId('connect-button').click()
            await connectDirect(page, `${base}/forbidden`, { waitConnected: false })
            const alert = page.getByTestId('connection-error')
            await expect(alert).toBeVisible({ timeout: 15_000 })
            await expect(alert).toHaveAttribute('role', 'alert')
            await ratio('connection error (alert)', alert)
            expect(low, low.join('\n')).toEqual([])
        })
    }

    test('copying a raw value says so in words (a polite status), not only by changing the button label', async ({ page, context }) => {
        test.setTimeout(60_000)
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
        await prepare(page, COMBOS[0]!)
        await page.goto('/')
        await connectDirect(page, `${base}/steady`)
        const row = page.getByTestId('event-row').first()
        await expect(row).toBeVisible()
        const status = page.getByTestId('copy-status')
        await expect(status).toHaveAttribute('role', 'status')
        await expect(status).toHaveAttribute('aria-live', 'polite')
        await expect(status).toHaveText('') // the region is there before the change, which is what makes the change announced
        await row.getByRole('button', { name: 'Copy', exact: true }).click()
        await page.getByRole('alertdialog').getByRole('button', { name: 'Copy anyway' }).click()
        await expect(status).toContainText('Copied')
    })

    test('what a person who cannot see the screen is told on the page keeps its order: the walk by Tab matches the visual order on the landing page', async ({ page }) => {
        await prepare(page, COMBOS[0]!)
        await page.goto('/')
        await expect(page.getByTestId('url-input')).toBeVisible()
        const walk = await tabWalk(page)
        expect(walk.stops).toBeGreaterThan(3)
        expect(walk.problems, walk.problems.join('\n')).toEqual([])
    })
})
