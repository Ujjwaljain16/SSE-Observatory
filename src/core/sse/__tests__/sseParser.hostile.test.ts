// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SSEParser, SSEParserError, type SSEViolation } from '../sseParser'
import { PayloadProbe } from '../../observe/payloadProbe'

// Campaign B4: hostile input stays bounded. A server (or a proxy, or a person pasting something) controls every byte the parser sees. None of
// these may throw anything but the documented SSEParserError, run away in time, or leave the parser holding what it refused. The budgets are
// generous (they exist to catch quadratic behaviour and unbounded growth, not to time the machine).

const encoder = new TextEncoder()
const PIECE = 64 * 1024

/** Feeds `total` bytes made of `unit` repeated, in 64 KiB pieces; returns the time taken and what was thrown, if anything. */
function pump(parser: SSEParser, unit: string, repeats: number, header = ''): { ms: number; threw: unknown; fed: number } {
    const bytes = encoder.encode(unit)
    const perPiece = Math.max(1, Math.floor(PIECE / bytes.length))
    const start = performance.now()
    let fed = 0
    try {
        if (header) parser.feed(header)
        for (let done = 0; done < repeats; done += perPiece) {
            const n = Math.min(perPiece, repeats - done)
            const piece = new Uint8Array(n * bytes.length)
            for (let i = 0; i < n; i++) piece.set(bytes, i * bytes.length)
            parser.feed(piece)
            fed += piece.length
        }
        return { ms: performance.now() - start, threw: undefined, fed }
    } catch (e) {
        return { ms: performance.now() - start, threw: e, fed }
    }
}

describe('one event that never ends', () => {
    it('(a) millions of short data lines and no blank line: stopped with EVENT_TOO_LONG, quickly, holding nothing afterwards', () => {
        const violations: SSEViolation[] = []
        const parser = new SSEParser({ onMessage: () => {}, onViolation: (v) => violations.push(v) })
        const r = pump(parser, 'data: x\n', 5_000_000) // 40 MB if it were all accepted
        expect(r.threw).toBeInstanceOf(SSEParserError)
        expect(violations.map((v) => v.code)).toContain('EVENT_TOO_LONG')
        expect(r.fed, 'it stopped well before the whole 40 MB').toBeLessThan(40_000_000)
        expect(r.ms).toBeLessThan(20_000)
        // what is left is at most the one piece that was being read when it stopped (the client abandons the parser on this error), never the event
        expect(parser.pendingBytes, 'at most the piece in hand is kept').toBeLessThanOrEqual(PIECE)
        parser.end(false)
        expect(parser.pendingBytes, 'and nothing once it is ended').toBe(0)
        // and the parser is usable again after it
        const events: string[] = []
        const again = new SSEParser({ onMessage: (m) => events.push(m.data) })
        again.feed('data: fine\n\n')
        expect(events).toEqual(['fine'])
    })

    it('(f) one 20 MB event of valid, long lines: bounded the same way, with the documented error and not a crash', () => {
        const violations: SSEViolation[] = []
        const parser = new SSEParser({ onMessage: () => {}, onViolation: (v) => violations.push(v) })
        const r = pump(parser, `data: ${'y'.repeat(1000)}\n`, 20_000)
        expect(r.threw).toBeInstanceOf(SSEParserError)
        expect(violations.map((v) => v.code)).toContain('EVENT_TOO_LONG')
        expect(r.ms).toBeLessThan(20_000)
    })

    it('a line with no end is bounded too (LINE_TOO_LONG), without copying the buffer on every piece', () => {
        const violations: SSEViolation[] = []
        const parser = new SSEParser({ onMessage: () => {}, onViolation: (v) => violations.push(v) })
        const r = pump(parser, 'z'.repeat(1024), 40_000) // 40 MB, no newline
        expect(r.threw).toBeInstanceOf(SSEParserError)
        expect(violations.map((v) => v.code)).toContain('LINE_TOO_LONG')
        expect(r.ms).toBeLessThan(20_000)
    })
})

describe('a great many lines that do not build an event', () => {
    it('(b) a million comment lines: no growth, no throw, in time', () => {
        let comments = 0
        const parser = new SSEParser({ onMessage: () => {}, onComment: () => { comments++ } })
        const r = pump(parser, ': keep-alive\n', 1_000_000)
        expect(r.threw).toBeUndefined()
        expect(comments).toBe(1_000_000)
        expect(parser.pendingBytes).toBe(0)
        expect(r.ms).toBeLessThan(20_000)
    })

    it('(c) a million retry lines and a million unknown-field lines: no throw, nothing held, in time', () => {
        const retries: number[] = []
        const violations: string[] = []
        const parser = new SSEParser({ onMessage: () => {}, onRetry: (ms) => retries.push(ms), onViolation: (v) => { if (violations.length < 5) violations.push(v.code) } })
        const a = pump(parser, 'retry: 5\n', 1_000_000)
        const b = pump(parser, 'x-unknown: v\n', 1_000_000)
        expect(a.threw).toBeUndefined()
        expect(b.threw).toBeUndefined()
        expect(retries.length).toBe(1_000_000)
        expect(parser.atBoundary, 'neither retry nor an unknown field starts an event').toBe(true)
        expect(a.ms + b.ms).toBeLessThan(30_000)
    })

    it('a million blank lines: no event, no growth', () => {
        let events = 0
        const parser = new SSEParser({ onMessage: () => { events++ } })
        const r = pump(parser, '\n', 1_000_000)
        expect(r.threw).toBeUndefined()
        expect(events).toBe(0)
        expect(r.ms).toBeLessThan(20_000)
    })
})

describe('payloads that try to hurt the probe', () => {
    const probe = new PayloadProbe({ sequence: { field: '$.seq' }, timestampField: '$.ts', partitionBy: '$.p' }, 1)

    it('(d) lone surrogates, NUL and every control character in data and ids: never a throw, always a hash', () => {
        const nasty = [`\ud800`, `\udfff`, `a\ud800b`, `\u0000`, `{"seq":1,"ts":"\u0000","p":"\ud800"}`, ''.padEnd(1000, '\u0001'), `{"seq":"\ud800"}`, `\u001b[2J`]
        for (const data of nasty) {
            for (const id of ['', '\u0000', '\ud800', '7']) {
                const r = probe.probe({ data, id, event: '\ud800' })
                expect(typeof r.dataHash).toBe('string')
            }
        }
    })

    it('(e) JSON nested 100000 deep in a 64 KiB payload, with a profile that makes the probe parse it: no throw, no stack overflow out of the probe', () => {
        const deep = '['.repeat(100_000) + ']'.repeat(100_000)
        expect(deep.length).toBeLessThan(250_000)
        const start = performance.now()
        const r = probe.probe({ data: deep, id: '', event: 'message' })
        expect(typeof r.dataHash).toBe('string')
        expect(r.extracted?.seq).toBeUndefined()
        expect(performance.now() - start).toBeLessThan(5_000)
        const object = '{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000)
        expect(typeof probe.probe({ data: object, id: '', event: 'message' }).dataHash).toBe('string')
    })

    it('a payload of many megabytes is hashed from its start and length only, quickly', () => {
        const big = 'x'.repeat(30_000_000)
        const start = performance.now()
        const r = probe.probe({ data: big, id: '', event: 'message' })
        expect(r.payloadTruncated).toBe(true)
        expect(performance.now() - start).toBeLessThan(2_000)
    })
})
