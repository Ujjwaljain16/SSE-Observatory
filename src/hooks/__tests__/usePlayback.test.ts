import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { usePlayback } from '../usePlayback'
import type { EventMessage } from '../../types'

describe('usePlayback', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    const generateEvents = (count: number): EventMessage[] => {
        return Array.from({ length: count }).map((_, i) => ({
            id: `id-${count - 1 - i}`, // Newest has highest index ID initially
            timestamp: `time-${count - 1 - i}`,
            type: 'message',
            data: `data-${count - 1 - i}`,
            raw: `raw-${count - 1 - i}`,
        }))
    }

    it('returns all events when live', () => {
        const events = generateEvents(5)
        const { result } = renderHook(() => usePlayback(events))

        expect(result.current.isPaused).toBe(false)
        expect(result.current.displayedEvents).toEqual(events)
    })

    it('pauses and freezes displayed events by indexing', () => {
        const initialEvents = generateEvents(5)
        const { result, rerender } = renderHook(({ evs }) => usePlayback(evs), {
            initialProps: { evs: initialEvents }
        })

        act(() => {
            result.current.togglePause()
        })
        expect(result.current.isPaused).toBe(true)

        // Simulate incoming new events
        const newEvents = [
            { id: 'new-1', timestamp: 'x', type: 'message', data: 'x', raw: 'x' },
            ...initialEvents
        ]
        rerender({ evs: newEvents })

        // When a new event arrives, if paused, currentEventIndex should remain wherever the user seeked
        // But the hook relies on currentEventIndex. If they paused at index 0, and a new event arrives,
        // it becomes index 1 effectively for that same event.
        // Actually, our hook didn't implement auto-shifting index on new events!
        // so if we are paused at index 0, we'll just see the newest event arriving rather than freezing on the old one.
        // That's a Known limitation of index-based pausing without ID anchoring, but let's test the hook's current behavior.

        // Wait, currentEventIndex is 0 when we pause.
        // displayedEvents is allEvents.slice(0). So it shows newEvents.
        // Actually since we paused, slice(1) limits it to 5 events
        expect(result.current.displayedEvents.length).toBe(5)
        // The hook increments currentEventIndex by the number of new events (1)
        // so the paused view "stays" on the same event objects
        expect(result.current.currentEventIndex).toBe(1)
    })

    it('handles time travel navigation forward and backward', () => {
        const events = generateEvents(10) // index 0 is newest (id-9), index 9 is oldest (id-0)
        const { result } = renderHook(() => usePlayback(events))

        act(() => {
            result.current.togglePause()
        })

        act(() => {
            result.current.stepBackward() // older --> index increases
        })
        expect(result.current.currentEventIndex).toBe(1)
        expect(result.current.displayedEvents[0].id).toBe('id-8')

        act(() => {
            result.current.stepBackward()
        })
        expect(result.current.currentEventIndex).toBe(2)
        expect(result.current.displayedEvents[0].id).toBe('id-7')

        act(() => {
            result.current.stepForward() // newer --> index decreases
        })
        expect(result.current.currentEventIndex).toBe(1)
        expect(result.current.displayedEvents[0].id).toBe('id-8')
    })

    it('prevents navigating past bounds', () => {
        const events = generateEvents(3)
        const { result } = renderHook(() => usePlayback(events))

        act(() => { result.current.togglePause() })

        act(() => { result.current.stepForward() })
        expect(result.current.currentEventIndex).toBe(0)

        act(() => { result.current.stepBackward() }) // index 1
        act(() => { result.current.stepBackward() }) // index 2
        act(() => { result.current.stepBackward() }) // attempt index 3

        expect(result.current.currentEventIndex).toBe(2)
    })

    it('resumes live playback correctly', () => {
        const events = generateEvents(5)
        const { result } = renderHook(() => usePlayback(events))

        act(() => { result.current.togglePause() })
        act(() => { result.current.stepBackward() })

        expect(result.current.isPaused).toBe(true)
        expect(result.current.currentEventIndex).toBe(1)

        act(() => { result.current.goLive() })

        expect(result.current.isPaused).toBe(false)
        expect(result.current.currentEventIndex).toBe(0)
    })

    it('maintains correct pointer when viewing an event that gets evicted from ring buffer', () => {
        // Imagine buffer limit is 5. We have 5 events.
        const initialEvents = generateEvents(5)
        const { result, rerender } = renderHook(({ evs }) => usePlayback(evs), {
            initialProps: { evs: initialEvents }
        })

        // User pauses and steps back to the oldest event (index 4)
        act(() => { result.current.togglePause() })
        act(() => { result.current.seekTo(4) })

        expect(result.current.currentEventIndex).toBe(4)
        expect(result.current.displayedEvents[0].id).toBe('id-0')

        // Now, the ring buffer overflows and evicts the oldest event ('id-0').
        // The new array still has length 5, but 'id-0' is gone.
        // It's replaced by a new newest event.
        const overflowingEvents = [
            { id: 'new-overflow', timestamp: 'x', type: 'message', data: 'x', raw: 'x' },
            ...initialEvents.slice(0, 4) // Drop the oldest one
        ]
        rerender({ evs: overflowingEvents })

        // Because currentEventIndex is bounded by the length (5), it remains at 4.
        // But the event at index 4 is now 'id-1', not 'id-0'.
        // In a strictly ID-anchored system, it would disconnect.
        // In our index-based sliding window:
        expect(result.current.currentEventIndex).toBe(4) // Clamped to max index
        expect(result.current.displayedEvents[0].id).toBe('id-1') // The oldest *available* event
    })

    it('preserves paused state upon simulated reconnection', () => {
        const events = generateEvents(3)
        const { result, rerender } = renderHook(({ evs }) => usePlayback(evs), {
            initialProps: { evs: events }
        })

        act(() => { result.current.togglePause() })
        expect(result.current.isPaused).toBe(true)

        // Connection drops, array is cleared, then new events arrive
        rerender({ evs: [] })

        // Wait, currentEventIndex should clamp to 0
        expect(result.current.currentEventIndex).toBe(0)
        expect(result.current.isPaused).toBe(true) // Should remain paused!

        rerender({ evs: [{ id: 'reconnected-1', timestamp: 'x', type: 'message', data: 'x', raw: 'x' }] })
        expect(result.current.isPaused).toBe(true)
        expect(result.current.currentEventIndex).toBe(0)
        rerender({ evs: [{ id: 'reconnected-1', timestamp: 'x', type: 'message', data: 'x', raw: 'x' }] })
        expect(result.current.isPaused).toBe(true)
        expect(result.current.currentEventIndex).toBe(0)
    })

    it('handles out-of-order event IDs gracefully (relies strictly on array index)', () => {
        // SSE servers might emit: 10, 11, 8, 12
        const outOfOrderEvents = [
            { id: '12', timestamp: 't4', type: 'message', data: 'd4', raw: 'r4' }, // newest (index 0)
            { id: '8', timestamp: 't3', type: 'message', data: 'd3', raw: 'r3' },
            { id: '11', timestamp: 't2', type: 'message', data: 'd2', raw: 'r2' },
            { id: '10', timestamp: 't1', type: 'message', data: 'd1', raw: 'r1' }, // oldest (index 3)
        ]

        const { result } = renderHook(() => usePlayback(outOfOrderEvents))

        act(() => { result.current.togglePause() })
        act(() => { result.current.stepBackward() }) // index 1 (ID 8)

        expect(result.current.currentEventIndex).toBe(1)
        expect(result.current.displayedEvents[0].id).toBe('8')

        act(() => { result.current.stepBackward() }) // index 2 (ID 11)
        expect(result.current.displayedEvents[0].id).toBe('11')

        act(() => { result.current.stepForward() }) // index 1 (ID 8)
        expect(result.current.displayedEvents[0].id).toBe('8')
    })
})
