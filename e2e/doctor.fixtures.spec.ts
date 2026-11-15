import { test, expect, type Page } from '@playwright/test'
import { startFixtureServer, type FixtureServer } from '../src/fixtures/server'
import { ageMs, connectDirect, eventCountOf, findingKeys, framesOf, healthStrip, msSinceLastWrite, openDoctor, startPlainServer, STREAM_HEAD, type PlainServer } from './support/doctorKit'

// Slice G (G1, G2, G5, G8): the Stream Doctor in a real browser against the fixture server, with the server's own log as the oracle.
// The server is started by this file. `scale` shortens the server's sleeps (events every 250 ms instead of 1 s) and nothing else:
// the Doctor still judges with its default thresholds. A test never waits for a fixed time: it waits for the server's log to show
// that enough has happened, and only then asserts that something is absent.

let fx: FixtureServer
let plain: PlainServer
test.beforeAll(async () => {
    fx = await startFixtureServer({ port: 0 })
    plain = await startPlainServer((_req, res) => { res.writeHead(200, STREAM_HEAD); res.flushHeaders() }) // headers, then nothing, ever
})
test.afterAll(async () => { await fx.close(); await plain.close() })

/** The connections a test opened on a route: only those after `before`, so a test never reads another test's log. */
const opened = (before: number, route: string) => fx.groundTruth.connections.slice(before).filter((c) => c.route === route)

async function waitForStatus(page: Page, text: string): Promise<void> {
    await expect.poll(async () => (await healthStrip(page))['Connection']?.value, { timeout: 30_000 }).toBe(text)
}

