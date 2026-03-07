import { useState, useRef, useEffect, useCallback } from 'react'
import { obtainSSEProxyTicket } from '../utils/sseProxyUrl'

import type { EventMessage } from '../types'

interface UseEventStreamReturn {
    connected: boolean
    events: EventMessage[]
    error: string
    isLoading: boolean
    connect: (url: string, token?: string, clearHistory?: boolean) => void
    disconnect: () => void
    clearEvents: () => void
    maxEvents: number
}

export const useEventStream = (
    maxEvents: number = 1000,
    applyInterceptors?: (event: EventMessage) => Promise<EventMessage | null>,
    onEventPersist?: (event: EventMessage) => void
): UseEventStreamReturn => {
    const [connected, setConnected] = useState(false)
    const [events, setEvents] = useState<EventMessage[]>([])
    const [error, setError] = useState<string>('')
    const [isLoading, setIsLoading] = useState(false)

    const eventSourceRef = useRef<EventSource | null>(null)
    const reconnectAttemptRef = useRef(0)
    const errorTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const maxReconnectAttempts = 3

    const disconnect = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close()
            eventSourceRef.current = null
        }
        if (errorTimeoutRef.current) {
            clearTimeout(errorTimeoutRef.current)
            errorTimeoutRef.current = null
        }
        setConnected(false)
        setIsLoading(false)
        reconnectAttemptRef.current = 0
    }, [])

    const setErrorThrottled = useCallback((msg: string) => {
        if (errorTimeoutRef.current) clearTimeout(errorTimeoutRef.current)
        errorTimeoutRef.current = setTimeout(() => {
            setError(msg)
        }, 500)
    }, [])

    const connect = useCallback(async (url: string, token?: string, clearHistory: boolean = true) => {
        if (!url.trim()) {
            setError('Please enter a valid URL')
            return
        }

        disconnect()
        setIsLoading(true)
        setError('')

        if (clearHistory) {
            setEvents([])

        }
        reconnectAttemptRef.current = 0

        try {
            const ticketUrl = await obtainSSEProxyTicket(url, token)

            console.log(`[useEventStream] Connecting to: ${ticketUrl}`);
            const eventSource = new EventSource(ticketUrl)
            eventSourceRef.current = eventSource

            eventSource.onopen = () => {
                console.log('[useEventStream] Connection opened');
                setConnected(true)
                setIsLoading(false)
                setError('')
                reconnectAttemptRef.current = 0
            }

            eventSource.onerror = (err) => {
                const readyState = eventSource.readyState
                const hadEvents = events.length > 0

                if (readyState === EventSource.CLOSED && hadEvents) {
                    console.log('[useEventStream] Stream closed by server.');
                } else if (readyState === EventSource.CONNECTING && hadEvents) {
                    console.log('[useEventStream] Connection interrupted, browser attempting auto-reconnect...');
                } else {
                    console.error('[useEventStream] SSE Error details:', err);
                }

                if (readyState === EventSource.CLOSED) {
                    if (reconnectAttemptRef.current < maxReconnectAttempts) {
                        reconnectAttemptRef.current++
                        setErrorThrottled(`Connection lost. Reconnecting... (${reconnectAttemptRef.current}/${maxReconnectAttempts})`)
                        setTimeout(() => {
                            if (eventSourceRef.current) {
                                eventSourceRef.current.close()
                                connect(url, token, false)
                            }
                        }, 2000 * reconnectAttemptRef.current)
                        return
                    }
                    setErrorThrottled(hadEvents ? 'Stream completed or closed by server.' : 'Connection closed by server. Max reconnection attempts reached.')
                } else if (readyState === EventSource.CONNECTING) {
                    setErrorThrottled(hadEvents ? 'Connection interrupted. Attempting to reconnect...' : 'Failed to connect. Check URL and authentication.')
                } else {
                    setErrorThrottled('Connection error occurred')
                }

                if (readyState === EventSource.CLOSED || !hadEvents) {
                    disconnect()
                }
            }

            eventSource.onmessage = async (event) => {
                let parsedType: string | undefined = undefined
                try {
                    const parsed = JSON.parse(event.data)
                    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
                        parsedType = String(parsed.type)
                    }
                } catch {
                }

                let newEvent: EventMessage = {
                    id: crypto.randomUUID(),
                    timestamp: new Date().toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                    }),
                    arrivalTime: Date.now(),
                    type: 'message',
                    data: event.data,
                    raw: JSON.stringify(event, null, 2),
                    ...(parsedType && { parsedType }),
                }

                if (applyInterceptors) {
                    const transformed = await applyInterceptors(newEvent)
                    if (transformed === null) return
                    newEvent = transformed
                }

                newEvent._searchIndex = (typeof newEvent.data === 'string' ? newEvent.data : JSON.stringify(newEvent.data)).toLowerCase()

                onEventPersist?.(newEvent)

                setEvents((prev) => {
                    // Ring buffer logic: keep most recent MAX_EVENTS
                    const newEvents = [newEvent, ...prev]
                    if (newEvents.length > maxEvents) {
                        return newEvents.slice(0, maxEvents)
                    }
                    return newEvents
                })
            }

            // Listen for explicit end event
            eventSource.addEventListener('end', () => {
                console.log('[useEventStream] Received end event. Closing cleanly.');
                disconnect();
                setError('Stream completed successfully.');
            });
        } catch (err) {
            console.error('Connection error:', err)
            setError('Failed to establish connection')
            setIsLoading(false)
        }
    }, [disconnect, maxEvents])

    const clearEvents = useCallback(() => {
        setEvents([])
    }, [])

    useEffect(() => {
        return () => {
            disconnect()
        }
    }, [disconnect])

    return {
        connected,
        events,
        error,
        isLoading,
        connect,
        disconnect,
        clearEvents,
        maxEvents
    }
}
