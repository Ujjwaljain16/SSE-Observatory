import { useState, useMemo } from 'react'
import type { EventMessage, CustomFilter } from '../types'
import { getFieldValue } from '../utils/eventUtils'

export const useCustomFilters = (events: EventMessage[]) => {
    const [customFilters, setCustomFilters] = useState<CustomFilter[]>([])
    const [newFilterField, setNewFilterField] = useState('')

    const getUniqueValuesForField = (fieldPath: string): string[] => {
        const values = new Set<string>()
        events.forEach(event => {
            const value = getFieldValue(event, fieldPath)
            if (value !== null) {
                values.add(value)
            }
        })
        return Array.from(values).sort()
    }

    const addCustomFilter = (): string | null => {
        if (!newFilterField.trim()) return null

        if (customFilters.some(f => f.field === newFilterField.trim())) {
            return 'This filter already exists'
        }

        setCustomFilters([...customFilters, { field: newFilterField.trim(), activeValues: new Set() }])
        setNewFilterField('')
        return null
    }

    const removeCustomFilter = (field: string) => {
        setCustomFilters(customFilters.filter(f => f.field !== field))
    }

    const toggleFilterValue = (field: string, value: string) => {
        setCustomFilters(customFilters.map(filter => {
            if (filter.field === field) {
                const newActiveValues = new Set(filter.activeValues)
                if (newActiveValues.has(value)) {
                    newActiveValues.delete(value)
                } else {
                    newActiveValues.add(value)
                }
                return { ...filter, activeValues: newActiveValues }
            }
            return filter
        }))
    }

    const clearFilterValues = (field: string) => {
        setCustomFilters(customFilters.map(filter =>
            filter.field === field ? { ...filter, activeValues: new Set() } : filter
        ))
    }

    const toggleRegexMode = (field: string) => {
        setCustomFilters(customFilters.map(filter => {
            if (filter.field === field) {
                return {
                    ...filter,
                    isRegex: !filter.isRegex,
                    regexPattern: '',
                    activeValues: new Set() // Clear values when switching modes
                }
            }
            return filter
        }))
    }

    const setRegexPattern = (field: string, pattern: string) => {
        setCustomFilters(customFilters.map(filter => {
            if (filter.field === field) {
                return { ...filter, regexPattern: pattern }
            }
            return filter
        }))
    }

    // We'll manage query state here or pass it in. For now, let's assume query filtering happens outside or we integrate it here.
    // However, the requirement is to have a robust query engine. 
    // Let's allow passing an external query filter function if needed, or keep it simple.
    // Actually, following the plan, we should integrate it here or in App.tsx. 
    // Let's modify App.tsx to handle the query filter composition.

    // For this hook, let's just ensure it handles the existing filters correctly. 
    // The query parser is a separate concern that filters the *result* of this hook, or vice versa.
    // Let's keep this hook focused on "Component-based" filters (Simple/Regex).

    const filteredEvents = useMemo(() => {
        if (customFilters.length === 0) return events

        return events.filter(event => {
            return customFilters.every(filter => {
                const eventValue = getFieldValue(event, filter.field)

                if (filter.isRegex) {
                    if (!filter.regexPattern) return true // No pattern = no filter
                    try {
                        const regex = new RegExp(filter.regexPattern, 'i')
                        return eventValue !== null && regex.test(String(eventValue))
                    } catch {
                        return true // Invalid regex = ignore filter
                    }
                }

                if (filter.activeValues.size === 0) return true
                return eventValue !== null && filter.activeValues.has(String(eventValue)) // Ensure string comparison
            })
        })
    }, [events, customFilters])

    return {
        customFilters,
        newFilterField,
        setNewFilterField,
        filteredEvents,
        getUniqueValuesForField,
        addCustomFilter,
        removeCustomFilter,
        toggleFilterValue,
        clearFilterValues,
        toggleRegexMode,
        setRegexPattern
    }
}
