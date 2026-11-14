// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SSEParser } from '../sseParser'

// The resume cursor (what the client sends as Last-Event-ID after a disconnect) is the parser's `lastId`. In the specification an `id` field only
// sets the "last event ID BUFFER"; the "last event ID STRING", which is what a reconnecting client sends, takes the buffer's value when an event is
// DISPATCHED (a blank line), and an event cut off by the end of the connection is discarded with its buffer. So a client that loses the connection
// in the middle of event 2 must ask for the events after 1, not after 2, or event 2 is lost for good: the server believes it was delivered.
//
// Found by the proxy-in-the-loop test (proxyInTheLoop.test.ts), where the upstream's request log showed `Last-Event-ID: 2` for an event that never arrived.

const feed = (pieces: string[]): SSEParser => {
    const parser = new SSEParser({ onMessage: () => undefined })
    for (const p of pieces) parser.feed(p)
    return parser
}

describe('the resume cursor moves when an event is dispatched, not when its id line is read', () => {
    it('an id line of an event that is still arriving does not move it', () => {
        expect(feed(['id: 1\ndata: a\n\nid: 2\ndata: par']).lastId).toBe('1')
    })

    it('...and it moves once the event is complete', () => {
        expect(feed(['id: 1\ndata: a\n\nid: 2\ndata: par', 'tial\n\n']).lastId).toBe('2')
    })

    it('an event cut off by the end of the connection leaves the cursor where the last complete event put it', () => {
        const parser = feed(['id: 1\ndata: a\n\nid: 2\ndata: par'])
        parser.end(true)
        expect(parser.lastId).toBe('1')
    })

    it('an id line with nothing after it (no blank line yet) does not move it either', () => {
        expect(feed(['id: 5']).lastId).toBe('')
        expect(feed(['id: 5\n']).lastId).toBe('')
    })

    it('an id-only frame moves it when its blank line arrives (the specification dispatches, and the empty data discards the event, but the id stands)', () => {
        expect(feed(['id: 5\n\n']).lastId).toBe('5')
    })

    it('an id line with no colon resets it, at the blank line', () => {
        const parser = feed(['id: 3\ndata: a\n\nid\ndata: b'])
        expect(parser.lastId).toBe('3')
        parser.feed('\n\n')
        expect(parser.lastId).toBe('')
    })

    it('the last id line of an event wins, and an id with a NUL in it is ignored', () => {
        expect(feed(['id: 7\nid: 8\ndata: x\n\n']).lastId).toBe('8')
        expect(feed(['id: 7\ndata: x\n\nid: 9\u00009\ndata: y\n\n']).lastId).toBe('7')
    })

    it('a cursor seeded by the caller (a client taking over a stream) survives an event that is cut off', () => {
        const parser = new SSEParser({ onMessage: () => undefined })
        parser.setLastEventId('41')
        parser.feed('id: 42\ndata: par')
        parser.end(true)
        expect(parser.lastId).toBe('41')
    })

    it('however the bytes are cut, the cursor after "event 1, then half of event 2" is 1', () => {
        const stream = 'id: 1\ndata: a\n\nid: 2\ndata: b'
        for (let cut = 0; cut <= stream.length; cut++) {
            const parser = feed([stream.slice(0, cut), stream.slice(cut)])
            expect(parser.lastId, `cut at ${cut}`).toBe(cut >= 'id: 1\ndata: a\n\n'.length ? '1' : cut >= stream.length ? '1' : '')
        }
    })
})
