import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'

// The failure lab, against the captures that ship in public/lab. No stream is connected: the Doctor reads recordings of the built-in
// faulty and healthy streams.

test.describe('Failure lab', () => {
    async function toLab(page: Page) {
        await page.goto('/')
        await page.getByTestId('url-input').fill('http://127.0.0.1:1/never')
        await page.getByTestId('connect-button').click()
        await page.getByTestId('doctor-toggle').click()
        await page.getByTestId('doctor-tab-captures').click()
        await page.getByText('Failure lab').click()
        await expect(page.getByTestId('lab-entry').first()).toBeVisible({ timeout: 10_000 })
    }

    test('lists the built-in fixtures, and what could not be shown and why', async ({ page }) => {
        test.setTimeout(60_000)
        await toLab(page)
        expect(await page.getByTestId('lab-entry').count()).toBeGreaterThanOrEqual(20)
        await expect(page.locator('[data-testid="lab-entry"][data-id="f04-silent"]')).toBeVisible()
        await page.getByText(/Not in the lab/).click()
        await expect(page.getByTestId('lab-skipped')).toContainText('f10-steady')
    })

    test('runs the Doctor on a stream that goes silent, and it finds the silence the stream was built to show', async ({ page }) => {
        test.setTimeout(60_000)
        await toLab(page)
        await page.getByRole('button', { name: 'Run the Doctor on f04-silent' }).click()
        const result = page.getByTestId('lab-result')
        await expect(result.getByTestId('lab-verdict')).toContainText('found what this stream was built to show')
        await expect(result.getByTestId('lab-expectations')).toContainText('Expected stall.silent:bytes: found')
        await expect(result.locator('[data-testid="doctor-finding"][data-finding-key^="stall.silent"]')).toBeVisible()
    })

    test('its healthy twin has no findings, and the lab says that is not proof of health', async ({ page }) => {
        test.setTimeout(60_000)
        await toLab(page)
        await page.getByRole('button', { name: 'Run the Doctor on f04-silent' }).click()
        await page.getByTestId('lab-twin').click()
        const result = page.getByTestId('lab-result')
        await expect(result.getByTestId('lab-expectations')).toContainText('none appeared')
        await expect(result).toContainText('No findings.')
    })

    test('a schema-drift stream shows the change of format, and the buffering pair differs the way they should', async ({ page }) => {
        test.setTimeout(60_000)
        await toLab(page)
        await page.getByRole('button', { name: 'Run the Doctor on f11-drift' }).click()
        await expect(page.getByTestId('lab-result').locator('[data-finding-key="schema.drift:order"]')).toBeVisible()
        await page.getByRole('button', { name: 'Run the Doctor on f03-buffered' }).click()
        await expect(page.getByTestId('lab-result').locator('[data-finding-key^="delivery.bursty"]')).toBeVisible()
    })

    test('saves a lab capture to the library', async ({ page }) => {
        test.setTimeout(60_000)
        await toLab(page)
        await page.getByRole('button', { name: 'Run the Doctor on f05-drops' }).click()
        await page.getByTestId('lab-save').click()
        await expect(page.getByTestId('lab-notice')).toContainText('Saved "Lab: f05-drops"')
        await expect(page.getByTestId('capture-list')).toContainText('Lab: f05-drops')
    })

    test('has no accessibility violations with a result open', async ({ page }) => {
        test.setTimeout(60_000)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await toLab(page)
        await page.getByRole('button', { name: 'Run the Doctor on f04-silent' }).click()
        await expect(page.getByTestId('lab-result')).toBeVisible()
        const results = await new AxeBuilder({ page }).include('[data-testid="failure-lab"]').analyze()
        expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    })
})

