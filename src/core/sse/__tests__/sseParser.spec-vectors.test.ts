// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SSEParser } from '../sseParser'

// Campaign B2: the specification's own examples (https://html.spec.whatwg.org/multipage/server-sent-events.html, "Event stream interpretation"
// and its examples), each with the result the specification states, fed whole, byte by byte, and cut at EVERY place into two pieces and at
// every pair of places into three. The expected values are written here, from the specification's text, not computed by anything in this
// repository: that is the oracle. (sseParser.reference.test.ts compares with a transcription of the algorithm on random input.)

interface Out { events: Array<{ type: string; data: string; id: string }>; retries: number[] }
const encoder = new TextEncoder()

function parse(pieces: Uint8Array[]): Out {
    const out: Out = { events: [], retries: [] }
    const parser = new SSEParser({ onMessage: (m) => out.events.push({ type: m.event, data: m.data, id: m.id }), onRetry: (ms) => out.retries.push(ms) })
    for (const p of pieces) parser.feed(p)
    parser.end(false)
    return out
}

const ev = (data: string, id = '', type = 'message') => ({ type, data, id })

interface Vector { name: string; stream: string; events: Out['events']; retries?: number[] }
const VECTORS: Vector[] = [
    // Specification examples
    { name: 'three data lines make one event, joined by line feeds ("YHOO", "+2", "10")', stream: 'data: YHOO\ndata: +2\ndata: 10\n\n', events: [ev('YHOO\n+2\n10')] },
    { name: 'a comment, an id, an event cut off before its blank line, an id with no colon', stream: ': test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n', events: [ev('first event', '1'), ev('second event', '')] },
    { name: 'empty data lines: the first event has empty data, the second a single line feed, and a trailing "data:" is discarded', stream: 'data\n\ndata\ndata\n\ndata:', events: [ev(''), ev('\n')] },
    { name: '"data:test" and "data: test" are the same event data', stream: 'data:test\n\ndata: test\n\n', events: [ev('test'), ev('test')] },
    // Behaviour the specification gives in its algorithm
    { name: 'only one space after the colon is removed', stream: 'data:  two spaces\n\n', events: [ev(' two spaces')] },
    { name: 'an event field names the type, and the next event is back to "message"', stream: 'event: add\ndata: 73857293\n\ndata: next\n\n', events: [ev('73857293', '', 'add'), ev('next')] },
    { name: 'an empty event field resets the type', stream: 'event: add\nevent:\ndata: x\n\n', events: [ev('x')] },
    { name: 'an event with no data is not dispatched, and its type does not carry over', stream: 'event: lost\n\ndata: x\n\n', events: [ev('x')] },
    { name: 'the last event id stays for later events', stream: 'id: 7\ndata: a\n\ndata: b\n\n', events: [ev('a', '7'), ev('b', '7')] },
    { name: 'an id that contains a NUL is ignored', stream: 'id: 7\ndata: a\n\nid: x\u0000y\ndata: b\n\n', events: [ev('a', '7'), ev('b', '7')] },
    { name: 'an empty id resets the id', stream: 'id: 7\ndata: a\n\nid:\ndata: b\n\n', events: [ev('a', '7'), ev('b', '')] },
    { name: 'retry takes digits only', stream: 'retry: 1500\ndata: a\n\nretry: 12ab\nretry:\nretry: 7\n', events: [ev('a')], retries: [1500, 7] },
    { name: 'a field with no colon uses the whole line as its name, with an empty value', stream: 'data\nid\n\n', events: [ev('')] },
    { name: 'field names are case-sensitive: "Data" is not "data"', stream: 'Data: x\n\ndata: y\n\n', events: [ev('y')] },
    { name: 'a line that is only a colon is a comment', stream: ':\ndata: x\n\n', events: [ev('x')] },
    { name: 'a colon inside the value is kept', stream: 'data: a:b:c\n\n', events: [ev('a:b:c')] },
    // Line endings
    { name: 'CRLF, CR and LF all end lines', stream: 'data: a\r\n\r\ndata: b\r\rdata: c\n\n', events: [ev('a'), ev('b'), ev('c')] },
    { name: 'CR then LF is one line ending, not two (so no blank line between)', stream: 'data: a\r\ndata: b\r\n\r\n', events: [ev('a\nb')] },
    // Byte order mark and UTF-8
    { name: 'one byte order mark at the start is removed', stream: '﻿data: a\n\n', events: [ev('a')] },
    { name: 'multi-byte characters survive (2, 3 and 4 bytes)', stream: 'data: é日😀\n\n', events: [ev('é日😀')] },
    // Edges
    { name: 'an empty stream gives nothing', stream: '', events: [] },
    { name: 'a stream of only comments gives nothing', stream: ': a\n: b\n: c\n', events: [] },
    { name: 'blank lines alone give nothing', stream: '\n\n\n', events: [] },
    { name: 'a last event with no blank line is discarded', stream: 'data: a\n\ndata: b', events: [ev('a')] },
]

/** Every way to cut `bytes` into two pieces, and into three. */
function* cuts(bytes: Uint8Array): Generator<Uint8Array[]> {
    yield [bytes]
    for (let i = 0; i < bytes.length; i++) yield [bytes.slice(0, i), bytes.slice(i)]
    for (let i = 0; i < bytes.length; i++) for (let j = i; j < bytes.length; j++) yield [bytes.slice(0, i), bytes.slice(i, j), bytes.slice(j)]
    yield Array.from(bytes, (b) => Uint8Array.of(b)) // byte by byte
}

describe('the specification\'s examples, however the bytes arrive', () => {
    for (const v of VECTORS) {
        it(v.name, () => {
            const bytes = encoder.encode(v.stream)
            const expected: Out = { events: v.events, retries: v.retries ?? [] }
            let tried = 0
            for (const pieces of cuts(bytes)) {
                tried++
                const got = parse(pieces)
                if (JSON.stringify(got) !== JSON.stringify(expected)) {
                    throw new Error(`cut at ${pieces.map((p) => p.length).join('+')} of ${JSON.stringify(v.stream)} gave ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
                }
            }
            expect(tried).toBeGreaterThan(0)
        })
    }

    it('covered a real number of cuts (a harness that tried one cut per vector would prove little)', () => {
        const total = VECTORS.reduce((n, v) => { let c = 0; for (const _ of cuts(encoder.encode(v.stream))) c++; return n + c }, 0)
        expect(total).toBeGreaterThan(10_000)
    })
})
