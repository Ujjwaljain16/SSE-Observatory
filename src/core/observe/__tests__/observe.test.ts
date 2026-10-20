import { describe, it, expect } from 'vitest'
import { Recorder } from '../recorder'
import { redactUrl } from '../redactUrl'
import { TestClock } from '../../testing/clock'
import { performanceClock } from '../../clock'
import type { Observation, ObservationDraft } from '../observation'

describe('TestClock and the real clock', () => {
    it('TestClock only moves when told to', () => {
        const clock = new TestClock(100, 5000)
        expect([clock.now(), clock.epoch()]).toEqual([100, 5000])
        clock.advance(25)
        expect([clock.now(), clock.epoch()]).toEqual([125, 5025])
        clock.set(10) // monotonic jumps, wall time does not
        expect([clock.now(), clock.epoch()]).toEqual([10, 5025])
    })

    it('the real clock is monotonic and reads wall time separately', () => {
        const a = performanceClock.now()
        const b = performanceClock.now()
        expect(b).toBeGreaterThanOrEqual(a)
        expect(Math.abs(performanceClock.epoch() - Date.now())).toBeLessThan(1000)
    })
})

describe('Recorder', () => {
    const connect: ObservationDraft = { kind: 'connect', attempt: 0, url: '/s', method: 'GET', headerNames: [], sentLastEventId: '' }

    it('stamps a strictly increasing seq and the time since the capture started', () => {
        const clock = new TestClock(1000, 7)
        const rec = new Recorder({ clock })
        clock.advance(40)
        const a = rec.record({ kind: 'chunk', bytes: 10 })
        clock.advance(60)
        const b = rec.record({ kind: 'chunk', bytes: 20 })
        expect([a.seq, a.t, b.seq, b.t]).toEqual([0, 40, 1, 100])
        expect(rec.startedAtEpochMs).toBe(7)
        expect(rec.count).toBe(2)
    })

    it('never lets time go backwards, even if the clock does', () => {
        const clock = new TestClock(500)
        const rec = new Recorder({ clock })
        clock.advance(100)
        const a = rec.record({ kind: 'chunk', bytes: 1 })
        clock.set(450) // a misbehaving clock
        const b = rec.record({ kind: 'chunk', bytes: 1 })
        expect(a.t).toBe(100)
        expect(b.t).toBe(100)
    })

    it('advances the connection index on every connect record and tags earlier records with 0', () => {
        const rec = new Recorder({ clock: new TestClock() })
        const seen: Observation[] = []
        const withSink = new Recorder({ clock: new TestClock(), onRecord: (o) => seen.push(o) })
        for (const r of [rec, withSink]) {
            r.record({ kind: 'chunk', bytes: 1 }) // before any connect
            r.record(connect)
            r.record({ kind: 'chunk', bytes: 1 })
            r.record(connect)
            r.record({ kind: 'chunk', bytes: 1 })
        }
        expect(seen.map((o) => o.conn)).toEqual([0, 0, 0, 1, 1])
    })

    it('hands every record to the sink in order, with the domain it was told', () => {
        const seen: Observation[] = []
        const rec = new Recorder({ clock: new TestClock(), domain: 'page', onRecord: (o) => seen.push(o) })
        rec.record({ kind: 'retry', ms: 1000 })
        rec.record({ kind: 'comment', text: 'hb', source: 'upstream' })
        expect(seen.map((o) => [o.seq, o.kind, o.domain])).toEqual([[0, 'retry', 'page'], [1, 'comment', 'page']])
    })

    it('omits the domain field entirely when none was given (exactOptionalPropertyTypes)', () => {
        const rec = new Recorder({ clock: new TestClock() })
        expect('domain' in rec.record({ kind: 'chunk', bytes: 1 })).toBe(false)
    })
})

describe('redactUrl', () => {
    it('keeps parameter names but drops values, so tokens never reach a capture', () => {
        expect(redactUrl('https://api.example.com/stream?token=abc123&since=42')).toBe('https://api.example.com/stream?token=[redacted]&since=[redacted]')
    })

    it('removes credentials in the userinfo and any fragment', () => {
        expect(redactUrl('https://user:secret@host.test:8443/a/b#frag')).toBe('https://host.test:8443/a/b')
    })

    it('keeps relative URLs relative and leaves a URL without a query alone', () => {
        expect(redactUrl('/api/sse')).toBe('/api/sse')
        expect(redactUrl('/api/sse?url=http://x/y&auth=Bearer abc')).toBe('/api/sse?url=[redacted]&auth=[redacted]')
        expect(redactUrl('http://localhost:4000/chaos-stream')).toBe('http://localhost:4000/chaos-stream')
    })

    it('lists a repeated parameter name once', () => {
        expect(redactUrl('http://h/x?a=1&a=2&b=3')).toBe('http://h/x?a=[redacted]&b=[redacted]')
    })

    it('never throws on garbage and never returns the query', () => {
        const out = redactUrl('::not a url::?secret=1')
        expect(out).not.toContain('secret=1')
    })
})
