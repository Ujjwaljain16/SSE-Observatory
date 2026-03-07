// manages SSE connections across tabs using a SharedWorker
// ensures only one connection exists per stream and multiplexes events to all ports
//
// message protocol (tab -> worker port):
//   { type: 'connect', url, token? }
//   { type: 'disconnect' }
//   { type: 'ping' }
//
// message protocol (worker -> tab):
//   { type: 'connected' }
//   { type: 'event', payload }
//   { type: 'error', message }
//   { type: 'catchup', events }
//   { type: 'disconnected' }

/// <reference lib="webworker" />

import { obtainSSEProxyTicket } from '../utils/sseProxyUrl'

const MAX_BUFFER = 50          // buffer events so late joiners can replay recent activity
const HEARTBEAT_MS = 30_000    // keeps worker alive while tabs remain open
const ZOMBIE_TIMEOUT_MS = 60_000  // drop connection if all tabs crash without disconnecting

interface Connection {
    eventSource: EventSource | null
    ports: MessagePort[]
    buffer: any[]      // last MAX_BUFFER events
    lastPing: number   // epoch ms
    zombieTimer: number | null  // window.setTimeout handle
}

// connectionKey → Connection
const connections = new Map<string, Connection>()

// test-only utility to reset connection state between tests
export function _clearConnectionsForTesting() {
    for (const conn of connections.values()) {
        if (conn.zombieTimer) clearTimeout(conn.zombieTimer)
        conn.eventSource?.close()
    }
    connections.clear()
}


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
        // start zombie timer to close connection if no tabs reconnect
        conn.zombieTimer = setTimeout(() => {
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

async function openConnection(key: string, url: string, token?: string): Promise<Connection> {
    let conn = connections.get(key)

    if (conn) {
        resetZombieTimer(conn)
        if (conn.eventSource && conn.eventSource.readyState !== EventSource.CLOSED) {
            return conn
        }
        // clear buffer on dead connections to avoid pushing stale events on reconnect
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

    try {
        const finalUrl = await obtainSSEProxyTicket(url, token)
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
    } catch (err: any) {
        broadcast(conn, { type: 'error', message: 'Failed to negotiate secure SSE proxy ticket' })
        connections.delete(key)
        throw err
    }

    return conn
}

// garbage collect stale connections where tabs vanished without proper disconnect
setInterval(() => {
    const now = Date.now()
    for (const [key, conn] of connections) {
        // skip zombie connections waiting for a potential reconnect
        if (conn.ports.length === 0) continue
        if (now - conn.lastPing > ZOMBIE_TIMEOUT_MS) {
            console.log(`[SharedSSEWorker] Stale connection closed: ${key}`)
            conn.eventSource?.close()
            connections.delete(key)
        }
    }
}, HEARTBEAT_MS)


    // accept new tab connections and route messages
    ; (self as unknown as SharedWorkerGlobalScope).onconnect = (connectEvent: MessageEvent) => {
        const port: MessagePort = connectEvent.ports[0]
        port.start()

        let myKey: string | null = null

        port.onmessage = (e: MessageEvent) => {
            const msg = e.data

            if (msg.type === 'connect') {
                myKey = makeKey(msg.url, msg.token)

                openConnection(myKey, msg.url, msg.token)
                    .then(conn => {
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
                    })
                    .catch(err => {
                        port.postMessage({ type: 'error', message: err.message })
                    })
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
                if (myKey) {
                    removePort(myKey, port)
                }
                return
            }
        }

        port.addEventListener('close', () => {
            if (myKey) removePort(myKey!, port)
        })
    }
