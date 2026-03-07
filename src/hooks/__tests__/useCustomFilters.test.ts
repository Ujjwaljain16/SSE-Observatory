import { renderHook, act } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useCustomFilters } from '../useCustomFilters'
import type { EventMessage } from '../../types'

describe('useCustomFilters', () => {
    const events: EventMessage[] = [
        { id: '1', timestamp: '1', type: 'message', data: '{"status":"ok", "value": 10}', raw: '' },
        { id: '2', timestamp: '2', type: 'error', data: '{"status":"failed", "reason": "timeout"}', raw: '' },
        { id: '4', timestamp: '4', type: 'update', data: '{"user": {"id": 123, "name": "alice"}}', raw: '' },
    ]

    it('returns all events entirely when no filters', () => {
        const { result } = renderHook(() => useCustomFilters(events))
        expect(result.current.filteredEvents.length).toBe(3)
    })

    it('can add a filter and filter by exact value', () => {
        const { result } = renderHook(() => useCustomFilters(events))

        // Add a filter field corresponding to type
        act(() => {
            result.current.setNewFilterField('type')
        })
        act(() => {
            result.current.addCustomFilter()
        })
        expect(result.current.customFilters.length).toBe(1)

        // Select 'error' value for this filter
        act(() => {
            result.current.toggleFilterValue('type', 'error')
        })

        expect(result.current.filteredEvents.length).toBe(1)
        expect(result.current.filteredEvents[0].type).toBe('error')
    })

    it('can filter by regex mode', () => {
        const { result } = renderHook(() => useCustomFilters(events))

        act(() => {
            result.current.setNewFilterField('data.reason')
        })
        act(() => {
            result.current.addCustomFilter()
        })

        // Enable regex mode
        act(() => {
            result.current.toggleRegexMode('data.reason')
        })

        // Match string starting with time
        act(() => {
            result.current.setRegexPattern('data.reason', '^time.*')
        })

        expect(result.current.filteredEvents.length).toBe(1)
        expect(result.current.filteredEvents[0].id).toBe('2')
    })
})
