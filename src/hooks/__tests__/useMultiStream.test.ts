import { describe, it, expect } from 'vitest'
import { STREAM_COLORS, mergeStreamEvents } from '../useMultiStream'
import type { EventMessage } from '../../types'

const ev = (id: string, arrivalTime?: number): EventMessage =>
    ({ id, timestamp: '', type: 'msg', data: '', raw: '', ...(arrivalTime !== undefined ? { arrivalTime } : {}) })

describe('STREAM_COLORS', () => {
    it('has at least 6 distinct colors', () => {
        expect(STREAM_COLORS.length).toBeGreaterThanOrEqual(6)
        expect(new Set(STREAM_COLORS).size).toBe(STREAM_COLORS.length)
    })
})

describe('mergeStreamEvents', () => {
    it('interleaves streams by arrival time, newest first', () => {
        const a = { events: [ev('a2', 300), ev('a1', 100)] }
        const b = { events: [ev('b2', 200), ev('b1', 50)] }
        expect(mergeStreamEvents([a, b]).map((e) => e.id)).toEqual(['a2', 'b2', 'a1', 'b1'])
    })

    it('treats a missing arrival time as the oldest', () => {
        expect(mergeStreamEvents([{ events: [ev('has', 50), ev('none')] }]).map((e) => e.id)).toEqual(['has', 'none'])
    })

    it('keeps the NEWEST events when capped', () => {
        const events = Array.from({ length: 10 }, (_, i) => ev(String(9 - i), 9 - i))
        expect(mergeStreamEvents([{ events }], 3).map((e) => e.id)).toEqual(['9', '8', '7'])
    })

    it('handles no streams', () => {
        expect(mergeStreamEvents([])).toEqual([])
    })
})
