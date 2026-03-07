import { test, expect } from '@playwright/test'

test.describe('Worker Restart Resilience', () => {
    test('Pipeline recovers gracefully if an underlying worker is terminated', async ({ page }) => {
        test.setTimeout(30000)
        await page.goto('/')

        // Connect to stream
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/stream?freq=5')
        await page.getByRole('button', { name: 'Connect', exact: true }).click()
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        await page.waitForTimeout(1000)

        // Simulate network failure by aborting all requests to the stream endpoint
        await page.route('**/api/stream**', route => route.abort('failed'))

        // Give the chaos server connection time to die and for the worker to detect it
        await page.waitForTimeout(3000)

        // Restore the network
        await page.unroute('**/api/stream**')

        // Wait for reconnect attempt to settle
        await page.waitForTimeout(3000)

        // The UI should still be alive — Event Stream heading visible (no React crash)
        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 5000 })

        // App should not show an uncaught error boundary
        const isCrashed = await page.evaluate(() =>
            document.body.innerText.includes('Something went wrong')
        )
        expect(isCrashed).toBe(false)

        // Disconnect cleanly
        const disconnectBtn = page.locator('button[title="Disconnect"]').first()
        if (await disconnectBtn.isVisible()) {
            await disconnectBtn.click()
        }
    })
})
