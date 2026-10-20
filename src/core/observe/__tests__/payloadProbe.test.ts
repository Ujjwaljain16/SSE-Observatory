import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { getJsonPath } from '../jsonPath'
import { PayloadProbe } from '../payloadProbe'

describe('getJsonPath', () => {
    const doc = { seq: 7, meta: { id: 'a', tags: ['x', 'y'] }, items: [{ n: 1 }, { n: 2 }], 'dotted.key': 1 }

    it('reads $-rooted, plain, array-index and numeric-segment paths', () => {
        expect(getJsonPath(doc, '$.seq')).toBe(7)
        expect(getJsonPath(doc, 'seq')).toBe(7)
        expect(getJsonPath(doc, '$.meta.id')).toBe('a')
        expect(getJsonPath(doc, 'meta.tags[1]')).toBe('y')
        expect(getJsonPath(doc, 'items[1].n')).toBe(2)
        expect(getJsonPath(doc, 'items.0.n')).toBe(1)
    })

    it('returns undefined for anything missing or malformed, never throwing', () => {
        for (const path of ['', '$', '.', 'nope', 'meta.nope.deeper', 'items[9]', 'seq.x', 'a..b', '[0]', 'items[x]']) {
            expect(getJsonPath(doc, path)).toBeUndefined()
        }
        expect(getJsonPath(null, 'a')).toBeUndefined()
        expect(getJsonPath('text', 'length')).toBeUndefined()
    })

    it('only follows own properties, so prototype keys find nothing', () => {
        for (const path of ['__proto__', '__proto__.polluted', 'constructor', 'constructor.name', 'meta.__proto__', 'toString']) {
            expect(getJsonPath(doc, path)).toBeUndefined()
        }
        expect(getJsonPath(JSON.parse('{"__proto__": {"x": 1}}'), '__proto__.x')).toBe(1) // a real own key is fine
    })

    it('never throws for arbitrary paths', () => {
        fc.assert(fc.property(fc.string(), (path) => { getJsonPath(doc, path) }), { numRuns: 300 })
    })
})

