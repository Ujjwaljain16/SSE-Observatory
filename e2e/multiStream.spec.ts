import { test, expect } from '@playwright/test'

test.describe('Multi-stream Concurrency', () => {
    test('Can connect to multiple tabs on the same SharedWorker and isolate filters', async ({ page, context }) => {
        test.setTimeout(40000)

        // Tab 1 — stream A
        await page.goto('/')
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/stream?freq=5')
        await page.getByRole('button', { name: 'Connect', exact: true }).click()
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        // Tab 2 — stream B (separate page shares the same SharedWorker)
        const page2 = await context.newPage()
        await page2.goto('/')
        await page2.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/stream?freq=5')
        await page2.getByRole('button', { name: 'Connect', exact: true }).click()
        await expect(page2.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })
        await expect(page2.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        // Apply a search filter on Tab 1 that matches nothing ('xyzzy' never appears)
        await page.fill('input[placeholder*="Search events..."]', 'xyzzy_no_match')
        await page.waitForTimeout(2000)

        // Tab 1 should show 0 filtered rows
        const rows1 = await page.getByTestId('event-row').count()
        expect(rows1).toBe(0)

        // Tab 2 should still be showing rows (filter is isolated per-tab)
        const rows2 = await page2.getByTestId('event-row').count()
        expect(rows2).toBeGreaterThan(0)

        // Clear Tab 1 filter — rows should come back
        await page.fill('input[placeholder*="Search events..."]', '')
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        await page2.close()
    })
})
