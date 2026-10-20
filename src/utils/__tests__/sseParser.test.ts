import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { SSEParser, SSEParserError, type SSEMessage } from '../sseParser'

function parseAll(chunks: Array<string | Uint8Array>) {
    const messages: SSEMessage[] = []
    const retries: number[] = []
    const parser = new SSEParser({ onMessage: (m) => messages.push(m), onRetry: (ms) => retries.push(ms) })
    for (const c of chunks) parser.feed(c)
    return { messages, retries, parser }
}
const one = (text: string) => parseAll([text])

describe('SSEParser (spec behaviour)', () => {
    it('parses a simple event, defaulting the name to "message"', () => {
        const { messages } = one('data: hello\n\n')
        expect(messages).toEqual([{ event: 'message', data: 'hello', id: '', raw: 'data: hello' }])
    })

    it('keeps named events (the thing EventSource.onmessage drops)', () => {
        const { messages } = one('event: order\ndata: {"id":1}\n\nevent: payment\ndata: x\n\n')
        expect(messages.map((m) => m.event)).toEqual(['order', 'payment'])
    })

    it('joins multi-line data with \\n and strips exactly one leading space', () => {
        expect(one('data: a\ndata:  b\ndata:c\n\n').messages[0].data).toBe('a\n b\nc')
        expect(one('data\n\n').messages.map((m) => m.data)).toEqual(['']) // an empty data line still dispatches (spec)
        expect(one('data:\n\n').messages.map((m) => m.data)).toEqual([''])
        expect(one('event: x\n\n').messages).toEqual([]) // no data field at all → nothing dispatched
        expect(one('data:\ndata:\n\n').messages[0].data).toBe('\n')
    })

    it('ignores comments and unknown fields', () => {
        const { messages } = one(': keep-alive\nfoo: bar\ndata: x\n\n')
        expect(messages).toHaveLength(1)
        expect(messages[0].data).toBe('x')
    })

    it('handles LF, CR and CRLF line endings', () => {
        for (const nl of ['\n', '\r', '\r\n']) {
            const { messages } = one(`event: e${nl}data: 1${nl}${nl}data: 2${nl}${nl}`)
            expect(messages.map((m) => [m.event, m.data])).toEqual([['e', '1'], ['message', '2']])
        }
    })

    it('handles CRLF split across chunks and CR at a chunk end', () => {
        expect(parseAll(['data: a\r', '\ndata: b\r\n', '\r', '\n']).messages.map((m) => m.data)).toEqual(['a\nb'])
        expect(parseAll(['data: x\r', '\r', 'data: y\r\r']).messages.map((m) => m.data)).toEqual(['x', 'y'])
    })

    it('tracks the last event id and keeps it for later events', () => {
        const { messages, parser } = one('id: 7\ndata: a\n\ndata: b\n\nid: 9\ndata: c\n\n')
        expect(messages.map((m) => m.id)).toEqual(['7', '7', '9'])
        expect(parser.lastId).toBe('9')
    })

    it('ignores ids containing NUL; an empty id resets it', () => {
        const { messages } = one('id: a\ndata: 1\n\nid: b\0c\ndata: 2\n\nid\ndata: 3\n\n')
        expect(messages.map((m) => m.id)).toEqual(['a', 'a', ''])
    })

    it('reports retry only for digit-only values', () => {
        expect(one('retry: 1500\n\n').retries).toEqual([1500])
        expect(one('retry: abc\nretry: 12x\n\n').retries).toEqual([])
    })

    it('strips a UTF-8 BOM and decodes multi-byte characters split across chunks', () => {
        const bytes = new TextEncoder().encode('﻿data: héllo ✓ 🎉\n\n')
        for (let split = 1; split < bytes.length; split++) {
            const { messages } = parseAll([bytes.slice(0, split), bytes.slice(split)])
            expect(messages.map((m) => m.data)).toEqual(['héllo ✓ 🎉'])
        }
    })

    it('discards an unterminated event at end of stream', () => {
        const { messages, parser } = one('data: complete\n\ndata: partial')
        parser.end()
        expect(messages.map((m) => m.data)).toEqual(['complete'])
    })

    it('does not treat a lone "data" prefix inside another field name as data', () => {
        expect(one('database: x\n\n').messages).toEqual([])
    })

    it('rejects absurdly long lines instead of buffering forever', () => {
        const parser = new SSEParser({ onMessage: () => {} }, 1024)
        expect(() => parser.feed('data: ' + 'x'.repeat(2000))).toThrow(SSEParserError)
    })
})

describe('SSEParser (properties)', () => {
    const eventArb = fc.record({
        event: fc.option(fc.stringMatching(/^[a-z]{1,8}$/), { nil: undefined }),
        id: fc.option(fc.stringMatching(/^[a-z0-9]{1,6}$/), { nil: undefined }),
        data: fc.array(fc.string({ maxLength: 12 }).filter((s) => !/[\r\n]/.test(s)), { minLength: 1, maxLength: 3 }),
        comment: fc.boolean(),
    })
    const eol = fc.constantFrom('\n', '\r\n', '\r')

    it('output is independent of how the byte stream is chunked', () => {
        fc.assert(fc.property(fc.array(eventArb, { maxLength: 8 }), eol, fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 40 }), (events, nl, sizes) => {
            const text = events.map((e) =>
                (e.comment ? `: c${nl}` : '') +
                (e.event ? `event: ${e.event}${nl}` : '') +
                (e.id ? `id: ${e.id}${nl}` : '') +
                e.data.map((d) => `data: ${d}${nl}`).join('') + nl
            ).join('')
            const bytes = new TextEncoder().encode(text)
            const whole = parseAll([bytes]).messages
            const chunks: Uint8Array[] = []
            for (let i = 0, k = 0; i < bytes.length; k++) {
                const size = sizes[k % sizes.length]
                chunks.push(bytes.slice(i, i + size))
                i += size
            }
            const pieces = parseAll(chunks).messages
            return JSON.stringify(whole) === JSON.stringify(pieces)
        }), { numRuns: 300 })
    })

    it('never throws on arbitrary input', () => {
        fc.assert(fc.property(fc.array(fc.string({ maxLength: 30 }), { maxLength: 10 }), (parts) => {
            const parser = new SSEParser({ onMessage: () => {} })
            for (const p of parts) parser.feed(p)
            parser.end()
            return true
        }), { numRuns: 300 })
    })
})
