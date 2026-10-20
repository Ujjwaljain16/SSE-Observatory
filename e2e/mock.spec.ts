import { test, expect } from '@playwright/test'

const EVENTS = 40
const recording = {
    version: '1.0',
    events: Array.from({ length: EVENTS }, (_, i) => ({
        id: String(i + 1),
        type: i % 5 === 0 ? 'alert' : 'message',
        data: JSON.stringify({ n: i + 1 }),
        deltaMs: 20,
    })),
}

test.describe('Mock Server / Replay E2E', () => {
    test('uploads a recording, serves it from a private URL and Monitor Mode replays it once', async ({ page }) => {
        test.setTimeout(60000)
        await page.goto('/')

        await page.getByRole('button', { name: 'Mock Server', exact: true }).click()
        await page.locator('input[type="file"]').setInputFiles({
            name: 'demo.sse-record',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(recording)),
        })
        await expect(page.getByText(`${EVENTS} events loaded`)).toBeVisible({ timeout: 5000 })

        await page.getByRole('button', { name: 'Start Mock Server', exact: true }).click()
        const urlText = await page.getByText(/session=[0-9a-f-]{36}/).first().innerText() // waits for a real id, not the placeholder
        const streamUrl = urlText.match(/https?:\/\/\S+\/api\/mock\/stream\?session=\S+/)![0]
        expect(streamUrl).toMatch(/session=[0-9a-f-]{36}/) // unguessable per-session id

        // Replay it in Monitor Mode
        await page.getByRole('button', { name: 'Monitor Mode', exact: true }).click()
        await page.getByTestId('url-input').fill(streamUrl)
        await page.getByTestId('connect-button').click()

        // 40 events plus the closing `end` message, then it stops by itself
        await expect(page.getByTestId('event-count')).toContainText(`${EVENTS + 1} events`, { timeout: 15000 })
        await page.waitForTimeout(3000)
        await expect(page.getByTestId('event-count')).toContainText(`${EVENTS + 1} events`) // no reconnect, no second pass

        // The recorded type is merged into the payload and shown
        await expect(page.getByTestId('event-row').first()).toBeVisible()
    })

    test('a session id that does not exist is a 404, not another session', async ({ request }) => {
        const res = await request.get('/api/mock/stream?session=00000000-0000-0000-0000-000000000000', { headers: { 'Sec-Fetch-Site': 'same-origin' } })
        expect(res.status()).toBe(404)
    })
})
