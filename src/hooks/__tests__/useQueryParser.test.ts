import { renderHook, act } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useQueryParser } from '../useQueryParser'

describe('useQueryParser', () => {
    it('has no error for an empty or valid query', () => {
        const { result } = renderHook(() => useQueryParser())
        expect(result.current.error).toBeNull()
        act(() => result.current.setQuery('type=="update" AND data.n >= 3'))
        expect(result.current.error).toBeNull()
    })

    it('reports readable syntax errors and clears them when fixed', () => {
        const { result } = renderHook(() => useQueryParser())
        act(() => result.current.setQuery('type =='))
        expect(result.current.error).toMatch(/expected a value/)
        act(() => result.current.setQuery('type == "x"'))
        expect(result.current.error).toBeNull()
    })

    it('reports invalid regular expressions', () => {
        const { result } = renderHook(() => useQueryParser())
        act(() => result.current.setQuery('a matches "("'))
        expect(result.current.error).toMatch(/Invalid regular expression/)
    })
})
