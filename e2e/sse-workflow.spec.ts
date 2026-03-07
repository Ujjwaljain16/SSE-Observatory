import { test, expect } from '@playwright/test'

test.describe('Basic SSE Workflow', () => {
    test('Connects to stream, filters events, and disconnects', async ({ page }) => {
        test.setTimeout(30000)
        await page.goto('/')

        // Connect using the correct placeholder
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/stream?freq=100')
        await page.getByRole('button', { name: 'Connect', exact: true }).click()

        // Wait for connection indicator
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })

        // Wait for at least one event row to render
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        // Apply a search filter
        await page.fill('input[placeholder*="Search events..."]', 'stream')
        await page.waitForTimeout(1000)

        // Clear the filter
        await page.fill('input[placeholder*="Search events..."]', '')

        // Disconnect via the title button
        const disconnectBtn = page.locator('button[title="Disconnect"]').first()
        if (await disconnectBtn.isVisible()) {
            await disconnectBtn.click()
        }

        // After disconnect the Connect button should come back
        await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible({ timeout: 5000 })
    })
})
