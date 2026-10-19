import { renderHook, act } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useCustomFilters } from '../useCustomFilters'
import type { EventMessage } from '../../types'

const events: EventMessage[] = [
    { id: '1', timestamp: '1', type: 'message', data: '{"status":"ok", "value": 10}', raw: '' },
    { id: '2', timestamp: '2', type: 'error', data: '{"status":"failed", "reason": "timeout"}', raw: '' },
    { id: '4', timestamp: '4', type: 'update', data: '{"user": {"id": 123, "name": "alice"}}', raw: '' },
]

const withFilter = (field: string) => {
    const hook = renderHook(() => useCustomFilters(events))
    act(() => { hook.result.current.setNewFilterField(field) })
    act(() => { hook.result.current.addCustomFilter() })
    return hook
}

describe('useCustomFilters', () => {
    it('adds a filter, rejects duplicates and blanks', () => {
        const { result } = withFilter('type')
        expect(result.current.customFilters.map(f => f.field)).toEqual(['type'])
        expect(result.current.newFilterField).toBe('')

        act(() => { result.current.setNewFilterField('type') })
        let err: string | null = null
        act(() => { err = result.current.addCustomFilter() })
        expect(err).toBe('This filter already exists')
        expect(result.current.customFilters).toHaveLength(1)

        act(() => { result.current.setNewFilterField('   ') })
        act(() => { err = result.current.addCustomFilter() })
        expect(err).toBeNull()
        expect(result.current.customFilters).toHaveLength(1)
    })

    it('toggles values, clears them, and removes filters', () => {
        const { result } = withFilter('type')
        act(() => { result.current.toggleFilterValue('type', 'error') })
        act(() => { result.current.toggleFilterValue('type', 'update') })
        expect([...result.current.customFilters[0].activeValues].sort()).toEqual(['error', 'update'])
        act(() => { result.current.toggleFilterValue('type', 'error') })
        expect([...result.current.customFilters[0].activeValues]).toEqual(['update'])
        act(() => { result.current.clearFilterValues('type') })
        expect(result.current.customFilters[0].activeValues.size).toBe(0)
        act(() => { result.current.removeCustomFilter('type') })
        expect(result.current.customFilters).toHaveLength(0)
    })

    it('switching to regex mode resets values and stores the pattern', () => {
        const { result } = withFilter('data.reason')
        act(() => { result.current.toggleFilterValue('data.reason', 'timeout') })
        act(() => { result.current.toggleRegexMode('data.reason') })
        act(() => { result.current.setRegexPattern('data.reason', '^time.*') })
        const f = result.current.customFilters[0]
        expect(f.isRegex).toBe(true)
        expect(f.regexPattern).toBe('^time.*')
        expect(f.activeValues.size).toBe(0)
    })

    it('several quick updates in one tick are all applied (no stale closures)', () => {
        const { result } = withFilter('type')
        act(() => {
            result.current.toggleFilterValue('type', 'a')
            result.current.toggleFilterValue('type', 'b')
            result.current.toggleFilterValue('type', 'c')
        })
        expect(result.current.customFilters[0].activeValues.size).toBe(3)
    })

    it('lists distinct values of root and nested payload fields, sorted', () => {
        const { result } = renderHook(() => useCustomFilters(events))
        expect(result.current.getUniqueValuesForField('type')).toEqual(['error', 'message', 'update'])
        expect(result.current.getUniqueValuesForField('data.status')).toEqual(['failed', 'ok'])
        expect(result.current.getUniqueValuesForField('user.name')).toEqual(['alice'])
        expect(result.current.getUniqueValuesForField('nope')).toEqual([])
    })

    it('caches per field until the events change', () => {
        const { result, rerender } = renderHook(({ evs }) => useCustomFilters(evs), { initialProps: { evs: events } })
        const first = result.current.getUniqueValuesForField('type')
        expect(result.current.getUniqueValuesForField('type')).toBe(first)
        rerender({ evs: [...events, { id: '5', timestamp: '5', type: 'ping', data: '{}', raw: '' }] })
        expect(result.current.getUniqueValuesForField('type')).toEqual(['error', 'message', 'ping', 'update'])
    })
})
