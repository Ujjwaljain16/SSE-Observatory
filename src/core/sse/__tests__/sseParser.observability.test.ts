import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { SSEParser, type SSEMessage, type SSEViolation } from '../sseParser'
import { VIOLATIONS, violationSeverity, type ViolationCode } from '../violations'
import { utf8Length } from '../utf8'

function observe(chunks: Array<string | Uint8Array>, options: { end?: boolean | 'quiet' } = {}) {
    const messages: SSEMessage[] = []
    const comments: string[] = []
    const retries: number[] = []
    const violations: SSEViolation[] = []
    const parser = new SSEParser({
        onMessage: (m) => messages.push(m),
        onRetry: (ms) => retries.push(ms),
        onComment: (text) => comments.push(text),
        onViolation: (v) => violations.push(v),
    })
    chunks.forEach((chunk) => parser.feed(chunk))
    if (options.end) parser.end(options.end !== 'quiet')
    return { messages, comments, retries, violations, parser, codes: violations.map((v) => v.code) }
}

describe('SSEParser observability: what the spec ignores is still visible', () => {
    it('reports comments (heartbeats) with the colon and one leading space removed', () => {
        const r = observe([': keep-alive\n\n:no-space\n\ndata: x\n\n'])
        expect(r.comments).toEqual(['keep-alive', 'no-space'])
        expect(r.messages).toHaveLength(1)
    })

    it('reports a valid retry and flags an invalid one without changing the stream', () => {
        const r = observe(['retry: 2500\nretry: soon\nretry: 12x\ndata: a\n\n'])
        expect(r.retries).toEqual([2500])
        expect(r.codes).toEqual(['INVALID_RETRY', 'INVALID_RETRY'])
        expect(r.messages.map((m) => m.data)).toEqual(['a'])
    })

    it('tells a wrong-case field name (likely a producer bug) from a plain unknown field', () => {
        const r = observe(['Data: lost\nEVENT: x\nfoo: bar\ndata: kept\n\n'])
        expect(r.codes).toEqual(['WRONG_CASE_FIELD', 'WRONG_CASE_FIELD', 'UNKNOWN_FIELD'])
        expect(r.messages).toHaveLength(1)
        expect(r.messages[0]?.data).toBe('kept') // the mis-cased line really was ignored, as the spec says
        expect(r.violations[0]?.detail).toContain('Data')
    })

    it('flags an id containing NUL as a warning and keeps the previous id', () => {
        const r = observe(['id: 1\ndata: a\n\nid: 2\u00003\ndata: b\n\n'])
        expect(r.codes).toEqual(['NUL_IN_ID'])
        expect(r.messages.map((m) => m.id)).toEqual(['1', '1'])
    })

    it('reports id-only and field-only frames, but not a retry-only frame (normal and common)', () => {
        const r = observe(['id: 5\n\nevent: x\n\nretry: 1000\n\ndata: ok\n\n'])
        expect(r.codes).toEqual(['ID_ONLY_FRAME', 'FRAME_WITHOUT_DATA'])
        expect(r.parser.lastId).toBe('5') // the id-only frame still moved the cursor
        expect(r.messages).toHaveLength(1)
    })

    it('reports a line with no colon', () => {
        expect(observe(['data\n\n']).codes).toEqual(['LINE_NO_COLON'])
    })

    it('reports a BOM at the start as info, and a BOM at the start of a later line', () => {
        expect(observe(['﻿data: x\n\n']).codes).toEqual(['BOM_STRIPPED'])
        const r = observe(['data: x\n\n', '﻿data: y\n\n'])
        expect(r.codes).toContain('BOM_MIDSTREAM')
    })

    it('reports mixed line endings once, and not for a CRLF split across chunks', () => {
        expect(observe(['data: a\n\ndata: b\r\n\r\n']).codes).toEqual(['MIXED_LINE_ENDINGS'])
        expect(observe(['data: a\n\ndata: b\r\n\r\ndata: c\r\r']).codes.filter((c) => c === 'MIXED_LINE_ENDINGS')).toHaveLength(1)
        expect(observe(['data: a\r', '\n\r', '\ndata: b\r\n\r\n']).codes).toEqual([]) // pure CRLF, split mid-pair
    })

    it('reports an event cut off by the end of the connection (data is lost) but not when we ended it ourselves', () => {
        const cut = observe(['data: complete\n\ndata: half'], { end: true })
        expect(cut.codes).toEqual(['UNTERMINATED_FRAME'])
        expect(cut.violations[0]?.detail).toContain(`${utf8Length('data: half')} bytes`)
        expect(observe(['data: complete\n\ndata: half'], { end: 'quiet' }).codes).toEqual([])
        expect(observe(['data: complete\n\n'], { end: true }).codes).toEqual([]) // clean end, nothing to report
    })

    it('labels each violation with the chunk it was noticed in', () => {
        const r = observe(['data: ok\n\n', 'foo: x\n', 'bar: y\n\n'])
        // chunk 1: unknown field "foo"; chunk 2: unknown field "bar", then the blank line ends a frame that had no data
        expect(r.violations.map((v) => [v.code, v.chunk])).toEqual([['UNKNOWN_FIELD', 1], ['UNKNOWN_FIELD', 2], ['FRAME_WITHOUT_DATA', 2]])
    })

    it('exposes atBoundary and pendingBytes so a stuck partial frame can be told from silence', () => {
        const parser = new SSEParser({ onMessage: () => {}, onViolation: () => {} })
        expect(parser.atBoundary).toBe(true)
        parser.feed('data: part')
        expect(parser.atBoundary).toBe(false)
        expect(parser.pendingBytes).toBe(utf8Length('data: part'))
        parser.feed('ial\n')
        expect(parser.atBoundary).toBe(false)
        parser.feed('\n')
        expect(parser.atBoundary).toBe(true)
        expect(parser.pendingBytes).toBe(0)
    })

    it('never raises a violation on a healthy stream (CRLF, comments, multi-line data, named events, ids)', () => {
        const healthy = ': hello\r\nevent: order\r\nid: 1\r\ndata: {"a":1}\r\n\r\nid: 2\r\ndata: line1\r\ndata: line2\r\n\r\nretry: 3000\r\n\r\n: ping\r\n\r\n'
        const r = observe([healthy], { end: true })
        expect(r.codes).toEqual([])
        expect(r.messages.map((m) => m.data)).toEqual(['{"a":1}', 'line1\nline2'])
    })
})

