import { useState, useMemo } from 'react'
import { EventMessage } from '../types'
import { QueryParser } from '../utils/queryParser'

export const useQueryParser = (events: EventMessage[]) => {
    const [query, setQuery] = useState('')
    const [error, setError] = useState<string | null>(null)

    const compiledFilter = useMemo(() => {
        if (!query.trim()) {
            setError(null)
            return null
        }

        try {
            const parser = new QueryParser(query)
            const ast = parser.parse()
            const filterFn = parser.compile(ast)
            setError(null)
            return filterFn
        } catch (err) {
            setError((err as Error).message)
            return null
        }
    }, [query])

    const filteredEvents = useMemo(() => {
        if (!compiledFilter) return events
        return events.filter(compiledFilter)
    }, [events, compiledFilter])

    return {
        query,
        setQuery,
        error,
        filteredEvents
    }
}
