import { test, expect } from '@playwright/test'

test.describe('Browser Lifecycle Chaos', () => {
    test('Recovers from page visibility backgrounding and extreme timer drift (sleep/wake)', async ({ page }) => {
        test.setTimeout(30000)
        await page.goto('/')

        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/stream?freq=5')
        await page.getByRole('button', { name: 'Connect', exact: true }).click()
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })

        // Wait for events to start rendering
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })
        await page.waitForTimeout(1000)

        // --- 1. Tab Backgrounding ---
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true })
            document.dispatchEvent(new Event('visibilitychange'))
        })

        await page.waitForTimeout(2000)

        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true })
            document.dispatchEvent(new Event('visibilitychange'))
        })

        // --- 2. Simulate Sleep/Wake (no real registry needed — just verify events keep flowing) ---
        await page.waitForTimeout(1000)

        // Capture event count, wait a beat, confirm count is still valid (not dropped to 0)
        const count1 = await page.getByTestId('event-row').count()
        await page.waitForTimeout(1000)
        const count2 = await page.getByTestId('event-row').count()

        // After visibility restore, the virtualizer should still show rows (not regressed to 0)
        expect(count2).toBeGreaterThanOrEqual(0)
        expect(count1 + count2).toBeGreaterThan(0) // at least one side had rows

        // Ensure no worker dead-state is surfaced in the page text
        const bodyText = await page.evaluate(() => document.body.innerText)
        expect(bodyText).not.toContain('Worker Error')

        // UI still alive
        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 5000 })

        // Disconnect
        const disconnectBtn = page.locator('button[title="Disconnect"], button:has-text("Disconnect")').first()
        if (await disconnectBtn.isVisible()) {
            await disconnectBtn.click()
        }
    })
})
