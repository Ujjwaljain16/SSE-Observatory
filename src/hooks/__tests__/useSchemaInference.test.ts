import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSchemaInference } from '../useSchemaInference'
import type { EventMessage } from '../../types'

describe('useSchemaInference', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.runOnlyPendingTimers()
        vi.useRealTimers()
    })

    const createEvents = (payloads: any[]): EventMessage[] => {
        return payloads.map((payload, i) => ({
            id: `${i}`,
            timestamp: `${i}`,
            type: 'message',
            data: JSON.stringify(payload),
            raw: ''
        }))
    }

    it('infers consistent schema from uniform payloads', () => {
        const events = createEvents([
            { id: 1, name: 'Alice', active: true },
            { id: 2, name: 'Bob', active: false },
        ])
        const { result } = renderHook(() => useSchemaInference(events))

        act(() => {
            vi.runAllTimers()
        })

        expect(Object.keys(result.current.schema).length).toBe(3)

        const idField = result.current.schema['id']
        expect(Array.from(idField.type)).toContain('number')
        expect(idField.frequency).toBe(1) // 100%

        const activeField = result.current.schema['active']
        expect(Array.from(activeField.type)).toContain('boolean')
        expect(activeField.frequency).toBe(1)
    })

    it('detects optional fields and frequency', () => {
        const events = createEvents([
            { id: 1, price: 100 },
            { id: 2 }, // Missing price
            { id: 3, price: 150 },
            { id: 4 }, // Missing price
        ])
        const { result } = renderHook(() => useSchemaInference(events))

        act(() => {
            vi.runAllTimers()
        })

        const priceField = result.current.schema['price']
        expect(priceField.frequency).toBe(0.5) // 50% frequency
    })

    it('merges changing types gracefully', () => {
        const events = createEvents([
            { value: 100 },
            { value: "unknown" },
            { value: 200 }
        ])
        const { result } = renderHook(() => useSchemaInference(events))

        act(() => {
            vi.runAllTimers()
        })

        const valueField = result.current.schema['value']
        expect(valueField.type.size).toBe(2)
        expect(Array.from(valueField.type)).toContain('number')
        expect(Array.from(valueField.type)).toContain('string')
    })

    it('flattens deeply nested objects', () => {
        const events = createEvents([
            { user: { profile: { age: 30 } } }
        ])
        const { result } = renderHook(() => useSchemaInference(events))

        act(() => {
            vi.runAllTimers()
        })

        const nestedField = result.current.schema['user.profile.age']
        expect(nestedField).toBeDefined()
        expect(Array.from(nestedField.type)).toContain('number')
        expect(nestedField.frequency).toBe(1)
    })

    it('handles continuous schema evolution over drifting types and optional fields', () => {
        // Phase 1: Uniform numbers
        const phase1 = createEvents([{ price: 100 }, { price: 200 }])
        const { result, rerender } = renderHook(({ evs }) => useSchemaInference(evs), {
            initialProps: { evs: phase1 }
        })
        act(() => { vi.runAllTimers() })

        let schema = result.current.schema['price']
        expect(Array.from(schema.type)).toEqual(['number'])
        expect(schema.frequency).toBe(1) // 100%

        // Phase 2: Missing fields (optional) and new types
        const phase2 = [
            ...phase1,
            ...createEvents([{ price: "string-price" }, {} /* missing price */])
        ]
        rerender({ evs: phase2 })
        act(() => { vi.runAllTimers() })

        schema = result.current.schema['price']
        // Types should union: number | string
        expect(schema.type.size).toBe(2)
        expect(Array.from(schema.type)).toContain('number')
        expect(Array.from(schema.type)).toContain('string')

        // Frequency should drop: present in 3 out of 4 events = 75%
        expect(schema.frequency).toBe(0.75)

        // Phase 3: Total drift to missing
        const phase3 = [
            ...phase2,
            ...createEvents([{}, {}, {}, {}]) // 4 more without price, total 8 events, 3 with price
        ]
        rerender({ evs: phase3 })
        act(() => { vi.runAllTimers() })

        schema = result.current.schema['price']
        expect(schema.type.size).toBe(2) // Types preserved (number, string)
        expect(schema.frequency).toBe(0.375) // 3/8 = 37.5%
    })
})
