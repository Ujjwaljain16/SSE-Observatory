/**
 * useCorrelationTracker.ts
 *
 * Detects causal chains across SSE events by extracting correlation identifiers
 * from event payloads. Standard distributed tracing fields are checked automatically.
 *
 * Correlation fields checked (in order of priority):
 *   traceId, requestId, correlationId, transactionId, spanId, sessionId, userId
 *
 * Returns:
 *   traces        — Map<correlationId, TraceEntry>  (all currently known chains)
 *   activeTraceId — currently selected trace for UI display
 *   setActiveTraceId
 *   getEventChain(id) — sorted array of events for a given correlation ID
 *   getTraceForEvent(event) — which trace this event belongs to (if any)
 *   correlationField — which field name was most commonly found (for UI hint)
 *   clearTraces()
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { EventMessage } from '../types'

export interface TraceEntry {
    id: string              // the correlation value
    field: string           // which field it came from (e.g. "traceId")
    events: EventMessage[]  // sorted oldest-first by arrivalTime
    firstSeen: number       // epoch ms
    lastSeen: number        // epoch ms
    services: string[]      // distinct event types seen in this trace
}

// Priority-ordered list of fields to check
const CORRELATION_KEYS = [
    'traceId',
    'requestId',
    'correlationId',
    'transactionId',
    'spanId',
    'sessionId',
    'userId',
    'x-trace-id',
    'x-request-id',
]

/** Extract the first found correlation id + field from a parsed event payload */
function extractCorrelation(event: EventMessage): { id: string; field: string } | null {
    let data: any
    if (typeof event.data === 'object' && event.data !== null) {
        data = event.data
    } else if (typeof event.data === 'string') {
        try { data = JSON.parse(event.data) } catch { return null }
    } else {
        return null
    }

    if (typeof data !== 'object' || data === null) return null

    // Check top-level fields first
    for (const key of CORRELATION_KEYS) {
        if (data[key] && typeof data[key] === 'string') {
            return { id: data[key], field: key }
        }
    }

    // Check one level of nesting (e.g. data.meta.traceId, data.headers.x-request-id)
    for (const topKey of Object.keys(data)) {
        const sub = data[topKey]
        if (sub && typeof sub === 'object') {
            for (const key of CORRELATION_KEYS) {
                if (sub[key] && typeof sub[key] === 'string') {
                    return { id: sub[key], field: `${topKey}.${key}` }
                }
            }
        }
    }

    return null
}

export function useCorrelationTracker(events: EventMessage[]) {
    // Map: correlationId → TraceEntry
    const tracesRef = useRef<Map<string, TraceEntry>>(new Map())
    const [traces, setTraces] = useState<Map<string, TraceEntry>>(new Map())
    const [activeTraceId, setActiveTraceId] = useState<string | null>(null)
    // Map: eventId → correlationId  (for O(1) "which trace is this event in?")
    const eventTraceMapRef = useRef<Map<string, string>>(new Map())
    // Track the length we have already indexed to only process new events (O(n) total)
    const prevLengthRef = useRef(0)

    // Incrementally index only new events — never re-scans the full array
    useEffect(() => {
        // Events are stored newest-first; new events arrive at the front.
        // `events.slice(0, events.length - prevLengthRef.current)` gives the new ones.
        const newCount = events.length - prevLengthRef.current
        if (newCount <= 0) return
        prevLengthRef.current = events.length

        const newEvents = events.slice(0, newCount)
        let changed = false

        for (const event of newEvents) {
            const correlation = extractCorrelation(event)
            if (!correlation) continue

            const { id, field } = correlation
            const existing = tracesRef.current.get(id)
            const arrival = event.arrivalTime ?? Date.now()

            if (existing) {
                existing.events.push(event)
                // Keep sorted oldest-first
                existing.events.sort((a, b) => (a.arrivalTime ?? 0) - (b.arrivalTime ?? 0))
                existing.lastSeen = Math.max(existing.lastSeen, arrival)
                if (!existing.services.includes(event.type)) {
                    existing.services.push(event.type)
                }
            } else {
                tracesRef.current.set(id, {
                    id,
                    field,
                    events: [event],
                    firstSeen: arrival,
                    lastSeen: arrival,
                    services: [event.type],
                })
            }
            eventTraceMapRef.current.set(event.id, id)
            changed = true
        }
        if (changed) {
            setTraces(new Map(tracesRef.current))
        }
    }, [events])

    const getEventChain = useCallback((traceId: string): EventMessage[] => {
        return tracesRef.current.get(traceId)?.events ?? []
    }, [])

    const getTraceForEvent = useCallback((event: EventMessage): TraceEntry | null => {
        const traceId = eventTraceMapRef.current.get(event.id)
        if (!traceId) return null
        return tracesRef.current.get(traceId) ?? null
    }, [])

    const clearTraces = useCallback(() => {
        tracesRef.current.clear()
        eventTraceMapRef.current.clear()
        prevLengthRef.current = 0
        setTraces(new Map())
        setActiveTraceId(null)
    }, [])

    // Derived: which correlation field is most common (for UI hint)
    const correlationField = useMemo(() => {
        const counts = new Map<string, number>()
        for (const trace of tracesRef.current.values()) {
            const base = trace.field.split('.').pop() ?? trace.field
            counts.set(base, (counts.get(base) ?? 0) + trace.events.length)
        }
        let best = ''
        let bestCount = 0
        for (const [field, count] of counts) {
            if (count > bestCount) { best = field; bestCount = count }
        }
        return best || 'traceId'
    }, [traces]) // eslint-disable-line

    return {
        traces,
        activeTraceId,
        setActiveTraceId,
        getEventChain,
        getTraceForEvent,
        correlationField,
        clearTraces,
        traceCount: traces.size,
    }
}
