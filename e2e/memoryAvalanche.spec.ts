import { test, expect } from '@playwright/test'

test.describe('Memory Avalanche & UI Virtualization', () => {
    test.setTimeout(60000)

    test('UI handles massive event bursts without DOM explosion or UI freezing', async ({ page }) => {
        await page.goto('/')

        // High-frequency burst: 1000 events/sec for ~10 seconds
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/stream?freq=1000')
        await page.getByRole('button', { name: 'Connect', exact: true }).click()
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })

        // Wait for first events to render
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        console.log('Ingesting high-frequency burst...')
        await page.waitForTimeout(10000)

        // UI should remain responsive — verify Event Stream heading is still visible
        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 5000 })

        // Virtualization check: the virtualizer renders only visible rows, not all in-memory events.
        // We expect a reasonable number of DOM nodes (< 100 event-row divs in the viewport at once)
        const drawnRows = await page.getByTestId('event-row').count()
        expect(drawnRows).toBeGreaterThan(0) // at least something rendered
        expect(drawnRows).toBeLessThan(100)   // virtualizer caps DOM nodes

        // Disconnect should be fast despite large in-memory state
        const disconnectBtn = page.locator('button[title="Disconnect"]').first()
        if (await disconnectBtn.isVisible()) {
            const t0 = Date.now()
            await disconnectBtn.click()
            expect(Date.now() - t0).toBeLessThan(2000)
        }

        // JS execution still alive (tab didn't crash)
        const isAlive = await page.evaluate(() => true)
        expect(isAlive).toBe(true)
    })
})
