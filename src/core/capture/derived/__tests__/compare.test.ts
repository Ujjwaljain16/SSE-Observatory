// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compareCaptures, type ComparisonFinding } from '../compare'
import { SEVERITY_RANK } from '../../../diagnostics/finding'
import { capture, healthyStart, type CaptureBuilder } from '../../../testing/captureBuilder'
import { captureOf, textCapture, type TextEvent } from './helpers'

const find = (fs: ComparisonFinding[], key: string) => fs.find((f) => f.key === key)
const above = (fs: ComparisonFinding[]) => fs.filter((f) => SEVERITY_RANK[f.severity] > SEVERITY_RANK.info)
const text = (f: ComparisonFinding) => JSON.stringify(f)

/** 12 events a second apart, with a heartbeat every 3 s. */
function steady(): CaptureBuilder {
    return healthyStart().at(100).repeat(12, 1000, (b, i) => { b.frame('tick', String(i + 1)); if (i % 3 === 2) b.beat() })
}

describe('compareCaptures: identical captures', () => {
    it('give nothing above info for builder captures', () => {
        expect(above(compareCaptures(captureOf(steady()), captureOf(steady())))).toEqual([])
    })

    it('give nothing at all for captures that carry payload text', () => {
        const events: TextEvent[] = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), data: `payload ${i}` }))
        expect(compareCaptures(textCapture(events), textCapture(events))).toEqual([])
    })

    it('tolerate a capture with nothing in it, and say what was not compared', () => {
        const empty = captureOf(capture())
        const out = compareCaptures(empty, empty)
        expect(above(out)).toEqual([])
        for (const key of ['compare.status', 'compare.first-byte', 'compare.heartbeat-cadence', 'compare.chunk-sizes', 'compare.events']) {
            const f = find(out, key)!
            expect(f.severity, key).toBe('info')
            expect(f.title, key).toContain('not compared')
        }
    })
})

describe('compareCaptures: findings use the engine shape', () => {
    it('are Findings of the compare rule with facts, evidence and a Likely deduction', () => {
        const out = compareCaptures(captureOf(steady()), captureOf(capture().connect().response({ status: 502, contentType: 'application/json' })))
        const f = find(out, 'compare.status')!
        expect(f.ruleId).toBe('compare')
        expect(f.ruleVersion).toBe(1)
        expect(f.status).toBe('open')
        expect(f.facts[0]!.evidence.length).toBeGreaterThan(0)
        expect(f.facts[0]!.evidence[0]!.note).toMatch(/^[AB]: /)
        expect(f.deductions.every((d) => d.statement.startsWith('Likely:'))).toBe(true)
        expect(out).toEqual([...out].sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] || (x.key < y.key ? -1 : 1)))
    })
})

describe('status, content type and headers', () => {
    it('reports a different status as an error with both values', () => {
        const f = find(compareCaptures(captureOf(steady()), captureOf(capture().connect().response({ status: 502, contentType: 'application/json' }))), 'compare.status')!
        expect(f.severity).toBe('error')
        expect(f.facts.map((x) => x.text).join(' ')).toContain('A answered HTTP 200; B answered HTTP 502')
        expect(f.facts.map((x) => x.text).join(' ')).toContain('"application/json"')
    })

    it('reports a different content type that is still 200 as a warning, unless the stream type is lost', () => {
        const mk = (contentType: string) => captureOf(capture().connect().response({ contentType }))
        expect(find(compareCaptures(mk('text/event-stream'), mk('text/event-stream; charset=utf-8')), 'compare.status')!.severity).toBe('warning')
        expect(find(compareCaptures(mk('text/event-stream'), mk('text/plain')), 'compare.status')!.severity).toBe('error')
    })

    it('does not compare when a capture has no response record', () => {
        const f = find(compareCaptures(captureOf(steady()), captureOf(capture().connect())), 'compare.status')!
        expect(f.severity).toBe('info')
        expect(f.summary).toContain('B has no response record')
        expect(f.summary).toContain('not the same as no difference')
    })

    it('flags headers that can change buffering as a warning, and lists each difference', () => {
        const a = captureOf(healthyStart().at(50).frame('t', '1'))
        const b = captureOf(healthyStart().at(50).frame('t', '1'))
        const gz = captureOf(capture().connect().response({ headers: { 'content-encoding': 'gzip', 'x-accel-buffering': undefined, via: '1.1 something' } }).at(50).frame('t', '1'))
        expect(find(compareCaptures(a, b), 'compare.headers')).toBeUndefined()
        const f = find(compareCaptures(a, gz), 'compare.headers')!
        expect(f.severity).toBe('warning')
        const facts = f.facts.map((x) => x.text)
        expect(facts).toContain('content-encoding: A absent; B "gzip".')
        expect(facts).toContain('x-accel-buffering: A "no"; B absent.')
        expect(facts).toContain('via: A absent; B "1.1 something".')
        expect(f.deductions[0]!.statement.startsWith('Likely:')).toBe(true)
    })

    it('treats a different cache-control as info, and ignores volatile values', () => {
        const mk = (headers: Record<string, string>) => captureOf(capture().connect().response({ headers }).at(50).frame('t', '1'))
        expect(find(compareCaptures(mk({ 'cache-control': 'no-cache' }), mk({ 'cache-control': 'no-store' })), 'compare.headers')!.severity).toBe('info')
        expect(find(compareCaptures(mk({ age: '1' }), mk({ age: '999', 'x-sse-upstream-ttfb-ms': '12' })), 'compare.headers')!.facts.map((x) => x.text)).toEqual(['x-sse-upstream-ttfb-ms: A absent; B present.'])
        expect(find(compareCaptures(mk({ age: '1' }), mk({ age: '999' })), 'compare.headers')).toBeUndefined()
    })

    it('says so when a response carried no headers', () => {
        const none = captureOf(capture().connect().response({ headers: 'none' }).at(50).frame('t', '1'))
        const f = find(compareCaptures(captureOf(steady()), none), 'compare.headers')!
        expect(f.severity).toBe('info')
        expect(f.summary).toContain("B's response record carries no headers")
    })
})

