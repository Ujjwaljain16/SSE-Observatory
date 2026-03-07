/**
 * sharedSSEWorker.ts  —  SharedWorker that owns SSE connections
 *
 * One EventSource per (url + token) combination.
 * All tabs share the same connection for the same key.
 *
 * Message protocol (tab → worker port):
 *   { type: 'connect',    url, token? }
 *   { type: 'disconnect' }
 *   { type: 'ping' }
 *
 * Message protocol (worker → tab):
 *   { type: 'connected' }
 *   { type: 'event',    payload }
 *   { type: 'error',    message }
 *   { type: 'catchup',  events }   ← last 50 events for late-joining tabs
 *   { type: 'disconnected' }
 */

/// <reference lib="webworker" />

import { buildSSEProxyUrl } from '../utils/sseProxyUrl'

const MAX_BUFFER = 50          // rolling catch-up buffer per connection
const HEARTBEAT_MS = 30_000   // ping interval from tab
const ZOMBIE_TIMEOUT_MS = 60_000  // close connection if no ping for 60s

interface Connection {
    eventSource: EventSource | null
    ports: MessagePort[]
    buffer: any[]      // last MAX_BUFFER events
    lastPing: number   // epoch ms
    zombieTimer: number | null  // window.setTimeout handle
}

// connectionKey → Connection
const connections = new Map<string, Connection>()


function makeKey(url: string, token?: string): string {
    return `${url}::${token ?? ''}`
}

function broadcast(conn: Connection, msg: unknown) {
    for (const port of conn.ports) {
        try { port.postMessage(msg) } catch { /* port may have closed */ }
    }
}

function removePort(key: string, port: MessagePort) {
    const conn = connections.get(key)
    if (!conn) return
    conn.ports = conn.ports.filter(p => p !== port)
    if (conn.ports.length === 0) {
        // No active tabs — start zombie timer, close if nothing reconnects
        conn.zombieTimer = self.setTimeout(() => {
            conn.eventSource?.close()
            conn.eventSource = null
            connections.delete(key)
            console.log(`[SharedSSEWorker] Zombie cleanup: ${key}`)
        }, ZOMBIE_TIMEOUT_MS) as unknown as number
    }
}

function resetZombieTimer(conn: Connection) {
    if (conn.zombieTimer) {
        clearTimeout(conn.zombieTimer)
        conn.zombieTimer = null
    }
}

function openConnection(key: string, url: string, token?: string): Connection {
    let conn = connections.get(key)

    if (conn) {
        resetZombieTimer(conn)
        // If the connection is still alive, just return it
        if (conn.eventSource && conn.eventSource.readyState !== EventSource.CLOSED) {
            return conn
        }
        // Otherwise, it's dead. Clear the old buffer so we don't dump stale events on reconnect.
        conn.buffer = []
        if (conn.eventSource) conn.eventSource.close()
    } else {
        conn = {
            eventSource: null,
            ports: [],
            buffer: [],
            lastPing: Date.now(),
            zombieTimer: null,
        }
        connections.set(key, conn)
    }

    // Proxy URL via shared utility (same logic as useEventStream + useMultiStream)
    const sseUrl = buildSSEProxyUrl(url)
    const finalUrl = token ? `${sseUrl}${sseUrl.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}` : sseUrl

    const es = new EventSource(finalUrl)
    conn.eventSource = es

    es.onopen = () => broadcast(conn, { type: 'connected' })

    es.onmessage = (evt) => {
        const payload = { raw: evt.data, arrivalTime: Date.now() }
        conn.buffer.push(payload)
        if (conn.buffer.length > MAX_BUFFER) conn.buffer.shift()
        broadcast(conn, { type: 'event', payload })
    }

    es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
            broadcast(conn, { type: 'error', message: 'Stream closed' })
        }
    }

    es.addEventListener('end', () => {
        broadcast(conn, { type: 'disconnected' })
        es.close()
        conn.eventSource = null
    })

    return conn
}

// ─── Heartbeat checker ────────────────────────────────────────────────────────
self.setInterval(() => {
    const now = Date.now()
    for (const [key, conn] of connections) {
        if (conn.ports.length === 0) continue  // zombie timer handles these
        if (now - conn.lastPing > ZOMBIE_TIMEOUT_MS) {
            console.log(`[SharedSSEWorker] Stale connection closed: ${key}`)
            conn.eventSource?.close()
            connections.delete(key)
        }
    }
}, HEARTBEAT_MS)


    // ─── Port handler ────────────────────────────────────────────────────────────
    ; (self as unknown as SharedWorkerGlobalScope).onconnect = (connectEvent: MessageEvent) => {
        const port: MessagePort = connectEvent.ports[0]
        port.start()

        let myKey: string | null = null

        port.onmessage = (e: MessageEvent) => {
            const msg = e.data

            if (msg.type === 'connect') {
                myKey = makeKey(msg.url, msg.token)
                const conn = openConnection(myKey, msg.url, msg.token)

                if (!conn.ports.includes(port)) {
                    conn.ports.push(port)
                }
                resetZombieTimer(conn)
                conn.lastPing = Date.now()

                if (conn.buffer.length > 0) {
                    port.postMessage({ type: 'catchup', events: conn.buffer })
                }

                if (conn.eventSource?.readyState === EventSource.OPEN) {
                    port.postMessage({ type: 'connected' })
                }
                return
            }

            if (msg.type === 'ping') {
                if (myKey) {
                    const conn = connections.get(myKey)
                    if (conn) conn.lastPing = Date.now()
                }
                return
            }

            if (msg.type === 'disconnect') {
                if (myKey) removePort(myKey, port)
                myKey = null
            }
        }

        // Handle port close (tab navigates away / closes)
        port.addEventListener('close', () => {
            if (myKey) removePort(myKey!, port)
        })
    }
