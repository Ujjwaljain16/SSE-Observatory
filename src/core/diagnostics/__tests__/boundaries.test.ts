// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { analyze } from '../engine'
import { DEFAULT_THRESHOLDS } from '../thresholds'
import type { StreamProfile } from '../thresholds'
import { capture, healthyStart, type CaptureBuilder } from '../../testing/captureBuilder'
import { run, withConsumer } from '../rules/__tests__/helpers'
import { proxyMasking } from '../rules/r13ProxyMasking'
import { PayloadProbe } from '../../observe/payloadProbe'
import type { EngineInput } from '../streamModel'
import { defaultRules } from '../rules'
import { sequenceIntegrity } from '../rules/r09SequenceIntegrity'

// Campaign C1: every threshold is pinned at its edge. For each limit the rule's own comparison was read (strict "more than" or "at least"), and
// the finding set at T-1, T and T+1 is written down here, with the default thresholds. A refactor that moves an edge by one (a `>` that
// becomes `>=`) breaks one line of this table and names the threshold. The numbers are the defaults; a test also reads them from
// DEFAULT_THRESHOLDS, so changing a default fails here and says what moved.

type Seen = Record<string, string> // key -> severity
const keysOf = (b: CaptureBuilder, endT: number, prefix: string, profile?: StreamProfile): Seen => {
    const out: Seen = {}
    for (const f of analyze(b.build(), { ...(profile ? { profile } : {}), endT }).findings) if (f.key.startsWith(prefix)) out[f.key] = f.severity
    return out
}
const T = DEFAULT_THRESHOLDS

describe('the defaults these edges are written for', () => {
    it('are the numbers in the table below (a change here is a decision, not an accident)', () => {
        expect({
            connectToHeadersMs: T.connectToHeadersMs, headersToFirstByteMs: T.headersToFirstByteMs, firstByteToEventMs: T.firstByteToEventMs, firstEventErrorFactor: T.firstEventErrorFactor,
            stallMinSamples: T.stallMinSamples, stallP95Factor: T.stallP95Factor, stallErrorFactor: T.stallErrorFactor, stallNoCadenceMs: T.stallNoCadenceMs, stallMinSilenceMs: T.stallMinSilenceMs,
        }).toEqual({ connectToHeadersMs: 3000, headersToFirstByteMs: 3000, firstByteToEventMs: 5000, firstEventErrorFactor: 3, stallMinSamples: 10, stallP95Factor: 3, stallErrorFactor: 5, stallNoCadenceMs: 30_000, stallMinSilenceMs: 1000 })
    })
})

describe('R04 time to first event: a stage is late when it takes MORE than its limit', () => {
    // [label, build(valueMs), the key, edge value, expected at edge-1, at edge, at edge+1]
    const none: Seen = {}
    const rows: Array<{ name: string; edge: number; build: (ms: number) => CaptureBuilder; key: string; below: Seen; at: Seen; above: Seen; endAt?: (ms: number) => number }> = [
        { name: 'headers (connect to response) 3000 ms', edge: T.connectToHeadersMs, build: (ms) => healthyStartless().silence(ms).response(), key: 'timing.first-event:headers', below: none, at: none, above: { 'timing.first-event:headers': 'warning' } },
        { name: 'first byte (headers to first body byte) 3000 ms', edge: T.headersToFirstByteMs, build: (ms) => healthyStart().silence(ms).chunk(), key: 'timing.first-event:first-byte', below: none, at: none, above: { 'timing.first-event:first-byte': 'warning' } },
        { name: 'first event (first byte to first event) 5000 ms: late above it', edge: T.firstByteToEventMs, build: (ms) => healthyStart().chunk().silence(ms).event('tick', '1'), key: 'timing.first-event:first-event', below: none, at: none, above: { 'timing.first-event:first-event': 'warning' } },
        { name: 'first event becomes an error above 3 x its limit (15000 ms)', edge: T.firstByteToEventMs * T.firstEventErrorFactor, build: (ms) => healthyStart().chunk().silence(ms).event('tick', '1'), key: 'timing.first-event:first-event', below: { 'timing.first-event:first-event': 'warning' }, at: { 'timing.first-event:first-event': 'warning' }, above: { 'timing.first-event:first-event': 'error' } },
    ]
    for (const r of rows) {
        it(`${r.name}: at the limit nothing, one millisecond over it a finding`, () => {
            expect(keysOf(r.build(r.edge - 1), r.edge + 60_000, r.key)).toEqual(r.below)
            expect(keysOf(r.build(r.edge), r.edge + 60_000, r.key)).toEqual(r.at)
            expect(keysOf(r.build(r.edge + 1), r.edge + 60_000, r.key)).toEqual(r.above)
        })
    }

    it('the same edge for a stage still waiting when the capture ends: shown once it has waited MORE than the limit', () => {
        // headers: connect at 0, no response by endT
        const waiting = (ms: number) => keysOf(healthyStartless(), ms, 'timing.first-event:headers')
        expect(waiting(T.connectToHeadersMs)).toEqual({})
        expect(waiting(T.connectToHeadersMs + 1)).toEqual({ 'timing.first-event:headers': 'warning' })
    })

    it('a declared first-event time replaces the limit, with the same edge', () => {
        const profile: StreamProfile = { expected: { firstEventMs: 800 } }
        const at = (ms: number) => keysOf(healthyStart().chunk().silence(ms).event('tick', '1'), 70_000, 'timing.first-event:first-event', profile)
        expect(at(800)).toEqual({})
        expect(at(801)).toEqual({ 'timing.first-event:first-event': 'warning' })
        expect(at(2400)).toEqual({ 'timing.first-event:first-event': 'warning' })
        expect(at(2401)).toEqual({ 'timing.first-event:first-event': 'error' })
    })
})

