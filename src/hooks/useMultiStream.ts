import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { EventMessage } from '../types'
import { SSEClient } from '../utils/sseClient'
import { buildSSERequest } from '../utils/sseProxyUrl'
import { buildEvent, finalizeEvent } from '../utils/buildEvent'
import { describeStatus } from './useSharedStream'

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

/** Newest-first merge of per-stream buffers, ordered by arrival time, capped for rendering. */
export function mergeStreamEvents(streams: Pick<StreamInstance, 'events'>[], limit = MERGED_VIEW_LIMIT): EventMessage[] {
    const all: EventMessage[] = []
    for (const s of streams) for (const e of s.events) all.push(e)
    all.sort((a, b) => (b.arrivalTime ?? 0) - (a.arrivalTime ?? 0))
    return all.length > limit ? all.slice(0, limit) : all
}

export const useMultiStream = (): UseMultiStreamReturn => {
    const [streams, setStreams] = useState<StreamInstance[]>([])
    const streamsRef = useRef(streams)
    streamsRef.current = streams

    const clientsRef = useRef<Map<string, SSEClient>>(new Map())
    const pendingRef = useRef<Map<string, EventMessage[]>>(new Map()) // oldest → newest per stream
    const frameRef = useRef<number | null>(null)

    const mergedEvents = useMemo(() => mergeStreamEvents(streams), [streams])

    const updateStream = useCallback((id: string, patch: Partial<StreamInstance>) => {
        setStreams(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)))
    }, [])

    // One state update per animation frame, however many events arrived.
    const flush = useCallback(() => {
        frameRef.current = null
        const pending = pendingRef.current
        if (pending.size === 0) return
        const batches = new Map(pending)
        pending.clear()
        setStreams(prev => prev.map(s => {
            const batch = batches.get(s.id)
            if (!batch || batch.length === 0) return s
            const merged = [...batch].reverse().concat(s.events)
            return { ...s, events: merged.length > PER_STREAM_LIMIT ? merged.slice(0, PER_STREAM_LIMIT) : merged }
        }))
    }, [])

    const scheduleFlush = useCallback(() => {
        if (frameRef.current !== null) return
        frameRef.current = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(flush)
            : (setTimeout(flush, 16) as unknown as number)
    }, [flush])

    const stopClient = useCallback((id: string) => {
        clientsRef.current.get(id)?.stop()
        clientsRef.current.delete(id)
        pendingRef.current.delete(id)
    }, [])

    const connectStream = useCallback((id: string) => {
        const stream = streamsRef.current.find(s => s.id === id)
        if (!stream || !stream.url.trim()) return
        stopClient(id)

        const client = new SSEClient({
            request: () => buildSSERequest(stream.url, stream.token, true),
            onMessage: (m) => {
                const event = finalizeEvent(buildEvent(
                    { event: m.event, data: m.data, id: m.id, raw: m.raw, arrivalTime: Date.now() },
                    { streamId: id, streamColor: stream.color }
                ))
                const list = pendingRef.current.get(id) ?? []
                list.push(event)
                pendingRef.current.set(id, list)
                scheduleFlush()
            },
            onPhase: (phase, info) => {
                const status = describeStatus(phase, info)
                updateStream(id, {
                    connected: status.phase === 'open',
                    isLoading: status.phase === 'connecting',
                    error: status.phase === 'reconnecting' || status.phase === 'failed' || status.phase === 'ended' ? status.message : '',
                })
            },
        })
        clientsRef.current.set(id, client)
        updateStream(id, { isLoading: true, error: '' })
        client.start()
    }, [scheduleFlush, stopClient, updateStream])

    const disconnectStream = useCallback((id: string) => {
        stopClient(id)
        updateStream(id, { connected: false, isLoading: false, error: '' })
    }, [stopClient, updateStream])

    const addStream = useCallback((name: string, url: string, token?: string): string => {
        const id = `stream-${++streamCounter}-${Date.now()}`
        const color = STREAM_COLORS[streamCounter % STREAM_COLORS.length]
        const newStream: StreamInstance = {
            id, name, url, color,
            events: [], connected: false, isLoading: false, error: '',
            ...(token && { token }),
        }
        setStreams(prev => [...prev, newStream])
        return id
    }, [])

    const removeStream = useCallback((id: string) => {
        stopClient(id)
        setStreams(prev => prev.filter(s => s.id !== id))
    }, [stopClient])

    const clearStreamEvents = useCallback((id: string) => {
        pendingRef.current.delete(id)
        updateStream(id, { events: [] })
    }, [updateStream])

    // Close everything on unmount
    useEffect(() => {
        const clients = clientsRef.current
        return () => {
            clients.forEach(c => c.stop())
            clients.clear()
            if (frameRef.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current)
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
