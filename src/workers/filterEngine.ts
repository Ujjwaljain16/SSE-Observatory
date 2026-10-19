// Pure filtering engine shared by the filter worker and the main-thread fallback.
//
// Keeps a bounded replica of the event log (oldest → newest) and an incrementally maintained
// "filtered" view: new events are tested once against the compiled predicate instead of
// re-filtering the whole log, and the log never grows beyond `maxEvents`.

import type { EventMessage } from '../types'
import { compileQuery, compileQueryString, type EventPredicate, type QueryNode } from '../utils/queryParser'
import { getFieldValue } from '../utils/eventUtils'

export interface SerializedFilter {
    field: string
    activeValues: string[] // Set serialized as array for structured clone
    isRegex: boolean
    regexPattern?: string | undefined
}

interface CompiledFilter {
    field: string
    regex: RegExp | null
    isRegex: boolean
    values: Set<string>
}

export const DEFAULT_MAX_EVENTS = 10_000

export class FilterEngine {
    private maxEvents = DEFAULT_MAX_EVENTS
    private events: EventMessage[] = []      // retained log, oldest → newest
    private base = 0                         // absolute index of events[0]
    private filtered: EventMessage[] = []    // events passing all filters, oldest → newest
    private filteredAbs: number[] = []       // absolute index of each entry in `filtered`

    private queryPredicate: EventPredicate | null = null
    private queryFallback = ''               // substring fallback when the query cannot be compiled
    private searchLower = ''
    private customFilters: CompiledFilter[] = []

    /** Returns true if the visible result changed. */
    configure(maxEvents: number): boolean {
        this.maxEvents = maxEvents
        if (this.trim()) { this.recompute(); return true }
        return false
    }

    /** Returns true if the filtered result changed. */
    addEvents(batch: readonly EventMessage[]): boolean {
        let changed = false
        for (const e of batch) {
            this.events.push(e)
            if (this.matches(e)) {
                this.filtered.push(e)
                this.filteredAbs.push(this.base + this.events.length - 1)
                changed = true
            }
        }
        return this.trim() || changed
    }

    /** Drops all events; query, search and field filters are kept (they are still visible in the UI). */
    clear() {
        this.events = []
        this.filtered = []
        this.filteredAbs = []
        this.base = 0
    }

    setQuery(query: unknown, search: string) {
        this.queryPredicate = null
        this.queryFallback = ''
        if (query) {
            try {
                this.queryPredicate = typeof query === 'string'
                    ? (query.trim() ? compileQueryString(query) : null)
                    : compileQuery(query as QueryNode)
            } catch {
                // invalid query: degrade to a plain substring match instead of showing nothing
                this.queryFallback = (typeof query === 'string' ? query : '').toLowerCase()
            }
        }
        this.searchLower = (search || '').trim().toLowerCase()
        this.recompute()
    }

    setCustomFilters(filters: readonly SerializedFilter[]) {
        this.customFilters = filters.map((f) => {
            let regex: RegExp | null = null
            if (f.isRegex && f.regexPattern) {
                try { regex = new RegExp(f.regexPattern, 'i') } catch { regex = null }
            }
            return { field: f.field, isRegex: f.isRegex, regex, values: new Set(f.activeValues) }
        })
        this.recompute()
    }

    /** Filtered events, newest first (the order the UI renders). */
    snapshot(): EventMessage[] {
        const n = this.filtered.length
        const out = new Array<EventMessage>(n)
        for (let i = 0; i < n; i++) out[i] = this.filtered[n - 1 - i]
        return out
    }

    get size() { return this.events.length }

    private matches(e: EventMessage): boolean {
        if (this.queryPredicate) {
            if (!this.queryPredicate(e)) return false
        } else if (this.queryFallback) {
            if (!String(e.type).toLowerCase().includes(this.queryFallback) && !String(e._searchIndex || '').includes(this.queryFallback)) return false
        }

        const q = this.searchLower
        if (q) {
            if (!(
                String(e.type).toLowerCase().includes(q) ||
                (e._searchIndex || '').includes(q) ||
                String(e.timestamp).toLowerCase().includes(q) ||
                String(e.id).includes(q)
            )) return false
        }

        for (const f of this.customFilters) {
            const val = getFieldValue(e, f.field)
            if (f.isRegex) {
                if (!f.regex) continue // empty/invalid pattern: filter is inactive
                if (val === null || !f.regex.test(val)) return false
            } else if (f.values.size > 0) {
                if (val === null || !f.values.has(val)) return false
            }
        }
        return true
    }

    private recompute() {
        this.filtered = []
        this.filteredAbs = []
        for (let i = 0; i < this.events.length; i++) {
            if (this.matches(this.events[i])) {
                this.filtered.push(this.events[i])
                this.filteredAbs.push(this.base + i)
            }
        }
    }

    private trim(): boolean {
        const excess = this.events.length - this.maxEvents
        if (excess <= 0) return false
        this.events.splice(0, excess)
        this.base += excess
        let drop = 0
        while (drop < this.filteredAbs.length && this.filteredAbs[drop] < this.base) drop++
        if (drop > 0) {
            this.filtered.splice(0, drop)
            this.filteredAbs.splice(0, drop)
        }
        return true
    }
}
