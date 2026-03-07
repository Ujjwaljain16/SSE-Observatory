import { renderHook, act } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useQueryParser } from '../useQueryParser'
import type { EventMessage } from '../../types'

describe('useQueryParser', () => {
    const events: EventMessage[] = [
        { id: '1', timestamp: '1', type: 'message', data: '{"status":"ok", "value": 10}', raw: '' },
        { id: '2', timestamp: '2', type: 'error', data: '{"status":"failed", "reason": "timeout"}', raw: '' },
        { id: '4', timestamp: '4', type: 'update', data: '{"user": {"id": 123, "name": "alice"}}', raw: '' },
    ]

    it('returns all events when query is empty', () => {
        const { result } = renderHook(() => useQueryParser(events))
        expect(result.current.filteredEvents.length).toBe(3)
        expect(result.current.error).toBeNull()
    })

    it('evaluates DSL query string', () => {
        const { result } = renderHook(() => useQueryParser(events))

        act(() => result.current.setQuery('type=="update"'))
        expect(result.current.filteredEvents.length).toBe(1)
        expect(result.current.filteredEvents[0].id).toBe('4')
        expect(result.current.error).toBeNull()
    })

    it('evaluates AND logic', () => {
        const { result } = renderHook(() => useQueryParser(events))

        act(() => result.current.setQuery('type=="message" AND data.status=="ok"'))
        expect(result.current.filteredEvents.length).toBe(1)
        expect(result.current.filteredEvents[0].id).toBe('1')
    })
})