/** A connection that has been opened but has no response yet. */
const healthyStartless = (): CaptureBuilder => capture().connect()

describe('R05 silence: a stall is MORE than its limit, and a silence under the minimum is never one', () => {
    /** `events` frames `gapMs` apart, then silence until `silentMs` after the last one. Returns the builder and the end time. */
    const stream = (events: number, gapMs: number, silentMs: number) => {
        const b = healthyStart()
        for (let i = 0; i < events; i++) b.silence(gapMs).frame('tick', String(i + 1))
        return { b, endT: b.now + silentMs }
    }
    const at = (events: number, gapMs: number, silentMs: number): Seen => { const { b, endT } = stream(events, gapMs, silentMs); return keysOf(b, endT, 'stall.silent') }

    it('no measured rhythm: silence is reported only beyond stallNoCadenceMs (30 s)', () => {
        expect(at(1, 100, T.stallNoCadenceMs - 1)).toEqual({})
        expect(at(1, 100, T.stallNoCadenceMs)).toEqual({})
        expect(at(1, 100, T.stallNoCadenceMs + 1)).toEqual({ 'stall.silent:bytes': 'warning' })
    })

    it('a connection that never sent a byte: the same limit, named differently', () => {
        const none = (ms: number) => keysOf(healthyStart(), ms, 'stall.silent')
        expect(none(T.stallNoCadenceMs)).toEqual({})
        expect(none(T.stallNoCadenceMs + 1)).toEqual({ 'stall.silent:no-bytes': 'warning' })
    })

    it('a tight rhythm (100 ms) still needs stallMinSilenceMs: a silence under 1000 ms is never a stall, and 1001 is (an error, since 5 x p95 is below the minimum)', () => {
        expect(at(12, 100, T.stallMinSilenceMs - 1)).toEqual({})
        expect(at(12, 100, T.stallMinSilenceMs)).toEqual({})
        expect(at(12, 100, T.stallMinSilenceMs + 1)).toEqual({ 'stall.silent:bytes': 'error' })
    })

    it('a 1 s rhythm: a warning beyond 3 x p95 (3000 ms), an error beyond 5 x p95 (5000 ms)', () => {
        expect(at(12, 1000, 3000)).toEqual({})
        expect(at(12, 1000, 3001)).toEqual({ 'stall.silent:bytes': 'warning' })
        expect(at(12, 1000, 5000)).toEqual({ 'stall.silent:bytes': 'warning' })
        expect(at(12, 1000, 5001)).toEqual({ 'stall.silent:bytes': 'error' })
    })

    it('the rhythm is trusted from stallMinSamples (10) gaps: with 11 events (10 gaps) the 1 s rhythm applies, with 10 (9 gaps) the 30 s default does', () => {
        expect(at(11, 1000, 5001)).toEqual({ 'stall.silent:bytes': 'error' })
        expect(at(10, 1000, 5001)).toEqual({})
        expect(at(10, 1000, T.stallNoCadenceMs + 1)).toEqual({ 'stall.silent:bytes': 'warning' })
    })

    it('a declared longest silence replaces the 30 s default (never below the minimum), with the same edge', () => {
        const profile: StreamProfile = { expected: { maxSilenceMs: 4000 } }
        const declared = (ms: number) => { const { b, endT } = stream(1, 100, ms); return keysOf(b, endT, 'stall.silent', profile) }
        expect(declared(4000)).toEqual({})
        expect(declared(4001)).toEqual({ 'stall.silent:bytes': 'warning' })
        const tiny: StreamProfile = { expected: { maxSilenceMs: 200 } }
        const floor = (ms: number) => { const { b, endT } = stream(1, 100, ms); return keysOf(b, endT, 'stall.silent', tiny) }
        expect(floor(1000)).toEqual({}) // 200 is below the 1000 ms minimum, so the minimum is the limit
        expect(floor(1001)).toEqual({ 'stall.silent:bytes': 'warning' })
    })
})

