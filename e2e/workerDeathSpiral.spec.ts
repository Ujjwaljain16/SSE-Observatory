import { test, expect } from '@playwright/test'

test.describe('Worker Death Spiral', () => {
    test('a killed SharedWorker is noticed and the stream carries on in the page', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'uses the Chrome DevTools Protocol to kill the worker')
        test.setTimeout(90000)

        await page.goto('/')
        await page.getByTestId('url-input').fill('http://localhost:4000/api/stream?freq=20')
        await page.getByTestId('connect-button').click()
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

        const count = async () => Number((await page.getByTestId('event-count').innerText()).match(/\d+/)![0])
        await page.waitForTimeout(1500)

        // Kill the SharedWorker from outside, the way a crash or an extension would.
        const cdp = await page.context().browser()!.newBrowserCDPSession()
        const { targetInfos } = await cdp.send('Target.getTargets')
        const worker = targetInfos.find((t) => t.type === 'shared_worker')
        test.skip(!worker, 'this browser did not start a SharedWorker (in-page fallback is in use)')
        await cdp.send('Target.closeTarget', { targetId: worker!.targetId })

        // Killing a SharedWorker raises no event; the tab notices through missing pongs and takes over the connection.
        const atKill = await count()
        await expect.poll(count, { timeout: 45000, intervals: [1000] }).toBeGreaterThan(atKill + 20)

        // The UI never crashed
        expect(await page.evaluate(() => document.body.innerText.includes('An error has occurred'))).toBe(false)
        await expect(page.locator('text=Event Stream')).toBeVisible()
    })
})
