import { useState, useRef, useCallback, useEffect } from 'react'
import type { EventMessage } from '../types'
import { buildEvent, finalizeEvent, type IncomingSSE } from '../utils/buildEvent'

/**
 * Turns raw SSE messages into the newest-first, capped event buffer the UI renders.
 *
 *  - messages are queued and flushed once per animation frame (or every 50 ms in a background tab), so a
 *    burst of thousands of events costs one React render, not thousands
 *  - interceptors run sequentially, in arrival order (no reordering from async completion)
 *  - the queue is bounded; if the page cannot keep up the oldest queued messages are dropped and counted
 */

const MAX_QUEUE = 20_000
const MAX_BATCH = 1_000
const BACKGROUND_FLUSH_MS = 50

type Interceptor = (event: EventMessage) => Promise<EventMessage | null>

export interface IngestOptions {
    maxEvents: number
    applyInterceptors?: Interceptor | undefined
    onEventPersist?: ((event: EventMessage) => void) | undefined
}

export function useEventIngest({ maxEvents, applyInterceptors, onEventPersist }: IngestOptions) {
    const [events, setEvents] = useState<EventMessage[]>([])
    const [droppedCount, setDroppedCount] = useState(0)

    const queue = useRef<IncomingSSE[]>([])
    const scheduled = useRef<{ raf?: number; timer?: ReturnType<typeof setTimeout> } | null>(null)
    const processing = useRef(false)
    const generation = useRef(0)
    const maxRef = useRef(maxEvents)
    maxRef.current = maxEvents
    const interceptorRef = useRef(applyInterceptors)
    interceptorRef.current = applyInterceptors
    const persistRef = useRef(onEventPersist)
    persistRef.current = onEventPersist
    const droppedRef = useRef(0)

    const flush = useCallback(async () => {
        scheduled.current = null
        if (processing.current) return
        processing.current = true
        const gen = generation.current
        try {
            while (queue.current.length > 0) {
                const batch = queue.current.splice(0, MAX_BATCH)
                const accepted: EventMessage[] = [] // oldest → newest
                for (const incoming of batch) {
                    let event: EventMessage | null = buildEvent(incoming)
                    const intercept = interceptorRef.current
                    if (intercept) {
                        try { event = await intercept(event) } catch { /* a failing interceptor must never lose the event */ }
                        if (event === null) continue
                    }
                    finalizeEvent(event)
                    persistRef.current?.(event)
                    accepted.push(event)
                }
                if (gen !== generation.current) return // cleared or reconnected while we were awaiting
                if (accepted.length > 0) {
                    setEvents((prev) => {
                        const max = maxRef.current
                        const merged = new Array<EventMessage>(Math.min(max, accepted.length + prev.length))
                        let w = 0
                        for (let i = accepted.length - 1; i >= 0 && w < merged.length; i--) merged[w++] = accepted[i]
                        for (let i = 0; i < prev.length && w < merged.length; i++) merged[w++] = prev[i]
                        return merged
                    })
                }
            }
        } finally {
            processing.current = false
            if (queue.current.length > 0 && !scheduled.current) schedule()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const schedule = useCallback(() => {
        if (scheduled.current || processing.current) return
        const hidden = typeof document !== 'undefined' && document.hidden
        if (!hidden && typeof requestAnimationFrame === 'function') {
            const slot: { raf?: number } = {}
            slot.raf = requestAnimationFrame(() => void flush())
            scheduled.current = slot
        } else {
            scheduled.current = { timer: setTimeout(() => void flush(), BACKGROUND_FLUSH_MS) }
        }
    }, [flush])

    const push = useCallback((incoming: IncomingSSE | IncomingSSE[]) => {
        const list = Array.isArray(incoming) ? incoming : [incoming]
        queue.current.push(...list)
        if (queue.current.length > MAX_QUEUE) {
            const drop = queue.current.length - MAX_QUEUE
            queue.current.splice(0, drop)
            droppedRef.current += drop
            setDroppedCount(droppedRef.current)
        }
        schedule()
    }, [schedule])

    const cancelScheduled = () => {
        const s = scheduled.current
        if (!s) return
        if (s.raf !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(s.raf)
        if (s.timer !== undefined) clearTimeout(s.timer)
        scheduled.current = null
    }

    /** Drops queued and in-flight messages and empties the buffer. */
    const clear = useCallback(() => {
        generation.current++
        queue.current = []
        cancelScheduled()
        droppedRef.current = 0
        setDroppedCount(0)
        setEvents([])
    }, [])

    /** Replaces the whole buffer (e.g. loading history from storage). */
    const replace = useCallback((next: EventMessage[]) => {
        generation.current++
        queue.current = []
        cancelScheduled()
        setEvents(next.slice(0, maxRef.current))
    }, [])

    useEffect(() => () => { generation.current++; cancelScheduled() }, [])

    return { events, push, clear, replace, droppedCount }
}
