import { test, expect } from '@playwright/test'

test.describe('Reconnect Storm', () => {
    test('Handles simultaneous network reconnects across multiple streams without UI crash', async ({ page, context }) => {
        test.setTimeout(50000)

        // Open 3 tabs in the same browser context (shares the same SharedWorker)
        const p1 = page
        const p2 = await context.newPage()
        const p3 = await context.newPage()

        await Promise.all([p1.goto('/'), p2.goto('/'), p3.goto('/')])

        // Connect all 3 tabs to different stream IDs
        const urlInput = 'input[placeholder*="https://api.example.com/sse"]'
        await p1.fill(urlInput, 'http://localhost:4000/api/stream?freq=5')
        await p2.fill(urlInput, 'http://localhost:4000/api/stream?freq=5')
        await p3.fill(urlInput, 'http://localhost:4000/api/stream?freq=5')

        await Promise.all([
            p1.getByRole('button', { name: 'Connect', exact: true }).click(),
            p2.getByRole('button', { name: 'Connect', exact: true }).click(),
            p3.getByRole('button', { name: 'Connect', exact: true }).click(),
        ])

        // Wait for all to connect and render at least one event
        await Promise.all([
            expect(p1.locator('text=Connected').first()).toBeVisible({ timeout: 10000 }),
            expect(p2.locator('text=Connected').first()).toBeVisible({ timeout: 10000 }),
            expect(p3.locator('text=Connected').first()).toBeVisible({ timeout: 10000 }),
        ])
        await expect(p1.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        // Record event count before network drop
        const countBefore = await p1.getByTestId('event-row').count()
        expect(countBefore).toBeGreaterThan(0)

        // Drop network — causes all 3 streams to disconnect simultaneously
        await context.setOffline(true)
        console.log('--- Network Dropped ---')
        await p1.waitForTimeout(2000)

        // Restore network — reconnect storm: all 3 tabs try to reconnect at once
        await context.setOffline(false)
        console.log('--- Network Restored ---')

        // Wait for reconnects to settle
        await p1.waitForTimeout(4000)

        // All 3 UIs should survive and still show the Event Stream heading (no crash)
        await expect(p1.locator('text=Event Stream')).toBeVisible({ timeout: 10000 })
        await expect(p2.locator('text=Event Stream')).toBeVisible({ timeout: 10000 })
        await expect(p3.locator('text=Event Stream')).toBeVisible({ timeout: 10000 })

        // No duplicate event-row IDs in Tab 1's rendered list
        const renderedIds = await p1.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('[data-testid="event-row"]'))
            return rows.map(r => r.querySelector('span')?.textContent?.trim() ?? '')
        })
        const unique = new Set(renderedIds.filter(Boolean))
        // Rendered set should have no duplicates
        expect(unique.size).toBe(renderedIds.filter(Boolean).length)

        await p2.close()
        await p3.close()
    })
})