test.describe('G1: a stream that behaves in a known way is diagnosed the way the server says it behaved', () => {
    test('a healthy stream: open, the count is the server\'s, nothing is reported, and the checks that could not run are listed', async ({ page }) => {
        test.setTimeout(60_000)
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await connectDirect(page, fx.urlFor('h01', { scale: 0.25, n: 4000 }))
        await openDoctor(page)
        await expect.poll(() => opened(before, 'h01').length, { timeout: 10_000 }).toBe(1)
        const conn = opened(before, 'h01')[0]!

        // The silent twin (f04-silent at the same scale) is reported about 4 s in: 12 events, then a second of silence. Wait for 30 events.
        await expect.poll(() => framesOf(conn), { timeout: 30_000 }).toBeGreaterThanOrEqual(30)

        await expect(page.getByTestId('doctor-none')).toContainText('not proof')
        await expect(page.getByTestId('doctor-badge')).toHaveCount(0)
        expect(await findingKeys(page)).toEqual([])
        const strip = await healthStrip(page)
        expect(strip['Connection']?.value).toBe('open')
        expect(strip['Reconnects']?.value).toBe('0')
        // The page's count is never ahead of the server's, and is at most a few events behind it.
        const serverFrames = framesOf(conn)
        expect(eventCountOf(strip)).toBeLessThanOrEqual(serverFrames)
        expect(eventCountOf(strip)).toBeGreaterThanOrEqual(serverFrames - 4)
        const last = ageMs(strip['Last event']?.value ?? '')
        expect(last, `Last event: ${strip['Last event']?.value}`).toBeLessThan(2000)

        // Checks that had nothing to look at are named, not left out.
        await page.getByText(/What was checked/).click()
        const items = await page.locator('details', { hasText: 'What was checked' }).locator('li').allInnerTexts()
        expect(items.some((t) => t.includes('not evaluated')), items.join('\n')).toBe(true)
        expect(items.some((t) => /: checked/.test(t)), items.join('\n')).toBe(true)
    })

    test('a finished stream: the page counts exactly the events the server wrote, and says it ended', async ({ page }) => {
        test.setTimeout(60_000)
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await connectDirect(page, fx.urlFor('h01', { scale: 0.1, n: 15 }), { waitConnected: false })
        await openDoctor(page)
        await waitForStatus(page, 'ended')
        const conns = opened(before, 'h01')
        expect(conns).toHaveLength(1)
        expect(conns[0]!.endedBy).toBe('server-end')
        // 15 ticks and the `end` event the client stops on: the server's framer counts the same 16 complete events.
        expect(framesOf(conns[0]!)).toBe(16)
        expect(eventCountOf(await healthStrip(page))).toBe(16)
        expect(await findingKeys(page)).toEqual([])
    })

    test('silence after events: one finding, stall.silent:bytes, and the strip says bytes stopped', async ({ page }) => {
        test.setTimeout(60_000)
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await connectDirect(page, fx.urlFor('f04-silent', { scale: 0.25 }))
        await openDoctor(page)
        await expect(page.locator('[data-finding-key="stall.silent:bytes"]')).toBeVisible({ timeout: 30_000 })
        const [conn] = opened(before, 'f04-silent')
        // The server's log says what it did: 12 events, then not one byte, and the connection is still open.
        expect(framesOf(conn)).toBe(12)
        expect(conn!.endedBy).toBe('open')
        // Absence is only claimed once the silence has lasted three times the limit the finding needs (1 s).
        await expect.poll(() => msSinceLastWrite(conn!), { timeout: 15_000 }).toBeGreaterThan(3000)
        expect(await findingKeys(page)).toEqual(['stall.silent:bytes'])
        const strip = await healthStrip(page)
        expect(ageMs(strip['Last byte']?.value ?? '')).toBeGreaterThan(1000)
        expect(strip['Origin heartbeat']?.value).toBe('none seen')
        expect(eventCountOf(strip)).toBe(12)
    })

    test('heartbeats but no events: stall.silent:events, and the strip says bytes are still arriving', async ({ page }) => {
        test.setTimeout(60_000)
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await connectDirect(page, fx.urlFor('f04-heartbeats', { scale: 0.25 }))
        await openDoctor(page)
        await expect(page.locator('[data-finding-key="stall.silent:events"]')).toBeVisible({ timeout: 30_000 })
        const [conn] = opened(before, 'f04-heartbeats')
        expect(framesOf(conn)).toBe(12)
        // The server went on writing: more heartbeat writes after the last event than the finding needed seconds, then assert absence.
        await expect.poll(() => conn!.writes.length, { timeout: 15_000 }).toBeGreaterThan(12 + 12)
        expect(await findingKeys(page)).toEqual(['stall.silent:events'])
        const strip = await healthStrip(page)
        expect(ageMs(strip['Last byte']?.value ?? '')).toBeLessThan(1000) // a heartbeat every 250 ms
        expect(ageMs(strip['Last event']?.value ?? '')).toBeGreaterThan(1000)
        expect(strip['Origin heartbeat']?.value).toMatch(/^every ~\d+ ms$/)
    })

    test('headers and then nothing: stall.silent:no-bytes (with the silence the profile allows), and the strip has no byte to show', async ({ page }) => {
        test.setTimeout(60_000)
        // With no byte there is no rhythm to compare with; the default allowance is 30 s, so the profile says 1.5 s.
        await page.addInitScript(() => localStorage.setItem('sse.doctor.profile', JSON.stringify({ expected: { maxSilenceMs: 1500 } })))
        const before = plain.connections.length
        await page.goto('/')
        await connectDirect(page, `${plain.url}/nothing`)
        await openDoctor(page)
        await expect(page.locator('[data-finding-key="stall.silent:no-bytes"]')).toBeVisible({ timeout: 30_000 })
        const mine = plain.connections.slice(before)
        expect(mine).toHaveLength(1)
        expect(mine[0]!.writes, 'the server wrote nothing after the headers').toBe(0)
        expect(mine[0]!.closed).toBe(false)
        expect(await findingKeys(page)).toEqual(['stall.silent:no-bytes'])
        const strip = await healthStrip(page)
        expect(strip['Last byte']?.value).toBe('–')
        expect(strip['Last event']?.value).toBe('–')
        expect(eventCountOf(strip)).toBe(0)
    })
})

