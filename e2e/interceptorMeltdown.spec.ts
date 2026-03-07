import { test, expect } from '@playwright/test'

test.describe('Interceptor Meltdown', () => {
    test.skip('Pipeline survives memory abuse and async hanging loops in user code', async ({ page }) => {
        test.setTimeout(40000)
        await page.goto('/')

        // Connect first so the Interceptors panel button appears in the toolbar
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/stream?freq=5')
        // Ensure clean state
        const initialDisconnectBtn = page.locator('button[title="Disconnect"]').first()
        if (await initialDisconnectBtn.isVisible()) {
            await initialDisconnectBtn.click()
            await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible({ timeout: 5000 })
        }

        // Connect
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/stream?freq=5')
        await page.getByRole('button', { name: 'Connect', exact: true }).click()
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        // Open the Interceptors panel
        await page.getByRole('button', { name: /Interceptors/i }).click()
        await expect(page.locator('text=Stream Interceptors')).toBeVisible({ timeout: 5000 })

        // Add a new interceptor
        await page.getByRole('button', { name: 'Add' }).click()

        // Wait for Interceptor 1 to appear and expand it
        const interceptorRow = page.locator('text=Interceptor 1').first()
        await expect(interceptorRow).toBeVisible({ timeout: 10000 })
        await interceptorRow.click()

        // Write a memory-abusing interceptor via textarea
        const codeEditor = page.locator('textarea').first()
        await expect(codeEditor).toBeVisible({ timeout: 5000 })
        await codeEditor.fill('let a = [];\nwhile(true) { a.push("x".repeat(10000)); }\nreturn event;')

        // Give it time to melt down (sandbox should detect and kill it)
        await page.waitForTimeout(3000)

        // Main UI thread MUST remain responsive — measure interaction latency
        const filterStart = Date.now()
        await page.fill('input[placeholder*="Search events..."]', 'stream')
        const filterEnd = Date.now()
        expect(filterEnd - filterStart).toBeLessThan(2000)
        await page.fill('input[placeholder*="Search events..."]', '')

        // Pipeline should still be alive
        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 10000 })

        // Disconnect
        const disconnectBtn = page.locator('button[title="Disconnect"]').first()
        if (await disconnectBtn.isVisible()) {
            await disconnectBtn.click({ force: true })
        }
    })
})
