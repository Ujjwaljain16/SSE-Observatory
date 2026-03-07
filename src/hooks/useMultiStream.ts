import { useState, useCallback, useRef, useEffect } from 'react'
import type { EventMessage } from '../types'
import { obtainSSEProxyTicket } from '../utils/sseProxyUrl'


// 6 distinct, accessible colors for stream lanes
export const STREAM_COLORS = [
    '#3b82f6', // blue
    '#10b981', // emerald
    '#f59e0b', // amber
    '#ef4444', // red
    '#8b5cf6', // violet
    '#06b6d4', // cyan
]

export interface StreamInstance {
    id: string
    name: string
    url: string
    token?: string
    color: string
    events: EventMessage[]
    connected: boolean
    isLoading: boolean
    error: string
    eventSource: EventSource | null
}

interface UseMultiStreamReturn {
    streams: StreamInstance[]
    mergedEvents: EventMessage[]
    addStream: (name: string, url: string, token?: string) => string
    removeStream: (id: string) => void
    connectStream: (id: string) => void
    disconnectStream: (id: string) => void
    clearStreamEvents: (id: string) => void
    totalMergedCount: number
}

const PER_STREAM_LIMIT = 1000
const MERGED_VIEW_LIMIT = 5000

let streamCounter = 0

export const useMultiStream = (): UseMultiStreamReturn => {
    const [streams, setStreams] = useState<StreamInstance[]>([])
    const eventSourcesRef = useRef<Map<string, EventSource>>(new Map())
    const eventCountersRef = useRef<Map<string, number>>(new Map())

    // Merge all stream events into a single chronological array
    const mergedEvents: EventMessage[] = (() => {
        const all: EventMessage[] = []
        for (const stream of streams) {
            all.push(...stream.events)
        }
        // Sort by arrivalTime (epoch ms). This is insertion-time corrected by
        // the actual arrival, not by SSE sequence. For distributed services,
        // this is more reliable than insertion order.
        all.sort((a, b) => (a.arrivalTime ?? 0) - (b.arrivalTime ?? 0))
        // Cap the merged view to avoid rendering too many DOM nodes
        return all.slice(-MERGED_VIEW_LIMIT)
    })()

    const updateStream = useCallback((id: string, patch: Partial<StreamInstance>) => {
        setStreams(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
    }, [])

    const connectStream = useCallback((id: string) => {
        setStreams(prev => {
            const stream = prev.find(s => s.id === id)
            if (!stream || !stream.url || stream.connected) return prev

            // Close existing connection safely outside, technically this is still inside prev 
            // but we can schedule the side effect using setTimeout to break out of React's pure render phase
            setTimeout(async () => {
                const existing = eventSourcesRef.current.get(id)
                if (existing) existing.close()

                try {
                    const sseUrl = await obtainSSEProxyTicket(stream.url, stream.token)
                    const es = new EventSource(sseUrl)
                    eventSourcesRef.current.set(id, es)
                    eventCountersRef.current.set(id, 0)

                    es.onopen = () => {
                        updateStream(id, { connected: true, isLoading: false, error: '' })
                    }

                    es.onmessage = (e) => {
                        const counter = eventCountersRef.current.get(id) ?? 0
                        eventCountersRef.current.set(id, counter + 1)

                        let parsedType: string | undefined
                        try {
                            const parsed = JSON.parse(e.data)
                            if (parsed && typeof parsed === 'object' && 'type' in parsed) {
                                parsedType = String(parsed.type)
                            }
                        } catch { /* not JSON */ }

                        const newEvent: EventMessage = {
                            id: `${id}-${counter}`,
                            timestamp: new Date().toLocaleTimeString('en-US', {
                                hour: '2-digit', minute: '2-digit', second: '2-digit',
                            }),
                            arrivalTime: Date.now(),
                            type: 'message',
                            data: e.data,
                            raw: JSON.stringify(e, null, 2),
                            streamId: id,
                            streamColor: stream.color,
                            ...(parsedType && { parsedType }),
                        }

                        setStreams(current => current.map(s => {
                            if (s.id !== id) return s
                            const updated = [newEvent, ...s.events]
                            return { ...s, events: updated.slice(0, PER_STREAM_LIMIT) }
                        }))
                    }

                    es.onerror = () => {
                        if (es.readyState === EventSource.CLOSED) {
                            eventSourcesRef.current.delete(id)
                            updateStream(id, { connected: false, isLoading: false, error: 'Connection closed' })
                        } else {
                            updateStream(id, { isLoading: false, error: 'Connection interrupted, reconnecting...' })
                        }
                    }
                } catch (err) {
                    updateStream(id, { connected: false, isLoading: false, error: 'Failed to negotiate secure SSE proxy ticket' })
                }
            }, 0)

            return prev.map(s => s.id === id ? { ...s, isLoading: true, error: '' } : s)
        })
    }, [updateStream])

    const disconnectStream = useCallback((id: string) => {
        const es = eventSourcesRef.current.get(id)
        if (es) {
            es.close()
            eventSourcesRef.current.delete(id)
        }
        updateStream(id, { connected: false, isLoading: false, eventSource: null })
    }, [updateStream])

    const addStream = useCallback((name: string, url: string, token?: string): string => {
        const id = `stream-${++streamCounter}-${Date.now()}`
        const color = STREAM_COLORS[streamCounter % STREAM_COLORS.length]
        const newStream: StreamInstance = {
            id, name, url, color,
            events: [], connected: false, isLoading: false,
            error: '', eventSource: null,
            ...(token && { token }),
        }
        setStreams(prev => [...prev, newStream])
        return id
    }, [])

    const removeStream = useCallback((id: string) => {
        disconnectStream(id)
        setStreams(prev => prev.filter(s => s.id !== id))
    }, [disconnectStream])

    const clearStreamEvents = useCallback((id: string) => {
        updateStream(id, { events: [] })
        eventCountersRef.current.set(id, 0)
    }, [updateStream])

    // Cleanup all EventSources on unmount
    useEffect(() => {
        return () => {
            eventSourcesRef.current.forEach(es => es.close())
        }
    }, [])

    return {
        streams,
        mergedEvents,
        addStream,
        removeStream,
        connectStream,
        disconnectStream,
        clearStreamEvents,
        totalMergedCount: mergedEvents.length,
    }
}