describe('time to first byte and first event', () => {
    it('warns when one path waits much longer, and does not name a layer', () => {
        const slow = captureOf(healthyStart().at(4000).repeat(12, 1000, (b, i) => b.frame('tick', String(i + 1))))
        const f = find(compareCaptures(captureOf(steady()), slow), 'compare.first-byte')!
        expect(f.severity).toBe('warning')
        expect(f.facts[0]!.text).toBe('Time to first byte: A 1.1 s, B 5 s.')
        expect(f.summary.startsWith('B waited')).toBe(true)
        expect(f.deductions[0]!.statement).toMatch(/^Likely: a layer between A and B/)
    })

    it('stays quiet about small differences', () => {
        const a = captureOf(healthyStart().at(100).frame('t', '1'))
        const b = captureOf(healthyStart().at(300).frame('t', '1'))
        expect(find(compareCaptures(a, b), 'compare.first-byte')).toBeUndefined()
    })
})

describe('heartbeat cadence', () => {
    const beats = (everyMs: number, n = 6) => captureOf(healthyStart().repeat(n, everyMs, (b) => b.beat()))

    it('compares the median gap between comments', () => {
        const f = find(compareCaptures(beats(15_000), beats(5_000)), 'compare.heartbeat-cadence')!
        expect(f.severity).toBe('warning')
        expect(f.facts[0]!.text).toBe('Median heartbeat gap: A 15 s, B 5 s.')
    })

    it('reports a small difference as info and an equal cadence as nothing', () => {
        expect(find(compareCaptures(beats(15_000), beats(20_000)), 'compare.heartbeat-cadence')!.severity).toBe('info')
        expect(find(compareCaptures(beats(15_000), beats(15_200)), 'compare.heartbeat-cadence')).toBeUndefined()
    })

    it('uses heartbeat series records', () => {
        const series = captureOf(healthyStart().chunk(10).at(1000))
        series.records.push({ seq: 99, t: 60_000, conn: 0, kind: 'heartbeatSeries', text: ' hb', source: 'upstream', count: 20, firstT: 1000, lastT: 60_000, minGapMs: 2900, maxGapMs: 3100, meanGapMs: 3000 })
        const f = find(compareCaptures(beats(15_000), series), 'compare.heartbeat-cadence')!
        expect(f.facts[0]!.text).toBe('Median heartbeat gap: A 15 s, B 3 s.')
    })

    it('warns when only one capture has heartbeats over a long enough time, and does not compare over a short one', () => {
        const quiet = (ms: number) => captureOf(healthyStart().frame('t', '1').silence(ms).frame('t', '2'))
        expect(find(compareCaptures(beats(15_000), quiet(120_000)), 'compare.heartbeat-cadence')!.severity).toBe('warning')
        const short = find(compareCaptures(beats(15_000), quiet(5_000)), 'compare.heartbeat-cadence')!
        expect(short.severity).toBe('info')
        expect(short.title).toContain('not compared')
    })

    it('notes a different heartbeat source', () => {
        const proxy = captureOf(healthyStart().repeat(6, 15_000, (b) => b.beat('proxy')))
        const f = find(compareCaptures(beats(15_000), proxy), 'compare.heartbeat-cadence')!
        expect(f.severity).toBe('info')
        expect(f.facts[0]!.text).toBe("A's heartbeats are marked upstream; B's are marked proxy.")
    })
})

