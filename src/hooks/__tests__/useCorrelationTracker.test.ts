import { renderHook } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useCorrelationTracker, extractCorrelation, MAX_TRACES, MAX_EVENTS_PER_TRACE } from '../useCorrelationTracker'
import type { EventMessage } from '../../types'

let n = 0
const ev = (data: unknown, arrivalTime = n, type = 'message'): EventMessage =>
    ({ id: `e${n++}`, type, timestamp: '', raw: '', arrivalTime, data: JSON.stringify(data) })

describe('extractCorrelation', () => {
    it('finds trace/request/correlation ids at the top level and one level down', () => {
        expect(extractCorrelation(ev({ traceId: 'T1' }))).toEqual({ id: 'T1', field: 'traceId' })
        expect(extractCorrelation(ev({ 'x-request-id': 'R1' }))).toEqual({ id: 'R1', field: 'x-request-id' })
        expect(extractCorrelation(ev({ meta: { correlationId: 'C1' } }))).toEqual({ id: 'C1', field: 'meta.correlationId' })
        expect(extractCorrelation(ev({ headers: { 'x-request-id': 'H1' } }))).toEqual({ id: 'H1', field: 'headers.x-request-id' })
    })
    it('prefers traceId over requestId and ignores per-span / per-user ids', () => {
        expect(extractCorrelation(ev({ requestId: 'R', traceId: 'T' }))?.id).toBe('T')
        expect(extractCorrelation(ev({ spanId: 'S', userId: 'U', sessionId: 'X' }))).toBeNull()
    })
    it('ignores non-JSON and arrays', () => {
        expect(extractCorrelation({ ...ev({}), data: 'plain' })).toBeNull()
        expect(extractCorrelation(ev([{ traceId: 'T' }]))).toBeNull()
    })
})

describe('useCorrelationTracker', () => {
    it('groups events into traces, oldest first, and remembers which trace an event is in', () => {
        const a1 = ev({ traceId: 'A' }, 1, 'start')
        const b1 = ev({ traceId: 'B' }, 2)
        const a2 = ev({ traceId: 'A' }, 3, 'end')
        const buf = [a2, b1, a1] // newest first (must be a stable reference, like the real buffer)
        const { result } = renderHook(() => useCorrelationTracker(buf))
        expect(result.current.traceCount).toBe(2)
        expect(result.current.traces.get('A')!.events.map((e) => e.id)).toEqual([a1.id, a2.id])
        expect(result.current.traces.get('A')!.services).toEqual(['start', 'end'])
        expect(result.current.getTraceForEvent(b1)?.id).toBe('B')
        expect(result.current.getEventChain('A')).toHaveLength(2)
    })

    it('keeps tracking after the ring buffer is full (length no longer changes)', () => {
        const CAP = 5
        let buf: EventMessage[] = []
        const { result, rerender } = renderHook(({ e }) => useCorrelationTracker(e), { initialProps: { e: buf } })
        for (let i = 0; i < 40; i++) {
            buf = [ev({ traceId: `T${i}` }), ...buf].slice(0, CAP)
            rerender({ e: buf })
        }
        expect(result.current.traceCount).toBe(40)
        expect(result.current.traces.has('T39')).toBe(true)
    })

    it('is bounded: oldest traces are evicted and per-trace events are capped', () => {
        let buf: EventMessage[] = []
        const { result, rerender } = renderHook(({ e }) => useCorrelationTracker(e), { initialProps: { e: buf } })
        const batch: EventMessage[] = []
        for (let i = 0; i < MAX_TRACES + 50; i++) batch.unshift(ev({ traceId: `T${i}` }))
        buf = batch
        rerender({ e: buf })
        expect(result.current.traceCount).toBe(MAX_TRACES)
        expect(result.current.traces.has('T0')).toBe(false)
        expect(result.current.traces.has(`T${MAX_TRACES + 49}`)).toBe(true)

        const many: EventMessage[] = []
        for (let i = 0; i < MAX_EVENTS_PER_TRACE + 30; i++) many.unshift(ev({ traceId: 'BIG' }, 100000 + i))
        rerender({ e: [...many, ...buf].slice(0, 1000) })
        expect(result.current.traces.get('BIG')!.events).toHaveLength(MAX_EVENTS_PER_TRACE)
    })

    it('resets when the buffer is emptied or replaced, and on clearTraces', () => {
        const first = [ev({ traceId: 'A' })]
        const { result, rerender } = renderHook(({ e }) => useCorrelationTracker(e), { initialProps: { e: first } })
        expect(result.current.traceCount).toBe(1)
        rerender({ e: [ev({ traceId: 'B' })] }) // replaced wholesale
        expect(result.current.traces.has('A')).toBe(false)
        expect(result.current.traces.has('B')).toBe(true)
        rerender({ e: [] })
        expect(result.current.traceCount).toBe(0)
    })

    it('reports the most common correlation field', () => {
        const buf = [ev({ requestId: 'r1' }), ev({ requestId: 'r2' }), ev({ traceId: 't1' })]
        const { result } = renderHook(() => useCorrelationTracker(buf))
        expect(result.current.correlationField).toBe('requestId')
    })
})
