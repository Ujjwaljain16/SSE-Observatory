import http from 'node:http'
import type { AddressInfo } from 'node:net'
import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'
import { activate } from './support/doctorKit'

// A stream in a format of its own (chat-style chunks): the profile's display mapping puts it into the common view, and a pinned field is
// followed across the events in the Stats panel.

let server: http.Server
let base = ''

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
        if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
        res.writeHead(200, headers)
        let n = 0
        const timer = setInterval(() => {
            if (n >= 6) { clearInterval(timer); return }
            res.write(`data: ${JSON.stringify({ object: 'chat.chunk', id: `c${n}`, n, status: n === 3 ? 'slow' : 'ok', choices: [{ delta: { content: `Hello ${n}` } }] })}\n\n`)
            n++
        }, 100)
        req.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => { server.closeAllConnections(); server.close() })

async function start(page: Page) {
    await page.goto('/')
    await page.getByTestId('url-input').fill(`${base}/chat`)
    await activate(page.getByTestId('connect-button'))
    await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('event-row')).toHaveCount(6, { timeout: 10_000 })
}
async function openProfile(page: Page) {
    await page.getByTestId('doctor-toggle').click()
    await page.getByTestId('doctor-tab-profile').click()
    await expect(page.getByTestId('doctor-profile')).toBeVisible()
}

test.describe('Display mapping', () => {
    test('puts a stream in its own format into the list as a type, a summary and an id', async ({ page }) => {
        test.setTimeout(60_000)
        await start(page)
        await expect(page.getByTestId('mapped-summary')).toHaveCount(0) // nothing mapped yet
        await openProfile(page)
        await page.getByTestId('profile-displayType').fill('$.object')
        await page.getByTestId('profile-displaySummary').fill('$.choices[0].delta.content')
        await page.getByTestId('profile-displayId').fill('$.id')
        // the form says what the newest event would show before anything is saved
        await expect(page.getByTestId('profile-display-preview')).toContainText('summary "Hello 5"')
        await page.getByTestId('profile-save').click()
        await expect(page.getByTestId('profile-message')).toContainText('Saved')

        const newest = page.getByTestId('event-row').first()
        await expect(newest.getByTestId('mapped-type')).toHaveText('chat.chunk')
        await expect(newest.getByTestId('mapped-summary')).toHaveText('Hello 5')
        await expect(newest.getByTestId('mapped-id')).toHaveText('c5')
        await expect(page.getByTestId('mapped-summary')).toHaveCount(6)
    })

    test('the chart counts by the mapped type, and the mapping survives a reload', async ({ page }) => {
        test.setTimeout(60_000)
        await start(page)
        await openProfile(page)
        await page.getByTestId('profile-displayType').fill('$.status')
        await page.getByTestId('profile-save').click()
        await expect(page.getByTestId('profile-message')).toContainText('Saved')

        await page.getByRole('button', { name: 'Stats' }).click()
        const chart = page.getByTestId('type-chart')
        await expect(chart.getByTestId('type-row').first()).toContainText('ok')
        await expect(chart).toContainText('slow')

        await start(page) // reloads the page and connects again
        await expect(page.getByTestId('event-row').first().getByTestId('mapped-type')).toHaveText('ok')
    })

    test('refuses a path that is not a path, and changes nothing', async ({ page }) => {
        test.setTimeout(60_000)
        await start(page)
        await openProfile(page)
        await page.getByTestId('profile-displaySummary').fill('not a path!')
        await page.getByTestId('profile-save').click()
        await expect(page.getByTestId('profile-errors')).toContainText('"display.summary" must be a JSON path')
        await expect(page.getByTestId('mapped-summary')).toHaveCount(0)
    })
})

test.describe('Followed fields', () => {
    test('follows a field you type, as a line and its range', async ({ page }) => {
        test.setTimeout(60_000)
        await start(page)
        await page.getByRole('button', { name: 'Stats' }).click()
        await page.getByTestId('follow-input').fill('$.n')
        await page.getByTestId('follow-add').click()
        const card = page.getByTestId('followed-field')
        await expect(card).toHaveAttribute('data-path', '$.n')
        await expect(card.getByTestId('followed-summary')).toContainText('In 6 of 6 events; newest value 5.')
        await expect(card.getByTestId('followed-numbers')).toContainText('0 → 5')
        await expect(card.getByRole('img')).toHaveAccessibleName(/counts up by one/)
    })

    test('follows a text field as its most common values', async ({ page }) => {
        test.setTimeout(60_000)
        await start(page)
        await page.getByRole('button', { name: 'Stats' }).click()
        await page.getByTestId('follow-input').fill('$.status')
        await page.getByTestId('follow-add').click()
        const values = page.getByTestId('followed-value')
        await expect(values.first()).toContainText('ok')
        await expect(values.first()).toContainText('5 (83%)')
        await expect(values.nth(1)).toContainText('slow')
    })

    test('a field pinned in the profile tab is followed in Stats, and removing it there unpins it', async ({ page }) => {
        test.setTimeout(60_000)
        await start(page)
        await openProfile(page)
        await page.getByRole('button', { name: 'Pin $.n' }).click()
        await expect(page.getByRole('button', { name: 'Unpin $.n' })).toBeVisible()

        await page.getByRole('button', { name: 'Stats' }).click()
        await expect(page.getByTestId('followed-field')).toHaveAttribute('data-path', '$.n')
        await page.getByRole('button', { name: 'Stop following $.n' }).click()
        await expect(page.getByTestId('followed-field')).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Pin $.n' })).toBeVisible() // the star in the profile tab follows
    })

    test('has no accessibility violations with the mapping inputs and a followed field showing', async ({ page }) => {
        test.setTimeout(60_000)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await start(page)
        await page.getByRole('button', { name: 'Stats' }).click()
        await page.getByTestId('follow-input').fill('$.status')
        await page.getByTestId('follow-add').click()
        await page.getByTestId('follow-input').fill('$.n')
        await page.getByTestId('follow-add').click()
        await openProfile(page)
        const results = await new AxeBuilder({ page }).include('[data-testid="followed-fields"]').include('[data-testid="profile-display"]').analyze()
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    })
})