describe('chunk-size distribution', () => {
    const lumps = (size: number) => captureOf(healthyStart().at(100).repeat(4, 5000, (b) => { b.chunk(size); for (let i = 0; i < 5; i++) b.event('tick', String(b.now) + i) }))

    it('says a layer between A and B buffers, at low or medium confidence, when only one shows block-sized chunks', () => {
        const f = find(compareCaptures(captureOf(steady()), lumps(16384)), 'compare.chunk-sizes')!
        expect(f.severity).toBe('warning')
        const d = f.deductions[0]!
        expect(d.statement.startsWith('Likely: a layer between A and B buffers')).toBe(true)
        expect(d.statement).toContain('B only')
        expect(['low', 'medium']).toContain(d.confidence)
        expect(d.confidence).toBe('medium') // block-sized and lumped
        expect(d.alternatives.length).toBeGreaterThan(0)
        expect(text(f)).not.toMatch(/nginx|cloudflare|envoy|haproxy|cdn|load.?balancer|reverse proxy|apache|traefik/i)
        expect(f.limits.length).toBeGreaterThan(1)
    })

    it('is symmetrical', () => {
        const f = find(compareCaptures(lumps(65536), captureOf(steady())), 'compare.chunk-sizes')!
        expect(f.deductions[0]!.statement).toContain('A only')
    })

    it('uses low confidence when only one of the two signs is there', () => {
        const odd = captureOf(healthyStart().at(100).repeat(8, 1000, (b) => { b.chunk(8192); b.event('tick', '') }))
        expect(find(compareCaptures(captureOf(steady()), odd), 'compare.chunk-sizes')!.deductions[0]!.confidence).toBe('low')
    })

    it('reports a shared signature as info only', () => {
        const f = find(compareCaptures(lumps(16384), lumps(4096)), 'compare.chunk-sizes')!
        expect(f.severity).toBe('info')
        expect(f.deductions).toEqual([])
    })

    it('does not evaluate when a capture has no chunk records', () => {
        const noChunks = captureOf(healthyStart().at(100).repeat(5, 1000, (b, i) => b.event('tick', String(i + 1))))
        const f = find(compareCaptures(captureOf(steady()), noChunks), 'compare.chunk-sizes')!
        expect(f.severity).toBe('info')
        expect(f.title).toBe('Chunk-size distribution not compared')
        expect(f.summary).toContain('B has no chunk records')
    })

    it('mentions the clients when they differ', () => {
        const a = captureOf(steady(), { source: { kind: 'browser-app', client: 'browser-fetch' } })
        const f = find(compareCaptures(a, lumps(16384)), 'compare.chunk-sizes')!
        expect(f.limits.join(' ')).toContain('different clients (A: browser-fetch, B: unknown)')
    })
})

