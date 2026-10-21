// Owns the SSE connections for every open tab: ONE connection per (url + token), multiplexed to all tabs.
//
// tab → worker:  { type: 'connect', url, token?, useProxy? } | { type: 'disconnect' } | { type: 'ping' }
// worker → tab:  { type: 'pong' }                      answer to ping
// worker → tab:  { type: 'status', phase, attempt?, delayMs?, reason?, status? }
//                { type: 'events', payloads }         payloads: IncomingSSE[] (each with a monotonic seq); everything parsed in
//                                                     one go is sent as one message instead of thousands
//                { type: 'catchup', events }          last events of a connection a tab joined late
//                { type: 'observations', key, captureId, batch, replace? }   recorded observations, batched (~10 Hz)
//
// Connection lifecycle (reconnect, backoff, Last-Event-ID resume) lives in SSEClient; this file only
// does the multi-tab bookkeeping.

/// <reference lib="webworker" />

import { SSEClient, type SSEClientOptions, type SSEPhase, type SSEPhaseInfo } from '../core/sse/sseClient'
import { createObservedStream, type ObservedStream } from '../core/sse/observedStream'
import { buildSSERequest } from '../utils/sseProxyUrl'
import type { IncomingSSE } from '../utils/buildEvent'
import type { PayloadProbeConfig } from '../core/observe/payloadProbe'
import { asProbeConfig } from './contracts'

const MAX_BUFFER = 50                // recent events kept so a late-joining tab can catch up
const SWEEP_MS = 15_000              // how often silent tabs are looked for
const PORT_TIMEOUT_MS = 75_000       // a tab that stayed silent this long (ping interval is 30 s) is considered gone
const JOIN_HISTORY_RECORDS = 5_000     // newest records sent to a tab that joins late
const IDLE_GRACE_MS = 5_000          // keep a connection this long after its last tab left (quick reloads)

interface StatusMessage { type: 'status'; key: string; phase: SSEPhase; attempt?: number; delayMs?: number; reason?: string; status?: number }

interface Connection {
    key: string
    client: ObservedStream
    ports: Set<MessagePort>
    buffer: IncomingSSE[]
    /** Events parsed but not yet posted: they are sent together once the current parse step finishes. */
    pending: IncomingSSE[]
    flushQueued: boolean
    status: StatusMessage
    idleTimer: ReturnType<typeof setTimeout> | null
}

interface PortState { key: string | null; lastSeen: number }

const connections = new Map<string, Connection>()
const portState = new Map<MessagePort, PortState>()
let seq = 0

let clientFactory = (opts: SSEClientOptions): SSEClient => new SSEClient(opts)

// test-only hooks
export function _setClientFactoryForTesting(f: typeof clientFactory) { clientFactory = f }
export function _clearConnectionsForTesting() {
    for (const c of connections.values()) { if (c.idleTimer) clearTimeout(c.idleTimer); c.client.stop() }
    connections.clear()
    portState.clear()
    seq = 0
}
export function _sweepForTesting(now: number) { sweep(now) }

const makeKey = (url: string, token?: string) => `${url}::${token ?? ''}`

function send(port: MessagePort, msg: unknown) {
    try { port.postMessage(msg) } catch { /* port is gone; the sweeper removes it */ }
}
function broadcast(conn: Connection, msg: unknown) {
    for (const port of conn.ports) send(port, msg)
}

function flushPending(conn: Connection) {
    conn.flushQueued = false
    if (conn.pending.length === 0) return
    const payloads = conn.pending
    conn.pending = []
    broadcast(conn, { type: 'events', key: conn.key, payloads })
}

