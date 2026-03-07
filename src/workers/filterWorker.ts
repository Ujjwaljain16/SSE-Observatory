// runs event filtering in a web worker to preserve main thread framerate
// maintains a replica of the event log to incrementally process additions
//
// message protocol (main -> worker):
//   { type: 'add_event', event }
//   { type: 'clear' }
//   { type: 'filter', query, search, customFilters }
//
// message protocol (worker -> main):
//   { type: 'result', filtered, execMs }

import type { EventMessage } from '../types'

interface SerializedFilter {
    field: string
    activeValues: string[]   // Set serialized as array for structured clone
    isRegex: boolean
    regexPattern?: string
}

import { FilterWorkerRequest, encodeFilterWorkerResponse, decodeFilterWorkerRequest } from './contracts'
import { QueryParser } from '../utils/queryParser'

const typeIndex = new Map<string, number[]>()

let events: EventMessage[] = []

// store previous filter state to re-filter efficiently when new events arrive
let lastQuery = ''
let lastSearchQuery = ''
let lastFilters: SerializedFilter[] = []

// compile regexes once to avoid parsing overhead per event
let compiledRegexes: (RegExp | null)[] = []

function indexEvent(event: EventMessage, index: number) {
    // normalize to lowercase for case-insensitive type lookups
    const key = String(event.type ?? 'message').toLowerCase()
    const bucket = typeIndex.get(key) ?? []
    bucket.push(index)
    typeIndex.set(key, bucket)
}

function compileRegexes(filters: SerializedFilter[]): (RegExp | null)[] {
    return filters.map(f => {
        if (!f.isRegex || !f.regexPattern) return null
        try { return new RegExp(f.regexPattern, 'i') }
        catch { return null }
    })
}

function applyQuery(evts: EventMessage[], queryASTOrString: any): EventMessage[] {
    if (!queryASTOrString) return evts

    try {
        let fn: (evt: EventMessage) => boolean

        const parser = new QueryParser(typeof queryASTOrString === 'string' ? queryASTOrString : '')
        if (typeof queryASTOrString === 'object') {
            fn = parser.compile(queryASTOrString)
        } else {
            fn = parser.compile(parser.parse())
        }

        return evts.filter(fn)
    } catch {
        // fallback to simple substring search if query is invalid
        const lower = String(queryASTOrString).toLowerCase()
        return evts.filter(e =>
            String(e.type).toLowerCase().includes(lower) ||
            String(e._searchIndex || '').includes(lower)
        )
    }
}

function applySearch(evts: EventMessage[], searchQuery: string): EventMessage[] {
    if (!searchQuery.trim()) return evts
    const q = searchQuery.toLowerCase()
    return evts.filter(e =>
        e.type.toLowerCase().includes(q) ||
        (e._searchIndex || '').includes(q) ||
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

export const _onMessage = (e: MessageEvent) => {
    let msg: FilterWorkerRequest
    try {
        msg = decodeFilterWorkerRequest(e.data)
    } catch {
        return
    }

    if (msg.type === 'PING') {
        self.postMessage(encodeFilterWorkerResponse({ type: 'READY' }))
        return
    }

    if (msg.type === 'ADD_EVENTS') {
        const startIndex = events.length
        for (let i = 0; i < msg.events.length; i++) {
            events.push(msg.events[i])
            indexEvent(msg.events[i], startIndex + i)
        }
        const t0 = performance.now()
        const filtered = runFilter()
        const execMs = +(performance.now() - t0).toFixed(2)
        // reverse results to display newest events first in ui
        self.postMessage(encodeFilterWorkerResponse({ type: 'FILTERED_EVENTS', events: filtered.slice().reverse(), execMs }))
        return
    }

    if (msg.type === 'CLEAR') {
        events = []
        typeIndex.clear()
        lastQuery = ''
        lastSearchQuery = ''
        lastFilters = []
        compiledRegexes = []
        self.postMessage(encodeFilterWorkerResponse({ type: 'FILTERED_EVENTS', events: [], execMs: 0 }))
        return
    }

    if (msg.type === 'QUERY_UPDATE') {
        lastQuery = msg.query
        lastSearchQuery = msg.search || ''
        const t0 = performance.now()
        const filtered = runFilter()
        const execMs = +(performance.now() - t0).toFixed(2)
        self.postMessage(encodeFilterWorkerResponse({ type: 'FILTERED_EVENTS', events: filtered.slice().reverse(), execMs }))
        return
    }

    if (msg.type === 'CUSTOM_FILTERS_UPDATE') {
        lastFilters = msg.filters
        compiledRegexes = compileRegexes(lastFilters)
        const t0 = performance.now()
        const filtered = runFilter()
        const execMs = +(performance.now() - t0).toFixed(2)
        self.postMessage(encodeFilterWorkerResponse({ type: 'FILTERED_EVENTS', events: filtered.slice().reverse(), execMs }))
    }
}

self.addEventListener('message', _onMessage)
