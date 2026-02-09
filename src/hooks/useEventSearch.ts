import { useState, useMemo } from 'react'
import type { EventMessage } from '../types'

export const useEventSearch = (events: EventMessage[]) => {
    const [searchQuery, setSearchQuery] = useState('')

    const searchedEvents = useMemo(() => {
        if (!searchQuery.trim()) return events

        const query = searchQuery.toLowerCase()
        return events.filter(event => {
            // Search in event data
            if (event.data.toLowerCase().includes(query)) return true
            // Search in parsed type
            if (event.parsedType?.toLowerCase().includes(query)) return true
            // Search in event type
            if (event.type.toLowerCase().includes(query)) return true
            // Search in timestamp
            if (event.timestamp.toLowerCase().includes(query)) return true
            return false
        })
    }, [events, searchQuery])

    return {
        searchQuery,
        setSearchQuery,
        searchedEvents
    }
}
