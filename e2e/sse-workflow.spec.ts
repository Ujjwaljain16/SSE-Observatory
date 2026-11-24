import { test, expect } from '@playwright/test'
import { activate } from './support/doctorKit'

test.describe('Basic SSE Workflow', () => {
    test('Connects to stream, filters events, and disconnects', async ({ page }) => {
        test.setTimeout(30000)
        await page.goto('/')

        // Connect using the correct placeholder
        await page.getByTestId('url-input').fill('http://localhost:4000/api/stream?freq=100')
        await activate(page.getByTestId('connect-button'))

        // Wait for connection indicator
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })

        // Wait for at least one event row to render
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        // Apply a search filter
        await page.getByTestId('search-input').fill('stream')
        await page.waitForTimeout(1000)

        // Clear the filter
        await page.getByTestId('search-input').fill('')

        // Disconnect
        await activate(page.getByTestId('connect-button'))

        // After disconnect the Connect button should come back and show "Connect"
        await expect(page.getByTestId('connect-button')).toContainText('Connect', { timeout: 5000 })
    })
})
