/**
 * filterWorker.ts  —  Stateful, indexed filter worker
 *
 * Runs entirely off the main thread. Owns a replica of the event ring buffer
 * so the main thread only needs to send incremental "add_event" messages rather
 * than the full array on every filter change.
 *
 * Message protocol (main → worker):
 *   { type: 'add_event',  event: EventMessage }
 *   { type: 'clear' }
 *   { type: 'filter',     query: string, searchQuery: string, customFilters: SerializedFilter[] }
 *
 * Message protocol (worker → main):
 *   { type: 'result',     filtered: EventMessage[], execMs: number }
 */

import type { EventMessage } from '../types'

interface SerializedFilter {
    field: string
    activeValues: string[]   // Set serialized as array for structured clone
    isRegex: boolean
    regexPattern?: string
}

interface FilterMsg {
    type: 'filter'
    query: string
    searchQuery: string
    customFilters: SerializedFilter[]
}

interface AddEventMsg {
    type: 'add_event'
    event: EventMessage
}

interface ClearMsg {
    type: 'clear'
}

type IncomingMsg = FilterMsg | AddEventMsg | ClearMsg

// ─── Worker-internal state ────────────────────────────────────────────────────

let events: EventMessage[] = []

// typeIndex: event.type (lowercased) → array of indices into `events[]`
// Provides O(k) lookup for type= queries where k << n
const typeIndex = new Map<string, number[]>()

// Last filter params — re-applied when add_event arrives
let lastQuery = ''
let lastSearchQuery = ''
let lastFilters: SerializedFilter[] = []

// Pre-compiled RegExp objects for last filter params (reused across events)
let compiledRegexes: (RegExp | null)[] = []

// ─── Index management ─────────────────────────────────────────────────────────

function indexEvent(event: EventMessage, index: number) {
    // Normalise to lowercase so type=error, type=Error, type=ERROR all match
    const key = (event.type ?? 'message').toLowerCase()
    const bucket = typeIndex.get(key) ?? []
    bucket.push(index)
    typeIndex.set(key, bucket)
}

// ─── RegExp compilation ───────────────────────────────────────────────────────

/** Compile each filter's regexPattern once. Returns null for non-regex or invalid patterns. */
function compileRegexes(filters: SerializedFilter[]): (RegExp | null)[] {
    return filters.map(f => {
        if (!f.isRegex || !f.regexPattern) return null
        try { return new RegExp(f.regexPattern, 'i') }
        catch { return null }
    })
}

// ─── Filter logic ─────────────────────────────────────────────────────────────

/** Simple query parser: supports `type=error`, `data=foo` prefix syntax */
function applyQuery(evts: EventMessage[], query: string): EventMessage[] {
    const q = query.trim()
    if (!q) return evts

    // Fast path: `type=<value>` — use the index (lowercase key)
    const typeMatch = q.match(/^type=(.+)$/i)
    if (typeMatch) {
        const val = typeMatch[1].toLowerCase()
        const indices = typeIndex.get(val) ?? []
        return indices.map(i => events[i]).filter(Boolean)
    }

    // Field equality: `<field>=<value>`
    // Field equality: `<field>=<value>`
    const fieldMatch = q.match(/^(\w[\w.]*)\s*=\s*(.+)$/)

    if (fieldMatch) {
        const [, field, val] = fieldMatch
        return evts.filter(e => {
            const ev = e as any
            const candidate = field === 'type' ? e.type
                : field === 'id' ? e.id
                    : ev[field]
            return String(candidate ?? '').toLowerCase().includes(val.toLowerCase())
        })
    }

    // Fallback: substring search across type + data
    const lower = q.toLowerCase()
    return evts.filter(e =>
        e.type.toLowerCase().includes(lower) ||
        JSON.stringify(e.data).toLowerCase().includes(lower)
    )
}

function applySearch(evts: EventMessage[], searchQuery: string): EventMessage[] {
    if (!searchQuery.trim()) return evts
    const q = searchQuery.toLowerCase()
    return evts.filter(e =>
        e.type.toLowerCase().includes(q) ||
        JSON.stringify(e.data).toLowerCase().includes(q) ||
        e.timestamp.toLowerCase().includes(q) ||
        e.id.toString().includes(q)
    )
}

function applyCustomFilters(evts: EventMessage[], filters: SerializedFilter[]): EventMessage[] {
    if (!filters.length) return evts
    const activeValues = filters.map(f => new Set(f.activeValues))
    return evts.filter(event =>
        filters.every((filter, fi) => {
            let val: any
            if (filter.field === 'type') val = event.type
            else if (filter.field === 'id') val = event.id
            else if (filter.field.startsWith('data.')) {
                const path = filter.field.split('.').slice(1)
                val = path.reduce((obj: any, key) => obj?.[key], event.data)
            } else {
                val = (event as any)[filter.field]
            }

            if (filter.isRegex) {
                // Use pre-compiled regex (compiled once per filter message, not per event)
                const rx = compiledRegexes[fi]
                if (!rx) return true
                return val != null && rx.test(String(val))
            }

            if (activeValues[fi].size === 0) return true
            return val != null && activeValues[fi].has(String(val))
        })
    )
}

function runFilter(): EventMessage[] {
    let result = events
    result = applyQuery(result, lastQuery)
    result = applySearch(result, lastSearchQuery)
    result = applyCustomFilters(result, lastFilters)
    return result
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.addEventListener('message', (e: MessageEvent<IncomingMsg>) => {
    const msg = e.data

    if (msg.type === 'add_event') {
        const idx = events.length
        events.push(msg.event)
        indexEvent(msg.event, idx)
        // Re-apply current filter and post result
        const t0 = performance.now()
        const filtered = runFilter()
        const execMs = +(performance.now() - t0).toFixed(2)
        // Reverse so UI receives newest-first (matches original ring buffer order)
        self.postMessage({ type: 'result', filtered: filtered.slice().reverse(), execMs })
        return
    }

    if (msg.type === 'clear') {
        events = []
        typeIndex.clear()
        lastQuery = ''
        lastSearchQuery = ''
        lastFilters = []
        compiledRegexes = []
        self.postMessage({ type: 'result', filtered: [], execMs: 0 })
        return
    }

    if (msg.type === 'filter') {
        lastQuery = msg.query
        lastSearchQuery = msg.searchQuery
        lastFilters = msg.customFilters
        // Compile regexes once for this new filter — reused across all events
        compiledRegexes = compileRegexes(lastFilters)
        const t0 = performance.now()
        const filtered = runFilter()
        const execMs = +(performance.now() - t0).toFixed(2)
        self.postMessage({ type: 'result', filtered: filtered.slice().reverse(), execMs })
    }
})
