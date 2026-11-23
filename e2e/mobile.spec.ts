import { test, expect, type Page } from '@playwright/test'
import { startFixtureServer, type FixtureServer } from '../src/fixtures/server'
import { startPlainServer, STREAM_HEAD, type PlainServer } from './support/doctorKit'

// Mobile device emulation: the iPhone 14 profile on Playwright's WebKit and the Pixel 7 profile on Chromium (see playwright.config.ts:
// the projects mobile-iphone and mobile-pixel, opt in with E2E_BROWSERS=mobile). This is a phone-sized viewport, a mobile user agent and
// touch input, which catches layout and tap problems. It is not a phone: no real touch hardware, keyboard, OS or Safari. Every action
// here is a tap, never a click.

// The desktop projects ignore this file and the mobile projects run nothing else (testIgnore and testMatch in the config), so it runs once.

let fx: FixtureServer
let plain: PlainServer
test.beforeAll(async () => {
    fx = await startFixtureServer({ port: 0 })
    plain = await startPlainServer((_req, res) => {
        res.writeHead(200, STREAM_HEAD)
        res.write('id: m1\nevent: tick\ndata: {"seq":1,"token":"mobile-copy-check"}\n\n') // one event, then the stream stays open and quiet
    })
})
test.afterAll(async () => { await fx.close(); await plain.close() })

/**
 * Connect straight to `url` (the proxy switched off) by tapping. The shared connectDirect clicks, and in Playwright's WebKit on Linux the iPhone
 * profile never saw the proxy switch hold still for a click (a click hovers first); a tap is also what a phone does.
 */
async function connectByTap(page: Page, url: string): Promise<void> {
    const proxy = page.getByRole('switch', { name: 'Use server proxy' })
    if ((await proxy.getAttribute('aria-checked')) === 'true') await proxy.tap()
    await expect(proxy).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('url-input').fill(url)
    await page.getByTestId('connect-button').tap()
    await expect(page.getByTestId('connection-status')).toContainText('Connected', { timeout: 15_000 })
}

/** Nothing wider than the screen: the page itself must not scroll sideways. */
async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
    const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    expect(sizes.scroll, `${where}: the page is ${sizes.scroll}px wide on a ${sizes.client}px screen`).toBeLessThanOrEqual(sizes.client)
}

