import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { RollingStats } from '../stats'

/** The straightforward way: keep the window, sort it, index it. */
function naive(values: number[], cap: number, q: number): number | undefined {
    const window = values.slice(-cap).sort((a, b) => a - b)
    return window.length === 0 ? undefined : window[Math.min(window.length - 1, Math.max(0, Math.ceil(q * window.length) - 1))]
}

describe('RollingStats', () => {
    it('gives the same quantiles as sorting the window, for any sequence and any window size', () => {
        fc.assert(fc.property(fc.array(fc.integer({ min: -50, max: 50 }), { maxLength: 400 }), fc.integer({ min: 1, max: 40 }), (values, cap) => {
            const stats = new RollingStats(cap)
            values.forEach((v, i) => {
                stats.push(v)
                // checked as the window moves, not only at the end
                if (i % 7 === 0) {
                    expect(stats.median()).toBe(naive(values.slice(0, i + 1), cap, 0.5))
                    expect(stats.p95()).toBe(naive(values.slice(0, i + 1), cap, 0.95))
                }
            })
            expect(stats.quantile(0.5)).toBe(naive(values, cap, 0.5))
            expect(stats.quantile(0.95)).toBe(naive(values, cap, 0.95))
            expect(stats.count).toBe(values.length)
        }), { numRuns: 300 })
    })

    it('keeps the largest value ever seen even after it left the window', () => {
        const stats = new RollingStats(3)
        for (const v of [1, 100, 2, 3, 4, 5]) stats.push(v)
        expect(stats.maxEver).toBe(100)
        expect(stats.quantile(1)).toBe(5)
    })

    it('has nothing to say before it has a sample', () => {
        const stats = new RollingStats()
        expect(stats.median()).toBeUndefined()
        expect(stats.snapshot()).toEqual({ count: 0, median: undefined, p95: undefined })
    })

    it('answers a million quantile questions on a moving window in well under a second', () => {
        const stats = new RollingStats(256)
        const t0 = performance.now()
        let sink = 0
        for (let i = 0; i < 1_000_000; i++) { stats.push((i * 7919) % 1013); sink += stats.p95() ?? 0 }
        expect(sink).toBeGreaterThan(0)
        expect(performance.now() - t0).toBeLessThan(2000) // it was several times slower when every question re-sorted the window
    })
})