function openConnection(key: string, url: string, token: string | undefined, useProxy: boolean, recording: boolean, profile: PayloadProbeConfig | undefined): Connection {
    const conn: Connection = {
        key,
        ports: new Set(),
        buffer: [],
        pending: [],
        flushQueued: false,
        status: { type: 'status', key, phase: 'connecting', attempt: 0 },
        idleTimer: null,
        client: undefined as unknown as ObservedStream,
    }
    conn.client = createObservedStream({
        request: () => buildSSERequest(url, token, useProxy),
        nextSeq: () => ++seq, // numbered across every connection this worker holds
        clientFactory: (options) => clientFactory(options), // read at call time: tests swap it
        // Records go to every tab in batches; the page runs the analysis, so the worker only records and forwards. A tab that
        // turned recording off asks for none; the tab that opens the connection decides for everyone sharing it.
        recording: recording ? { ...(profile ? { profile } : {}), onObservations: (batch) => broadcast(conn, { type: 'observations', key, captureId: conn.client.captureId, batch }) } : undefined,
        sinks: {
            onMessage: (payload) => {
                conn.buffer.push(payload)
                if (conn.buffer.length > MAX_BUFFER) conn.buffer.shift()
                conn.pending.push(payload)
                if (!conn.flushQueued) {
                    conn.flushQueued = true
                    queueMicrotask(() => flushPending(conn))
                }
            },
            onPhase: (phase: SSEPhase, info: SSEPhaseInfo) => {
                flushPending(conn) // events that came before the status change must arrive before it
                conn.status = { type: 'status', key, phase, ...info }
                broadcast(conn, conn.status)
            },
        },
    })
    connections.set(key, conn)
    conn.client.start()
    return conn
}

function leave(port: MessagePort) {
    const st = portState.get(port)
    if (!st?.key) return
    const conn = connections.get(st.key)
    st.key = null
    if (!conn) return
    conn.ports.delete(port)
    if (conn.ports.size === 0 && !conn.idleTimer) {
        conn.idleTimer = setTimeout(() => {
            if (conn.ports.size === 0) {
                conn.client.stop()
                connections.delete(conn.key)
            }
        }, IDLE_GRACE_MS)
    }
}

function join(port: MessagePort, url: string, token: string | undefined, useProxy: boolean, recording: boolean, profile: PayloadProbeConfig | undefined) {
    const key = makeKey(url, token)
    const st = portState.get(port)!
    if (st.key && st.key !== key) leave(port)  // switching streams must not leave the old subscription behind
    st.key = key

    let conn = connections.get(key)
    if (!conn) conn = openConnection(key, url, token, useProxy, recording, profile)
    if (conn.idleTimer) { clearTimeout(conn.idleTimer); conn.idleTimer = null }
    conn.ports.add(port)

    // Explicit (re)connect after the stream ended or failed → start it again.
    if (!conn.client.isRunning) {
        conn.buffer = []
        conn.status = { type: 'status', key, phase: 'connecting', attempt: 0 }
        conn.client.start()
    }

    send(port, conn.status)
    if (conn.buffer.length > 0) send(port, { type: 'catchup', key, events: conn.buffer })
    // A tab that joins late gets the retained history, so its analysis starts from everything recorded so far.
    const history = conn.client.store?.snapshot().slice(-JOIN_HISTORY_RECORDS)
    if (history && history.length > 0) send(port, { type: 'observations', key, captureId: conn.client.captureId, batch: history, replace: true })
}

function sweep(now: number) {
    for (const [port, st] of portState) {
        if (now - st.lastSeen > PORT_TIMEOUT_MS) {
            leave(port)
            portState.delete(port)
        }
    }
}

setInterval(() => sweep(Date.now()), SWEEP_MS)

;(self as unknown as SharedWorkerGlobalScope).onconnect = (connectEvent: MessageEvent) => {
    const port: MessagePort = connectEvent.ports[0]
    portState.set(port, { key: null, lastSeen: Date.now() })
    port.start()

    port.onmessage = (e: MessageEvent) => {
        const msg = e.data
        const st = portState.get(port)
        if (!msg || typeof msg.type !== 'string' || !st) return
        st.lastSeen = Date.now()

        switch (msg.type) {
            case 'connect':
                if (typeof msg.url === 'string' && msg.url) join(port, msg.url, msg.token || undefined, msg.useProxy !== false, msg.recording !== false, asProbeConfig(msg.profile))
                return
            case 'disconnect':
                leave(port)
                return
            case 'ping':
                send(port, { type: 'pong' }) // lets the tab notice a dead worker: any message counts as a sign of life
                return
        }
    }
}