describe('R06 bursty delivery: how many, how big, how far apart', () => {
    /** One connection; each burst is `size` events at one instant, preceded by `quietMs` of nothing. */
    const bursty = (sizes: number[], quietMs: number): Seen => {
        const b = healthyStart()
        sizes.forEach((size, i) => { b.silence(quietMs); for (let k = 0; k < size; k++) b.frame('tick', String(i * 100 + k + 1)) })
        return keysOf(b, b.now + 100, 'delivery.bursty')
    }
    const FIRES = { 'delivery.bursty': 'warning' }

    it('burstMinEvents (30): thirty events in bursts is enough, twenty-nine is not', () => {
        expect(bursty([10, 10, 10, 10], 3000)).toEqual(FIRES) // 40
        expect(bursty([10, 10, 10], 3000)).toEqual({}) // 30 events but only two bursts follow a quiet time: three are needed (MIN_QUALIFIED)
        expect(bursty([10, 10, 10, 10], 3000)).toEqual(FIRES)
        expect(bursty([10, 10, 9, 9], 3000)).toEqual({ 'delivery.bursty': 'warning' }) // 38
    })

    it('burstEventsPerWindow (8): a cluster of eight events is a burst, a cluster of seven is not, however many there are', () => {
        expect(bursty([8, 8, 8, 8], 3000)).toEqual(FIRES)
        expect(bursty([7, 7, 7, 7, 7, 7], 3000)).toEqual({})
    })

    it('burstMinGapMs (1000): a quiet time of 1000 ms qualifies a burst, 999 ms does not', () => {
        expect(bursty([10, 10, 10, 10], T.burstMinGapMs)).toEqual(FIRES)
        expect(bursty([10, 10, 10, 10], T.burstMinGapMs - 1)).toEqual({})
    })

    it('burstMinNominalGapMs (100): ten events a second apart is 100 ms each and counts; eleven is 91 ms, which is a fast producer, not a buffer', () => {
        expect(bursty([10, 10, 10, 10], 1000)).toEqual(FIRES)
        expect(bursty([11, 11, 11, 11], 1000)).toEqual({})
    })
})

describe('R07 reconnect loop and fixed lifetimes', () => {
    /** `spans.length + 1` healthy connections, each delivering an event, the n-th opened `spans[n]` ms after the one before. */
    const connections = (spans: number[]): CaptureBuilder => {
        const b = healthyStart().frame('tick', '1')
        spans.forEach((span, i) => { b.silence(span).reconnect({ delayMs: 0 }).connect().response().frame('tick', String(i + 2)) })
        return b
    }
    const loop = (b: CaptureBuilder): Seen => keysOf(b, b.now + 100, 'reconnect.loop')

    it('loopMinConnections (3) inside loopWindowMs (60000): three connections spanning 60000 ms are a loop, spanning 60001 are not, two never are', () => {
        expect(loop(connections([30_000, 30_000]))).toEqual({ 'reconnect.loop': 'warning' })
        expect(loop(connections([30_000, 30_001]))).toEqual({})
        expect(loop(connections([100]))).toEqual({})
    })

    it('loopNoEventReconnects (5): five reconnects in a row with no event between are a loop (an error), four are not', () => {
        const refused = (n: number): CaptureBuilder => {
            const b = capture().connect()
            for (let i = 0; i < n; i++) b.response({ status: 503, contentType: 'text/plain' }).silence(61_000).reconnect({ delayMs: 61_000, status: 503 }).connect()
            return b
        }
        expect(loop(refused(5))).toEqual({ 'reconnect.loop': 'error' })
        expect(loop(refused(4))).toEqual({})
    })

    describe('durationMinLifetimes (3) and durationMaxCv (0.03)', () => {
        const pattern = (lifetimes: number[]): Seen => {
            const b = capture().connect().response()
            for (const l of lifetimes) b.silence(l).reconnect({ delayMs: 0 }).connect().response()
            return keysOf(b, b.now + 100, 'reconnect.duration-pattern')
        }
        it('three equal lifetimes are a pattern, two are not', () => {
            expect(Object.keys(pattern([10_000, 10_000, 10_000]))).toEqual(['reconnect.duration-pattern'])
            expect(pattern([10_000, 10_000])).toEqual({})
        })
        // Pinned to within 1 ms. A coefficient of variation of EXACTLY 0.03 cannot be built from whole-millisecond lifetimes (no integers satisfy it),
        // so whether the comparison is `<` or `<=` is not something a capture can show; it is left out on purpose and listed in the campaign results.
        it('three lifetimes of 10 s +- d: a coefficient of variation under 0.03 is a pattern, from 0.03 up is not (d = 367 ms is 0.02997, 368 ms is 0.03005)', () => {
            expect(Object.keys(pattern([10_000 - 367, 10_000, 10_000 + 367]))).toEqual(['reconnect.duration-pattern'])
            expect(pattern([10_000 - 368, 10_000, 10_000 + 368])).toEqual({})
        })
    })
})

