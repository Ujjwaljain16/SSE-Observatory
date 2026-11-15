/** Filters (query engine expressions) a person saved to use again, kept in this browser. */

const KEY = 'sse.savedQueries'
export const MAX_SAVED_QUERIES = 30
const MAX_QUERY_CHARS = 500
const MAX_NAME_CHARS = 60

export interface SavedQuery { name: string; query: string }

export function getSavedQueries(): SavedQuery[] {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
        if (!Array.isArray(parsed)) return []
        return parsed
            .filter((q): q is SavedQuery => typeof q === 'object' && q !== null && typeof (q as SavedQuery).name === 'string' && typeof (q as SavedQuery).query === 'string')
            .map((q) => ({ name: q.name.slice(0, MAX_NAME_CHARS), query: q.query.slice(0, MAX_QUERY_CHARS) }))
            .slice(0, MAX_SAVED_QUERIES)
    } catch { return [] }
}

function write(list: SavedQuery[]): void {
    try { localStorage.setItem(KEY, JSON.stringify(list)) } catch { /* private mode: lasts for this tab only */ }
}

/** Saves a filter under a name (the filter itself when no name is given). The same name replaces the old one. Returns the new list. */
export function saveQuery(name: string, query: string): SavedQuery[] {
    const q = query.trim()
    if (q === '') return getSavedQueries()
    const label = (name.trim() || q).slice(0, MAX_NAME_CHARS)
    const rest = getSavedQueries().filter((s) => s.name !== label)
    const next = [{ name: label, query: q.slice(0, MAX_QUERY_CHARS) }, ...rest].slice(0, MAX_SAVED_QUERIES)
    write(next)
    return next
}

export function removeQuery(name: string): SavedQuery[] {
    const next = getSavedQueries().filter((s) => s.name !== name)
    write(next)
    return next
}
