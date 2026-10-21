/**
 * The reconnect timeline: one row per connection attempt, built from the recording's records. Pure, so it can be
 * tested without a browser and shown as a drawing and as a table from the same data.
 */

import type { Observation } from '../core/observe/observation'

export interface TimelineConnection {
    conn: number
    attempt: number
    /** When the request was made. */
    startT: number
    /** When the response headers arrived. */
    responseT?: number | undefined
    status?: number | undefined
    firstByteT?: number | undefined
    firstEventT?: number | undefined
    /** When the connection stopped being open (closed, failed, ended); undefined while it is still going. */
    endT?: number | undefined
    /** Why it ended, in the client's words. */
    endReason?: string | undefined
    sentLastEventId: string
    events: number[]
    /** Times of comment lines (heartbeats), by source. */
    heartbeats: Array<{ t: number; source: 'proxy' | 'upstream' }>
    bytes: number
    /** The longest wait between two byte arrivals on this connection. */
    longestGapMs: number
    /** What the client did before the next attempt: delay and reason. */
    reconnectDelayMs?: number | undefined
    reconnectReason?: string | undefined
    /** A retry hint the server sent on this connection. */
    serverRetryMs?: number | undefined
}

export interface Timeline {
    connections: TimelineConnection[]
    /** The latest time in the recording. */
    endT: number
}

export function buildTimeline(records: readonly Observation[], nowT?: number): Timeline {
    const byConn = new Map<number, TimelineConnection>()
    const lastByte = new Map<number, number>()
    let endT = 0
    const ensure = (conn: number, t: number): TimelineConnection => {
        let c = byConn.get(conn)
        if (!c) {
            c = { conn, attempt: conn, startT: t, sentLastEventId: '', events: [], heartbeats: [], bytes: 0, longestGapMs: 0 }
            byConn.set(conn, c)
        }
        return c
    }
    for (const r of records) {
        endT = Math.max(endT, r.t)
        if (r.kind === 'consumer' || r.kind === 'truncated') continue
        const c = ensure(r.conn, r.t)
        switch (r.kind) {
            case 'connect':
                c.attempt = r.attempt
                c.startT = r.t
                c.sentLastEventId = r.sentLastEventId
                break
            case 'response':
                c.responseT = r.t
                c.status = r.status
                break
            case 'chunk': {
                c.firstByteT ??= r.t
                c.bytes += r.bytes
                const prev = lastByte.get(r.conn) ?? c.responseT
                if (prev !== undefined) c.longestGapMs = Math.max(c.longestGapMs, r.t - prev)
                lastByte.set(r.conn, r.t)
                break
            }
            case 'event':
                c.firstEventT ??= r.t
                c.events.push(r.t)
                break
            case 'comment':
                c.heartbeats.push({ t: r.t, source: r.source })
                break
            case 'heartbeatSeries':
                c.heartbeats.push({ t: r.firstT, source: r.source }, ...(r.count > 1 ? [{ t: r.lastT, source: r.source }] : []))
                break
            case 'retry':
                c.serverRetryMs = r.ms
                break
            case 'phase':
                if (r.phase !== 'open' && r.phase !== 'connecting' && c.endT === undefined) {
                    c.endT = r.t
                    c.endReason = r.info.reason ?? r.phase
                }
                break
            case 'reconnect':
                c.reconnectDelayMs = r.delayMs
                c.reconnectReason = r.reason
                break
            default:
                break
        }
    }
    const connections = [...byConn.values()].sort((a, b) => a.conn - b.conn)
    return { connections, endT: Math.max(endT, nowT ?? 0) }
}

/** One short sentence per connection for the table and for assistive technology. */
export function describeConnection(c: TimelineConnection, timelineEnd: number): string {
    const lifetime = (c.endT ?? timelineEnd) - c.startT
    const parts = [`attempt ${c.attempt + 1}`, c.status !== undefined ? `status ${c.status}` : 'no response']
    parts.push(`${c.events.length} event${c.events.length === 1 ? '' : 's'} in ${Math.round(lifetime)} ms`)
    parts.push(c.endT === undefined ? 'still open' : `ended: ${c.endReason ?? 'closed'}`)
    if (c.sentLastEventId) parts.push(`resumed from id ${c.sentLastEventId}`)
    return parts.join(', ')
}