test.describe('phone: the whole path with taps', () => {
    test('a touch device is what runs this: a phone-sized screen, touch input and no hover', async ({ page, browserName }) => {
        await page.goto('/')
        // Playwright's WebKit delivers touch events but reports navigator.maxTouchPoints as 0, so either signal counts as a touch screen.
        const device = await page.evaluate(() => ({ w: window.innerWidth, touch: navigator.maxTouchPoints > 0 || 'ontouchstart' in window ? 1 : 0, coarse: matchMedia('(pointer: coarse)').matches }))
        expect(device.w).toBeLessThan(500)
        expect(device.touch).toBeGreaterThan(0)
        // Playwright's mobile WebKit and Chromium both report a coarse primary pointer when hasTouch and isMobile are set.
        expect(device.coarse, `pointer: coarse on ${browserName}`).toBe(true)
    })

    test('loads without scrolling sideways, and the connect controls can be tapped', async ({ page }) => {
        await page.goto('/')
        await expect(page.getByTestId('url-input')).toBeVisible()
        await expect(page.getByTestId('connect-button')).toBeVisible()
        await expectNoHorizontalScroll(page, 'the first screen')
        // the proxy switch is a tap target too
        const proxy = page.getByRole('switch', { name: 'Use server proxy' })
        const before = await proxy.getAttribute('aria-checked')
        await proxy.tap()
        await expect(proxy).not.toHaveAttribute('aria-checked', before ?? '')
    })

    test('connects to a fixture stream by tapping, events arrive, and the page still fits the screen', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        const proxy = page.getByRole('switch', { name: 'Use server proxy' })
        if ((await proxy.getAttribute('aria-checked')) === 'true') await proxy.tap()
        await expect(proxy).toHaveAttribute('aria-checked', 'false')
        await page.getByTestId('url-input').fill(fx.urlFor('h01', { scale: 0.25, n: 4000 }))
        await page.getByTestId('connect-button').tap()
        await expect(page.getByTestId('connection-status')).toContainText('Connected', { timeout: 15_000 })
        await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 15_000 })
        await expectNoHorizontalScroll(page, 'with a stream connected')
    })

    test('opens the Doctor and every tab by tapping, and no tab makes the page scroll sideways', async ({ page }) => {
        test.setTimeout(90_000)
        await page.goto('/')
        await connectByTap(page, fx.urlFor('h01', { scale: 0.25, n: 4000 }))
        await page.getByTestId('doctor-toggle').tap()
        await expect(page.getByTestId('doctor-panel').first()).toBeVisible()
        await expectNoHorizontalScroll(page, 'the Doctor, first tab')
        const ids = await page.getByRole('tab').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').replace('doctor-tab-', '')))
        expect(ids, 'the Doctor tabs').toEqual(expect.arrayContaining(['findings', 'request', 'flow', 'timeline', 'sequence', 'captures', 'profile']))
        for (const id of ids) {
            const tab = page.getByTestId(`doctor-tab-${id}`)
            await tab.tap()
            await expect(tab, `the ${id} tab`).toHaveAttribute('aria-selected', 'true')
            await expectNoHorizontalScroll(page, `the ${id} tab`)
        }
    })

    test('the failure lab opens by tap and runs an entry', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await page.getByTestId('doctor-toggle').tap()
        await expect(page.getByTestId('doctor-empty')).toContainText('Connect to a stream')
        await page.getByTestId('doctor-try-lab').tap()
        await expect(page.getByTestId('lab-entry').first()).toBeVisible({ timeout: 10_000 })
        await expectNoHorizontalScroll(page, 'the failure lab')
        const run = page.getByRole('button', { name: 'Run the Doctor on f04-silent' })
        await run.scrollIntoViewIfNeeded()
        await run.tap()
        const result = page.getByTestId('lab-result')
        await expect(result.getByTestId('lab-verdict')).toContainText('found what this stream was built to show')
        await expect(result.locator('[data-testid="doctor-finding"][data-finding-key^="stall.silent"]')).toBeVisible()
        await expectNoHorizontalScroll(page, 'a lab result')
    })

    test('the export dialog opens by tap, fits the screen, and closes', async ({ page }) => {
        test.setTimeout(60_000)
        await page.goto('/')
        await connectByTap(page, fx.urlFor('h01', { scale: 0.25, n: 4000 }))
        await page.getByTestId('doctor-toggle').tap()
        await expect(page.getByTestId('doctor-panel').first()).toBeVisible()
        await page.getByTestId('doctor-export').tap()
        const dialog = page.getByTestId('export-dialog')
        await expect(dialog).toBeVisible()
        await expect(page.getByTestId('export-download')).toBeVisible()
        const box = await dialog.boundingBox()
        const viewport = page.viewportSize()!
        expect(box!.x, 'the dialog starts on the screen').toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width, 'the dialog ends on the screen').toBeLessThanOrEqual(viewport.width)
        await expectNoHorizontalScroll(page, 'the export dialog')
        await page.keyboard.press('Escape') // a phone has no Escape key, but a keyboard attached to one does
        await expect(dialog).toBeHidden()
    })

    test('the copy warning works by touch: Cancel copies nothing, Copy anyway copies', async ({ page, context, browserName }) => {
        test.setTimeout(60_000)
        // Chromium asks for permission to write the clipboard; WebKit allows it inside a tap.
        if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.goto('/')
        await connectByTap(page, `${plain.url}/stream`)
        const row = page.getByTestId('event-row').first()
        await expect(row).toBeVisible({ timeout: 15_000 })
        const copy = row.getByRole('button', { name: 'Copy', exact: true })
        await copy.tap()
        const dialog = page.getByRole('alertdialog', { name: 'Copy a raw value?' })
        await expect(dialog).toBeVisible()
        await expect(dialog).toContainText('may contain secrets')
        await expectNoHorizontalScroll(page, 'the copy warning')
        const box = await dialog.boundingBox()
        expect(box!.x + box!.width, 'the warning fits the screen').toBeLessThanOrEqual(page.viewportSize()!.width)

        await dialog.getByRole('button', { name: 'Cancel' }).tap()
        await expect(dialog).toBeHidden()
        await expect(row.getByRole('button', { name: 'Copied!' })).toHaveCount(0)

        await copy.tap()
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: 'Copy anyway' }).tap()
        await expect(dialog).toBeHidden()
        await expect(row.getByRole('button', { name: 'Copied!' })).toBeVisible()
        if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('{"seq":1,"token":"mobile-copy-check"}')
    })
})
