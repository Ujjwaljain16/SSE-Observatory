import { describe, it, expect } from 'vitest'
import { analyze } from '../../engine'
import { capture, healthyStart, type CaptureBuilder } from '../../../testing/captureBuilder'
import { deliveryBursty } from '../r06DeliveryBursty'
import { find, keys, run, runRecords, sameLiveAndBatch, withProducerTs, withRule } from './helpers'

const KEY = 'delivery.bursty'

/** `lumps` bursts of `size` events, one lump every `everyMs`, each lump written as one chunk. */
function buffered(lumps: number, size = 12, everyMs = 3000): CaptureBuilder {
    const b = healthyStart()
    for (let l = 0; l < lumps; l++) {
        b.silence(everyMs).chunk(size * 60)
        for (let i = 0; i < size; i++) b.event('tick', String(l * size + i + 1))
    }
    return b
}

/** Events one at a time, `everyMs` apart. */
const steady = (count: number, everyMs = 250) => healthyStart().repeat(count, everyMs, (b, i) => b.frame('tick', String(i + 1)))

describe('R06 delivery.bursty', () => {
    it('fires a hypothesis for events that arrive in periodic lumps', () => {
        const a = run(buffered(6), deliveryBursty)
        const f = find(a.findings, KEY)!
        expect(f).toBeDefined()
        expect(f.severity).toBe('warning')
        expect(f.facts[0]!.text).toMatch(/72 events arrived in 6 tight clusters/)
        expect(f.facts[0]!.evidence.length).toBeGreaterThan(0)
        expect(f.deductions).toHaveLength(1)
        expect(f.deductions[0]!.statement).toBe('Likely: response buffering (something holds the bytes and releases them in lumps).')
        expect(f.deductions[0]!.confidence).toBe('low')
        expect(f.deductions[0]!.alternatives.length).toBeGreaterThan(1)
        expect(f.limits.join(' ')).toMatch(/cannot name the layer/)
        expect(f.status).toBe('open')
    })

    it('is medium confidence only when producer timestamps are even while arrival is clustered', () => {
        const even = withProducerTs(buffered(6).build(), (i) => 1_700_000_000_000 + i * 250)
        const medium = find(runRecords(even, deliveryBursty, 18_000 + 1).findings, KEY)!
        expect(medium.deductions[0]!.confidence).toBe('medium')
        expect(medium.facts.some((x) => /evenly spaced, about 250 ms apart, while arrival is clustered/.test(x.text))).toBe(true)

        // The producer itself stamps a whole lump with one time: that is batching at the source, not proof of even production.
        const batched = withProducerTs(buffered(6).build(), (i) => 1_700_000_000_000 + Math.floor(i / 12) * 3000)
        const low = find(runRecords(batched, deliveryBursty, 18_001).findings, KEY)!
        expect(low.deductions[0]!.confidence).toBe('low')
    })

    it('is silent for a steady stream, the healthy twin of the same cadence', () => {
        const a = run(steady(60), deliveryBursty)
        expect(a.findings).toEqual([])
        expect(a.coverage.find((c) => c.ruleId === KEY)!.status).toBe('evaluated')
    })

    it('stays silent for a fast steady stream (5000 tiny events a second)', () => {
        const b = healthyStart()
        for (let i = 0; i < 6000; i++) b.silence(0.2).frame('tick', String(i), 4)
        expect(run(b, deliveryBursty).findings).toEqual([])
    })

    it('stays silent for a fast producer that sends a batch every second (nominal gap far under the minimum)', () => {
        const b = healthyStart()
        for (let l = 0; l < 8; l++) {
            b.silence(1000).chunk(9000)
            for (let i = 0; i < 200; i++) b.event('tick', String(l * 200 + i))
        }
        expect(run(b, deliveryBursty).findings).toEqual([])
    })

    it('stays silent for a single catch-up burst after a reconnect', () => {
        const b = steady(10).silence(2000).chunk(3000)
        for (let i = 0; i < 40; i++) b.event('tick', String(100 + i))
        expect(run(b, deliveryBursty).findings).toEqual([])
    })

    it('stays silent when there are too few events or the bursts are irregular', () => {
        expect(run(buffered(2), deliveryBursty).findings).toEqual([])
        const irregular = healthyStart()
        let at = 0
        for (const gap of [1100, 9000, 1500, 14000, 2300]) {
            at += gap
            irregular.at(at).chunk(500)
            for (let i = 0; i < 10; i++) irregular.event('tick')
        }
        expect(run(irregular, deliveryBursty).findings).toEqual([])
    })

    it('reports a buffer-sized chunk as a hint, and fires on size alone when the period is uneven', () => {
        const b = healthyStart()
        let at = 0
        for (const gap of [1200, 7000, 1500, 15000, 2600]) {
            at += gap
            b.at(at).chunk(8000)
            for (let i = 0; i < 10; i++) b.event('tick')
        }
        const f = find(run(b, deliveryBursty).findings, KEY)!
        expect(f.facts.some((x) => /just under 8192 bytes/.test(x.text))).toBe(true)
    })

    it('honours the thresholds', () => {
        const a = analyze(buffered(6).build(), withRule(deliveryBursty, { endT: 18_001, thresholds: { burstMinGapMs: 5000 } }))
        expect(keys(a.findings)).not.toContain(KEY)
        const b = analyze(buffered(6).build(), withRule(deliveryBursty, { endT: 18_001, thresholds: { burstMinNominalGapMs: 400 } }))
        expect(keys(b.findings)).not.toContain(KEY)
    })

    it('is not evaluated, and says so, when the capture has no chunk records', () => {
        const a = analyze([], withRule(deliveryBursty))
        expect(a.coverage.find((c) => c.ruleId === KEY)).toMatchObject({ status: 'not-evaluated' })
        const eventsOnly = capture()
        for (let l = 0; l < 6; l++) { eventsOnly.silence(3000); for (let i = 0; i < 12; i++) eventsOnly.event('tick') }
        const b = analyze(eventsOnly.build(), withRule(deliveryBursty))
        expect(b.coverage.find((c) => c.ruleId === KEY)).toMatchObject({ status: 'not-evaluated', missingCapabilities: ['chunks'] })
    })

    it('notes that the spacing at the producer is estimated when no timestamp field is set', () => {
        const a = run(buffered(3), deliveryBursty)
        expect(a.coverage.find((c) => c.ruleId === KEY)!.notes.join(' ')).toMatch(/estimated/)
    })

    it('live analysis equals batch analysis, with ticks in the middle of a burst', () => {
        for (const b of [buffered(6), steady(40), buffered(4, 9, 1500)]) {
            const { live, batch } = sameLiveAndBatch(b, deliveryBursty)
            expect(live).toEqual(batch)
        }
        // a provisional view while a burst is still arriving does not change what is kept
        const records = buffered(5).build()
        const a = analyze(records, withRule(deliveryBursty, { endT: 15_001 }))
        expect(find(a.findings, KEY)).toBeDefined()
    })
})
