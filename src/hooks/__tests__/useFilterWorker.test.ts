import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useFilterWorker } from '../useFilterWorker'
import type { EventMessage, CustomFilter } from '../../types'

// No Worker in this environment → the hook runs the same FilterEngine on the main thread.
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('Worker', undefined) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const mk = (i: number): EventMessage => ({
    id: `e${i}`, type: 'message', timestamp: 't', raw: '',
    data: JSON.stringify({ n: i, level: i % 2 ? 'error' : 'info' }),
})
const NO_FILTERS: CustomFilter[] = []
const base = { query: '', queryError: null, searchQuery: '', customFilters: NO_FILTERS }
const flush = () => act(() => { vi.advanceTimersByTime(50) })
const ids = (r: { current: { filteredEvents: EventMessage[] } }) => r.current.filteredEvents.map((e) => e.id)

describe('useFilterWorker (inline engine)', () => {
    it('mirrors the live buffer and keeps updating after the ring buffer is full', () => {
        const CAP = 5
        let buf: EventMessage[] = []
        const { result, rerender } = renderHook(({ events }) => useFilterWorker(events, base, CAP), { initialProps: { events: buf } })
        for (let i = 0; i < 40; i++) {
            buf = [mk(i), ...buf].slice(0, CAP) // length stops changing at CAP
            rerender({ events: buf })
        }
        flush()
        expect(ids(result)).toEqual(['e39', 'e38', 'e37', 'e36', 'e35'])
    })

    it('applies query and search changes to events already in the buffer', () => {
        let buf = [5, 4, 3, 2, 1].map(mk)
        const { result, rerender } = renderHook(({ q }) => useFilterWorker(buf, { ...base, query: q }, 100), { initialProps: { q: '' } })
        flush()
        expect(ids(result)).toEqual(['e5', 'e4', 'e3', 'e2', 'e1'])
        rerender({ q: 'level == "error"' })
        flush()
        expect(ids(result)).toEqual(['e5', 'e3', 'e1'])
        buf = [mk(6), mk(7), ...buf]
        rerender({ q: 'level == "error"' })
        flush()
        expect(ids(result)).toEqual(['e7', 'e5', 'e3', 'e1'])
    })

    it('filters on data fields via field filters', () => {
        const buf = [4, 3, 2, 1].map(mk)
        const filters: CustomFilter[] = [{ field: 'data.level', activeValues: new Set(['error']) }]
        const { result } = renderHook(() => useFilterWorker(buf, { ...base, customFilters: filters }, 100))
        flush()
        expect(ids(result)).toEqual(['e3', 'e1'])
    })

    it('clears when the buffer is emptied and resyncs when it is replaced', () => {
        const { result, rerender } = renderHook(({ events }) => useFilterWorker(events, base, 100), { initialProps: { events: [3, 2, 1].map(mk) } })
        flush()
        expect(ids(result)).toEqual(['e3', 'e2', 'e1'])
        rerender({ events: [] })
        flush()
        expect(ids(result)).toEqual([])
        rerender({ events: [mk(10), mk(9)] })
        flush()
        expect(ids(result)).toEqual(['e10', 'e9'])
        // replaced wholesale (e.g. reconnect with a different history): old events must not linger
        rerender({ events: [mk(20), mk(19)] })
        flush()
        expect(ids(result)).toEqual(['e20', 'e19'])
    })

    it('ignores an invalid query (the error is shown elsewhere) instead of hiding everything', () => {
        const buf = [2, 1].map(mk)
        const { result } = renderHook(() => useFilterWorker(buf, { ...base, query: 'level ==', queryError: 'Unexpected end' }, 100))
        flush()
        expect(ids(result)).toEqual(['e2', 'e1'])
    })
})
