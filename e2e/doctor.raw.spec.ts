import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { startFixtureServer, type FixtureServer } from '../src/fixtures/server'
import { connectDirect, findingKeys, openDoctor, startPlainServer, STREAM_HEAD, type PlainServer } from './support/doctorKit'

// Q19 (decided): the live views show what was recorded, as received. They say so in one plain sentence, and a raw value is not copied to the
// clipboard before a warning is confirmed. The stream below sends a token as an event id and another in the data, so a real secret-shaped
// value is on screen; the clipboard is read from the browser itself, never from the page's own state.

const LABEL = 'Raw values — as received, not redacted.'
const ID = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.q19-id-token'
// What the server sent in the data line, byte for byte (two spaces inside a string, a non-ASCII letter, a quote).
const DATA = '{"seq":1,"token":"q19-secret-token-0123456789","note":"two  spaces, café, \\"quoted\\""}'
const SENTINEL = 'sentinel: nothing has been copied yet'

let plain: PlainServer
let busy: PlainServer
let fx: FixtureServer
test.beforeAll(async () => {
    fx = await startFixtureServer({ port: 0 })
    plain = await startPlainServer((_req, res) => {
        res.writeHead(200, STREAM_HEAD)
        res.write(`id: ${ID}\nevent: tick\ndata: ${DATA}\n\n`) // one event, then the stream stays open and quiet
    })
    // a fast stream: forty events a second, each with its own data, the way the hosted demo's public stream arrives
    busy = await startPlainServer((req, res, log) => {
        res.writeHead(200, STREAM_HEAD)
        let n = 0
        const timer = setInterval(() => { res.write(`id: ${n}\nevent: tick\ndata: {"n":${n},"token":"q19-busy-${n}"}\n\n`); log.writes++; n++ }, 25)
        req.on('close', () => clearInterval(timer))
    })
})
test.afterAll(async () => { await plain.close(); await busy.close(); await fx.close() })

const clipboard = (page: Page): Promise<string> => page.evaluate(() => navigator.clipboard.readText())

test.describe('Q19: raw values are labelled, and a copy of one asks first', () => {
    test('the label is on every live view that shows recorded values, and on the events list', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await connectDirect(page, `${plain.url}/stream`)
        await expect(page.getByTestId('event-row')).toHaveCount(1, { timeout: 15_000 })
        await openDoctor(page)
        const doctor = page.getByTestId('doctor-panel').first()
        // The events list says it too: it is the other place the raw data is.
        await expect(page.getByTestId('event-count').locator('..').getByTestId('raw-values-label')).toHaveText(LABEL)
        for (const tab of ['request', 'timeline', 'sequence', 'profile']) {
            await page.getByTestId(`doctor-tab-${tab}`).click()
            await expect(doctor.getByTestId('raw-values-label').first(), `the ${tab} view`).toHaveText(LABEL)
        }
        // The Sequence view lists the id as received: the label is true, and the value is the server's.
        await page.getByTestId('doctor-tab-sequence').click()
        await expect(page.getByTestId('doctor-sequence')).toContainText(ID)
    })

    test('a finding says the same, where a record is opened', async ({ page }) => {
        test.setTimeout(90_000)
        await page.goto('/')
        await connectDirect(page, fx.urlFor('f05-drops', { scale: 0.25 }), { waitConnected: false })
        await openDoctor(page)
        const finding = page.locator('[data-finding-key="reconnect.loop"]')
        await expect(finding).toBeVisible({ timeout: 60_000 })
        expect(await findingKeys(page)).toContain('reconnect.loop')
        await expect(page.getByTestId('doctor-panel').first().getByTestId('raw-values-label').first()).toHaveText(LABEL) // above the list
        const chip = finding.getByRole('button', { name: /^record #/ }).first()
        await chip.click()
        await expect(finding.getByTestId('raw-values-label')).toHaveText(LABEL) // and where the record itself is
        await expect(finding.getByLabel(/^Raw record /)).toBeVisible()
    })

    test('Copy asks first: cancel and Escape copy nothing, Copy anyway puts exactly the value the server sent on the clipboard', async ({ page, context }) => {
        test.setTimeout(60_000)
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.goto('/')
        await connectDirect(page, `${plain.url}/stream`)
        const row = page.getByTestId('event-row').first()
        await expect(row).toBeVisible({ timeout: 15_000 })
        await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL)
        expect(await clipboard(page)).toBe(SENTINEL)

        // The click only opens the warning.
        await row.getByRole('button', { name: 'Copy', exact: true }).click()
        const dialog = page.getByRole('alertdialog', { name: 'Copy a raw value?' })
        await expect(dialog).toBeVisible()
        await expect(dialog).toContainText('as received, not redacted')
        await expect(dialog).toContainText('may contain secrets')
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused() // the safe choice has focus
        expect(await clipboard(page)).toBe(SENTINEL)
        const axe = await new AxeBuilder({ page }).include('[data-testid="raw-copy-dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
        const found = axe.violations.map((v) => `${v.id} (${v.impact}) ${v.help} e.g. ${v.nodes[0]?.target.join(' ')}`)
        expect(found, found.join('\n')).toEqual([])

        // Cancel: nothing copied, focus back on the button that opened it.
        await dialog.getByRole('button', { name: 'Cancel' }).click()
        await expect(dialog).toBeHidden()
        await expect(row.getByRole('button', { name: 'Copy', exact: true })).toBeFocused()
        expect(await clipboard(page)).toBe(SENTINEL)

        // Escape: nothing copied.
        await row.getByRole('button', { name: 'Copy', exact: true }).click()
        await expect(dialog).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        expect(await clipboard(page)).toBe(SENTINEL)

        // Copy anyway: exactly what the server sent in the data line.
        await row.getByRole('button', { name: 'Copy', exact: true }).click()
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: 'Copy anyway' }).click()
        await expect(dialog).toBeHidden()
        await expect.poll(() => clipboard(page)).toBe(DATA)
        await expect(row.getByRole('button', { name: 'Copied!' })).toBeVisible()
    })
})

test.describe('Q19: the warning survives a fast stream (found on the deployed site)', () => {
    test('the warning stays open while events keep arriving, and Copy anyway copies the value that was clicked', async ({ page, context }) => {
        test.setTimeout(60_000)
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.goto('/')
        await connectDirect(page, `${busy.url}/stream`)
        const row = page.getByTestId('event-row').first()
        await expect(row).toBeVisible({ timeout: 15_000 })
        await page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL)
        await row.getByRole('button', { name: 'Copy', exact: true }).click()
        const dialog = page.getByRole('alertdialog', { name: 'Copy a raw value?' })
        await expect(dialog).toBeVisible()
        // the list keeps moving under the open warning: more than a hundred events arrive while it is open, and it must still be there
        const written = () => busy.connections.reduce((n, c) => n + c.writes, 0)
        const before = written()
        await expect.poll(written, { timeout: 15_000 }).toBeGreaterThan(before + 100)
        await expect(dialog).toBeVisible()
        expect(await clipboard(page), 'nothing is copied until it is confirmed').toBe(SENTINEL)
        await dialog.getByRole('button', { name: 'Copy anyway' }).click()
        await expect(dialog).toBeHidden()
        // exactly one event's data, as the server wrote it
        await expect.poll(() => clipboard(page)).toMatch(/^\{"n":\d+,"token":"q19-busy-\d+"\}$/)
    })
})
