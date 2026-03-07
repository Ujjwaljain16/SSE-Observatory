/**
 * useSharedStream.ts
 *
 * Drop-in replacement for useEventStream that routes through a SharedWorker.
 * All tabs sharing the same (url + token) combination will see the same live data
 * from a single EventSource owned by the SharedWorker.
 *
 * Automatically falls back to useEventStream if:
 *   - SharedWorker is not supported (Firefox private mode, Safari < 16)
 *   - The worker fails to initialise
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { EventMessage } from '../types'
import { useEventStream } from './useEventStream'
import { workerRegistry } from '../utils/workerRegistry'

const WORKER_KEY = 'shared-sse-worker'
const PING_INTERVAL_MS = 30_000
const MAX_EVENTS = 1000
const MAX_RECONNECT_ATTEMPTS = 3




export type UseEventStreamReturn = ReturnType<typeof useEventStream>

export function useSharedStream(
    maxEvents: number = MAX_EVENTS,
    applyInterceptors?: (event: EventMessage) => Promise<EventMessage | null>,
    onEventPersist?: (event: EventMessage) => void
): UseEventStreamReturn {
    const sharedWorkerSupported = typeof SharedWorker !== 'undefined'



    const fallback = useEventStream(maxEvents, applyInterceptors, onEventPersist)


    const [connected, setConnected] = useState(false)
    const [events, setEvents] = useState<EventMessage[]>([])
    const [error, setError] = useState('')
    const [isLoading, setIsLoading] = useState(false)

    const workerRef = useRef<SharedWorker | null>(null)
    const counterRef = useRef(0)
    const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const currentUrlRef = useRef<string>('')
    const currentTokenRef = useRef<string | undefined>()
    const fallbackRef = useRef(false)
    const reconnectAttemptRef = useRef(0)

    // Keep a live ref to applyInterceptors to avoid stale closure in onmessage
    const interceptorRef = useRef(applyInterceptors)
    useEffect(() => { interceptorRef.current = applyInterceptors }, [applyInterceptors])

    // Keep a live ref to onEventPersist for the same reason
    const onEventPersistRef = useRef(onEventPersist)
    useEffect(() => { onEventPersistRef.current = onEventPersist }, [onEventPersist])

    useEffect(() => {
        if (!sharedWorkerSupported) return
        try {
            const worker = workerRegistry.create(WORKER_KEY, () =>
                new SharedWorker(
                    new URL('../workers/sharedSSEWorker.ts', import.meta.url),
                    { type: 'module', name: 'sse-shared-worker' }
                )
            )
            workerRef.current = worker
            worker.port.start()

            if (typeof window !== 'undefined') {
                const w = window as any
                if (!w.__sharedWorkerPorts__) w.__sharedWorkerPorts__ = []
                if (!w.__sharedWorkerPorts__.includes(worker.port)) {
                    w.__sharedWorkerPorts__.push(worker.port)
                }
            }

            worker.port.onmessage = async (e: MessageEvent) => {
                const msg = e.data

                if (msg.type === 'connected') {
                    reconnectAttemptRef.current = 0
                    setConnected(true)
                    setIsLoading(false)
                    setError('')
                    return
                }

                if (msg.type === 'catchup') {
                    // Batch-add catch-up events; extract parsedType from JSON payload
                    const stamped: EventMessage[] = msg.events.map((raw: any) => {
                        let parsedType: string | undefined
                        try {
                            const parsed = JSON.parse(raw.raw ?? raw)
                            if (parsed?.type) parsedType = String(parsed.type)
                        } catch { }
                        return {
                            id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Math.random().toString(36).substring(2) + Date.now().toString(36)),
                            timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                            arrivalTime: raw.arrivalTime ?? Date.now(),
                            type: 'message',
                            data: raw.raw ?? raw,
                            raw: typeof raw === 'string' ? raw : JSON.stringify(raw),
                            ...(parsedType && { parsedType }),
                            _searchIndex: (typeof raw === 'string' ? raw : JSON.stringify(raw)).toLowerCase()
                        }
                    })
                    setEvents(prev => {
                        const merged = [...stamped, ...prev]
                        return merged.length > maxEvents ? merged.slice(0, maxEvents) : merged
                    })
                    return
                }

                if (msg.type === 'event') {
                    let newEvent: EventMessage = {
                        id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Math.random().toString(36).substring(2) + Date.now().toString(36)),
                        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                        arrivalTime: msg.payload.arrivalTime ?? Date.now(),
                        type: 'message',
                        data: msg.payload.raw,
                        raw: msg.payload.raw,
                    }

                    // Try to extract parsedType from JSON payload — never overwrite data with object
                    try {
                        const parsed = JSON.parse(msg.payload.raw)
                        if (parsed?.type) {
                            newEvent.parsedType = String(parsed.type)
                        }
                    } catch { }

                    // Always read interceptors via ref — never stale
                    if (interceptorRef.current) {
                        const transformed = await interceptorRef.current(newEvent)
                        if (transformed === null) return
                        newEvent = transformed
                    }

                    newEvent._searchIndex = (typeof newEvent.data === 'string' ? newEvent.data : JSON.stringify(newEvent.data)).toLowerCase()

                    onEventPersistRef.current?.(newEvent)

                    setEvents(prev => {
                        const next = [newEvent, ...prev]
                        return next.length > maxEvents ? next.slice(0, maxEvents) : next
                    })
                    return
                }

                if (msg.type === 'error') {
                    // EventSource error — attempt to reconnect
                    const attempt = reconnectAttemptRef.current
                    if (attempt < MAX_RECONNECT_ATTEMPTS && currentUrlRef.current) {
                        reconnectAttemptRef.current = attempt + 1
                        setError(`Connection lost. Reconnecting... (${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})`)
                        setTimeout(() => {
                            if (workerRef.current && !fallbackRef.current) {
                                workerRef.current.port.postMessage({
                                    type: 'connect',
                                    url: currentUrlRef.current,
                                    token: currentTokenRef.current,
                                })
                            }
                        }, 2000 * (attempt + 1))
                    } else {
                        setError(msg.message ?? 'Stream error — reconnecting...')
                    }
                    return
                }

                if (msg.type === 'disconnected') {
                    // Explicit user-initiated disconnect from the SharedWorker
                    setConnected(false)
                    setIsLoading(false)
                    setError('')
                }
            }

            worker.port.addEventListener('messageerror', () => {
                fallbackRef.current = true
            })
        } catch {
            fallbackRef.current = true
        }

        return () => {
            if (pingRef.current) clearInterval(pingRef.current)
            workerRegistry.release(WORKER_KEY)
        }
    }, [])

    const connect = useCallback((url: string, token?: string, clearHistory = true) => {
        if (!workerRef.current || fallbackRef.current) return
        currentUrlRef.current = url
        currentTokenRef.current = token
        reconnectAttemptRef.current = 0

        if (clearHistory) {
            setEvents([])
            counterRef.current = 0
        }

        setIsLoading(true)
        setError('')

        workerRef.current.port.postMessage({ type: 'connect', url, token })

        // Start ping heartbeat
        if (pingRef.current) clearInterval(pingRef.current)
        pingRef.current = setInterval(() => {
            workerRef.current?.port.postMessage({ type: 'ping' })
        }, PING_INTERVAL_MS)
    }, [])

    const disconnect = useCallback(() => {
        if (workerRef.current && !fallbackRef.current) {
            workerRef.current.port.postMessage({ type: 'disconnect' })
        }
        if (pingRef.current) clearInterval(pingRef.current)
        reconnectAttemptRef.current = 0
        setConnected(false)
        setIsLoading(false)
    }, [])

    const clearEvents = useCallback(() => {
        setEvents([])
    }, [])

    // If SharedWorker not supported or failed, use the fallback
    if (!sharedWorkerSupported || fallbackRef.current) {
        return fallback
    }

    return {
        connected,
        events,
        error,
        isLoading,
        connect,
        disconnect,
        clearEvents,
        maxEvents,
    }
}
