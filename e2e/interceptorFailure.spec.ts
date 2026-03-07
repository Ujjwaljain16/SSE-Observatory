import { test, expect } from '@playwright/test'

test.describe('Interceptor Sandbox Resiliency', () => {
    test.skip('UI surfaces interceptor runtime errors but prevents worker crashes', async ({ page }) => {
        test.setTimeout(40000)
        await page.goto('/')

        // Connect first so the event toolbar (which contains the Interceptors button) renders
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/stream?freq=5')
        // If already connected from a previous flaky run, disconnect first to ensure clean state
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

        // Open the Interceptors panel (only rendered when connected or events > 0)
        await page.getByRole('button', { name: /Interceptors/i }).click()
        await expect(page.locator('text=Stream Interceptors')).toBeVisible({ timeout: 5000 })

        // Add a new interceptor
        await page.getByRole('button', { name: 'Add' }).click()

        // Wait for Interceptor 1 to appear in the list
        const interceptorRow = page.locator('text=Interceptor 1').first()
        await expect(interceptorRow).toBeVisible({ timeout: 10000 })
        await interceptorRow.click()

        // The code editor is a plain textarea — fill with error-throwing code
        const codeEditor = page.locator('textarea').first()
        await expect(codeEditor).toBeVisible({ timeout: 5000 })
        await codeEditor.fill('throw new Error("Malicious Crash");')

        // Let events run through the interceptor for a bit
        await page.waitForTimeout(2000)

        // Pipeline should NOT be frozen — Event Stream heading still visible
        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 5000 })

        // Error should be surfaced in the interceptor panel
        await expect(page.locator('text=/Runtime Error|Last error:/')).toBeVisible({ timeout: 10000 })

        // Disconnect
        const disconnectBtn = page.locator('button[title="Disconnect"]').first()
        if (await disconnectBtn.isVisible()) {
            await disconnectBtn.click({ force: true })
        }
    })
})
