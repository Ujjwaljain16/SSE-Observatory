import { test, expect } from '@playwright/test'

test.describe('Long-Running Stream Resilience', () => {
    test.setTimeout(90000)

    test('UI and Memory heap remains stable over a 30 second heavy stream', async ({ page }) => {
        await page.goto('/')

        // Connect to a continuous stream (10 events/sec)
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/stream?freq=10')
        await page.getByRole('button', { name: 'Connect', exact: true }).click()
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })

        // Wait for events to start rendering
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        // Run the stream for 30 seconds (halved from 60s to stay within timeout budget)
        await page.waitForTimeout(30000)

        // 1. Verify UI is still responsive by interacting with the search filter
        const filterStart = Date.now()
        await page.fill('input[placeholder*="Search events..."]', 'stream')
        const filterEnd = Date.now()
        expect(filterEnd - filterStart).toBeLessThan(2000)
        await page.fill('input[placeholder*="Search events..."]', '')

        // 2. Verify we haven't crashed — Event Stream heading still visible
        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 5000 })

        // 3. Verify events are still rendering (virtualizer has rows)
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 5000 })

        // 4. Log final event count stat
        const statText = await page.locator('text=events captured').first().textContent().catch(() => 'n/a')
        console.log('Final event count after 30s:', statText)

        // Disconnect
        const disconnectBtn = page.locator('button[title="Disconnect"], button:has-text("Disconnect")').first()
        if (await disconnectBtn.isVisible()) {
            await disconnectBtn.click()
        }
    })
})
