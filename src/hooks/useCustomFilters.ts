import { useState, useCallback, useRef } from 'react'
import type { EventMessage, CustomFilter } from '../types'
import { getFieldValue } from '../utils/eventUtils'

/**
 * State for the "Field Filters" panel. The filtering itself happens in the filter engine
 * (worker); this hook only owns the filter definitions and offers the distinct values of a field
 * for the picker.
 */
export const useCustomFilters = (events: EventMessage[]) => {
    const [customFilters, setCustomFilters] = useState<CustomFilter[]>([])
    const [newFilterField, setNewFilterField] = useState('')

    // Distinct values per field are computed on demand and cached until the events change,
    // instead of re-scanning (and re-parsing) every event on every render.
    const cache = useRef<{ events: EventMessage[]; byField: Map<string, string[]> }>({ events, byField: new Map() })
    const getUniqueValuesForField = useCallback((fieldPath: string): string[] => {
        if (cache.current.events !== events) cache.current = { events, byField: new Map() }
        const hit = cache.current.byField.get(fieldPath)
        if (hit) return hit
        const values = new Set<string>()
        for (const event of events) {
            const value = getFieldValue(event, fieldPath)
            if (value !== null) values.add(value)
        }
        const sorted = Array.from(values).sort()
        cache.current.byField.set(fieldPath, sorted)
        return sorted
    }, [events])

    const addCustomFilter = (): string | null => {
        const field = newFilterField.trim()
        if (!field) return null
        if (customFilters.some(f => f.field === field)) return 'This filter already exists'
        setCustomFilters(prev => [...prev, { field, activeValues: new Set() }])
        setNewFilterField('')
        return null
    }

    const update = (field: string, fn: (f: CustomFilter) => CustomFilter) =>
        setCustomFilters(prev => prev.map(f => (f.field === field ? fn(f) : f)))

    const removeCustomFilter = (field: string) => setCustomFilters(prev => prev.filter(f => f.field !== field))

    const toggleFilterValue = (field: string, value: string) =>
        update(field, (filter) => {
            const activeValues = new Set(filter.activeValues)
            if (activeValues.has(value)) activeValues.delete(value)
            else activeValues.add(value)
            return { ...filter, activeValues }
        })

    const clearFilterValues = (field: string) => update(field, (filter) => ({ ...filter, activeValues: new Set() }))

    const toggleRegexMode = (field: string) =>
        update(field, (filter) => ({ ...filter, isRegex: !filter.isRegex, regexPattern: '', activeValues: new Set() }))

    const setRegexPattern = (field: string, pattern: string) =>
        update(field, (filter) => ({ ...filter, regexPattern: pattern }))

    return {
        customFilters,
        newFilterField,
        setNewFilterField,
        getUniqueValuesForField,
        addCustomFilter,
        removeCustomFilter,
        toggleFilterValue,
        clearFilterValues,
        toggleRegexMode,
        setRegexPattern,
    }
}