describe('event set and order', () => {
    const ids = (list: Array<number | string>): TextEvent[] => list.map((i) => ({ id: String(i), data: `payload ${i}` }))
    const one = (...l: Array<number | string>) => textCapture(ids(l))

    it('aligns by id and reports an event missing between shared events as a warning', () => {
        const f = find(compareCaptures(one(1, 2, 3, 4, 5, 6), one(1, 2, 3, 5, 6)), 'compare.events')!
        expect(f.severity).toBe('warning')
        expect(f.facts.map((x) => x.text).join(' ')).toContain('message id 4')
        expect(f.facts.map((x) => x.text).join(' ')).toContain('appear in A only')
        expect(f.deductions[0]!.statement.startsWith('Likely:')).toBe(true)
        expect(f.limits.join(' ')).toContain('salted')
    })

    it('treats events only at the start or end as a difference in span, at info', () => {
        const f = find(compareCaptures(one(1, 2, 3, 4, 5, 6), one(3, 4, 5)), 'compare.events')!
        expect(f.severity).toBe('info')
        expect(f.facts.map((x) => x.text).join(' ')).toContain('before the first or after the last shared event appear in A only')
    })

    it('reports a different order', () => {
        const f = find(compareCaptures(one(1, 2, 3, 4, 5), one(1, 3, 2, 4, 5)), 'compare.events')!
        expect(f.severity).toBe('warning')
        expect(f.facts.map((x) => x.text).join(' ')).toContain('1 shared event arrive in a different order in B than in A')
    })

    it('reports the same id with different payload text', () => {
        const a = textCapture([{ id: '1', data: 'x' }, { id: '2', data: 'y' }])
        const b = textCapture([{ id: '1', data: 'x' }, { id: '2', data: 'CHANGED' }])
        const f = find(compareCaptures(a, b), 'compare.events')!
        expect(f.severity).toBe('warning')
        expect(f.facts.map((x) => x.text).join(' ')).toContain('1 event with the same id have a different name or payload text')
    })

    it('aligns events without ids by name and payload text, and never by the per-capture dataHash', () => {
        const mk = (salt: string) => textCapture(Array.from({ length: 6 }, (_, i) => ({ event: 'tick', data: `payload ${i}`, dataHash: `${salt}-${i}` })))
        expect(compareCaptures(mk('saltA'), mk('saltB'))).toEqual([])
        // and a changed payload is still found even though the hashes on the records are equal
        const b = textCapture(Array.from({ length: 6 }, (_, i) => ({ event: 'tick', data: i === 3 ? 'other' : `payload ${i}`, dataHash: `saltA-${i}` })))
        const f = find(compareCaptures(mk('saltA'), b), 'compare.events')!
        expect(f.severity).toBe('warning')
        expect(f.facts.map((x) => x.text).join(' ')).toContain('by payload 5')
    })

    it('keeps repeated identical events in order', () => {
        const same = textCapture(Array.from({ length: 5 }, () => ({ event: 'tick', data: 'same' })))
        expect(compareCaptures(same, same)).toEqual([])
    })

    it('falls back to the extracted sequence number', () => {
        const a = textCapture([1, 2, 3, 4, 5].map((n) => ({ data: `a${n}`, extractedSeq: n })))
        const b = textCapture([1, 2, 4, 5].map((n) => ({ data: `b${n}`, extractedSeq: n })))
        const f = find(compareCaptures(a, b), 'compare.events')!
        expect(f.severity).toBe('warning')
        expect(f.facts.map((x) => x.text).join(' ')).toContain('by sequence number 4')
    })

    it('says when payload text is missing and events cannot be matched', () => {
        const bare = (n: number) => captureOf(healthyStart().at(100).repeat(n, 1000, (b) => b.frame('tick', '')))
        const f = find(compareCaptures(bare(5), bare(4)), 'compare.events')!
        expect(f.severity).toBe('info')
        expect(f.facts.map((x) => x.text).join(' ')).toContain('cannot be matched')
        expect(f.limits.join(' ')).toContain('Payload text could not be rebuilt for A and B')
    })

    it('warns when nothing could be matched', () => {
        const f = find(compareCaptures(one(1, 2, 3), one(7, 8, 9)), 'compare.events')!
        expect(f.severity).toBe('warning')
        expect(f.facts[0]!.text).toContain('None of')
    })
})

describe('arrival delay of matching events', () => {
    const events = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), data: `p${i}` }))

    it('reports a steady delay', () => {
        const f = find(compareCaptures(textCapture(events(6), { everyMs: 1000 }), textCapture(events(6), { everyMs: 1000, startMs: 3100 })), 'compare.latency')!
        expect(f.severity).toBe('warning')
        expect(f.facts[0]!.text).toContain('Median arrival difference (B minus A): 3000 ms')
        expect(f.deductions[0]!.statement.startsWith('Likely:')).toBe(true)
    })

    it('reports batching as a wide range of delays', () => {
        const a = textCapture(events(6), { everyMs: 1000 })
        const b = textCapture(events(6), { everyMs: 1000 })
        // B releases the first events late and the last on time, like a buffer flushing
        let n = 0
        for (const r of b.records) if (r.kind === 'chunk' || r.kind === 'event') r.t += 3000 - Math.min(3000, Math.floor(n++ / 2) * 600)
        const f = find(compareCaptures(a, b), 'compare.latency')!
        expect(['warning', 'info']).toContain(f.severity)
        expect(f.facts[0]!.text).toContain('ranges over')
    })

    it('is not evaluated with fewer than three matched events', () => {
        const f = find(compareCaptures(textCapture(events(2)), textCapture(events(2))), 'compare.latency')!
        expect(f.severity).toBe('info')
        expect(f.title).toBe('Event arrival delay not compared')
    })

    it('is silent for equal timing', () => {
        expect(find(compareCaptures(textCapture(events(6)), textCapture(events(6))), 'compare.latency')).toBeUndefined()
    })
})
