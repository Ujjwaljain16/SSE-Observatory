/**
 * useSharedStream.ts
 *
 * The live-stream hook. Connections are owned by a SharedWorker so that every tab watching the same
 * url+token shares ONE upstream connection; when SharedWorker is unavailable (Android Chrome, some
 * private modes) or fails, the very same SSEClient runs directly in the page.
 *
 * Connection lifecycle (connect / retry with backoff / resume with Last-Event-ID / fatal errors) is reported as a
 * single `status`, so the UI can show "Connecting", "Connected", "Reconnecting in 4s (attempt 2)" or a real error.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { EventMessage } from '../types'
import { workerRegistry } from '../utils/workerRegistry'
import { SSEClient, type SSEPhase, type SSEPhaseInfo } from '../utils/sseClient'
import { buildSSERequest } from '../utils/sseProxyUrl'
import type { IncomingSSE } from '../utils/buildEvent'
import { useEventIngest } from './useEventIngest'

const WORKER_KEY = 'shared-sse-worker'
const PING_INTERVAL_MS = 30_000
const MAX_EVENTS = 1000

export type StreamPhase = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'ended' | 'failed'

export interface StreamStatus {
    phase: StreamPhase
    message: string
}

export interface UseStreamReturn {
    connected: boolean
    events: EventMessage[]
    /** Changes whenever the buffer is cleared or replaced; incremental consumers must resync when it does. */
    epoch: number
    /** Human-readable problem or note (reconnecting, failed, ended); '' when all is well. */
    error: string
    /** True only while the first connection attempt is in flight. */
    isLoading: boolean
    /** True while the stream is down and the client is retrying. */
    reconnecting: boolean
    status: StreamPhase
    connect: (url: string, token?: string, clearHistory?: boolean, useProxy?: boolean) => void
    disconnect: () => void
    clearEvents: () => void
    /** Replace the buffer (history loaded from storage). */
    replaceEvents: (events: EventMessage[]) => void
    maxEvents: number
    /** Messages dropped because the page could not keep up. */
    droppedCount: number
    /** Events accepted since the last clear (keeps counting after the ring buffer is full). */
    receivedCount: number
}
export type UseEventStreamReturn = UseStreamReturn

const IDLE: StreamStatus = { phase: 'idle', message: '' }

export function describeStatus(phase: SSEPhase, info: SSEPhaseInfo): StreamStatus {
    switch (phase) {
        case 'connecting': return { phase: 'connecting', message: '' }
        case 'open': return { phase: 'open', message: '' }
        case 'reconnecting': {
            const secs = Math.max(1, Math.round((info.delayMs ?? 0) / 1000))
            return { phase: 'reconnecting', message: `Connection lost${info.reason ? ` (${info.reason})` : ''}. Retrying in ${secs}s (attempt ${info.attempt})…` }
        }
        case 'ended': return { phase: 'ended', message: info.reason ?? 'Stream ended' }
        case 'failed': return { phase: 'failed', message: info.reason ?? 'Connection failed' }
        case 'stopped': return IDLE
    }
}

