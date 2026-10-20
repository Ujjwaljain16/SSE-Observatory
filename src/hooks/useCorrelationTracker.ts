/**
 * Groups events into causal chains by a correlation identifier found in the payload.
 *
 * Fields are checked in priority order, at the top level first and then one level down
 * (e.g. data.meta.traceId, data.headers["x-request-id"]).
 *
 * Memory is bounded: at most MAX_TRACES traces are kept (least recently updated are evicted) and each trace keeps
 * its newest MAX_EVENTS_PER_TRACE events.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { EventMessage } from '../types'
import { getParsedData } from '../utils/eventUtils'
import { newEventsSince } from '../utils/eventBuffer'

export interface TraceEntry {
    id: string              // the correlation value
    field: string           // which field it came from (e.g. "traceId")
    events: EventMessage[]  // sorted oldest-first by arrivalTime
    firstSeen: number       // epoch ms
    lastSeen: number        // epoch ms
    services: string[]      // distinct event types seen in this trace
}

// Identifiers that group a *request chain*. Per-span ids (spanId) are unique per event, and user/session ids
// group unrelated activity, so they are deliberately not used.
export const CORRELATION_KEYS = [
    'traceId', 'trace_id', 'trace-id', 'x-trace-id',
    'requestId', 'request_id', 'request-id', 'x-request-id',
    'correlationId', 'correlation_id', 'correlation-id', 'x-correlation-id',
    'transactionId', 'transaction_id',
]

export const MAX_TRACES = 500
export const MAX_EVENTS_PER_TRACE = 200

const asId = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null)

/** Extract the first found correlation id + field from an event payload */
export function extractCorrelation(event: EventMessage): { id: string; field: string } | null {
    const data = getParsedData(event)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
    const obj = data as Record<string, unknown>

    for (const key of CORRELATION_KEYS) {
        const id = asId(Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined)
        if (id) return { id, field: key }
    }
    for (const topKey of Object.keys(obj)) {
        const sub = obj[topKey]
        if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
            for (const key of CORRELATION_KEYS) {
                const id = asId(Object.prototype.hasOwnProperty.call(sub, key) ? (sub as Record<string, unknown>)[key] : undefined)
                if (id) return { id, field: `${topKey}.${key}` }
            }
        }
    }
    return null
}

export function useCorrelationTracker(events: EventMessage[], epoch = 0) {
    const tracesRef = useRef<Map<string, TraceEntry>>(new Map())
    const [traces, setTraces] = useState<Map<string, TraceEntry>>(new Map())
    const [activeTraceId, setActiveTraceId] = useState<string | null>(null)
    const eventTraceMapRef = useRef<Map<string, string>>(new Map()) // eventId → traceId
    const lastIdRef = useRef<string | null>(null)
    const epochRef = useRef(epoch)

    const reset = useCallback(() => {
        tracesRef.current.clear()
        eventTraceMapRef.current.clear()
        lastIdRef.current = null
    }, [])

    // Only new events are examined, found by identity (the buffer length stops changing once it is full)
    useEffect(() => {
        if (events.length === 0) {
            if (lastIdRef.current !== null || tracesRef.current.size > 0) { reset(); setTraces(new Map()) }
            return
        }
        const last = lastIdRef.current
        let replaced = false
        const epochChanged = epochRef.current !== epoch
        epochRef.current = epoch
        if (epochChanged || (last !== null && !events.some((e) => e.id === last))) { replaced = true; reset() }

        const fresh = newEventsSince(events, replaced ? null : last)
        lastIdRef.current = events[0].id
        let changed = replaced

        for (const event of fresh) {
            const correlation = extractCorrelation(event)
            if (!correlation) continue
            const { id, field } = correlation
            const arrival = event.arrivalTime ?? Date.now()
            let trace = tracesRef.current.get(id)

            if (trace) {
                // Map preserves insertion order: re-insert to mark as most recently used
                tracesRef.current.delete(id)
                tracesRef.current.set(id, trace)
                const list = trace.events
                // arrival order is the norm; fall back to insertion for out-of-order (catch-up) events
                let i = list.length
                while (i > 0 && (list[i - 1].arrivalTime ?? 0) > arrival) i--
                list.splice(i, 0, event)
                if (list.length > MAX_EVENTS_PER_TRACE) {
                    const dropped = list.splice(0, list.length - MAX_EVENTS_PER_TRACE)
                    for (const d of dropped) eventTraceMapRef.current.delete(d.id)
                }
                trace.lastSeen = Math.max(trace.lastSeen, arrival)
                trace.firstSeen = Math.min(trace.firstSeen, arrival)
                if (!trace.services.includes(event.type)) trace.services.push(event.type)
            } else {
                trace = { id, field, events: [event], firstSeen: arrival, lastSeen: arrival, services: [event.type] }
                tracesRef.current.set(id, trace)
                if (tracesRef.current.size > MAX_TRACES) {
                    const oldestKey = tracesRef.current.keys().next().value as string
                    const evicted = tracesRef.current.get(oldestKey)
                    tracesRef.current.delete(oldestKey)
                    for (const e of evicted?.events ?? []) eventTraceMapRef.current.delete(e.id)
                }
            }
            eventTraceMapRef.current.set(event.id, id)
            changed = true
        }
        if (changed) setTraces(new Map(tracesRef.current))
    }, [events, epoch, reset])

    const getEventChain = useCallback((traceId: string): EventMessage[] => tracesRef.current.get(traceId)?.events ?? [], [])

    const getTraceForEvent = useCallback((event: EventMessage): TraceEntry | null => {
        const traceId = eventTraceMapRef.current.get(event.id)
        return traceId ? tracesRef.current.get(traceId) ?? null : null
    }, [])

    const clearTraces = useCallback(() => {
        reset()
        setTraces(new Map())
        setActiveTraceId(null)
    }, [reset])

    // Which correlation field is most common (UI hint)
    const correlationField = useMemo(() => {
        const counts = new Map<string, number>()
        for (const trace of traces.values()) {
            const base = trace.field.split('.').pop() ?? trace.field
            counts.set(base, (counts.get(base) ?? 0) + trace.events.length)
        }
        let best = ''
        let bestCount = 0
        for (const [field, count] of counts) if (count > bestCount) { best = field; bestCount = count }
        return best || 'traceId'
    }, [traces])

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
