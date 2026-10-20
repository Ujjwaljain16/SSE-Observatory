import { test, expect } from '@playwright/test'

// Regression for two visual bugs that counting rows in the DOM cannot see:
//  - rows were positioned with other rows' cached heights, so they overlapped
//  - the newest row faded in from transparent on every event, leaving a blank slot at the top of a busy list
test.describe('Event list layout under a live stream', () => {
    test('rows never overlap and the top of the list is never blank', async ({ page }) => {
        test.setTimeout(40000)
        await page.goto('/')
        await page.getByTestId('url-input').fill('http://localhost:4000/api/stream?freq=15')
        await page.getByTestId('connect-button').click()
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        // sample the layout several times while events keep arriving
        for (let i = 0; i < 6; i++) {
            await page.waitForTimeout(700)
            const layout = await page.evaluate(() => {
                const rows = [...document.querySelectorAll('[data-testid="event-row"]')]
                const scroller = rows[0]?.closest('.overflow-y-auto') as HTMLElement | null
                const boxes = rows.map((r) => r.getBoundingClientRect()).sort((a, b) => a.top - b.top)
                let overlaps = 0
                for (let n = 1; n < boxes.length; n++) if (boxes[n].top < boxes[n - 1].bottom - 1) overlaps++
                const first = boxes[0]
                return {
                    rows: rows.length,
                    overlaps,
                    firstRowOffset: scroller && first ? first.top - scroller.getBoundingClientRect().top : null,
                    firstRowOpacity: rows[0] ? Number(getComputedStyle(rows[0]).opacity) : null,
                }
            })
            expect(layout.rows).toBeGreaterThan(1)
            expect(layout.overlaps).toBe(0)
            expect(layout.firstRowOffset).toBeLessThan(60) // right under the header, not pushed down by a blank gap
            expect(layout.firstRowOpacity).toBeGreaterThan(0.95) // visible, not mid-fade
        }
    })
})
