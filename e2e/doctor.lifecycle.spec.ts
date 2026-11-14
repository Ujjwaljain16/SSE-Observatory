import { test, expect, type Page } from '@playwright/test'
import { startFixtureServer, type FixtureServer } from '../src/fixtures/server'
import { connectDirect, framesOf, healthStrip, openDoctor } from './support/doctorKit'

// G4: the Doctor opens and closes without leaving anything behind. An init script wraps setInterval, setTimeout, clearInterval,
// clearTimeout, addEventListener and removeEventListener before the app loads, so the page can say how many timers and listeners are
// alive. The Doctor and its export dialog are opened and closed many times while events stream; the counts afterwards must be the counts
// from before, give or take a small constant, and the stream must have gone on meanwhile.

let fx: FixtureServer
test.beforeAll(async () => { fx = await startFixtureServer({ port: 0 }) })
test.afterAll(async () => { await fx.close() })

interface Counts { timeouts: number; intervals: number; listeners: number; nodes: number; byListener: Record<string, number> }

/** Installed before any page script runs. `window.__live()` reads the counts. */
function installCounters(): void {
    const w = window as unknown as Record<string, unknown> & typeof globalThis
    const timeouts = new Set<unknown>()
    const intervals = new Set<unknown>()
    const rawSetTimeout = w.setTimeout.bind(w) as (...a: unknown[]) => unknown
    const rawSetInterval = w.setInterval.bind(w) as (...a: unknown[]) => unknown
    const rawClearTimeout = w.clearTimeout.bind(w) as (id: unknown) => void
    const rawClearInterval = w.clearInterval.bind(w) as (id: unknown) => void
    w.setTimeout = ((fn: unknown, ms?: unknown, ...rest: unknown[]) => {
        if (typeof fn !== 'function') return rawSetTimeout(fn, ms, ...rest)
        const id: unknown = rawSetTimeout(function (this: unknown, ...args: unknown[]) { timeouts.delete(id); return (fn as (...a: unknown[]) => unknown).apply(this, args) }, ms, ...rest)
        timeouts.add(id)
        return id
    }) as typeof setTimeout
    w.setInterval = ((fn: unknown, ms?: unknown, ...rest: unknown[]) => {
        const id = rawSetInterval(fn, ms, ...rest)
        if (typeof fn === 'function') intervals.add(id)
        return id
    }) as typeof setInterval
    // the two clear functions clear either kind of timer, as in the browser
    w.clearTimeout = ((id?: unknown) => { timeouts.delete(id); intervals.delete(id); rawClearTimeout(id) }) as typeof clearTimeout
    w.clearInterval = ((id?: unknown) => { timeouts.delete(id); intervals.delete(id); rawClearInterval(id) }) as typeof clearInterval

    // listener -> counted once per (target, type, capture), as the DOM itself treats a duplicate
    const registry = new Map<EventTarget, Map<string, Set<unknown>>>()
    const slot = (type: string, options: unknown): string => `${type}|${(typeof options === 'boolean' ? options : !!(options as { capture?: boolean } | undefined)?.capture) ? 'capture' : 'bubble'}`
    const rawAdd = EventTarget.prototype.addEventListener
    const rawRemove = EventTarget.prototype.removeEventListener
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
        const o = options as { once?: boolean; signal?: unknown } | boolean | undefined
        // A listener that removes itself (once) or goes with a signal is not one that has to be removed by hand.
        const selfRemoving = typeof o === 'object' && o !== null && (o.once === true || o.signal !== undefined)
        if (listener && !selfRemoving) {
            let byKey = registry.get(this)
            if (!byKey) { byKey = new Map(); registry.set(this, byKey) }
            const key = slot(type, options)
            let set = byKey.get(key)
            if (!set) { set = new Set(); byKey.set(key, set) }
            set.add(listener)
        }
        return rawAdd.call(this, type, listener as EventListenerOrEventListenerObject, options as AddEventListenerOptions)
    }
    EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
        registry.get(this)?.get(slot(type, options))?.delete(listener)
        return rawRemove.call(this, type, listener as EventListenerOrEventListenerObject, options as EventListenerOptions)
    }
    const name = (t: EventTarget): string => (t === w ? 'window' : t === document ? 'document' : t instanceof Element ? t.tagName.toLowerCase() : (t as object).constructor?.name ?? 'target')
    w['__live'] = (): Counts => {
        let listeners = 0
        const byListener: Record<string, number> = {}
        for (const [target, byKey] of registry) {
            if (target instanceof Node && !target.isConnected) continue // listeners go with a node that has left the page
            for (const [key, set] of byKey) {
                listeners += set.size
                if (set.size > 0) byListener[`${name(target)} ${key}`] = (byListener[`${name(target)} ${key}`] ?? 0) + set.size
            }
        }
        return { timeouts: timeouts.size, intervals: intervals.size, listeners, nodes: document.getElementsByTagName('*').length, byListener }
    }
}

