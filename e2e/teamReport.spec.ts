import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type Page } from '@playwright/test'
import { activate } from './support/doctorKit'

// The Export dialog's "For an issue or pull request": a short body to paste into a ticket, made from the redacted copy.

// Built at run time so this file holds no secret-shaped text.
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXZhbHVlLW5vdC1yZWFs'].join('.')

let server: http.Server
let base = ''

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
        if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
        res.writeHead(200, headers)
        res.write(`: debug auth ${JWT}\n\n`)
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

async function openExport(page: Page) {
    await page.goto('/')
    await page.getByTestId('url-input').fill(`${base}/notes`)
    await activate(page.getByTestId('connect-button'))
    await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('event-row')).toHaveCount(4, { timeout: 10_000 })
    await page.getByTestId('doctor-toggle').click()
    await page.getByTestId('doctor-export').click()
    await expect(page.getByTestId('export-dialog')).toBeVisible()
}

test.describe('Export for an issue or pull request', () => {
    test('is a short body with the verdict, how to reproduce and the full report folded away, without the secret', async ({ page }) => {
        test.setTimeout(60_000)
        await openExport(page)
        await page.getByLabel(/For an issue or pull request/).check()
        const preview = page.getByTestId('export-dialog').getByLabel(/Preview of/)
        await expect(preview).toContainText('## Stream check:')
        await expect(preview).toContainText('### How to reproduce')
        await expect(preview).toContainText('<summary>Full report</summary>')
        await expect(preview).not.toContainText(JWT)
        await expect(page.getByTestId('export-redaction')).toContainText('replaced')
    })

    test('downloads as a Markdown file that ends with the marker and holds no secret', async ({ page }) => {
        test.setTimeout(60_000)
        await openExport(page)
        await page.getByLabel(/For an issue or pull request/).check()
        const ack = page.getByTestId('export-ack')
        if (await ack.isVisible()) await ack.check()
        const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-download').click()])
        expect(file.suggestedFilename()).toMatch(/\.issue\.md$/)
        const text = fs.readFileSync((await file.path())!, 'utf8')
        expect(text).not.toContain(JWT)
        expect(text.trimEnd().endsWith('<!-- sse-doctor:report -->')).toBe(true)
    })
})
