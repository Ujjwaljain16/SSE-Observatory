import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'
import { activate } from './support/doctorKit'

// Your own redaction rules in the export dialog. The stream puts internal references into comment lines: text no built-in rule
// recognises, which is exactly what a person's own rule is for.

let server: http.Server
let base = ''

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
        if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
        res.writeHead(200, headers)
        res.write(': ticket ACME-123456 raised by ops\n\n')
        res.write(': also see ZETA-998877\n\n')
        let n = 0
        const timer = setInterval(() => {
            if (n >= 4) { clearInterval(timer); return }
            res.write(`id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`)
            n++
        }, 200)
        req.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => { server.closeAllConnections(); server.close() })

const RULES = JSON.stringify({ version: 1, extraPatterns: [{ name: 'ticket', pattern: 'ACME-\\d{6}' }] })

async function openExport(page: Page) {
    await page.goto('/')
    await page.getByTestId('url-input').fill(`${base}/notes`)
    await activate(page.getByTestId('connect-button'))
    await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('event-row')).toHaveCount(4, { timeout: 10_000 })
    await page.getByTestId('doctor-toggle').click()
    await page.getByTestId('doctor-export').click()
    await expect(page.getByTestId('export-dialog')).toBeVisible()
    await page.getByLabel(/Capture to share/).check()
}
const preview = (page: Page) => page.getByTestId('export-dialog').getByLabel(/Preview of/)
const rules = (page: Page) => page.getByTestId('redaction-rules')
async function writeRules(page: Page, text: string) {
    await rules(page).locator('summary').click()
    await page.getByTestId('redaction-rules-text').fill(text)
    await page.getByTestId('redaction-rules-apply').click()
}

test.describe('Redaction rules', () => {
    test('a reference the built-in rules do not know is replaced once you add a rule for it', async ({ page }) => {
        test.setTimeout(60_000)
        await openExport(page)
        await expect(preview(page)).toContainText('ACME-123456') // nothing built in matches it
        await expect(page.getByTestId('redaction-rules-summary')).toContainText('built-in rules only')

        await writeRules(page, RULES)
        await expect(page.getByTestId('redaction-rules-saved')).toBeVisible()
        await expect(preview(page)).not.toContainText('ACME-123456')
        await expect(preview(page)).toContainText('ZETA-998877') // no rule for this one
        await expect(page.getByTestId('export-redaction')).toContainText('ticket: 1')
        await expect(page.getByTestId('redaction-rules-summary')).toContainText('1 extra pattern')
        await expect(page.getByTestId('export-dialog')).toContainText('Redacted with the built-in rules plus your own: 1 extra pattern')
    })

    test('the downloaded file has none of it, and says the rules were custom', async ({ page }) => {
        test.setTimeout(60_000)
        await openExport(page)
        await writeRules(page, RULES)
        await expect(preview(page)).not.toContainText('ACME-123456')
        const ack = page.getByTestId('export-ack')
        if (await ack.isVisible()) await ack.check()
        const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-download').click()])
        const text = fs.readFileSync((await file.path())!, 'utf8')
        expect(text).not.toContain('ACME-123456')
        expect(JSON.parse(text.split('\n')[0]!).redaction.policy).toBe('custom')
    })

    test('rules that are not valid are refused with every problem listed, and the earlier rules stay', async ({ page }) => {
        test.setTimeout(60_000)
        await openExport(page)
        await writeRules(page, RULES)
        await expect(preview(page)).not.toContainText('ACME-123456')

        await page.getByTestId('redaction-rules-text').fill(JSON.stringify({ keepHeaders: ['Authorization'], extraPatterns: [{ name: 'x', pattern: '(a+)+$' }], nope: 1 }))
        await page.getByTestId('redaction-rules-apply').click()
        const errors = page.getByTestId('redaction-rules-errors')
        await expect(errors).toContainText('not saved')
        await expect(errors).toContainText('"Authorization" carries credentials')
        await expect(errors).toContainText('exponentially')
        await expect(errors).toContainText('Unknown field "nope"')
        await expect(preview(page)).not.toContainText('ACME-123456') // the saved rules still apply
        await expect(page.getByTestId('redaction-rules-summary')).toContainText('1 extra pattern')
    })

    test('the rules are kept in this browser, and can be removed', async ({ page }) => {
        test.setTimeout(60_000)
        await openExport(page)
        await writeRules(page, RULES)
        await page.reload()
        await openExport(page)
        await expect(page.getByTestId('redaction-rules-summary')).toContainText('1 extra pattern')
        await expect(preview(page)).not.toContainText('ACME-123456')

        await rules(page).locator('summary').click()
        await page.getByTestId('redaction-rules-clear').click()
        await expect(page.getByTestId('redaction-rules-summary')).toContainText('built-in rules only')
        await expect(preview(page)).toContainText('ACME-123456')
    })

    test('has no accessibility violations with the editor open and an error showing', async ({ page }) => {
        test.setTimeout(60_000)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await openExport(page)
        await rules(page).locator('summary').click()
        await page.getByTestId('redaction-rules-text').fill('{ nope')
        await page.getByTestId('redaction-rules-apply').click()
        await expect(page.getByTestId('redaction-rules-errors')).toBeVisible()
        const results = await new AxeBuilder({ page }).include('[data-testid="export-dialog"]').analyze()
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    })
})

test.describe('Privacy and retention', () => {
    async function openCaptures(page: Page) {
        await page.goto('/')
        await page.getByTestId('url-input').fill(`${base}/notes`)
        await activate(page.getByTestId('connect-button'))
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10_000 })
        await expect(page.getByTestId('event-row')).toHaveCount(4, { timeout: 10_000 })
        await page.getByTestId('doctor-toggle').click()
        await page.getByTestId('doctor-tab-captures').click()
        await expect(page.getByTestId('privacy-settings')).toBeVisible()
    }

    test('says what is kept where, and deleting every saved capture asks first', async ({ page }) => {
        test.setTimeout(60_000)
        await openCaptures(page)
        await expect(page.getByTestId('privacy-settings')).toContainText('Saved captures')
        await expect(page.getByTestId('privacy-delete-all')).toBeDisabled() // nothing saved yet

        await page.getByTestId('capture-save').click()
        await expect(page.getByTestId('capture-list')).toBeVisible()
        await expect(page.getByTestId('privacy-delete-all')).toContainText('(1)')

        await page.getByTestId('privacy-delete-all').click()
        await expect(page.getByTestId('privacy-delete-confirm')).toBeVisible()
        await page.getByRole('button', { name: 'Keep them' }).click()
        await expect(page.getByTestId('capture-list')).toBeVisible()

        await page.getByTestId('privacy-delete-all').click()
        await page.getByTestId('privacy-delete-confirm').click()
        await expect(page.getByTestId('privacy-notice')).toContainText('Deleted 1 saved capture.')
        await expect(page.getByTestId('capture-list')).toHaveCount(0)
    })

    test('turning recording off is remembered, and the Doctor then has nothing to show for a new stream', async ({ page }) => {
        test.setTimeout(60_000)
        await openCaptures(page)
        await page.getByTestId('privacy-recording').uncheck()
        await page.reload()
        await page.getByTestId('url-input').fill(`${base}/notes`)
        await activate(page.getByTestId('connect-button'))
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10_000 })
        await expect(page.getByTestId('event-row')).toHaveCount(4, { timeout: 10_000 }) // the viewer works as before
        await page.getByTestId('doctor-toggle').click()
        await expect(page.getByTestId('doctor-empty')).toContainText('Recording is switched off')
    })
})