describe('R10 heartbeat: late is MORE than 2.5 x the usual interval, judged from 3 intervals', () => {
    /** `n` heartbeats `everyMs` apart, then `quietMs` of nothing. */
    const beats = (n: number, everyMs: number, quietMs: number): Seen => {
        const b = healthyStart()
        for (let i = 0; i < n; i++) b.silence(everyMs).beat()
        return keysOf(b, b.now + quietMs, 'heartbeat.')
    }
    it('late beyond 2.5 x the median interval: 2500 ms after 1000 ms beats is not late, 2501 ms is', () => {
        expect(beats(4, 1000, 2500)).toEqual({})
        expect(Object.keys(beats(4, 1000, 2501))).toEqual(['heartbeat.late:origin'])
    })
    it('heartbeatMinIntervals (3): with three intervals the rhythm is trusted, with two it is not', () => {
        expect(Object.keys(beats(4, 1000, 2501))).toEqual(['heartbeat.late:origin']) // 4 beats = 3 intervals
        expect(beats(3, 1000, 2501)).toEqual({}) // 2 intervals
    })
})

describe('R11 consumer: late is MORE than 250 ms p95 lag, a queue that grew by MORE than 1000, full at 20000', () => {
    const base = () => { const b = healthyStart().repeat(60, 10, (x, i) => x.frame('tick', String(i + 1))); return { records: b.build(), endT: b.now + 1000 } }
    const consumerKeys = (records: ReturnType<typeof withConsumer>, endT: number): Seen => {
        const out: Seen = {}
        for (const f of analyze(records, { endT }).findings) if (f.key.startsWith('consumer.')) out[f.key] = f.severity
        return out
    }
    const lagged = (lagMs: number): Seen => {
        const { records, endT } = base()
        return consumerKeys(withConsumer(records, Array.from({ length: 40 }, (_, i) => ({ t: 20 + i * 10 + lagMs, queueDepth: 0, lagMs }))), endT)
    }
    const queue = (depths: number[]): Seen => {
        const { records, endT } = base()
        return consumerKeys(withConsumer(records, depths.map((queueDepth, i) => ({ t: 20 + i * 10, queueDepth, lagMs: 5 }))), endT)
    }

    it('consumerLagP95Ms (250): a p95 of 250 ms is fine, 251 is slow', () => {
        expect(lagged(T.consumerLagP95Ms)).toEqual({})
        expect(Object.keys(lagged(T.consumerLagP95Ms + 1))).toEqual(['consumer.slow'])
    })
    it('consumerQueueGrowth (1000): growing by 1000 within the window is fine, by 1001 is falling behind', () => {
        expect(queue([0, T.consumerQueueGrowth])).toEqual({})
        expect(Object.keys(queue([0, T.consumerQueueGrowth + 1]))).toEqual(['consumer.slow'])
    })
    it('consumerQueueCap (20000): a queue of 19999 is not full, 20000 is (an error: the app dropped events)', () => {
        expect(queue([T.consumerQueueCap - 1])['consumer.queue-overflow']).toBeUndefined()
        expect(queue([T.consumerQueueCap])['consumer.queue-overflow']).toBe('error')
    })
})

