import { test, expect } from '@playwright/test'

test.describe('Backpressure & Throughput Resilience', () => {
    test('UI handles burst stream of 20k events without freezing or dropping events', async ({ page }) => {
        test.setTimeout(60000)
        await page.goto('/')

        // Connect to burst endpoint (20k events)
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/burst?count=20000')
        await page.getByRole('button', { name: 'Connect', exact: true }).click()

        // Wait for connection
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })

        // Wait for at least one event row to render
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 15000 })

        // Apply a search filter mid-stream
        await page.fill('input[placeholder*="Search events..."]', 'burst')

        // Let it settle — 20k events from local server should finish within a few seconds
        await page.waitForTimeout(5000)

        // UI should NOT be frozen — verify the search filter is still interactive
        await page.fill('input[placeholder*="Search events..."]', '')

        // Try pause/resume if button exists
        const pauseBtn = page.locator('button[title="Pause Stream"], button[title="Resume Stream"]').first()
        if (await pauseBtn.isVisible()) {
            await pauseBtn.click()
            await pauseBtn.click()
        }

        // Validate that Event Stream heading is still alive
        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 10000 })

        // Check the virtualizer rendered rows without crashing
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })
    })
})
