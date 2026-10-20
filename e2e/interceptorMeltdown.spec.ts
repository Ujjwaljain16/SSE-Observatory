import { test, expect } from '@playwright/test'

test.describe('Interceptor Meltdown', () => {
    test('an infinite loop is killed after 100 ms, the page stays responsive and recovers', async ({ page }) => {
        test.setTimeout(60000)
        await page.goto('/')
        await page.getByTestId('url-input').fill('http://localhost:4000/api/stream?freq=5')
        await page.getByTestId('connect-button').click()
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        await page.getByRole('button', { name: /Interceptors/i }).click()
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        await page.getByText('Ready', { exact: true }).first().click() // the row toggles the editor (the name starts a rename)
        const editor = page.locator('textarea').first()
        await expect(editor).toBeVisible({ timeout: 5000 })

        // Memory-hungry, never-ending user code
        await editor.fill('const a = []\nwhile (true) { a.push("x".repeat(10000)) }\nreturn event')

        // The worker is killed after its time budget and the reason is shown
        await expect(page.locator('text=/exceeded 100ms/i').first()).toBeVisible({ timeout: 15000 })

        // The main thread never noticed: typing stays instant
        const start = Date.now()
        await page.getByTestId('search-input').fill('stream')
        expect(Date.now() - start).toBeLessThan(2000)
        await page.getByTestId('search-input').fill('')

        // Events keep arriving while the broken interceptor is active
        const count = async () => Number((await page.getByTestId('event-count').innerText()).match(/\d+/)![0])
        const before = await count()
        await page.waitForTimeout(2500)
        expect(await count()).toBeGreaterThan(before)

        // Fixing the code brings it back to normal
        await editor.fill('return event')
        await expect(page.locator('text=/exceeded 100ms/i')).toHaveCount(0, { timeout: 15000 })
    })
})