const live = (page: Page): Promise<Counts> => page.evaluate(() => (window as unknown as { __live: () => Counts }).__live())

async function openAndCloseOnce(page: Page): Promise<void> {
    await page.getByTestId('doctor-toggle').click()
    await expect(page.getByTestId('doctor-panel')).toBeVisible()
    await page.getByTestId('doctor-export').click()
    await expect(page.getByTestId('export-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('export-dialog')).toHaveCount(0)
    await page.getByTestId('doctor-tab-timeline').click()
    await expect(page.getByTestId('doctor-timeline')).toBeVisible()
    await page.getByTestId('doctor-toggle').click()
    await expect(page.getByTestId('doctor-panel')).toHaveCount(0)
}

/** The number in the connection panel's "N events". */
const rowCount = (page: Page): Promise<number> => page.evaluate(() => Number(/([\d,]+) events/.exec(document.body.innerText)?.[1]?.replace(/,/g, '') ?? -1))

test.describe('G4: the Doctor leaves nothing behind', () => {
    test.beforeEach(async ({ page }) => { await page.addInitScript(installCounters) })

    test('the counters can fail: a timer, an interval and a listener that are not cleaned up are seen, and the ones that are cleaned up are not', async ({ page }) => {
        await page.goto('/')
        const before = await live(page)
        await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>
            const handler = () => undefined
            window.addEventListener('resize', handler)
            window.addEventListener('resize', handler) // the same listener twice is one
            const interval = setInterval(() => undefined, 60_000)
            const timeout = setTimeout(() => undefined, 60_000)
            w['__test'] = { handler, interval, timeout }
        })
        const during = await live(page)
        expect(during.listeners - before.listeners).toBe(1)
        expect(during.intervals - before.intervals).toBe(1)
        expect(during.timeouts - before.timeouts).toBe(1)
        await page.evaluate(() => {
            const t = (window as unknown as { __test: { handler: () => void; interval: number; timeout: number } }).__test
            window.removeEventListener('resize', t.handler)
            clearInterval(t.interval)
            clearTimeout(t.timeout)
        })
        const after = await live(page)
        expect([after.listeners, after.intervals, after.timeouts]).toEqual([before.listeners, before.intervals, before.timeouts])
    })

    test('twenty times open the Doctor, its export dialog and a tab, and close them, while events stream: the counts come back', async ({ page }) => {
        test.setTimeout(180_000)
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await connectDirect(page, fx.urlFor('h01', { scale: 0.25, n: 100_000 }))
        const conn = fx.groundTruth.connections.slice(before).filter((c) => c.route === 'h01')[0]!
        await expect.poll(() => framesOf(conn), { timeout: 15_000 }).toBeGreaterThanOrEqual(6)

        const start = await live(page)
        const rowsAtStart = await rowCount(page)
        const framesAtStart = framesOf(conn)
        await openAndCloseOnce(page)
        // After the first round everything the Doctor sets up once (its lazily loaded parts, its stores) is in place.
        const afterFirst = await live(page)
        for (let i = 1; i < 20; i++) await openAndCloseOnce(page)

        // The counts settle: a timer that is only waiting for its turn goes, one that was leaked does not.
        const settled = async (limit: { timeouts: number; intervals: number; listeners: number }): Promise<Counts> => {
            let last = await live(page)
            try {
                await expect.poll(async () => {
                    last = await live(page)
                    return last.listeners <= limit.listeners && last.intervals <= limit.intervals && last.timeouts <= limit.timeouts
                }, { timeout: 10_000 }).toBe(true)
            } catch (err) {
                throw new Error(`live counts never came back to ${JSON.stringify(limit)}; last ${JSON.stringify({ timeouts: last.timeouts, intervals: last.intervals, listeners: last.listeners })}\nlisteners now ${JSON.stringify(last.byListener)}\nbefore ${JSON.stringify(start.byListener)}`, { cause: err })
            }
            return last
        }
        // Twenty rounds add nothing to what one round left (a constant of 2 timers for ones that are in flight).
        const end = await settled({ timeouts: afterFirst.timeouts + 2, intervals: afterFirst.intervals, listeners: afterFirst.listeners })
        // And what is left of the first round is a small constant over the page as it was before the Doctor was ever opened.
        expect(end.listeners - start.listeners, `listeners: before ${JSON.stringify(start.byListener)} after ${JSON.stringify(end.byListener)}`).toBeLessThanOrEqual(2)
        expect(end.intervals - start.intervals).toBeLessThanOrEqual(1)
        expect(end.timeouts - start.timeouts).toBeLessThanOrEqual(4)

        // The stream went on the whole time, and the page took the events in.
        expect(framesOf(conn)).toBeGreaterThan(framesAtStart + 8)
        await expect.poll(() => rowCount(page), { timeout: 15_000 }).toBeGreaterThan(rowsAtStart + 8)
        expect(conn.endedBy).toBe('open')
    })

    test('resizing with the Doctor open, and opening and closing it again, adds no listener or timer', async ({ page }) => {
        test.setTimeout(90_000)
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await connectDirect(page, fx.urlFor('h01', { scale: 0.25, n: 100_000 }))
        await openDoctor(page)
        const conn = fx.groundTruth.connections.slice(before).filter((c) => c.route === 'h01')[0]!
        await expect.poll(() => framesOf(conn), { timeout: 15_000 }).toBeGreaterThanOrEqual(6)
        const start = await live(page)
        for (const [width, height] of [[1280, 900], [800, 700], [390, 800], [1024, 600], [1280, 900]] as const) {
            await page.setViewportSize({ width, height })
            await expect(page.getByTestId('doctor-panel')).toBeVisible()
        }
        await expect.poll(async () => { const c = await live(page); return c.listeners <= start.listeners && c.intervals <= start.intervals }, { timeout: 10_000 }).toBe(true)
    })

    test('a reload while a stream is being diagnosed starts clean: no finding from the stream that was open before', async ({ page }) => {
        test.setTimeout(90_000)
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await connectDirect(page, fx.urlFor('f04-silent', { scale: 0.25 }))
        await openDoctor(page)
        await expect(page.locator('[data-finding-key="stall.silent:bytes"]')).toBeVisible({ timeout: 30_000 })
        await page.reload()
        await openDoctor(page)
        await expect(page.getByTestId('doctor-empty')).toBeVisible()
        await expect(page.getByTestId('doctor-badge')).toHaveCount(0)
        // A different healthy stream: nothing from the first one is in its diagnosis, once the server has written more than the silent one needed.
        await page.getByTestId('doctor-toggle').click()
        await connectDirect(page, fx.urlFor('h01', { scale: 0.25, n: 100_000 }))
        const healthy = fx.groundTruth.connections.slice(before).filter((c) => c.route === 'h01')[0]!
        await expect.poll(() => framesOf(healthy), { timeout: 30_000 }).toBeGreaterThanOrEqual(30)
        await openDoctor(page)
        await expect(page.getByTestId('doctor-none')).toBeVisible()
        await expect(page.getByTestId('doctor-badge')).toHaveCount(0)
        expect((await healthStrip(page))['Connection']?.value).toBe('open')
    })
})

