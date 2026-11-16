import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'

// A long soak on a continuous stream: does memory, the DOM, and the number of listeners stay bounded?
//
// Every 30 seconds the page's garbage is collected (CDP HeapProfiler.collectGarbage), so the heap figure is what is still held, not what
// has not been swept yet. Garbage collection timing is why the old version could only assert "under 1.5 GB". After a warm-up (the stores
// fill to their caps first), the heap should be flat: the fitted slope of the held heap over the run must stay under a small limit, and
// the DOM node count and the listener count must not keep climbing.
//
// Environment:
//   SOAK_MINUTES   length (default 1 in CI, 10 locally; the scheduled "Performance" workflow runs 30)
//   SOAK_FREQ      events per second the stream sends (default 200)
//   SOAK_OUT       a file to write the samples and the verdict to, as JSON

const SAMPLE_MS = 30_000
const WARMUP_MS = 5 * 60_000
/** Held heap growth allowed after the warm-up, in MB per minute. A leak of one small object per event would be far above it at 200 events/s. */
const MAX_SLOPE_MB_PER_MIN = 0.5

/** Least-squares slope of y over x. */
function slope(points: Array<{ x: number; y: number }>): number {
    const n = points.length
    if (n < 2) return 0
    const mx = points.reduce((a, p) => a + p.x, 0) / n
    const my = points.reduce((a, p) => a + p.y, 0) / n
    const num = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0)
    const den = points.reduce((a, p) => a + (p.x - mx) ** 2, 0)
    return den === 0 ? 0 : num / den
}

test.describe('Soak Testing', () => {
    test('handles a continuous stream for an extended duration with a flat heap, DOM and listener count', async ({ page }) => {
        const soakMinutes = Number(process.env.SOAK_MINUTES) || (process.env.CI ? 1 : 10)
        const freq = Number(process.env.SOAK_FREQ) || 200
        test.setTimeout((soakMinutes + 5) * 60 * 1000) // the soak itself plus five minutes

        await page.goto('/')
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Performance.enable')

        // /load-stream ends after 10,000 events, which a soak must not rely on; /api/stream does not end.
        await page.fill('input[placeholder*="https://api.example.com/sse"]', `http://localhost:4000/api/stream?freq=${freq}`)
        await page.getByRole('button', { name: 'Connect', exact: true }).click()
        await expect(page.locator('text=Connected').first()).toBeVisible({ timeout: 10000 })
        console.log(`Soak: ${soakMinutes} min at ${freq} events/s. Stream connected.`)

        const samples: Array<{ minute: number; heapMB: number; nodes: number; listeners: number }> = []
        const iterations = Math.floor((soakMinutes * 60_000) / SAMPLE_MS)
        const started = Date.now()

        for (let i = 0; i < iterations; i++) {
            await page.waitForTimeout(SAMPLE_MS)
            await expect(page.locator('text=Connected').first()).toBeVisible()
            expect(await page.locator('.animate-slide-up').count()).toBeGreaterThan(0) // the list is alive and showing rows

            await cdp.send('HeapProfiler.collectGarbage')
            const { metrics } = await cdp.send('Performance.getMetrics')
            const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
            const sample = { minute: Math.round(((Date.now() - started) / 60_000) * 100) / 100, heapMB: Math.round(((m.JSHeapUsedSize ?? 0) / 1e6) * 10) / 10, nodes: m.Nodes ?? 0, listeners: m.JSEventListeners ?? 0 }
            samples.push(sample)
            console.log(`[Soak ${i + 1}/${iterations}] t=${sample.minute} min  held heap ${sample.heapMB} MB  DOM nodes ${sample.nodes}  listeners ${sample.listeners}`)
            expect(sample.heapMB).toBeLessThan(1500) // a hard stop long before the browser would die
        }

        // The verdict, from the samples after the warm-up (or, in a run shorter than the warm-up, the second half, which is only indicative).
        const warmMin = soakMinutes * 60_000 > 2 * WARMUP_MS ? WARMUP_MS / 60_000 : soakMinutes / 2
        const settled = samples.filter((s) => s.minute >= warmMin)
        const heapSlope = slope(settled.map((s) => ({ x: s.minute, y: s.heapMB })))
        const first = settled[0]
        const last = settled.at(-1)
        const verdict = {
            minutes: soakMinutes,
            eventsPerSecond: freq,
            warmUpMinutes: warmMin,
            samples: samples.length,
            heapSlopeMBPerMin: Math.round(heapSlope * 1000) / 1000,
            limitMBPerMin: MAX_SLOPE_MB_PER_MIN,
            heapMB: { min: Math.min(...samples.map((s) => s.heapMB)), max: Math.max(...samples.map((s) => s.heapMB)), last: samples.at(-1)?.heapMB },
            nodes: { first: first?.nodes, last: last?.nodes },
            listeners: { first: first?.listeners, last: last?.listeners },
            indicativeOnly: soakMinutes * 60_000 <= 2 * WARMUP_MS,
        }
        console.log('Soak verdict: ' + JSON.stringify(verdict))
        if (process.env.SOAK_OUT) writeFileSync(process.env.SOAK_OUT, JSON.stringify({ verdict, samples }, null, 2))

        // A run shorter than twice the warm-up is still filling the stores' caps (the heap rises for the first few minutes by design), so
        // its slope says nothing about a leak: it is reported, not asserted. The scheduled 30-minute run is the gate.
        if (verdict.indicativeOnly) return
        expect(settled.length, 'enough samples after the warm-up to fit a slope').toBeGreaterThanOrEqual(2)
        expect(heapSlope, `held heap grew ${verdict.heapSlopeMBPerMin} MB/min after the warm-up`).toBeLessThan(MAX_SLOPE_MB_PER_MIN)
        if (first && last) {
            // Bounded, not exactly constant: a list that is capped holds a roughly constant number of nodes and listeners.
            expect(last.nodes, 'DOM nodes kept climbing').toBeLessThan(first.nodes * 1.25 + 500)
            expect(last.listeners, 'event listeners kept climbing').toBeLessThan(first.listeners * 1.25 + 100)
        }
    })
})
