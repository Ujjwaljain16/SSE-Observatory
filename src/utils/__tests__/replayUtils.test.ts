import { describe, it, expect } from 'vitest'
import { createRecording } from '../replayUtils'
import type { EventMessage } from '../../types'

describe('createRecording utility', () => {
    it('creates an empty recording for no events', () => {
        const recording = createRecording([])
        expect(recording.totalEvents).toBe(0)
        expect(recording.durationMs).toBe(0)
        expect(recording.events).toEqual([])
    })

    it('calculates deltaMs accurately for chronological timestamps', () => {
        // Events come from the ring buffer newest first
        const events: EventMessage[] = [
            { id: '3', timestamp: '10:00:02.500', arrivalTime: 1000002500, type: 'message', data: 'last', raw: 'raw' },
            { id: '2', timestamp: '10:00:01.500', arrivalTime: 1000001500, type: 'message', data: 'mid', raw: 'raw' },
            { id: '1', timestamp: '10:00:01.000', arrivalTime: 1000001000, type: 'message', data: 'first', raw: 'raw' }
        ]

        const recording = createRecording(events)

        expect(recording.totalEvents).toBe(3)
        // total duration should track start to end
        // first event is delta 0
        // second event is at .500 (diff 500)
        // third event is at .500 (diff 1000)
        // total duration = 1500
        expect(recording.durationMs).toBe(1500)

        // Output is chronological
        expect(recording.events[0].id).toBe('1')
        expect(recording.events[0].deltaMs).toBe(0)

        expect(recording.events[1].id).toBe('2')
        expect(recording.events[1].deltaMs).toBe(500)

        expect(recording.events[2].id).toBe('3')
        expect(recording.events[2].deltaMs).toBe(1000)
    })

    it('handles midnight crossovers', () => {
        const events: EventMessage[] = [
            { id: '2', timestamp: '00:00:01.000', arrivalTime: 1700000001000, type: 'message', data: 'day2', raw: 'raw' },
            { id: '1', timestamp: '23:59:59.000', arrivalTime: 1699999999000, type: 'message', data: 'day1', raw: 'raw' }
        ]

        const recording = createRecording(events)

        expect(recording.events[1].deltaMs).toBe(2000) // 2 sec passed across midnight
        expect(recording.durationMs).toBe(2000)
    })
})
