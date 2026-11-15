import { describe, it, expect } from 'vitest'
import { analyze } from '../../engine'
import type { EngineInput } from '../../streamModel'
import { capture, healthyStart } from '../../../testing/captureBuilder'
import { consumerSlow } from '../r11ConsumerSlow'
import { feedLive, find, keys, runRecords, withConsumer, withRule, type ConsumerSample } from './helpers'

const SLOW = 'consumer.slow'
const OVERFLOW = 'consumer.queue-overflow'

/** A steady 100 events/s transport capture, `count` events long. */
function transport(count: number, everyMs = 10): { records: EngineInput[]; endT: number } {
    const b = healthyStart().repeat(count, everyMs, (x, i) => x.frame('tick', String(i + 1)))
    return { records: b.build(), endT: b.now }
}

/** One consumer sample per event: `lag(i)` ms behind, `depth(i)` events waiting. */
const samples = (count: number, lag: (i: number) => number, depth: (i: number) => number, everyMs = 10): ConsumerSample[] =>
    Array.from({ length: count }, (_, i) => ({ t: 10 + (i + 1) * everyMs + lag(i), queueDepth: depth(i), lagMs: lag(i) }))

describe('R11 consumer.slow', () => {
    it('fires when the p95 lag is over the limit, and says receipt was healthy', () => {
        const { records, endT } = transport(200)
        const slow = withConsumer(records, samples(200, (i) => 100 + i * 5, (i) => Math.floor(i / 2)))
        const f = find(runRecords(slow, consumerSlow, endT + 1000).findings, SLOW)!
        expect(f).toBeDefined()
        expect(f.severity).toBe('warning')
        expect(f.summary).toMatch(/^Receipt healthy, processing late/)
        expect(f.facts[0]!.text).toMatch(/95th percentile of the wait/)
        expect(f.facts.some((x) => /Receipt was healthy/.test(x.text))).toBe(true)
        expect(f.deductions[0]!.statement).toMatch(/^Likely: the page's own event handling/)
        expect(f.limits.join(' ')).toMatch(/worker-to-page hop is approximate/)
        expect(f.facts[0]!.evidence.length).toBeGreaterThan(0)
    })

    it('fires on queue growth alone, with small waits', () => {
        const { records, endT } = transport(100, 50)
        const growing = withConsumer(records, samples(100, () => 20, (i) => i * 20, 50))
        const f = find(runRecords(growing, consumerSlow, endT + 100).findings, SLOW)!
        expect(f.facts.some((x) => /queue of unprocessed events grew by/.test(x.text))).toBe(true)
        expect(f.facts.some((x) => /95th percentile/.test(x.text))).toBe(false)
        expect(f.summary).toMatch(/the queue of unprocessed events grew/)
    })

    it('reports the full queue as its own finding: the app dropped events, not the network', () => {
        const { records, endT } = transport(60, 20)
        const overflowing = withConsumer(records, samples(60, () => 40, (i) => (i < 50 ? i * 400 : 20_000), 20))
        const a = runRecords(overflowing, consumerSlow, endT + 100)
        const o = find(a.findings, OVERFLOW)!
        expect(o.severity).toBe('error')
        expect(o.title).toBe('The app dropped events')
        expect(o.summary).toMatch(/not on the network/)
        expect(o.deductions[0]!.statement).toMatch(/^Likely: events that arrived after the queue was full were discarded/)
        expect(o.limits.join(' ')).toMatch(/How many events were dropped is not recorded/)
        expect(keys(a.findings)).toContain(SLOW) // a queue that deep is also a slow consumer
        // a queue that stays below the cap is no overflow
        expect(keys(runRecords(withConsumer(records, samples(60, () => 40, () => 500, 20)), consumerSlow, endT + 100).findings)).not.toContain(OVERFLOW)
    })

    it('does not claim healthy receipt when the transport had a stall, or when there is no transport data', () => {
        const b = healthyStart().repeat(120, 10, (x, i) => x.frame('tick', String(i + 1)))
        b.silence(6000).frame('tick', 'late')
        const stalled = withConsumer(b.build(), samples(120, (i) => 100 + i * 5, () => 5))
        const f = find(runRecords(stalled, consumerSlow, b.now + 100).findings, SLOW)!
        expect(f.summary).not.toMatch(/Receipt healthy/)
        expect(f.facts.some((x) => /network side was not clean/.test(x.text))).toBe(true)
        expect(f.deductions[0]!.statement).toMatch(/cannot separate the two/)

        const onlyConsumer = capture().connect().build()
        const g = find(runRecords(withConsumer(onlyConsumer, samples(120, (i) => 100 + i * 5, () => 5)), consumerSlow, 3000).findings, SLOW)!
        expect(g.summary).not.toMatch(/Receipt healthy/)
        expect(g.limits.join(' ')).toMatch(/whether receipt was healthy is not known/)
    })

    it('is silent for a healthy consumer, the twin of the same stream', () => {
        const { records, endT } = transport(200)
        const a = runRecords(withConsumer(records, samples(200, (i) => 2 + (i % 5), () => 1)), consumerSlow, endT + 100)
        expect(a.findings).toEqual([])
        expect(a.coverage.find((c) => c.ruleId === SLOW)!.status).toBe('evaluated')
    })

    it('waits for enough samples before judging the lag', () => {
        const { records, endT } = transport(10)
        expect(runRecords(withConsumer(records, samples(10, () => 5000, () => 3)), consumerSlow, endT + 1000).findings).toEqual([])
    })

    it('resolves once the page catches up', () => {
        const { records, endT } = transport(500)
        const recovering = withConsumer(records, samples(500, (i) => (i < 40 ? 600 : 3), () => 1))
        const f = find(runRecords(recovering, consumerSlow, endT + 100).findings, SLOW)!
        expect(f.status).toBe('resolved')
        expect(f.firstSeenT).toBeLessThan(f.lastSeenT)
    })

    it('honours the thresholds', () => {
        const { records, endT } = transport(200)
        const slow = withConsumer(records, samples(200, () => 300, () => 1))
        expect(keys(runRecords(slow, consumerSlow, endT + 100).findings)).toContain(SLOW)
        expect(keys(analyze(slow, withRule(consumerSlow, { endT: endT + 100, thresholds: { consumerLagP95Ms: 1000 } })).findings)).not.toContain(SLOW)
    })

    it('is not evaluated, and says so, when the capture has no consumer records', () => {
        const { records, endT } = transport(50)
        const a = runRecords(records, consumerSlow, endT)
        expect(a.coverage.find((c) => c.ruleId === SLOW)).toMatchObject({ status: 'not-evaluated', missingCapabilities: ['consumer'], missingKinds: ['consumer'] })
        expect(a.findings).toEqual([])
    })

    it('live analysis equals batch analysis', () => {
        const { records, endT } = transport(200)
        for (const consumerRecords of [
            samples(200, (i) => 100 + i * 5, (i) => Math.floor(i / 2)),
            samples(200, () => 3, () => 1),
            samples(200, (i) => (i < 40 ? 600 : 3), (i) => (i < 150 ? i * 200 : 20_000)),
        ]) {
            const all = withConsumer(records, consumerRecords)
            const live = feedLive(all, consumerSlow, endT + 100)
            expect(live.findings).toEqual(runRecords(all, consumerSlow, endT + 100).findings)
        }
    })
})