/** The timeline table as rows of cells: the connection label (the row heading), then the cells found by the heading above them. */
async function timelineRows(page: Page): Promise<Array<{ connection: string; retry: string; started: string; response: string; events: string; ended: string; resumedFrom: string }>> {
    return page.getByTestId('timeline-table').evaluate((table) => {
        const headings = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent ?? '')
        return Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
            const cells = [tr.querySelector('th')?.textContent ?? '', ...Array.from(tr.querySelectorAll('td')).map((td) => td.textContent ?? '')]
            const under = (heading: string): string => cells[headings.indexOf(heading)] ?? ''
            return { connection: under('Connection'), retry: under('Retry'), started: under('Started'), response: under('Response'), events: under('Events'), ended: under('Ended'), resumedFrom: under('Resumed from id') }
        })
    })
}

test.describe('G8: a stream that is dropped and resumed is shown the way the server logged it', () => {
    test('f05-drops: the attempts, what each resumed from, and how many events each carried are the server\'s', async ({ page }) => {
        test.setTimeout(90_000)
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await connectDirect(page, fx.urlFor('f05-drops', { scale: 0.25 }), { waitConnected: false })
        await openDoctor(page)
        await waitForStatus(page, 'ended')
        const conns = opened(before, 'f05-drops')
        // What the server did: four connections, each resuming after the id the last one reached; the last one ends the stream.
        expect(conns).toHaveLength(4)
        expect(fx.groundTruth.lastEventIdHeaders('f05-drops').slice(-4)).toEqual(['', '3', '6', '9'])
        expect(conns.map((c) => c.endedBy)).toEqual(['server-end', 'server-end', 'server-end', 'server-end'])

        const strip = await healthStrip(page)
        expect(strip['Reconnects']?.value).toBe(String(conns.length - 1))

        await page.getByTestId('doctor-tab-timeline').click()
        const rows = await timelineRows(page)
        // Q18 (decided): a row is labelled by the connection it is, in order. This pin used to record the old label, the client's retry
        // counter, which starts again after each connection that opened ('#1', '#2', '#2', '#2'); it is now '#1' to '#4', and the counter
        // has its own column (0, then 1 each time: each reconnect was the first retry after a connection that had opened).
        expect(rows.map((r) => r.connection)).toEqual(['#1', '#2', '#3', '#4'])
        expect(rows.map((r) => r.retry)).toEqual(['0', '1', '1', '1'])
        // The Nth row is the Nth connection the server saw: its own log gives the id each request carried, and the events it wrote, in order.
        expect(rows.map((r) => (r.resumedFrom === '–' ? '' : r.resumedFrom))).toEqual(fx.groundTruth.lastEventIdHeaders('f05-drops').slice(-4))
        expect(rows.map((r) => r.resumedFrom)).toEqual(['–', '3', '6', '9'])
        expect(rows.map((r) => Number(r.events))).toEqual(conns.map((c) => framesOf(c)))
        expect(rows.every((r) => r.response.startsWith('200'))).toBe(true)

        // The finding: the same number of connections, and a warning (the stream made progress between drops), not an error.
        await page.getByTestId('doctor-tab-findings').click()
        const loop = page.locator('[data-finding-key="reconnect.loop"]')
        await expect(loop).toBeVisible()
        await expect(loop).toContainText('Connection keeps dropping and reconnecting')
        await expect(loop).toContainText(`${conns.length} connections were opened within`)
        expect(await findingKeys(page)).toEqual(['reconnect.loop'])
    })

    test('f05-drops with ?ignore=1: the server restarts from id 1 although each request carried the id it had reached, and the Doctor says so', async ({ page }) => {
        test.setTimeout(90_000)
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await connectDirect(page, fx.urlFor('f05-drops', { scale: 0.25, ignore: 1 }))
        await openDoctor(page)
        // Three reconnects that carried the id of the connection before and were answered from the start.
        const restarted = () => opened(before, 'f05-drops').slice(1).filter((c) => c.requestHeaders['last-event-id'] === '3' && c.writes.length > 0 && frameLog0(c) === '1')
        await expect.poll(() => restarted().length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
        const finding = page.locator('[data-finding-key="resume.last-event-id:ignored"]')
        await expect(finding).toBeVisible({ timeout: 30_000 })
        await page.getByRole('button', { name: 'Stop' }).click()
        // After the stop the log and the page are both final: the finding counts the reconnects the server restarted.
        const claimed = async () => Number(/After (\d+) reconnects? that sent a Last-Event-ID/.exec(await finding.innerText())?.[1] ?? -1)
        await expect.poll(claimed, { timeout: 15_000 }).toBeLessThanOrEqual(restarted().length)
        expect(await claimed()).toBeGreaterThanOrEqual(restarted().length - 1)
        expect(await claimed()).toBeGreaterThanOrEqual(2)
        // Every request after the first carried the id the connection before had reached (3), as the log shows: that is what the finding rests on.
        for (const c of opened(before, 'f05-drops').slice(1)) expect(c.requestHeaders['last-event-id']).toBe('3')
    })
})

/** The id of the first event the server wrote on a connection (its own framer, not the page's). */
function frameLog0(c: Parameters<typeof framesOf>[0]): string {
    return c.writes.length === 0 ? '' : (c.writes.map((w) => w.text).join('').match(/^id: (\S+)/m)?.[1] ?? '')
}

test.describe('G2: two tabs on the same stream share one connection', () => {
    test('one connection in the server log for two tabs; it outlives the second tab and ends after the last one', async ({ page, context }) => {
        test.setTimeout(180_000)
        const before = fx.groundTruth.connections.length
        const url = fx.urlFor('h01', { scale: 0.25, n: 100_000 })
        await page.goto('/')
        await connectDirect(page, url)
        await openDoctor(page)
        const second = await context.newPage()
        await second.goto('/')
        await connectDirect(second, url)
        await openDoctor(second)

        const conns = opened(before, 'h01')
        expect(conns, 'two tabs, one request').toHaveLength(1)
        const conn = conns[0]!
        // Both tabs show the stream live and counting. (Both are ahead of zero and follow the same server frames.)
        const countIn = async (p: Page) => eventCountOf(await healthStrip(p))
        const mark = framesOf(conn)
        await expect.poll(() => framesOf(conn), { timeout: 30_000 }).toBeGreaterThan(mark + 8)
        for (const p of [page, second]) {
            await expect.poll(() => countIn(p), { timeout: 15_000 }).toBeGreaterThan(8)
            expect((await healthStrip(p))['Connection']?.value).toBe('open')
        }
        expect(opened(before, 'h01'), 'still one connection after a while').toHaveLength(1)

        // Closing the second tab does not stop the stream, and the first tab goes on counting.
        await second.close()
        const firstCount = await countIn(page)
        const written = framesOf(conn)
        await expect.poll(() => framesOf(conn), { timeout: 15_000 }).toBeGreaterThan(written + 8)
        await expect.poll(() => countIn(page), { timeout: 15_000 }).toBeGreaterThan(firstCount + 8)
        expect(conn.endedBy).toBe('open')
        expect(opened(before, 'h01')).toHaveLength(1)

        // Closing the last tab ends the connection. How long that takes is measured and printed: the tab cannot tell the worker it
        // left, so the worker finds out by itself.
        const closedAt = Date.now()
        await page.close()
        await expect.poll(() => conn.endedBy, { timeout: 150_000, intervals: [500] }).toBe('client-closed')
        console.log(`G2: the server saw the connection close ${((Date.now() - closedAt) / 1000).toFixed(1)} s after the last tab closed`)
        expect(opened(before, 'h01')).toHaveLength(1)
    })

    test('both tabs show the same finding from the one connection', async ({ page, context }) => {
        test.setTimeout(90_000)
        const before = fx.groundTruth.connections.length
        const url = fx.urlFor('f04-silent', { scale: 0.25 })
        await page.goto('/')
        await connectDirect(page, url)
        await openDoctor(page)
        const second = await context.newPage()
        await second.goto('/')
        await connectDirect(second, url)
        await openDoctor(second)
        for (const p of [page, second]) await expect(p.locator('[data-finding-key="stall.silent:bytes"]')).toBeVisible({ timeout: 30_000 })
        expect(opened(before, 'f04-silent')).toHaveLength(1)
        await expect.poll(() => msSinceLastWrite(opened(before, 'f04-silent')[0]!), { timeout: 15_000 }).toBeGreaterThan(3000)
        for (const p of [page, second]) expect(await findingKeys(p)).toEqual(['stall.silent:bytes'])
    })
})

test.describe('G5: lanes are judged one at a time', () => {
    test('a stalled lane, a healthy lane and a dropping lane: each card has its own findings, and removing a lane leaves the others as they were', async ({ page }) => {
        test.setTimeout(120_000)
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await page.getByRole('button', { name: 'Multi-Stream', exact: true }).click()
        const lanes = [
            ['stalled', fx.urlFor('f04-silent', { scale: 0.25 }), 'f04-silent'],
            ['healthy', fx.urlFor('h01', { scale: 0.25, n: 100_000 }), 'h01'],
            ['dropping', fx.urlFor('f05-drops', { scale: 0.25 }), 'f05-drops'],
        ] as const
        for (const [name, url] of lanes) {
            await page.getByLabel('Stream name').fill(name)
            await page.getByLabel('Stream URL').fill(url)
            await page.getByRole('button', { name: 'Add', exact: true }).click()
        }
        // each click turns that lane's button into Disconnect, so the next lane's is the first Connect again
        for (const [, , route] of lanes) {
            await page.getByRole('button', { name: 'Connect', exact: true }).first().click()
            await expect.poll(() => opened(before, route).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
        }
        await openDoctor(page)
        const card = (name: string) => page.getByRole('region', { name: `Doctor: ${name}` })
        const keysOf = (name: string) => card(name).locator('[data-finding-key]').evaluateAll((els) => els.map((e) => e.getAttribute('data-finding-key') ?? ''))
        await expect(page.getByTestId('doctor-lanes').getByTestId('doctor-panel')).toHaveCount(3)

        // The stalled lane is reported, and the dropping lane has its loop; neither says anything about the other.
        await expect(card('stalled').locator('[data-finding-key^="stall.silent"]').first()).toBeVisible({ timeout: 40_000 })
        await expect(card('dropping').locator('[data-finding-key="reconnect.loop"]')).toBeVisible({ timeout: 60_000 })
        // The healthy lane is only judged absent once the server has written far more than the stalled lane needed to be reported.
        const healthy = opened(before, 'h01')[0]!
        await expect.poll(() => framesOf(healthy), { timeout: 30_000 }).toBeGreaterThanOrEqual(30)
        expect(await keysOf('healthy')).toEqual([])
        expect(await keysOf('stalled')).toEqual(expect.arrayContaining(['stall.silent:bytes']))
        expect((await keysOf('stalled')).every((k) => k.startsWith('stall.silent'))).toBe(true)
        expect(await keysOf('dropping')).toEqual(['reconnect.loop'])
        // The worst lane is listed first.
        await expect(page.getByTestId('doctor-lanes').getByTestId('doctor-panel').first()).toContainText('Doctor: ')

        // Remove the stalled lane: its connection is closed (the server's log says so), the other two keep their state.
        const stalledConn = opened(before, 'f04-silent')[0]!
        await page.getByRole('button', { name: 'Remove stream' }).first().click()
        await expect(page.getByTestId('doctor-lanes').getByTestId('doctor-panel')).toHaveCount(2)
        await expect(card('stalled')).toHaveCount(0)
        await expect.poll(() => stalledConn.endedBy, { timeout: 15_000 }).toBe('client-closed')
        expect(await keysOf('healthy')).toEqual([])
        expect(await keysOf('dropping')).toEqual(['reconnect.loop'])
        expect(healthy.endedBy).toBe('open')
    })
})
