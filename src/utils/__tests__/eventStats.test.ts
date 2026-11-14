import { describe, expect, it } from 'vitest'
import type { EventMessage } from '../../types'
import { eventRate, formatRate, toRows, typeShares } from '../eventStats'

let n = 0
const ev = (over: Partial<EventMessage> = {}): EventMessage => ({ id: `e${++n}`, timestamp: '', type: 'message', data: '{}', raw: '', arrivalTime: 0, ...over })

describe('eventRate', () => {
    it('is zero with nothing held or nothing recent', () => {
        expect(eventRate([], 10_000)).toBe(0)
        expect(eventRate([ev({ arrivalTime: 1000 })], 60_000)).toBe(0)
    })

    it('counts the events of the window and divides by the window', () => {
        const events = Array.from({ length: 50 }, (_, i) => ev({ arrivalTime: 100_000 - i * 100 })) // 50 events over the last 4.9 s
        expect(eventRate(events, 100_000, 5000)).toBeCloseTo(10, 0) // 50 events in 4.9 s: about 10 a second
    })

    it('does not call a stream that just started slow: it divides by how long it has run, at least one second', () => {
        const events = [ev({ arrivalTime: 99_500 }), ev({ arrivalTime: 99_700 }), ev({ arrivalTime: 99_900 })]
        expect(eventRate(events, 100_000, 5000)).toBeCloseTo(3, 5) // three events in under a second: a one-second floor, not 3/5
    })

    it('ignores events from the future and events without a time', () => {
        expect(eventRate([ev({ arrivalTime: 200_000 }), ev({ arrivalTime: undefined })], 100_000)).toBe(0)
    })

    it('is worded for a person', () => {
        expect(formatRate(0)).toBe('0 events/s')
        expect(formatRate(2.34)).toBe('2.3 events/s')
        expect(formatRate(48.2)).toBe('48 events/s')
        expect(formatRate(512.7)).toBe('513 events/s')
    })
})

describe('typeShares', () => {
    it('counts by the type a person sees (parsedType first), largest first, with shares that add up', () => {
        const events = [ev({ type: 'message', parsedType: 'tick' }), ev({ type: 'message', parsedType: 'tick' }), ev({ type: 'ping' }), ev({ type: 'message' })]
        const shares = typeShares(events)
        expect(shares.map((s) => [s.type, s.count])).toEqual([['tick', 2], ['message', 1], ['ping', 1]])
        expect(shares.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 10)
    })

    it('folds the tail into one other row and keeps the total', () => {
        const events = Array.from({ length: 12 }, (_, i) => ev({ type: `t${i}` }))
        const shares = typeShares(events, 3)
        expect(shares).toHaveLength(4)
        expect(shares[3]).toMatchObject({ type: 'other', count: 9 })
        expect(shares.reduce((a, s) => a + s.count, 0)).toBe(12)
    })

    it('treats __proto__ as an ordinary name', () => {
        expect(typeShares([ev({ type: '__proto__' }), ev({ type: '__proto__' })])).toEqual([{ type: '__proto__', count: 2, share: 1 }])
    })

    it('is empty with no events', () => { expect(typeShares([])).toEqual([]) })
})

describe('toRows', () => {
    it('is one row per event when nothing is collapsed', () => {
        const events = [ev(), ev()]
        expect(toRows(events, false).map((r) => r.count)).toEqual([1, 1])
    })

    it('collapses a run of identical neighbours and says how many', () => {
        const same = () => ev({ type: 'ping', data: 'pong' })
        const rows = toRows([same(), same(), same(), ev({ type: 'tick', data: '1' })], true)
        expect(rows.map((r) => r.count)).toEqual([3, 1])
        expect(rows[0]!.members).toHaveLength(3)
    })

    it('keeps two identical events apart when something different sits between them', () => {
        const rows = toRows([ev({ data: 'a' }), ev({ data: 'b' }), ev({ data: 'a' })], true)
        expect(rows.map((r) => r.count)).toEqual([1, 1, 1])
    })

    it('does not merge the same data under another event name, or from another stream', () => {
        expect(toRows([ev({ type: 'a', data: 'x' }), ev({ type: 'b', data: 'x' })], true)).toHaveLength(2)
        expect(toRows([ev({ data: 'x', streamId: 's1' }), ev({ data: 'x', streamId: 's2' })], true)).toHaveLength(2)
    })

    it('puts every event in exactly one row, in order', () => {
        const events = [ev({ data: 'a' }), ev({ data: 'a' }), ev({ data: 'b' }), ev({ data: 'b' }), ev({ data: 'b' }), ev({ data: 'a' })]
        const flat = toRows(events, true).flatMap((r) => r.members)
        expect(flat).toEqual(events)
    })
})
