import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { shownFor, typeShown } from '../displayMapping'
import { MAX_EVENTS_LOOKED_AT, POINTS, downsample, followField } from '../fieldFollow'
import { listFieldPaths } from '../fieldSuggestions'
import { MAX_PINS, getPins, setPins, subscribePins } from '../pins'
import type { EventMessage } from '../../types'

let n = 0
const ev = (data: unknown, over: Partial<EventMessage> = {}): EventMessage => ({ id: `e${++n}`, timestamp: '', type: 'message', data: typeof data === 'string' ? data : JSON.stringify(data), raw: '', arrivalTime: 0, ...over })
/** Events are newest first in the app; this builds them from oldest to newest and reverses. */
const stream = (...payloads: unknown[]) => payloads.map((p) => ev(p)).reverse()

describe('shownFor (the display mapping)', () => {
    const display = { type: '$.object', summary: '$.choices[0].delta.content', id: '$.id' }

    it('reads type, summary and id from the payload by their paths', () => {
        const e = ev({ object: 'chat.chunk', id: 'cmpl-9', choices: [{ delta: { content: 'Hello' } }] })
        expect(shownFor(e, display)).toEqual({ type: 'chat.chunk', summary: 'Hello', id: 'cmpl-9' })
    })

    it('gives nothing for a part whose path finds nothing, and nothing at all without a mapping or for text that is not JSON', () => {
        expect(shownFor(ev({ object: 'x' }), display)).toEqual({ type: 'x' })
        expect(shownFor(ev({ object: 'x' }), undefined)).toEqual({})
        expect(shownFor(ev('plain text'), display)).toEqual({})
        expect(shownFor(ev({ id: null, object: '  ' }), display)).toEqual({})
    })

    it('writes numbers, booleans and objects as text, and cuts a long value', () => {
        expect(shownFor(ev({ n: 4, ok: false, o: { a: 1 } }), { type: '$.n', summary: '$.o', id: '$.ok' })).toEqual({ type: '4', summary: '{"a":1}', id: 'false' })
        const long = shownFor(ev({ t: 'x'.repeat(500) }), { summary: '$.t' }).summary!
        expect(long.length).toBe(201)
        expect(long.endsWith('…')).toBe(true)
    })

    it('does not follow prototype paths', () => {
        expect(shownFor(ev({ a: 1 }), { summary: '__proto__.polluted' })).toEqual({})
        expect(shownFor(ev({ a: 1 }), { summary: 'constructor.name' })).toEqual({})
    })

    it('typeShown prefers the mapped type and falls back to the usual one', () => {
        expect(typeShown(ev({ kind: 'delta' }, { type: 'message' }), { type: '$.kind' })).toBe('delta')
        expect(typeShown(ev({ other: 1 }, { type: 'message' }), { type: '$.kind' })).toBe('message')
        expect(typeShown(ev({ type: 'tick' }, { type: 'message', parsedType: 'tick' }), undefined)).toBe('tick')
    })
})