describe('PayloadProbe', () => {
    const SALT = 12345
    const ev = (data: string, over: Partial<{ event: string; id: string }> = {}) => ({ event: 'message', id: '', data, ...over })

    it('with no profile, only hashes: nothing is extracted from the payload', () => {
        const r = new PayloadProbe({}, SALT).probe(ev('{"seq":1}'))
        expect(Object.keys(r).sort()).toEqual(['dataHash'])
    })

    it('extracts the declared sequence, timestamp and partition from the payload', () => {
        const probe = new PayloadProbe({ sequence: { field: '$.seq' }, timestampField: 'meta.ts', partitionBy: 'shard' }, SALT)
        const r = probe.probe(ev('{"seq":42,"meta":{"ts":1700000000000},"shard":"eu"}'))
        expect(r.extracted).toEqual({ seq: 42, ts: 1700000000000, partition: 'eu' })
    })

    it('reads an ISO timestamp, a string sequence and a numeric partition', () => {
        const probe = new PayloadProbe({ sequence: { field: 'id' }, timestampField: 'at', partitionBy: 'p' }, SALT)
        expect(probe.probe(ev('{"id":"evt-9","at":"2025-01-01T00:00:00Z","p":3}')).extracted)
            .toEqual({ seq: 'evt-9', ts: Date.parse('2025-01-01T00:00:00Z'), partition: '3' })
    })

    it('can use the SSE id as the sequence (numeric ids become numbers), and the event name as the partition', () => {
        const probe = new PayloadProbe({ sequence: { useSseId: true }, partitionBy: '$event' }, SALT)
        expect(probe.probe(ev('x', { id: '104', event: 'order' })).extracted).toEqual({ seq: 104, partition: 'order' })
        expect(probe.probe(ev('x', { id: 'abc-1', event: 'order' })).extracted).toEqual({ seq: 'abc-1', partition: 'order' })
        expect(probe.probe(ev('x', { id: '', event: 'order' })).extracted).toEqual({ partition: 'order' }) // no id, no seq
    })

    it('ignores values of the wrong type instead of guessing', () => {
        const probe = new PayloadProbe({ sequence: { field: 'seq' }, timestampField: 'ts' }, SALT)
        expect(probe.probe(ev('{"seq":{"a":1},"ts":"not a date"}')).extracted).toBeUndefined()
        expect(probe.probe(ev('{"seq":null,"ts":true}')).extracted).toBeUndefined()
    })

    it('does nothing for a non-JSON payload, but still hashes it', () => {
        const r = new PayloadProbe({ sequence: { field: 'seq' } }, SALT).probe(ev('plain text, not json'))
        expect(r.extracted).toBeUndefined()
        expect(r.dataHash).toMatch(/^[0-9a-f]+$/)
    })

    it('recognises heartbeats by event name or by a data pattern', () => {
        const probe = new PayloadProbe({ heartbeat: { events: ['ping'], dataPattern: '^\\{\\}$' } }, SALT)
        expect(probe.probe(ev('anything', { event: 'ping' })).extracted).toEqual({ isHeartbeat: true })
        expect(probe.probe(ev('{}')).extracted).toEqual({ isHeartbeat: true })
        expect(probe.probe(ev('{"real":1}')).extracted).toEqual({ isHeartbeat: false })
    })

    it('survives an invalid heartbeat pattern', () => {
        const probe = new PayloadProbe({ heartbeat: { dataPattern: '([' } }, SALT)
        expect(probe.probe(ev('x')).extracted).toEqual({ isHeartbeat: false })
    })

    it('does not parse an oversized payload: marks it truncated and extracts nothing from it', () => {
        const probe = new PayloadProbe({ sequence: { field: 'seq' }, maxChars: 50 }, SALT)
        const big = JSON.stringify({ seq: 1, pad: 'x'.repeat(200) })
        const r = probe.probe(ev(big))
        expect(r.payloadTruncated).toBe(true)
        expect(r.extracted).toBeUndefined()
        expect(r.dataHash).toBeTruthy()
    })

    describe('dataHash', () => {
        it('is equal for equal data and different for different data, within one capture', () => {
            const probe = new PayloadProbe({}, SALT)
            const a = probe.probe(ev('{"a":1}')).dataHash
            expect(probe.probe(ev('{"a":1}')).dataHash).toBe(a)
            expect(probe.probe(ev('{"a":2}')).dataHash).not.toBe(a)
        })

        it('is salted per capture: the same data hashes differently under another salt', () => {
            const one = new PayloadProbe({}, 1).probe(ev('same payload')).dataHash
            const two = new PayloadProbe({}, 2).probe(ev('same payload')).dataHash
            expect(one).not.toBe(two)
        })

        it('is random per probe by default', () => {
            const hashes = new Set(Array.from({ length: 20 }, () => new PayloadProbe().probe(ev('same payload')).dataHash))
            expect(hashes.size).toBeGreaterThan(15)
        })

        it('has few collisions across many distinct payloads', () => {
            const probe = new PayloadProbe({}, SALT)
            const hashes = new Set(Array.from({ length: 5000 }, (_, i) => probe.probe(ev(`{"n":${i}}`)).dataHash))
            expect(hashes.size).toBe(5000)
        })

        it('does not contain the payload', () => {
            const r = new PayloadProbe({ sequence: { field: 'seq' } }, SALT).probe(ev('{"seq":1,"secret":"hunter2-password"}'))
            expect(JSON.stringify(r)).not.toContain('hunter2')
        })
    })
})

describe('PayloadProbe: the SSE id as the sequence', () => {
    it('counts an event only when it set its own id, not when it inherits the previous one', () => {
        const probe = new PayloadProbe({ sequence: { useSseId: true } }, 1)
        expect(probe.probe({ event: 'tick', data: 'x', id: '7', raw: 'id: 7\ndata: x' }).extracted?.seq).toBe(7)
        expect(probe.probe({ event: 'end', data: 'done', id: '7', raw: 'event: end\ndata: done' }).extracted?.seq).toBeUndefined()
        expect(probe.probe({ event: 'tick', data: 'x', id: '8' }).extracted?.seq).toBe(8) // no raw given: the id is taken as it is
    })
})
