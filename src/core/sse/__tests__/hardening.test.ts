// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SSEParser, SSEParserError } from '../sseParser'
import type { ViolationCode } from '../violations'
import { CaptureStore } from '../../observe/captureStore'
import type { Observation } from '../../observe/observation'

describe('S10: one event that never ends is bounded', () => {
    it('stops with a violation instead of growing without limit', () => {
        const violations: ViolationCode[] = []
        const parser = new SSEParser({ onMessage: () => {}, onViolation: (v) => violations.push(v.code) }, 10_000)
        const line = `data: ${'x'.repeat(98)}\n`
        let fed = 0
        expect(() => { for (let i = 0; i < 1000; i++) { parser.feed(line); fed++ } }).toThrow(SSEParserError)
        expect(fed).toBeLessThan(200) // 10,000 characters is about a hundred of these lines
        expect(violations).toContain('EVENT_TOO_LONG')
    })

    it('counts event and id lines too, and starts over after the event ends', () => {
        const messages: string[] = []
        const parser = new SSEParser({ onMessage: (m) => messages.push(m.data) }, 2000)
        for (let i = 0; i < 10; i++) parser.feed(`data: ${'y'.repeat(100)}\n\n`) // 10 events of 100 characters: each ends, so none adds up
        expect(messages).toHaveLength(10)
        expect(() => { for (let i = 0; i < 1000; i++) parser.feed('event: a\n') }).toThrow(SSEParserError)
    })

    it('does not stop a normal large event that ends', () => {
        const messages: number[] = []
        const parser = new SSEParser({ onMessage: (m) => messages.push(m.data.length) }, 1_000_000)
        parser.feed(`data: ${'z'.repeat(400_000)}\n\n`)
        expect(messages).toEqual([400_000])
    })
})

describe('S22: an empty chunk between CR and LF', () => {
    const run = (chunks: string[]) => {
        const messages: string[] = []
        const parser = new SSEParser({ onMessage: (m) => messages.push(m.data) })
        for (const c of chunks) parser.feed(c)
        return messages
    }

    it('is not a blank line', () => {
        expect(run(['data: a\r', '', '\n'])).toEqual([])
        expect(run(['data: a\r\n'])).toEqual([])
    })

    it('gives the same events as the chunks without it', () => {
        expect(run(['data: a\r', '', '\n', '\r', '', '\n'])).toEqual(run(['data: a\r\n\r\n']))
        expect(run(['data: a\r', '', '\n\r\n'])).toEqual(['a'])
    })
})

describe('S11: the store forgets comment texts it no longer holds', () => {
    it('does not grow with the number of different comments seen', () => {
        const store = new CaptureStore({ capBytes: 200_000 })
        const keys = () => (store as unknown as { commentsPerKey: Map<string, number> }).commentsPerKey.size
        for (let i = 0; i < 4000; i++) {
            const o: Observation = { seq: i, t: i, conn: 0, kind: 'comment', text: `unique ${String.fromCharCode(97 + (i % 26))}${'q'.repeat(i % 7)} ${i.toString(36)}-${'w'.repeat(500)}`, source: 'upstream' }
            store.append(o)
        }
        expect(store.stats.retainedBytes).toBeLessThanOrEqual(200_000)
        expect(keys()).toBeLessThan(1000) // it was 4000 and growing before
    })

    it('keys a very long comment by its start and length, never by the whole text', () => {
        const store = new CaptureStore({ capBytes: 1_000_000 })
        const text = 'long'.repeat(100_000)
        store.append({ seq: 0, t: 0, conn: 0, kind: 'comment', text, source: 'upstream' })
        const map = (store as unknown as { commentsPerKey: Map<string, number> }).commentsPerKey
        for (const key of map.keys()) expect(key.length).toBeLessThan(300)
    })
})
