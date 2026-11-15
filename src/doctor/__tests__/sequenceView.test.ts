import { describe, expect, it } from 'vitest'
import { readSequence, trustOf } from '../sequenceView'
import { suggestFields } from '../fieldSuggestions'
import type { Observation } from '../../core/observe/observation'

let n = 0
const event = (seq: number | string | undefined, extra: { partition?: string; conn?: number } = {}): Observation => ({
    seq: n++, t: n * 10, conn: extra.conn ?? 0, kind: 'event', event: 'tick', sseId: '', dataBytes: 5,
    ...(seq !== undefined || extra.partition !== undefined ? { extracted: { ...(seq !== undefined ? { seq } : {}), ...(extra.partition !== undefined ? { partition: extra.partition } : {}) } } : {}),
})
const states = (values: Array<number | string | undefined>, policy: 'consecutive' | 'monotonic' = 'consecutive') => readSequence(values.map((v) => event(v)), policy).cells.map((c) => c.state)

describe('readSequence', () => {
    it('calls the next number ok, and starts anywhere', () => {
        expect(states([7, 8, 9])).toEqual(['ok', 'ok', 'ok'])
    })

    it('marks skipped numbers on the event after the gap, with the range', () => {
        const r = readSequence([event(1), event(2), event(5)].map((x) => x), 'consecutive')
        expect(r.cells.map((c) => c.state)).toEqual(['ok', 'ok', 'gap'])
        expect(r.cells[2]!.missing).toEqual({ from: 3, to: 4 })
    })

    it('a jump is fine under a monotonic policy', () => {
        expect(states([1, 2, 5, 9], 'monotonic')).toEqual(['ok', 'ok', 'ok', 'ok'])
    })

    it('marks repeats and numbers that went backwards', () => {
        expect(states([1, 2, 3, 3, 2, 4])).toEqual(['ok', 'ok', 'ok', 'duplicate', 'duplicate', 'ok'])
        expect(states([1, 2, 5, 3])).toEqual(['ok', 'ok', 'gap', 'backward'])
    })

    it('reads numbers written as text, and counts events it cannot read instead of guessing', () => {
        const r = readSequence([event('4'), event('5'), event(undefined), event('x')], 'consecutive')
        expect(r.cells.map((c) => c.value)).toEqual([4, 5])
        expect(r.unreadable).toBe(2)
    })

    it('keeps each partition on its own count', () => {
        const r = readSequence([event(1, { partition: 'a' }), event(1, { partition: 'b' }), event(2, { partition: 'a' }), event(2, { partition: 'b' })], 'consecutive')
        expect(r.cells.map((c) => c.state)).toEqual(['ok', 'ok', 'ok', 'ok'])
    })

    it('ignores records that are not events, and keeps only the most recent cells', () => {
        const many = Array.from({ length: 600 }, (_, i) => event(i))
        const r = readSequence([{ seq: 9999, t: 1, conn: 0, kind: 'chunk', bytes: 3 }, ...many], 'consecutive', 400)
        expect(r.cells.length).toBe(400)
        expect(r.cells.at(-1)!.value).toBe(599)
    })
})

describe('trustOf', () => {
    it('only a declaration is trusted', () => {
        expect(trustOf(true, [])).toBe('declared')
    })
    it('ids that look like a counter are a hint, never a verdict', () => {
        expect(trustOf(false, ['1', '2', '3', '4', '5', '6'])).toBe('inferred')
    })
    it('opaque or irregular ids give nothing', () => {
        expect(trustOf(false, ['a1', 'b2', 'c3', 'd4', 'e5'])).toBe('none')
        expect(trustOf(false, ['104', '111', '112', '120', '125'])).toBe('none')
        expect(trustOf(false, ['1', '2'])).toBe('none')
    })
})

describe('suggestFields', () => {
    const payloads = Array.from({ length: 6 }, (_, i) => ({ seq: 100 + i, ts: 1_700_000_000_000 + i * 1000, at: `2026-01-01T00:00:0${i}Z`, shard: 'a', price: 3.5 + i, name: 'x', nested: { n: 10 + i, flag: true } }))

    it('finds the counter first, then timestamps, then other numbers', () => {
        const found = suggestFields(payloads)
        expect(found[0]).toMatchObject({ path: '$.nested.n', kind: 'counter' })
        const byPath = Object.fromEntries(found.map((f) => [f.path, f.kind]))
        expect(byPath['$.seq']).toBe('counter')
        expect(byPath['$.ts']).toBe('timestamp')
        expect(byPath['$.at']).toBe('timestamp')
        expect(byPath['$.price']).toBe('number')
        expect(byPath['$.name']).toBeUndefined() // text that is not a date is no candidate
        expect(byPath['$.nested.flag']).toBeUndefined()
    })

    it('a number that does not step by one is not called a counter', () => {
        const found = suggestFields([{ v: 1 }, { v: 3 }, { v: 4 }, { v: 9 }])
        expect(found.find((f) => f.path === '$.v')).toMatchObject({ kind: 'number', counter: false })
    })

    it('copes with payloads that are not objects, and with nothing', () => {
        expect(suggestFields([])).toEqual([])
        expect(() => suggestFields(['text', 5, null, [1, 2, 3]])).not.toThrow()
    })

    it('does not follow keys that are not plain names (no prototype or odd paths)', () => {
        const found = suggestFields([{ 'a b': 1 }, { 'a b': 2 }, { 'a b': 3 }])
        expect(found).toEqual([])
    })
})