export function useSharedStream(
    maxEvents: number = MAX_EVENTS,
    applyInterceptors?: (event: EventMessage) => Promise<EventMessage | null>,
    onEventPersist?: (event: EventMessage) => void
): UseStreamReturn {
    const ingest = useEventIngest({ maxEvents, applyInterceptors, onEventPersist })
    const [status, setStatus] = useState<StreamStatus>(IDLE)

    const workerRef = useRef<SharedWorker | null>(null)
    const directRef = useRef<SSEClient | null>(null)
    const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const keyRef = useRef('')
    const lastSeqRef = useRef(0)
    const lastParamsRef = useRef<{ url: string; token: string | undefined; useProxy: boolean } | null>(null)
    const pushRef = useRef(ingest.push)
    pushRef.current = ingest.push

    const stopPing = () => { if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null } }

    const startDirect = useCallback((url: string, token: string | undefined, useProxy: boolean) => {
        directRef.current?.stop()
        const client = new SSEClient({
            request: () => buildSSERequest(url, token, useProxy),
            onMessage: (m) => pushRef.current({ event: m.event, data: m.data, id: m.id, raw: m.raw, arrivalTime: Date.now() }),
            onPhase: (phase, info) => setStatus(describeStatus(phase, info)),
        })
        directRef.current = client
        client.start()
    }, [])

    // --- SharedWorker lifecycle -------------------------------------------------------------
    useEffect(() => {
        if (typeof SharedWorker === 'undefined') return
        try {
            const worker = workerRegistry.create(WORKER_KEY, () =>
                new SharedWorker(new URL('../workers/sharedSSEWorker.ts', import.meta.url), { type: 'module', name: 'sse-shared-worker' })
            )
            workerRef.current = worker
            worker.port.start()

            worker.port.onmessage = (e: MessageEvent) => {
                const msg = e.data
                if (!msg || (msg.key !== undefined && msg.key !== keyRef.current)) return // stale message from a stream we left
                if (msg.type === 'status') {
                    setStatus(describeStatus(msg.phase, msg))
                } else if (msg.type === 'event') {
                    const p = msg.payload as IncomingSSE
                    if (p.seq !== undefined && p.seq <= lastSeqRef.current) return
                    if (p.seq !== undefined) lastSeqRef.current = p.seq
                    pushRef.current(p)
                } else if (msg.type === 'catchup') {
                    const fresh = (msg.events as IncomingSSE[]).filter((p) => p.seq === undefined || p.seq > lastSeqRef.current)
                    if (fresh.length === 0) return
                    const last = fresh[fresh.length - 1].seq
                    if (last !== undefined) lastSeqRef.current = last
                    pushRef.current(fresh)
                }
            }

            // The script failed to load or crashed: carry on in the page with the same client.
            worker.onerror = () => {
                workerRef.current = null
                stopPing()
                const params = lastParamsRef.current
                if (params) startDirect(params.url, params.token, params.useProxy)
            }
        } catch {
            workerRef.current = null
        }

        return () => {
            stopPing()
            workerRef.current?.port.postMessage({ type: 'disconnect' })
            workerRef.current = null
            directRef.current?.stop()
            directRef.current = null
            workerRegistry.release(WORKER_KEY)
        }
    }, [startDirect])

    // --- public API -------------------------------------------------------------------------
    const connect = useCallback((url: string, token?: string, clearHistory = true, useProxy = true) => {
        const trimmed = url.trim()
        if (!trimmed) {
            setStatus({ phase: 'failed', message: 'Please enter a valid URL' })
            return
        }
        stopPing()
        directRef.current?.stop()
        directRef.current = null
        lastParamsRef.current = { url: trimmed, token, useProxy }
        keyRef.current = `${trimmed}::${token ?? ''}`
        lastSeqRef.current = 0
        if (clearHistory) ingest.clear()
        setStatus({ phase: 'connecting', message: '' })

        const worker = workerRef.current
        if (worker) {
            worker.port.postMessage({ type: 'connect', url: trimmed, token, useProxy })
            pingRef.current = setInterval(() => worker.port.postMessage({ type: 'ping' }), PING_INTERVAL_MS)
        } else {
            startDirect(trimmed, token, useProxy)
        }
    }, [ingest.clear, startDirect]) // eslint-disable-line react-hooks/exhaustive-deps

    const disconnect = useCallback(() => {
        stopPing()
        workerRef.current?.port.postMessage({ type: 'disconnect' })
        directRef.current?.stop()
        directRef.current = null
        keyRef.current = ''
        setStatus(IDLE)
    }, [])

    const { phase, message } = status
    return {
        connected: phase === 'open',
        events: ingest.events,
        epoch: ingest.epoch,
        error: phase === 'reconnecting' || phase === 'failed' || phase === 'ended' ? message : '',
        isLoading: phase === 'connecting',
        reconnecting: phase === 'reconnecting',
        status: phase,
        connect,
        disconnect,
        clearEvents: ingest.clear,
        replaceEvents: ingest.replace,
        maxEvents,
        droppedCount: ingest.droppedCount,
        receivedCount: ingest.receivedCount,
    }
}
