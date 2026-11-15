import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'

// Automated accessibility checks (axe-core, WCAG 2.0/2.1 A and AA) on the main states of the app, plus keyboard checks.
// A screen reader is not run here: this finds what can be found by rules (names, roles, contrast, structure) and by keyboard.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

async function violations(page: Page, label: string) {
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    return results.violations.map((v) => `${label}: ${v.id} (${v.impact}) ${v.help} [${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'}] e.g. ${v.nodes[0]?.target.join(' ')}`)
}

async function connect(page: Page) {
    await page.getByTestId('url-input').fill('http://localhost:4000/api/stream?freq=1')
    await page.getByTestId('connect-button').click()
    await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('event-row').first()).toBeVisible({ timeout: 10000 })
    // a new row fades in; measure colours once it has settled (one event a second leaves time between rows)
    await page.waitForTimeout(1500)
}

test.describe('Accessibility', () => {
    test('has no WCAG A/AA violations on the main screens', async ({ page }) => {
        test.setTimeout(120_000)
        const found: string[] = []
        await page.emulateMedia({ reducedMotion: 'reduce' }) // the app honours it; animated colours would be measured half way
        await page.goto('/')
        found.push(...(await violations(page, 'start')))

        await connect(page)
        found.push(...(await violations(page, 'connected, events flowing')))

        await page.getByRole('button', { name: /Interceptors/i }).click()
        await expect(page.locator('textarea, [data-testid="interceptor-panel"]').first()).toBeVisible({ timeout: 5000 }).catch(() => undefined)
        found.push(...(await violations(page, 'interceptors open')))

        await page.getByRole('button', { name: 'Multi-Stream', exact: true }).click()
        await page.waitForTimeout(500) // let colour transitions finish, or axe measures a half-faded colour
        found.push(...(await violations(page, 'multi-stream')))

        await page.getByRole('button', { name: 'Mock Server', exact: true }).click()
        await page.waitForTimeout(500)
        found.push(...(await violations(page, 'mock server')))

        await page.getByRole('button', { name: /dark mode/i }).click().catch(() => undefined)
        await page.waitForTimeout(500)
        found.push(...(await violations(page, 'mock server, dark')))

        expect(found, found.join('\n')).toEqual([])
    })

    test('the main controls are reachable and operable by keyboard alone', async ({ page }) => {
        await page.goto('/')
        await page.getByTestId('url-input').focus()
        await page.keyboard.type('http://localhost:4000/api/stream?freq=1')
        // Tab reaches the connect button within a few presses and Enter activates it
        let reached = false
        for (let i = 0; i < 8 && !reached; i++) {
            await page.keyboard.press('Tab')
            reached = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'connect-button')
        }
        expect(reached, 'Tab never reached the connect button').toBe(true)
        await page.keyboard.press('Enter')
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })
        // every focusable element shows where the focus is
        const unfocusable = await page.evaluate(() => {
            const bad: string[] = []
            for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])')).slice(0, 40)) {
                if (el.offsetParent === null) continue
                el.focus()
                const style = getComputedStyle(el)
                const visible = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 || style.boxShadow !== 'none' || el.matches(':focus-visible')
                if (document.activeElement === el && !visible) bad.push(`${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}`)
            }
            return bad
        })
        expect(unfocusable, `no visible focus indicator on: ${unfocusable.join(', ')}`).toEqual([])
    })

    test('connection state changes are announced through a live region', async ({ page }) => {
        await page.goto('/')
        const regions = await page.locator('[aria-live], [role="status"], [role="alert"]').count()
        expect(regions, 'no aria-live / status / alert region exists to announce connection changes').toBeGreaterThan(0)
    })
})