describe('severity follows the spec', () => {
    it('only genuine failures are errors; ignored or normalised things are never errors', () => {
        const errors = (Object.keys(VIOLATIONS) as ViolationCode[]).filter((c) => violationSeverity(c) === 'error').sort()
        expect(errors).toEqual(['BAD_CONTENT_TYPE', 'EVENT_TOO_LONG', 'HTTP_STATUS_NOT_200', 'LINE_TOO_LONG'])
        for (const code of ['UNKNOWN_FIELD', 'INVALID_RETRY', 'ID_ONLY_FRAME', 'BOM_STRIPPED', 'LINE_NO_COLON', 'MIXED_LINE_ENDINGS'] as const) {
            expect(violationSeverity(code)).toBe('info')
        }
        for (const code of ['UNTERMINATED_FRAME', 'NUL_IN_ID', 'WRONG_CASE_FIELD'] as const) {
            expect(violationSeverity(code)).toBe('warning')
        }
    })
})

describe('observing must not change parsing', () => {
    // Same bytes, any chunking: the messages and the last id are identical with and without diagnostics handlers.
    const stream = ': hi\nevent: a\nid: 1\ndata: one\n\nFoo: bar\nid: 2\ndata: two\ndata: 2b\n\nretry: x\nid: 3\n\ndata: tail\n\n'
    it('produces identical messages for any chunking', () => {
        fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: stream.length }), { maxLength: 20 }), (cuts) => {
            const points = [...new Set(cuts)].sort((a, b) => a - b)
            const pieces: string[] = []
            let last = 0
            for (const p of points) { pieces.push(stream.slice(last, p)); last = p }
            pieces.push(stream.slice(last))

            const plain: SSEMessage[] = []
            const plainParser = new SSEParser({ onMessage: (m) => plain.push(m) })
            const watched = observe(pieces)
            pieces.forEach((piece) => plainParser.feed(piece))
            expect(watched.messages).toEqual(plain)
            expect(watched.parser.lastId).toBe(plainParser.lastId)
        }), { numRuns: 200 })
    })

    it('reports the same violations however the bytes are split, including multi-byte characters split mid-sequence', () => {
        const bytes = new TextEncoder().encode('data: héllo 😀\n\nFoo: ü\nid: 9\n\n')
        const whole = observe([bytes]).codes
        fc.assert(fc.property(fc.integer({ min: 1, max: bytes.length - 1 }), (cut) => {
            expect(observe([bytes.slice(0, cut), bytes.slice(cut)]).codes).toEqual(whole)
        }), { numRuns: 100 })
    })
})

describe('utf8Length', () => {
    it('matches TextEncoder', () => {
        fc.assert(fc.property(fc.string({ unit: 'binary' }), (text) => {
            expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length)
        }), { numRuns: 300 })
        expect(utf8Length('héllo 😀')).toBe(new TextEncoder().encode('héllo 😀').length)
    })
})
