import { describe, expect, it } from 'vitest'
import { FLOW_MAX_EVENTS, SLOW_WAIT_MS, buildFlow, flowStatements, type FlowBatch } from '../flow'
import { capture, healthyStart } from '../../core/testing/captureBuilder'

const steady = (n: number, everyMs = 100) => healthyStart().repeat(n, everyMs, (b, i) => b.frame('tick', String(i + 1), 30)).observations()
const batch = (receivedT: number, lagMs: number, n = 1, queueDepth = 0): FlowBatch => ({ receivedT, processedT: receivedT + lagMs, n, queueDepth, lagMs })

describe('buildFlow', () => {
    it('lists the events with the gap since the previous one and the bytes read between them', () => {
        const flow = buildFlow(steady(4), [])
        expect(flow.events.map((e) => e.gapMs)).toEqual([null, 100, 100, 100])
        expect(flow.events[1]!.bytes).toBe(50) // one 30-byte event plus the 20 of framing the builder adds
        expect(flow.summary.events).toBe(4)
        expect(flow.summary.gap).toEqual({ p50: 100, p95: 100, max: 100 })
        expect(flow.summary.eventsPerSecond).toBeCloseTo(10, 5)
    })

    it('keeps the newest events up to the limit, and says nothing about older ones', () => {
        const flow = buildFlow(steady(FLOW_MAX_EVENTS + 50), [])
        expect(flow.events).toHaveLength(FLOW_MAX_EVENTS)
        expect(flow.events[0]!.gapMs).toBe(100) // a real gap, not the first-event null
        expect(flow.span.toT).toBeGreaterThan(flow.span.fromT)
    })

    it('summarises the page batches that fall in the same stretch: wait quantiles, the slow share, the deepest queue', () => {
        const records = steady(20)
        const t = (i: number) => 100 * (i + 1) + 0
        const batches = [batch(t(2), 10, 3, 0), batch(t(5), 40, 3, 4), batch(t(9), 600, 4, 120), batch(t(14), 20, 5, 0)]
        const page = buildFlow(records, batches).summary.page!
        expect(page.batches).toBe(4)
        expect(page.processed).toBe(15)
        expect(page.wait.max).toBe(600)
        expect(page.slowShare).toBeCloseTo(0.25, 5)
        expect(page.maxQueueDepth).toBe(120)
        expect(page.wait.p50).toBe(20)
    })

    it('leaves out batches that belong to another stretch of time', () => {
        const records = steady(10)
        const far = [batch(900_000, 10), batch(-5000, 10)]
        expect(buildFlow(records, far).batches).toEqual([])
        expect(buildFlow(records, far).summary.page).toBeNull()
    })

    it('marks where the connection was made again', () => {
        const b = healthyStart().repeat(3, 100, (x, i) => x.frame('tick', String(i + 1)))
        b.reconnect({ attempt: 1, delayMs: 100 }).silence(100).connect().response()
        b.repeat(3, 100, (x, i) => x.frame('tick', String(i + 4)))
        const flow = buildFlow(b.observations(), [])
        expect(flow.reconnects).toHaveLength(1)
        expect(flow.events.map((e) => e.conn)).toEqual([0, 0, 0, 1, 1, 1])
    })

    it('is empty and calm with nothing recorded', () => {
        const flow = buildFlow(capture().connect().response().observations(), [])
        expect(flow.events).toEqual([])
        expect(flow.summary).toMatchObject({ events: 0, gap: null, page: null, eventsPerSecond: 0 })
    })
})

describe('flowStatements', () => {
    it('says what was measured in plain sentences, and what was not', () => {
        const text = flowStatements(buildFlow(steady(30), [batch(500, 20, 5), batch(1500, 30, 5)])).join('\n')
        expect(text).toMatch(/30 events arrived over 2\.9 s, about 10 a second/)
        expect(text).toMatch(/time between events was 100 ms in the middle/)
        expect(text).toMatch(/processed them in 2 batches/)
        expect(text).toMatch(/Not measured: when the producer created or wrote each event/)
    })

    it('says the page is falling behind only when its wait is well over the time between events', () => {
        const slow = flowStatements(buildFlow(steady(30), [batch(500, 900, 5, 40), batch(1500, 1200, 5, 80)])).join('\n')
        expect(slow).toContain('processing events more slowly than they arrive')
        expect(slow).toMatch(/100% of the batches waited longer than 250 ms; up to 80 events were queued at once/)
        const fine = flowStatements(buildFlow(steady(30), [batch(500, 20), batch(1500, 30)])).join('\n')
        expect(fine).not.toContain('more slowly than they arrive')
        expect(SLOW_WAIT_MS).toBe(250)
    })

    it('says the wait is not known when the page reported none', () => {
        expect(flowStatements(buildFlow(steady(5), [])).join('\n')).toContain('not known')
    })

    it('has one sentence when there are no events', () => {
        expect(flowStatements(buildFlow([], []))).toEqual(['No events have arrived yet.'])
    })
})
