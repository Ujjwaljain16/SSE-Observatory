import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from '@playwright/test'
import { connectDirect, openDoctor } from './support/doctorKit'
import { describeTargets, smallTargets } from './support/targetSize'

// WCAG 2.2 criterion 2.5.8 (Target Size, Minimum, AA): every button, link, input and tab is at least 24 by 24 CSS pixels, measured at the
// width of a phone (360 px). Issue 82 found 25 that were not. The measurement is in support/targetSize.ts.

let server: http.Server
let base = ''
test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }
        if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
        res.writeHead(200, headers)
        let n = 0
        const timer = setInterval(() => res.write(`id: ${n}\nevent: tick\ndata: {"n":${n++},"user":{"name":"ada"}}\n\n`), 200)
        req.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => { server.closeAllConnections(); server.close() })

test.describe('Target size at 360 px', () => {
    test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.setViewportSize({ width: 360, height: 740 })
        await page.goto('/')
        await expect(page.getByTestId('url-input')).toBeVisible()
    })

    test('every target on the landing page is at least 24 by 24', async ({ page }) => {
        const small = await smallTargets(page)
        expect(small, `smaller than 24x24:\n${describeTargets(small)}`).toEqual([])
    })

    test('every target is at least 24 by 24 with a stream connected and the Doctor open', async ({ page }) => {
        await connectDirect(page, `${base}/s`)
        await expect(page.getByTestId('event-row').first()).toBeVisible()
        await openDoctor(page)
        const small = await smallTargets(page)
        expect(small, `smaller than 24x24:\n${describeTargets(small)}`).toEqual([])
    })

    test('and in the panels that are opened from the toolbar, a saved profile, the Doctor tabs and an interceptor', async ({ page }) => {
        test.setTimeout(90_000)
        // a saved profile has a delete button
        await page.getByTestId('url-input').fill(`${base}/s`)
        await page.getByRole('button', { name: 'Save profile' }).click()
        await page.getByLabel('Profile name').fill('local')
        await page.getByRole('dialog', { name: 'Save profile' }).getByRole('button', { name: 'Save' }).click()
        await expect(page.getByRole('tab', { name: 'local' })).toBeVisible()
        await connectDirect(page, `${base}/s`)
        await expect(page.getByTestId('event-row').first()).toBeVisible()

        const found: string[] = []
        const check = async (label: string) => {
            const small = await smallTargets(page)
            if (small.length > 0) found.push(`${label}:\n${describeTargets(small)}`)
        }
        for (const name of ['Stats', 'Schema', 'Patterns', 'Interceptors']) {
            await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
            await check(`${name} open`)
        }
        await page.getByRole('button', { name: /^Add$/ }).first().click() // an interceptor, with its switch and remove button
        await check('an interceptor added')
        await openDoctor(page)
        for (const tab of await page.getByRole('tab').allInnerTexts()) {
            const name = tab.trim()
            if (name === 'local') continue
            await page.getByRole('tab', { name }).first().click()
            await check(`Doctor tab ${name}`)
        }
        expect(found, found.join('\n')).toEqual([])
    })
})
