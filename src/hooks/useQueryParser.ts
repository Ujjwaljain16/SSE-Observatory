import { useState, useMemo } from 'react'
import { parseQuery, compileQuery } from '../utils/queryParser'

/**
 * Query box state plus live syntax validation. The query is evaluated by the filter engine
 * (worker); here we only parse it to surface a readable error while the user types.
 */
export const useQueryParser = () => {
    const [query, setQuery] = useState('')

    const error = useMemo<string | null>(() => {
        if (!query.trim()) return null
        try {
            compileQuery(parseQuery(query)) // compile too: catches invalid regular expressions
            return null
        } catch (err) {
            return (err as Error).message
        }
    }, [query])

    return { query, setQuery, error }
}
