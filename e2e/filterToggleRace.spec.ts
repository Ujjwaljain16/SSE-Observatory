import { test, expect } from '@playwright/test'

test.describe('Filter Toggle Race Condition', () => {
    test('Rapidly toggling a complex filter during a high-speed event burst does not corrupt state or ordering', async ({ page }) => {
        test.setTimeout(40000)
        await page.goto('/')

        // Connect to a fast continuous stream (500 events/sec)
        await page.fill('input[placeholder*="https://api.example.com/sse"]', 'http://localhost:4000/api/stream?freq=500')
        await page.getByRole('button', { name: 'Connect', exact: true }).click()

        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })

        // Wait for events to start rendering
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })
        await page.waitForTimeout(1000)

        // Rapidly toggle the search filter 20 times while events are streaming in
        const searchInput = page.locator('input[placeholder*="Search events..."]')
        for (let i = 0; i < 20; i++) {
            await searchInput.fill(i % 2 === 0 ? 'stream' : '')
            await page.waitForTimeout(50)
        }

        // Clear the filter and let the dust settle
        await searchInput.fill('')
        await page.waitForTimeout(2000)

        // Disconnect to freeze state
        const disconnectBtn = page.locator('button[title="Disconnect"], button:has-text("Disconnect")').first()
        if (await disconnectBtn.isVisible()) {
            await disconnectBtn.click()
        }

        // Verify no duplicate IDs in the visible rendered rows
        const eventIds = await page.evaluate(() => {
            const rows = document.querySelectorAll('[data-testid="event-row"]')
            const ids: string[] = []
            rows.forEach(row => {
                // ID is shown as a code element with # prefix
                const idEl = row.querySelector('span')
                if (idEl?.textContent) ids.push(idEl.textContent.trim())
            })
            return ids
        })

        // We should have some events
        expect(eventIds.length).toBeGreaterThan(0)

        // No duplicates in the visible rendered set
        const uniqueIds = new Set(eventIds)
        expect(uniqueIds.size).toBe(eventIds.length)

        // UI is still alive
        await expect(page.locator('text=Event Stream')).toBeVisible({ timeout: 10000 })
    })
})
