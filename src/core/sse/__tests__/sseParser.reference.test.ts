// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { SSEParser } from '../sseParser'
import { parseBytes, parseStream, splitLines, type RefEvent, type RefResult } from '../../testing/refSseParser'

// The incremental parser against a literal transcription of the specification (src/core/testing/refSseParser.ts). Every other parser test
// compares the parser with itself (chunked against whole), which cannot find a rule it gets wrong in both ways. This can.

const encoder = new TextEncoder()

function runProduct(bytes: Uint8Array, cuts: readonly number[]): RefResult {
    const events: RefEvent[] = []
    const retries: number[] = []
    const parser = new SSEParser({ onMessage: (m) => events.push({ type: m.event, data: m.data, lastEventId: m.id }), onRetry: (ms) => retries.push(ms) })
    const points = [...new Set([0, ...cuts.filter((c) => c > 0 && c < bytes.length), bytes.length])].sort((a, b) => a - b)
    for (let i = 0; i + 1 < points.length; i++) parser.feed(bytes.slice(points[i]!, points[i + 1]!))
    parser.end(false)
    return { events, retries }
}

// ---- generators

const text = fc.constantFrom('', 'a', 'hello', ' padded ', '日本語', 'é', '😀', '{"a":1}', 'x:y', ':', ' ', 'a b', 'AB', '0', '42', '007', '1e3', '-1', '12345678901234567890', 'z\u0000z', 'tab\there')
const name = fc.constantFrom('data', 'event', 'id', 'retry', 'Data', 'EVENT', 'ID', 'foo', 'x-y', '', ' data', 'data ', 'retry ', 'dat')
const lineBody = fc.oneof(
    { weight: 6, arbitrary: fc.tuple(fc.constantFrom('data', 'event', 'id', 'retry'), fc.constantFrom(':', ': ', ':  ', ''), text).map(([f, sep, v]) => (sep === '' ? f : `${f}${sep}${v}`)) },
    { weight: 2, arbitrary: fc.tuple(name, fc.constantFrom(':', ': '), text).map(([f, sep, v]) => `${f}${sep}${v}`) },
    { weight: 2, arbitrary: text.map((t) => `:${t}`) }, // a comment
    { weight: 2, arbitrary: fc.constantFrom('data', 'event', 'id', 'retry', 'foo') }, // a field with no colon
    { weight: 5, arbitrary: fc.constant('') }, // a blank line: dispatch
)
const eol = fc.constantFrom('\n', '\r\n', '\r')

/** A stream of lines with chosen endings, an optional BOM, and an optional unterminated last line. */
const grammarStream = fc.record({
    lines: fc.array(fc.tuple(lineBody, eol), { maxLength: 40 }),
    bom: fc.boolean(),
    tail: fc.option(lineBody, { nil: undefined }),
}).map(({ lines, bom, tail }) => `${bom ? '﻿' : ''}${lines.map(([l, e]) => `${l}${e}`).join('')}${tail ?? ''}`)

/** Raw bytes drawn from the ones that matter to the grammar, plus UTF-8 pieces (some invalid) and BOM bytes. */
const interestingByte = fc.constantFrom(0x0a, 0x0d, 0x3a, 0x20, 0x64, 0x61, 0x74, 0x69, 0x65, 0x72, 0x00, 0x31, 0xef, 0xbb, 0xbf, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80, 0xff, 0xc0)
const byteStream = fc.array(interestingByte, { maxLength: 120 }).map((b) => Uint8Array.from(b))

const cutsFor = (length: number) => fc.array(fc.nat({ max: Math.max(length, 1) }), { maxLength: 12 })

const sameAsReference = (bytes: Uint8Array, cuts: readonly number[]) => {
    expect(runProduct(bytes, cuts)).toEqual(parseBytes(bytes))
}

