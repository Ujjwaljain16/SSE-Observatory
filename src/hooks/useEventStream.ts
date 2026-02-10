import { useState, useRef, useEffect, useCallback } from 'react'
import type { EventMessage } from '../types'

interface UseEventStreamReturn {
    connected: boolean
    events: EventMessage[]
    error: string
    isLoading: boolean
    connect: (url: string, token?: string) => void
    disconnect: () => void
    clearEvents: () => void
    maxEvents: number
}

export const useEventStream = (maxEvents: number = 1000): UseEventStreamReturn => {
    const [connected, setConnected] = useState(false)
    const [events, setEvents] = useState<EventMessage[]>([])
    const [error, setError] = useState<string>('')
    const [isLoading, setIsLoading] = useState(false)

    const eventSourceRef = useRef<EventSource | null>(null)
    const eventCounterRef = useRef(0)
    const reconnectAttemptRef = useRef(0)
    const maxReconnectAttempts = 3

    const disconnect = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close()
            eventSourceRef.current = null
        }
        setConnected(false)
        setIsLoading(false)
        reconnectAttemptRef.current = 0
    }, [])

    const connect = useCallback((url: string, token?: string) => {
        if (!url.trim()) {
            setError('Please enter a valid URL')
            return
        }

        disconnect() // Close existing connection if any
        setIsLoading(true)
        setError('')

        // Don't clear events on reconnect, only on manual clear or new connection if desired
        // For now, let's keep behavior consistent: clear on new connection
        setEvents([])
        eventCounterRef.current = 0
        reconnectAttemptRef.current = 0

        try {
            const authParam = token ? `&auth=${encodeURIComponent(token)}` : ''
            const eventSource = new EventSource(`/api/sse?url=${encodeURIComponent(url)}${authParam}`)
            eventSourceRef.current = eventSource

            eventSource.onopen = () => {
                setConnected(true)
                setIsLoading(false)
                setError('')
                reconnectAttemptRef.current = 0
            }

            eventSource.onerror = (err) => {
                console.error('SSE Error:', err)
                const readyState = eventSource.readyState

                if (readyState === EventSource.CLOSED) {
                    if (reconnectAttemptRef.current < maxReconnectAttempts) {
                        reconnectAttemptRef.current++
                        setError(`Connection lost. Reconnecting... (${reconnectAttemptRef.current}/${maxReconnectAttempts})`)
                        setTimeout(() => {
                            if (eventSourceRef.current) { // Check if still intended to be connected
                                eventSourceRef.current.close()
                                connect(url, token)
                            }
                        }, 2000 * reconnectAttemptRef.current)
                        return
                    }
                    setError('Connection closed by server. Max reconnection attempts reached.')
                } else if (readyState === EventSource.CONNECTING) {
                    setError('Failed to connect. Check URL and authentication.')
                } else {
                    setError('Connection error occurred')
                }
                disconnect()
            }

            eventSource.onmessage = (event) => {
                let parsedType: string | undefined = undefined
                try {
                    const parsed = JSON.parse(event.data)
                    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
                        parsedType = String(parsed.type)
                    }
                } catch {
                    // Not JSON or no type field
                }

                const newEvent: EventMessage = {
                    id: String(eventCounterRef.current++),
                    timestamp: new Date().toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                    }),
                    type: 'message',
                    data: event.data,
                    raw: JSON.stringify(event, null, 2),
                    ...(parsedType && { parsedType }),
                }

                setEvents((prev) => {
                    // Ring buffer logic: keep most recent MAX_EVENTS
                    const newEvents = [newEvent, ...prev]
                    if (newEvents.length > maxEvents) {
                        return newEvents.slice(0, maxEvents)
                    }
                    return newEvents
                })
            }
        } catch (err) {
            console.error('Connection error:', err)
            setError('Failed to establish connection')
            setIsLoading(false)
        }
    }, [disconnect, maxEvents])

    const clearEvents = useCallback(() => {
        setEvents([])
        eventCounterRef.current = 0
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
