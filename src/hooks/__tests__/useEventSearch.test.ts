import { renderHook, act } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useEventSearch } from '../useEventSearch'
import type { EventMessage } from '../../types'

describe('useEventSearch', () => {
    const events: EventMessage[] = [
        { id: '1', timestamp: '1', type: 'message', data: '{"status":"ok", "value": 10}', raw: '' },
        { id: '2', timestamp: '2', type: 'error', data: '{"status":"failed", "reason": "timeout"}', raw: '' },
        { id: '3', timestamp: '3', type: 'message', data: 'plain text payload', raw: '' },
        { id: '4', timestamp: '4', type: 'update', data: '{"user": {"id": 123, "name": "alice"}}', parsedType: 'update_user', raw: '' },
    ]

    it('returns all events when no search is active', () => {
        const { result } = renderHook(() => useEventSearch(events))
        expect(result.current.searchedEvents.length).toBe(4)
    })

    it('filters by basic search query (text match in data or type)', () => {
        const { result } = renderHook(() => useEventSearch(events))

        act(() => {
            result.current.setSearchQuery('timeout')
        })

        expect(result.current.searchedEvents.length).toBe(1)
        expect(result.current.searchedEvents[0].id).toBe('2')
    })

    it('filters by parsed type', () => {
        const { result } = renderHook(() => useEventSearch(events))

        act(() => result.current.setSearchQuery('update_user'))

        expect(result.current.searchedEvents.length).toBe(1)
        expect(result.current.searchedEvents[0].id).toBe('4')
    })
})
