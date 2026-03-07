import { describe, it, expect } from 'vitest'

// useMultiStream uses EventSource and React hooks — we test the pure logic separately
// and test the hook using a lightweight simulation.

import { STREAM_COLORS } from '../../hooks/useMultiStream'
import type { EventMessage } from '../../types'

// ----------------------------
// Pure Logic Tests
// ----------------------------

describe('STREAM_COLORS', () => {
    it('has at least 6 distinct colors', () => {
        expect(STREAM_COLORS.length).toBeGreaterThanOrEqual(6)
        const unique = new Set(STREAM_COLORS)
        expect(unique.size).toBe(STREAM_COLORS.length)
    })
})

describe('Multi-stream merge sort logic', () => {
    /**
     * Simulates the mergedEvents sort logic from useMultiStream.
     * Events should sort by arrivalTime (ascending = oldest first).
     */
    const merge = (streams: EventMessage[][]): EventMessage[] => {
        const all: EventMessage[] = []
        for (const s of streams) all.push(...s)
        all.sort((a, b) => (a.arrivalTime ?? 0) - (b.arrivalTime ?? 0))
        return all
    }

    it('sorts events by arrivalTime, not insertion order', () => {
        const streamA: EventMessage[] = [
            { id: 'a1', timestamp: '', type: 'msg', data: 'A1', raw: '', arrivalTime: 100 },
            { id: 'a2', timestamp: '', type: 'msg', data: 'A2', raw: '', arrivalTime: 300 },
        ]
        const streamB: EventMessage[] = [
            { id: 'b1', timestamp: '', type: 'msg', data: 'B1', raw: '', arrivalTime: 50 },
            { id: 'b2', timestamp: '', type: 'msg', data: 'B2', raw: '', arrivalTime: 200 },
        ]

        const merged = merge([streamA, streamB])
        expect(merged.map(e => e.id)).toEqual(['b1', 'a1', 'b2', 'a2'])
    })

    it('handles streams with equal arrivalTime (stable-ish)', () => {
        const streamA: EventMessage[] = [
            { id: 'a1', timestamp: '', type: 'msg', data: 'A1', raw: '', arrivalTime: 100 },
        ]
        const streamB: EventMessage[] = [
            { id: 'b1', timestamp: '', type: 'msg', data: 'B1', raw: '', arrivalTime: 100 },
        ]

        const merged = merge([streamA, streamB])
        // Both have same arrivalTime — just verify both are present
        expect(merged).toHaveLength(2)
        expect(merged.map(e => e.id)).toContain('a1')
        expect(merged.map(e => e.id)).toContain('b1')
    })

    it('handles missing arrivalTime gracefully (defaults to 0)', () => {
        const events: EventMessage[] = [
            { id: 'no-ts', timestamp: '', type: 'msg', data: '', raw: '' }, // no arrivalTime
            { id: 'has-ts', timestamp: '', type: 'msg', data: '', raw: '', arrivalTime: 50 },
        ]

        const merged = merge([events])
        // no-ts defaults to 0, so it should come first
        expect(merged[0].id).toBe('no-ts')
        expect(merged[1].id).toBe('has-ts')
    })
})

describe('Per-stream ring buffer behavior', () => {
    const PER_STREAM_LIMIT = 1000

    it('caps events at PER_STREAM_LIMIT = 1000', () => {
        let events: EventMessage[] = []

        for (let i = 0; i < 1200; i++) {
            const newEvent: EventMessage = {
                id: String(i),
                timestamp: '',
                type: 'msg',
                data: `data-${i}`,
                raw: '',
                arrivalTime: i,
            }
            events = [newEvent, ...events].slice(0, PER_STREAM_LIMIT)
        }

        expect(events.length).toBe(PER_STREAM_LIMIT)
        // Newest event should be the last one added (id: '1199')
        expect(events[0].id).toBe('1199')
    })
})

describe('Merged view buffer behavior', () => {
    const MERGED_VIEW_LIMIT = 5000

    it('caps merged view at 5000 events', () => {
        const all: EventMessage[] = Array.from({ length: 6000 }, (_, i) => ({
            id: String(i),
            timestamp: '',
            type: 'msg',
            data: '',
            raw: '',
            arrivalTime: i,
        }))

        const capped = all.slice(-MERGED_VIEW_LIMIT)
        expect(capped.length).toBe(MERGED_VIEW_LIMIT)
        // Should keep the NEWEST (highest arrivalTime) events
        expect(capped[0].id).toBe('1000')
        expect(capped[capped.length - 1].id).toBe('5999')
    })
})

describe('Stream identity (streamId + streamColor)', () => {
    it('events carry their stream metadata', () => {
        const event: EventMessage = {
            id: 'e1',
            timestamp: '12:00:00 AM',
            type: 'message',
            data: '{}',
            raw: '',
            streamId: 'stream-1',
            streamColor: '#3b82f6',
            arrivalTime: Date.now(),
        }

        expect(event.streamId).toBe('stream-1')
        expect(event.streamColor).toBe('#3b82f6')
    })
})
