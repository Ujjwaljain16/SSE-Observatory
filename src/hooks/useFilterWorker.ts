/**
 * useFilterWorker.ts
 *
 * React hook that manages the stateful filterWorker.
 * The worker owns the event buffer — this hook sends incremental updates.
 *
 * Exports:
 *   filteredEvents  — result of the most recent filter pass
 *   filterExecMs    — last filter execution time (for PerfOverlay)
 *   isWorkerReady   — false if Worker API is unavailable (test env / old browser)
 *   addEventToWorker(event)  — called by AppProviders on each new SSE event
 *   sendFilterToWorker(...)  — called when filter params change
 *   clearWorker()            — called on stream reconnect
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { EventMessage, CustomFilter } from '../types'
import { workerRegistry } from '../utils/workerRegistry'
import { getFieldValue } from '../utils/eventUtils'

const WORKER_KEY = 'filter-worker'
const DEBOUNCE_MS = 10

// Serialize a CustomFilter for structured-clone (Set → Array)
function serializeFilters(filters: CustomFilter[]) {
    return filters.map(f => ({
        field: f.field,
        activeValues: Array.from(f.activeValues),
        isRegex: f.isRegex ?? false,
        regexPattern: f.regexPattern,
    }))
}

// Inline fallback filter (mirrors filterWorker logic)
function inlineFilter(
    events: EventMessage[],
    query: string,
    searchQuery: string,
    customFilters: CustomFilter[]
): EventMessage[] {
    let result = events
    if (query.trim()) {
        const q = query.toLowerCase()
        result = result.filter(e =>
            e.type.toLowerCase().includes(q) ||
            JSON.stringify(e.data).toLowerCase().includes(q)
        )
    }
    if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        result = result.filter(e =>
            e.type.toLowerCase().includes(q) ||
            JSON.stringify(e.data).toLowerCase().includes(q) ||
            e.timestamp.toLowerCase().includes(q) ||
            e.id.toString().includes(q)
        )
    }
    if (customFilters.length) {
        result = result.filter(event =>
            customFilters.every(filter => {
                const val = getFieldValue(event, filter.field)

                if (filter.isRegex) {
                    if (!filter.regexPattern) return true
                    try { return val != null && new RegExp(filter.regexPattern, 'i').test(String(val)) }
                    catch { return true }
                }
                if (filter.activeValues.size === 0) return true
                return val != null && filter.activeValues.has(String(val))
            })
        )
    }
    return result
}

interface FilterParams {
    query: string
    queryError: string | null
    searchQuery: string
    customFilters: CustomFilter[]
}

interface UseFilterWorkerResult {
    filteredEvents: EventMessage[]
    filterExecMs: number
    isWorkerReady: boolean
    addEventToWorker: (event: EventMessage) => void
    sendFilterToWorker: (params: FilterParams) => void
    clearWorker: () => void
}

export function useFilterWorker(
    allEvents: EventMessage[],
    params: FilterParams
): UseFilterWorkerResult {
    const [filteredEvents, setFilteredEvents] = useState<EventMessage[]>([])
    const [filterExecMs, setFilterExecMs] = useState(0)
    const [isWorkerReady, setIsWorkerReady] = useState(false)

    const workerRef = useRef<Worker | null>(null)
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const lastParamsRef = useRef(params)
    lastParamsRef.current = params


    const syncFilter = useCallback((events: EventMessage[], p: FilterParams) => {
        const t0 = performance.now()
        const result = (p.query.trim() && !p.queryError)
            ? inlineFilter(events, p.query, p.searchQuery, p.customFilters)
            : inlineFilter(events, '', p.searchQuery, p.customFilters)
        setFilterExecMs(+(performance.now() - t0).toFixed(2))
        setFilteredEvents(result)
    }, [])


    useEffect(() => {
        if (typeof Worker === 'undefined') {
            // Fallback: sync inline in test/old browser environments
            syncFilter(allEvents, lastParamsRef.current)
            return
        }

        try {
            const worker = workerRegistry.create(WORKER_KEY, () =>
                new Worker(new URL('../workers/filterWorker.ts', import.meta.url), { type: 'module' })
            )
            workerRef.current = worker
            setIsWorkerReady(true)

            worker.onmessage = (e: MessageEvent) => {
                const msg = e.data
                if (msg.type === 'FILTERED_EVENTS') {
                    setFilteredEvents(msg.events)
                    setFilterExecMs(msg.execMs)
                }
            }

            worker.onerror = () => {
                setIsWorkerReady(false)
                syncFilter(allEvents, lastParamsRef.current)
            }
        } catch {
            setIsWorkerReady(false)
        }

        return () => workerRegistry.release(WORKER_KEY)
    }, [])


    const addEventToWorker = useCallback((event: EventMessage) => {
        if (workerRef.current && isWorkerReady) {
            workerRef.current.postMessage({ type: 'ADD_EVENTS', events: [event] })
        } else {
            // Handled by syncFilter path via allEvents change
        }
    }, [isWorkerReady])

    const sendFilterToWorker = useCallback((p: FilterParams) => {
        if (debounceRef.current) clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => {
            if (workerRef.current && isWorkerReady) {
                workerRef.current.postMessage({
                    type: 'QUERY_UPDATE',
                    query: p.queryError ? '' : p.query,
                    search: p.searchQuery,
                })
                workerRef.current.postMessage({
                    type: 'CUSTOM_FILTERS_UPDATE',
                    filters: serializeFilters(p.customFilters),
                })
            } else {
                syncFilter(allEvents, p)
            }
        }, DEBOUNCE_MS)
    }, [isWorkerReady, allEvents, syncFilter])

    const clearWorker = useCallback(() => {
        if (workerRef.current && isWorkerReady) {
            workerRef.current.postMessage({ type: 'CLEAR' })
        }
        setFilteredEvents([])
    }, [isWorkerReady])


    useEffect(() => {
        if (!isWorkerReady) {
            syncFilter(allEvents, lastParamsRef.current)
        }
    }, [allEvents, isWorkerReady, syncFilter])


    useEffect(() => {
        sendFilterToWorker(params)
    }, [params.query, params.queryError, params.searchQuery, params.customFilters])

    return useMemo(() => ({
        filteredEvents,
        filterExecMs,
        isWorkerReady,
        addEventToWorker,
        sendFilterToWorker,
        clearWorker,
    }), [filteredEvents, filterExecMs, isWorkerReady, addEventToWorker, sendFilterToWorker, clearWorker])
}