describe('the incremental parser agrees with the specification', () => {
    it('on structured streams, however they are cut (every ending, a BOM, an unterminated last line, odd field names)', () => {
        fc.assert(
            fc.property(grammarStream, fc.nat({ max: 10_000 }), fc.array(fc.nat({ max: 400 }), { maxLength: 12 }), (stream, _salt, cuts) => {
                const bytes = encoder.encode(stream)
                sameAsReference(bytes, cuts)
            }),
            { seed: 15, numRuns: 4000 },
        )
    })

    it('on streams of bytes that mostly look like the grammar, including invalid UTF-8, cut anywhere', () => {
        fc.assert(
            fc.property(byteStream.chain((b) => cutsFor(b.length).map((cuts) => ({ b, cuts }))), ({ b, cuts }) => {
                sameAsReference(b, cuts)
            }),
            { seed: 16, numRuns: 4000 },
        )
    })

    it('byte by byte, which puts every cut inside every multi-byte character and between every CR and LF', () => {
        fc.assert(
            fc.property(grammarStream, (stream) => {
                const bytes = encoder.encode(stream)
                sameAsReference(bytes, Array.from({ length: bytes.length }, (_, i) => i))
            }),
            { seed: 17, numRuns: 1500 },
        )
    })

    it('fed as a string, the same events come out as when it is fed as bytes', () => {
        fc.assert(
            fc.property(grammarStream, (stream) => {
                const events: RefEvent[] = []
                const parser = new SSEParser({ onMessage: (m) => events.push({ type: m.event, data: m.data, lastEventId: m.id }) })
                parser.feed(stream)
                parser.end(false)
                expect(events).toEqual(parseStream(stream.replace(/^﻿/, '')).events)
            }),
            { seed: 18, numRuns: 1500 },
        )
    })
})

// The examples the specification itself gives, so a failure here names the rule and not a random input.
describe('the specification\'s own examples', () => {
    const events = (s: string) => parseBytes(encoder.encode(s)).events
    const both = (s: string) => { const b = encoder.encode(s); expect(runProduct(b, [])).toEqual(parseBytes(b)); expect(runProduct(b, Array.from({ length: b.length }, (_, i) => i))).toEqual(parseBytes(b)); return events(s) }

    it('"data: YHOO / data: +2 / data: 10" is one event with the lines joined by line feeds', () => {
        expect(both('data: YHOO\ndata: +2\ndata: 10\n\n')).toEqual([{ type: 'message', data: 'YHOO\n+2\n10', lastEventId: '' }])
    })

    it('a comment, an id, and an event cut off before its blank line is not dispatched; an id with no colon resets the id', () => {
        const stream = ': test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n'
        expect(both(stream)).toEqual([
            { type: 'message', data: 'first event', lastEventId: '1' },
            { type: 'message', data: 'second event', lastEventId: '' },
        ])
    })

    it('empty data lines: the first event has empty data, the second a single line feed removed, and a trailing "data:" with no blank line is discarded', () => {
        expect(both('data\n\ndata\ndata\n\ndata:')).toEqual([
            { type: 'message', data: '', lastEventId: '' },
            { type: 'message', data: '\n', lastEventId: '' },
        ])
    })

    it('"data:test" and "data: test" are the same, and only one leading space is removed', () => {
        expect(both('data:test\n\ndata: test\n\ndata:  test\n\n').map((e) => e.data)).toEqual(['test', 'test', ' test'])
    })

    it('an event with no data does not dispatch, and clears its name', () => {
        expect(both('event: lost\n\ndata: x\n\n')).toEqual([{ type: 'message', data: 'x', lastEventId: '' }])
    })

    it('an id stays in effect for later events, and one containing NUL is ignored', () => {
        expect(both('id: 7\ndata: a\n\ndata: b\n\nid: x\u0000y\ndata: c\n\n').map((e) => e.lastEventId)).toEqual(['7', '7', '7'])
    })

    it('retry takes digits only', () => {
        expect(parseStream('retry: 1500\nretry: 12ab\nretry:\nretry: 7\n').retries).toEqual([1500, 7])
    })

    it('CR, LF and CRLF all end a line, and a lone CR at the end of a chunk waits for a possible LF', () => {
        expect(both('data: a\r\rdata: b\r\n\r\ndata: c\n\n').map((e) => e.data)).toEqual(['a', 'b', 'c'])
        expect(splitLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c']) // "d" never ended: not a line
    })

    it('one BOM at the start is removed, and a BOM anywhere else is part of the text', () => {
        expect(both('﻿data: a\n\n')).toEqual([{ type: 'message', data: 'a', lastEventId: '' }])
        expect(both('data: a\n\n﻿data: b\n\n').map((e) => e.data)).toEqual(['a']) // "﻿data" is not the field "data"
    })
})