describe('followField', () => {
    it('summarises a counter: first, last, min, max, mean, and that every step was +1', () => {
        const f = followField(stream({ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }), '$.n')
        expect(f).toMatchObject({ kind: 'number', total: 4, present: 4, latest: '4', distinct: 4 })
        expect(f.numeric).toMatchObject({ min: 1, max: 4, mean: 2.5, first: 1, last: 4, direction: 'rising', ups: 3, downs: 0, counter: true })
        expect(f.numeric!.points).toEqual([1, 2, 3, 4])
    })

    it('says a series that goes both ways is mixed, one that never changes is flat, and a jump is not a counter', () => {
        expect(followField(stream({ n: 1 }, { n: 5 }, { n: 3 }), 'n').numeric).toMatchObject({ direction: 'mixed', ups: 1, downs: 1, counter: false })
        expect(followField(stream({ n: 7 }, { n: 7 }, { n: 7 }), 'n').numeric).toMatchObject({ direction: 'flat', counter: false })
        expect(followField(stream({ n: 3 }, { n: 2 }, { n: 1 }), 'n').numeric?.direction).toBe('falling')
        expect(followField(stream({ n: 1 }, { n: 2 }, { n: 4 }), 'n').numeric?.counter).toBe(false)
    })

    it('counts the values of a text field, most common first, and says how many events lacked it', () => {
        const f = followField(stream({ s: 'ok' }, { s: 'ok' }, { s: 'slow' }, { other: 1 }, { s: 'ok' }), '$.s')
        expect(f).toMatchObject({ kind: 'text', total: 5, present: 4, distinct: 2, latest: 'ok' })
        expect(f.top).toEqual([{ value: 'ok', count: 3 }, { value: 'slow', count: 1 }])
        expect(f.numeric).toBeUndefined()
    })

    it('knows true/false, mixed kinds, and a field that is nowhere', () => {
        expect(followField(stream({ b: true }, { b: false }, { b: true }), 'b')).toMatchObject({ kind: 'boolean', distinct: 2 })
        expect(followField(stream({ v: 1 }, { v: 'one' }), 'v').kind).toBe('mixed')
        const none = followField(stream({ a: 1 }, 'not json'), '$.zzz')
        expect(none).toMatchObject({ kind: 'none', present: 0, total: 2, distinct: 0 })
        expect(none.numeric).toBeUndefined()
    })

    it('reads the newest first as it is given, so latest is the first event of the list', () => {
        expect(followField([ev({ n: 9 }), ev({ n: 1 })], 'n').latest).toBe('9')
    })

    it('looks only at the newest events up to the limit, and says how many that was', () => {
        const many = Array.from({ length: 50 }, (_, i) => ev({ n: 50 - i })) // newest first: 50 ... 1
        const f = followField(many, 'n', 10)
        expect(f.total).toBe(10)
        expect(f.numeric).toMatchObject({ first: 41, last: 50 })
        expect(MAX_EVENTS_LOOKED_AT).toBeGreaterThanOrEqual(5000) // "thousands" is what this is for
    })

    it('stops counting different values at a limit instead of growing without one, and says so', () => {
        const many = Array.from({ length: 6000 }, (_, i) => ev({ s: `v${i}` }))
        const f = followField(many, 's')
        expect(f.distinct).toBe(5000)
        expect(f.distinctCapped).toBe(true)
    })

    it('does not follow prototype paths', () => {
        expect(followField(stream({ a: 1 }), '__proto__.x').kind).toBe('none')
    })
})

describe('downsample', () => {
    it('keeps a short series as it is', () => {
        expect(downsample([1, 2, 3])).toEqual([1, 2, 3])
    })

    it('shortens a long one to the limit, with the mean of each stretch, keeping its overall shape', () => {
        const long = Array.from({ length: 1200 }, (_, i) => i)
        const d = downsample(long)
        expect(d).toHaveLength(POINTS)
        expect(d[0]).toBeCloseTo(4.5, 5)
        expect(d.every((v, i) => i === 0 || v > d[i - 1]!)).toBe(true)
    })

    it('never makes up a value: every point is between the smallest and largest of the input', () => {
        fc.assert(fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 800 }), (values) => {
            const d = downsample(values, 50)
            const lo = Math.min(...values), hi = Math.max(...values)
            return d.length === Math.min(values.length, 50) && d.every((v) => v >= lo - 1e-9 && v <= hi + 1e-9)
        }), { seed: 14, numRuns: 200 })
    })
})

describe('listFieldPaths', () => {
    it('lists every field of any kind in the latest payloads, once, sorted', () => {
        expect(listFieldPaths([{ a: 1, s: 'x', o: { b: true } }, { a: 2, t: 'y' }, 'not an object'])).toEqual(['$.a', '$.o.b', '$.s', '$.t'])
        expect(listFieldPaths([])).toEqual([])
    })
})

describe('pins', () => {
    beforeEach(() => { localStorage.clear(); setPins([]) })

    it('keeps what was pinned, once each, and gives the same array until it changes', () => {
        setPins(['$.a', '$.b', '$.a'])
        expect(getPins()).toEqual(['$.a', '$.b'])
        expect(getPins()).toBe(getPins())
    })

    it('ignores junk in storage, and keeps no more than the limit', () => {
        localStorage.setItem('sse.doctor.pins', '{ nope')
        expect(getPins()).toEqual([])
        localStorage.setItem('sse.doctor.pins', JSON.stringify([1, '$.ok', 'x'.repeat(300)]))
        expect(getPins()).toEqual(['$.ok'])
        setPins(Array.from({ length: MAX_PINS + 10 }, (_, i) => `$.f${i}`))
        expect(getPins()).toHaveLength(MAX_PINS)
    })

    it('tells subscribers, including when another tab changes them', () => {
        const seen = vi.fn()
        const stop = subscribePins(seen)
        setPins(['$.a'])
        window.dispatchEvent(new StorageEvent('storage', { key: 'sse.doctor.pins' }))
        window.dispatchEvent(new StorageEvent('storage', { key: 'other' }))
        expect(seen).toHaveBeenCalledTimes(2)
        stop()
        setPins([])
        expect(seen).toHaveBeenCalledTimes(2)
    })
})
