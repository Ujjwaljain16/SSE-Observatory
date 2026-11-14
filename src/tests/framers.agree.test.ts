// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { FrameTracker, errorEvent } from '../../lib/proxy/guard.js'
import { SSEParser } from '../core/sse/sseParser'
import { parseBytes, type RefResult } from '../core/testing/refSseParser'

// The proxy writes its own bytes into the stream (a keep-alive comment, an `event: error` frame, `retry: 1000`) only when its FrameTracker
// says the bytes forwarded so far end on an event boundary. If the tracker is ever wrong in that direction, the proxy's own bytes get glued
// onto the producer's half-written event. The property: wherever the tracker says "boundary", whatever the stream so far, the injected bytes
// change nothing about the events before them, and arrive as exactly what they are. The specification's algorithm (the reference parser)
// is the judge.

const encoder = new TextEncoder()

const text = fc.constantFrom('', 'a', '{"a":1}', ' x', 'x:y', ':', 'z')
const line = fc.oneof(
    { weight: 5, arbitrary: fc.tuple(fc.constantFrom('data', 'event', 'id', 'retry'), fc.constantFrom(':', ': '), text).map(([f, s, v]) => `${f}${s}${v}`) },
    { weight: 2, arbitrary: text.map((t) => `:${t}`) },
    { weight: 2, arbitrary: fc.constantFrom('data', 'id', 'foo') },
    { weight: 4, arbitrary: fc.constant('') },
)
const eol = fc.constantFrom('\n', '\r\n', '\r')
const stream = fc.tuple(fc.array(fc.tuple(line, eol), { maxLength: 14 }), fc.option(line, { nil: undefined }))
    .map(([lines, tail]) => lines.map(([l, e]) => `${l}${e}`).join('') + (tail ?? ''))

function trackerSays(chunks: Uint8Array[]): boolean {
    const t = new FrameTracker()
    for (const c of chunks) t.push(Buffer.from(c))
    return t.atBoundary
}

function split(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
    const points = [...new Set([0, ...cuts.filter((c) => c > 0 && c < bytes.length), bytes.length])].sort((a, b) => a - b)
    const out: Uint8Array[] = []
    for (let i = 0; i + 1 < points.length; i++) out.push(bytes.slice(points[i], points[i + 1]))
    return out
}

const injections: Array<[string, string, (r: RefResult) => void]> = [
    ['an error event', errorEvent('upstream closed'), (r) => expect(r.events.at(-1)).toEqual({ type: 'error', data: '{"error":"upstream closed"}', lastEventId: r.events.at(-1)!.lastEventId })],
    ['a keep-alive comment', ': keep-alive\n\n', () => {}],
    ['the closing retry line', 'retry: 1000\n\n', (r) => expect(r.retries.at(-1)).toBe(1000)],
]

describe('the proxy only writes its own bytes where the tracker says an event has ended', () => {
    for (const [name, injected, check] of injections) {
        it(`${name} never changes the producer's events, wherever the tracker allows it`, () => {
            fc.assert(
                fc.property(stream, fc.array(fc.nat({ max: 300 }), { maxLength: 8 }), (s, cuts) => {
                    const bytes = encoder.encode(s)
                    if (!trackerSays(split(bytes, cuts))) return // the proxy would not write here
                    const before = parseBytes(bytes)
                    const after = parseBytes(encoder.encode(s + injected))
                    // the events before the injection are the same, in the same order, with the same ids...
                    expect(after.events.slice(0, before.events.length)).toEqual(before.events)
                    // ...and the injection adds nothing but itself
                    expect(after.events.length - before.events.length).toBeLessThanOrEqual(1)
                    check(after)
                }),
                { seed: 31, numRuns: 6000 },
            )
        })
    }

    it('the tracker does not depend on how the bytes were chunked', () => {
        fc.assert(
            fc.property(stream, fc.array(fc.nat({ max: 300 }), { maxLength: 8 }), (s, cuts) => {
                const bytes = encoder.encode(s)
                expect(trackerSays(split(bytes, cuts))).toBe(trackerSays([bytes]))
                expect(trackerSays(split(bytes, Array.from({ length: bytes.length }, (_, i) => i)))).toBe(trackerSays([bytes]))
            }),
            { seed: 32, numRuns: 4000 },
        )
    })

    it('agrees with the client parser about "between events": whenever the tracker says boundary, the parser holds nothing half-read', () => {
        fc.assert(
            fc.property(stream, (s) => {
                const bytes = encoder.encode(s)
                if (!trackerSays([bytes])) return
                const parser = new SSEParser({ onMessage: () => {} })
                parser.feed(bytes)
                expect(parser.atBoundary, JSON.stringify(s)).toBe(true)
            }),
            { seed: 33, numRuns: 6000 },
        )
    })

    // The plan's B3, as written: at every chunk end, the proxy's framer and the client parser give the same answer to "does the output end exactly
    // on an event boundary". They are allowed one documented difference, listed here so that any other is a failure.
    it('at every chunk end, the proxy framer and the client parser agree on "ends exactly on an event boundary"', () => {
        const disagreements = new Map<string, string>()
        fc.assert(
            fc.property(stream, fc.array(fc.nat({ max: 300 }), { maxLength: 8 }), (s, cuts) => {
                const bytes = encoder.encode(s)
                const tracker = new FrameTracker()
                const parser = new SSEParser({ onMessage: () => {} })
                for (const c of split(bytes, cuts)) {
                    tracker.push(Buffer.from(c))
                    parser.feed(c)
                    if (tracker.atBoundary !== parser.atBoundary) disagreements.set(`tracker=${tracker.atBoundary} parser=${parser.atBoundary}`, JSON.stringify(s))
                }
            }),
            { seed: 35, numRuns: 6000 },
        )
        expect([...disagreements]).toEqual([])
    })

    it('and on raw bytes that mostly look like the grammar (a byte order mark, invalid UTF-8, NUL), cut anywhere', () => {
        const interesting = fc.constantFrom(0x0a, 0x0d, 0x3a, 0x20, 0x64, 0x61, 0x74, 0x69, 0x65, 0x72, 0x00, 0x31, 0xef, 0xbb, 0xbf, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80, 0xff, 0xc0)
        const disagreements = new Map<string, string>()
        fc.assert(
            fc.property(fc.array(interesting, { maxLength: 100 }), fc.array(fc.nat({ max: 120 }), { maxLength: 8 }), (raw, cuts) => {
                const bytes = Uint8Array.from(raw)
                const tracker = new FrameTracker()
                const parser = new SSEParser({ onMessage: () => {} })
                for (const c of split(bytes, cuts)) {
                    tracker.push(Buffer.from(c))
                    parser.feed(c)
                    if (tracker.atBoundary !== parser.atBoundary) disagreements.set(`tracker=${tracker.atBoundary} parser=${parser.atBoundary}`, JSON.stringify(Buffer.from(bytes).toString('latin1')))
                }
            }),
            { seed: 36, numRuns: 8000 },
        )
        expect([...disagreements]).toEqual([])
    })

    it('is not so cautious that it never writes: a stream of complete events is at a boundary', () => {
        fc.assert(
            fc.property(fc.array(fc.tuple(fc.constantFrom('a', '{"x":1}'), eol), { minLength: 1, maxLength: 8 }), (events) => {
                const s = events.map(([d, e]) => `data: ${d}${e}${e}`).join('')
                expect(trackerSays([encoder.encode(s)]), JSON.stringify(s)).toBe(true)
            }),
            { seed: 34, numRuns: 500 },
        )
    })
})
