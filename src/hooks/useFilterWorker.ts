/**
 * useFilterWorker.ts
 *
 * Mirrors the live event buffer into a filtering engine and exposes the filtered result.
 *
 *  - Normally the engine runs in a Web Worker; if Workers are unavailable (or the worker crashes)
 *    the very same FilterEngine runs on the main thread, so behaviour is identical.
 *  - New events are detected by identity (see newEventsSince), never by buffer length, so the view keeps
 *    updating after the ring buffer is full, and the engine is re-synced if the buffer is replaced.
 *  - Filter parameters are debounced and only the parts that changed are re-sent.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { EventMessage, CustomFilter } from '../types'
import { workerRegistry } from '../utils/workerRegistry'
import { newEventsSince } from '../utils/eventBuffer'
import { FilterEngine } from '../workers/filterEngine'

const WORKER_KEY = 'filter-worker'
const DEBOUNCE_MS = 10
const DEFAULT_MAX_EVENTS = 1000

// Serialize a CustomFilter for structured-clone (Set → Array)
function serializeFilters(filters: CustomFilter[]) {
    return filters.map(f => ({
        field: f.field,
        activeValues: Array.from(f.activeValues),
        isRegex: f.isRegex ?? false,
        regexPattern: f.regexPattern,
    }))
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
    clearWorker: () => void
}

export function useFilterWorker(
    events: EventMessage[],
    params: FilterParams,
    maxEvents: number = DEFAULT_MAX_EVENTS
): UseFilterWorkerResult {
    const [filteredEvents, setFilteredEvents] = useState<EventMessage[]>([])
    const [filterExecMs, setFilterExecMs] = useState(0)
    const [isWorkerReady, setIsWorkerReady] = useState(false)
    const [inline, setInline] = useState(typeof Worker === 'undefined')

    const workerRef = useRef<Worker | null>(null)
    const engineRef = useRef<FilterEngine | null>(null)
    const lastIdRef = useRef<string | null>(null)
    const sentRef = useRef<{ query: string; search: string; filters: CustomFilter[] | null }>({ query: '\0', search: '\0', filters: null })
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const paramsRef = useRef(params)
    paramsRef.current = params
    const eventsRef = useRef(events)
    eventsRef.current = events

    const getEngine = () => {
        if (!engineRef.current) {
            engineRef.current = new FilterEngine()
            engineRef.current.configure(maxEvents)
        }
        return engineRef.current
    }

    const publishInline = useCallback(() => {
        const engine = engineRef.current
        if (!engine) return
        setFilteredEvents(engine.snapshot())
    }, [])

    // --- worker lifecycle -----------------------------------------------------------------
    useEffect(() => {
        lastIdRef.current = null
        sentRef.current = { query: '\0', search: '\0', filters: null }

        if (inline || typeof Worker === 'undefined') {
            setIsWorkerReady(false)
            return
        }

        try {
            const worker = workerRegistry.create(WORKER_KEY, () =>
                new Worker(new URL('../workers/filterWorker.ts', import.meta.url), { type: 'module' })
            )
            workerRef.current = worker
            worker.onmessage = (e: MessageEvent) => {
                const msg = e.data
                if (msg?.type === 'FILTERED_EVENTS') {
                    setFilteredEvents(msg.events)
                    setFilterExecMs(msg.execMs)
                }
            }
            worker.onerror = () => setInline(true) // fall back to the same engine on the main thread
            worker.postMessage({ type: 'CONFIG', maxEvents })
            setIsWorkerReady(true)
        } catch {
            setIsWorkerReady(false)
            setInline(true)
        }

        return () => {
            workerRef.current = null
            workerRegistry.release(WORKER_KEY)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inline, maxEvents])

    // --- filter parameters (debounced, only changed parts are re-sent) -------------------------
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => {
            const p = paramsRef.current
            const query = p.queryError ? '' : p.query
            const sent = sentRef.current
            const queryChanged = sent.query !== query || sent.search !== p.searchQuery
            const filtersChanged = sent.filters !== p.customFilters
            if (!queryChanged && !filtersChanged) return
            sentRef.current = { query, search: p.searchQuery, filters: p.customFilters }

            const worker = workerRef.current
            if (worker && !inline) {
                if (queryChanged) worker.postMessage({ type: 'QUERY_UPDATE', query, search: p.searchQuery })
                if (filtersChanged) worker.postMessage({ type: 'CUSTOM_FILTERS_UPDATE', filters: serializeFilters(p.customFilters) })
            } else {
                const engine = getEngine()
                const t0 = performance.now()
                if (queryChanged) engine.setQuery(query, p.searchQuery)
                if (filtersChanged) engine.setCustomFilters(serializeFilters(p.customFilters))
                setFilterExecMs(+(performance.now() - t0).toFixed(2))
                publishInline()
            }
        }, DEBOUNCE_MS)
        return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params.query, params.queryError, params.searchQuery, params.customFilters, inline, isWorkerReady])

    // --- mirror new events into the engine --------------------------------------------------
    useEffect(() => {
        const worker = workerRef.current
        const useWorker = Boolean(worker) && !inline
        const sink = {
            clear: () => { if (useWorker) worker!.postMessage({ type: 'CLEAR' }); else getEngine().clear() },
            add: (batch: EventMessage[]) => { if (useWorker) worker!.postMessage({ type: 'ADD_EVENTS', events: batch }); else getEngine().addEvents(batch) },
        }

        if (events.length === 0) {
            if (lastIdRef.current !== null) {
                sink.clear()
                lastIdRef.current = null
                if (!useWorker) publishInline()
            }
            return
        }

        const last = lastIdRef.current
        // The buffer was replaced (reconnect, history load) or a whole buffer arrived at once: start from scratch.
        if (last !== null && !events.some((e) => e.id === last)) sink.clear()

        const fresh = newEventsSince(events, last)
        if (fresh.length === 0) return
        lastIdRef.current = events[0].id
        if (useWorker) {
            sink.add(fresh)
        } else {
            const t0 = performance.now()
            sink.add(fresh)
            setFilterExecMs(+(performance.now() - t0).toFixed(2))
            publishInline()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [events, inline, isWorkerReady])

    const clearWorker = useCallback(() => {
        if (workerRef.current && !inline) workerRef.current.postMessage({ type: 'CLEAR' })
        else engineRef.current?.clear()
        lastIdRef.current = null
        setFilteredEvents([])
    }, [inline])

    return useMemo(() => ({
        filteredEvents,
        filterExecMs,
        isWorkerReady,
        clearWorker,
    }), [filteredEvents, filterExecMs, isWorkerReady, clearWorker])
}
