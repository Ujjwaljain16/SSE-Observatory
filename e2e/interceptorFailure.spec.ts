import { test, expect, type Page } from '@playwright/test'

async function connectAndOpenInterceptors(page: Page) {
    await page.goto('/')
    await page.getByTestId('url-input').fill('http://localhost:4000/api/stream?freq=5')
    await page.getByTestId('connect-button').click()
    await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })

    await page.getByRole('button', { name: /Interceptors/i }).click()
    await expect(page.locator('text=Stream Interceptors')).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByText('Ready', { exact: true }).first().click() // the row toggles the editor (the name starts a rename)
    const editor = page.locator('textarea').first()
    await expect(editor).toBeVisible({ timeout: 5000 })
    return editor
}

test.describe('Interceptor Sandbox Resiliency', () => {
    test('surfaces a runtime error, keeps the events flowing and the page alive', async ({ page }) => {
        test.setTimeout(40000)
        const editor = await connectAndOpenInterceptors(page)
        await editor.fill('throw new Error("Malicious Crash");')

        await expect(page.locator('text=/Runtime Error|Last error:/').first()).toBeVisible({ timeout: 10000 })
        await expect(page.locator('text=Malicious Crash').first()).toBeVisible({ timeout: 10000 })

        // A failing interceptor must never lose events: the stream keeps filling.
        const count = async () => Number((await page.getByTestId('event-count').innerText()).match(/\d+/)![0])
        const before = await count()
        await page.waitForTimeout(2500)
        expect(await count()).toBeGreaterThan(before)
        await expect(page.getByTestId('event-row').first()).toBeVisible()
    })

    test('an interceptor that returns nothing is reported and the original event is kept', async ({ page }) => {
        test.setTimeout(40000)
        const editor = await connectAndOpenInterceptors(page)
        await editor.fill('// forgot the return')
        await expect(page.locator('text=/returned nothing/i').first()).toBeVisible({ timeout: 10000 })
        await expect(page.getByTestId('event-row').first()).toBeVisible()
    })

    test('the sandbox has no network, storage or eval', async ({ page }) => {
        test.setTimeout(40000)
        const editor = await connectAndOpenInterceptors(page)
        await editor.fill('return { ...event, data: JSON.stringify({ fetch: typeof fetch, idb: typeof indexedDB, post: typeof postMessage, evalType: (() => { try { return typeof (0, eval)("1") } catch (e) { return "blocked" } })(), ctor: (() => { try { return typeof [].constructor.constructor("return 1")() } catch (e) { return "blocked" } })() }) }')
        // the event list pretty-prints the payload, so allow whitespace after the colon
        const row = page.getByTestId('event-row').first()
        await expect(row).toContainText(/"fetch": *"undefined"/, { timeout: 10000 })
        await expect(row).toContainText(/"idb": *"undefined"/)
        await expect(row).toContainText(/"post": *"undefined"/)
        await expect(row).toContainText(/"evalType": *"blocked"/)
        await expect(row).toContainText(/"ctor": *"blocked"/)
    })
})