describe('R09 sequence: a gap is confirmed after reorderWindowEvents (50) more events or reorderWindowMs (2000), whichever comes first', () => {
    const DECLARED: StreamProfile = { sequence: { useSseId: true, policy: 'consecutive' } }
    /** Numbers 1, 2, 3, then 5 (4 is missing), then `after` more numbers `stepMs` apart, then the late 4 `lateMs` after the last of them. */
    const withLate = (after: number, stepMs: number, lateMs: number): Seen => {
        const probe = new PayloadProbe({ sequence: { useSseId: true } }, 1)
        const b = healthyStart()
        for (const id of [1, 2, 3, 5]) b.silence(10).frame('tick', String(id), 10 + (id % 7))
        for (let i = 0; i < after; i++) b.silence(stepMs).frame('tick', String(6 + i), 10 + ((6 + i) % 7))
        b.silence(lateMs).frame('tick', '4', 10 + (4 % 7))
        const records = (b.build() as EngineInput[]).map((r) => (r.kind === 'event' ? { ...r, ...probe.probe({ data: `p${r.sseId}`, id: r.sseId, event: r.event }) } : r))
        const out: Seen = {}
        for (const f of analyze(records, { rules: [...defaultRules, sequenceIntegrity], profile: DECLARED, endT: b.now + 100 }).findings) if (f.key.startsWith('seq.integrity:')) out[f.key] = f.severity
        return out
    }

    it('reorderWindowEvents (50): the missing number arriving after 49 more events is a late arrival (a note); after 50 it was already reported as lost', () => {
        expect(withLate(T.reorderWindowEvents - 1, 10, 10)).toEqual({ 'seq.integrity:reorder': 'info' })
        expect(Object.keys(withLate(T.reorderWindowEvents, 10, 10))).toContain('seq.integrity:gap')
    })

    it('reorderWindowMs (2000): the missing number arriving after an event 1999 ms later is a late arrival; 2000 ms later it was already reported as lost', () => {
        expect(withLate(1, T.reorderWindowMs - 1, 10)).toEqual({ 'seq.integrity:reorder': 'info' })
        expect(Object.keys(withLate(1, T.reorderWindowMs, 10))).toContain('seq.integrity:gap')
    })
})

describe('R09 sequence: the last sequenceWindow (4096) numbers are remembered, to tell a repeat from a new number', () => {
    const repeatAfter = (n: number): Seen => {
        const probe = new PayloadProbe({ sequence: { useSseId: true } }, 1)
        const b = healthyStart()
        for (let id = 1; id <= n; id++) b.silence(1).frame('tick', String(id), 10)
        b.silence(1).frame('tick', '1', 10) // the first number again
        const records = (b.build() as EngineInput[]).map((r) => (r.kind === 'event' ? { ...r, ...probe.probe({ data: `p${r.sseId}`, id: r.sseId, event: r.event }) } : r))
        const out: Seen = {}
        for (const f of analyze(records, { rules: [...defaultRules, sequenceIntegrity], profile: { sequence: { useSseId: true, policy: 'consecutive' } }, endT: b.now + 100 }).findings) if (f.key.startsWith('seq.integrity:')) out[f.key] = f.severity
        return out
    }
    it('a number repeated while it is still remembered is a duplicate; once 4096 newer numbers have pushed it out, it is not recognised', () => {
        expect(Object.keys(repeatAfter(T.sequenceWindow))).toContain('seq.integrity:duplicate')
        expect(Object.keys(repeatAfter(T.sequenceWindow + 1))).not.toContain('seq.integrity:duplicate')
    })
})

describe('R13 proxy masking: the proxy-reported idle time is judged like a silence, MORE than the limit', () => {
    const proxied = () => capture().connect().response({ headers: { 'x-sse-proxy': 'observatory/1', 'x-sse-upstream-status': '200', 'x-sse-upstream-content-type': 'text/event-stream' } })
    const hb = (b: CaptureBuilder, upIdle: number, n: number) => b.beat('proxy', `sse-proxy hb up_idle=${upIdle} n=${n}`)
    /** Twelve events one second apart (so a warning above 3 s and an error above 5 s), then the proxy reports the origin idle for 2 s, then `upIdleMs`. */
    const idle = (upIdleMs: number): Seen => {
        const b = proxied()
        for (let i = 0; i < 12; i++) { b.silence(1000).frame('tick', String(i + 1)); hb(b, 200, i + 1) }
        b.silence(1000); hb(b, 2000, 100)
        b.silence(1000); hb(b, upIdleMs, 101)
        const out: Seen = {}
        for (const f of run(b, proxyMasking).findings) if (f.key === 'proxy.masking') out[f.key] = f.severity
        return out
    }
    it('3000 ms of idle is not masking, 3001 is a warning; 5000 is still a warning, 5001 an error', () => {
        expect(idle(3000)).toEqual({})
        expect(idle(3001)).toEqual({ 'proxy.masking': 'warning' })
        expect(idle(5000)).toEqual({ 'proxy.masking': 'warning' })
        expect(idle(5001)).toEqual({ 'proxy.masking': 'error' })
    })
})