test.describe('G4: the browser agrees (Chrome\'s own counters)', () => {
    test('event listeners and DOM nodes after twenty rounds are within 5% (+ a small constant) of before', async ({ page }) => {
        test.setTimeout(180_000)
        const before = fx.groundTruth.connections.length
        await page.goto('/')
        await connectDirect(page, fx.urlFor('h01', { scale: 0.25, n: 100_000 }))
        const conn = fx.groundTruth.connections.slice(before).filter((c) => c.route === 'h01')[0]!
        await expect.poll(() => framesOf(conn), { timeout: 15_000 }).toBeGreaterThanOrEqual(6)
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Performance.enable')
        const metrics = async (): Promise<{ listeners: number; nodes: number }> => {
            await cdp.send('HeapProfiler.collectGarbage')
            const { metrics: list } = await cdp.send('Performance.getMetrics')
            const get = (name: string) => list.find((m) => m.name === name)?.value ?? NaN
            return { listeners: get('JSEventListeners'), nodes: get('Nodes') }
        }
        await openAndCloseOnce(page) // the Doctor's parts load once
        const start = await metrics()
        expect(Number.isFinite(start.listeners) && Number.isFinite(start.nodes), `Performance.getMetrics gave ${JSON.stringify(start)}`).toBe(true)
        for (let i = 0; i < 20; i++) await openAndCloseOnce(page)
        let end = await metrics()
        try {
            await expect.poll(async () => { end = await metrics(); return end.listeners <= start.listeners * 1.05 + 10 && end.nodes <= start.nodes * 1.05 + 50 }, { timeout: 15_000 }).toBe(true)
        } catch (err) {
            throw new Error(`Chrome's counters did not come back: start ${JSON.stringify(start)} end ${JSON.stringify(end)}`, { cause: err })
        }
    })
})
