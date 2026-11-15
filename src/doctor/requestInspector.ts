/**
 * What was asked and what came back, per connection attempt, from the recording's records. Pure, so it is tested without a browser.
 * Nothing here is measured again: every figure is a difference of two record times, so it is exactly what the Doctor's rules saw.
 */

import type { Observation } from '../core/observe/observation'

export interface RequestInfo {
    conn: number
    /** The connection this is, counting from 1 in the order the client made them: its label. Not the retry counter. */
    number: number
    /** The client's retry counter at this connection (0 for the first); it starts again after a connection that opened. Undefined when the connect record is gone. */
    retry?: number | undefined
    /** The URL as it was recorded (credentials and query values are already replaced). */
    url: string
    method: string
    /** Names only: the recorder never keeps a request header's value. */
    requestHeaderNames: string[]
    sentLastEventId: string
    /** Undefined until a response arrived (or when none did). */
    response?: {
        status: number
        contentType: string
        redirected: boolean
        /** The diagnostic headers the recorder keeps, in the order the recorder lists them. */
        headers: Array<[string, string]>
    } | undefined
    /** Milliseconds, each measured from the start of this request; undefined when that moment never came. */
    timing: {
        /** Until the response headers arrived. */
        headersMs?: number | undefined
        /** Until the first body bytes arrived. */
        firstByteMs?: number | undefined
        /** Until the first complete event. */
        firstEventMs?: number | undefined
        /** The whole attempt, until it ended (or until the recording's end when it is still open). */
        totalMs: number
    }
    /** The client's own time-to-first-byte of the response headers, as measured around fetch. */
    ttfbMs?: number | undefined
    /** The request went to the app's own server proxy, which opened the stream: the URL above is the proxy's, not the stream's. */
    viaAppProxy: boolean
    open: boolean
    endReason?: string | undefined
    serverRetryMs?: number | undefined
    chunks: number
    bytes: number
    events: number
}

export function inspectRequests(records: readonly Observation[], endT: number): RequestInfo[] {
    const byConn = new Map<number, RequestInfo & { _start: number; _end?: number }>()
    const ensure = (conn: number, t: number) => {
        let c = byConn.get(conn)
        if (!c) {
            c = { conn, number: conn + 1, url: '', method: 'GET', requestHeaderNames: [], sentLastEventId: '', timing: { totalMs: 0 }, viaAppProxy: false, open: true, chunks: 0, bytes: 0, events: 0, _start: t }
            byConn.set(conn, c)
        }
        return c
    }
    for (const r of records) {
        if (r.kind === 'consumer' || r.kind === 'truncated') continue
        const c = ensure(r.conn, r.t)
        switch (r.kind) {
            case 'connect':
                c._start = r.t
                c.retry = r.attempt
                c.url = r.url
                c.method = r.method
                c.requestHeaderNames = [...r.headerNames]
                c.sentLastEventId = r.sentLastEventId
                if (/\/api\/sse(?:\?|$)/.test(r.url)) c.viaAppProxy = true
                break
            case 'response':
                c.response = { status: r.status, contentType: r.contentType, redirected: r.redirected, headers: Object.entries(r.headers) }
                c.ttfbMs = r.ttfbMs
                if (Object.keys(r.headers).some((h) => h.startsWith('x-sse-proxy'))) c.viaAppProxy = true
                c.timing.headersMs = Math.max(0, r.t - c._start)
                break
            case 'chunk':
                c.chunks++
                c.bytes += r.bytes
                c.timing.firstByteMs ??= Math.max(0, r.t - c._start)
                break
            case 'event':
                c.events++
                c.timing.firstEventMs ??= Math.max(0, r.t - c._start)
                break
            case 'retry':
                c.serverRetryMs = r.ms
                break
            case 'phase':
                if (r.phase !== 'open' && r.phase !== 'connecting' && c._end === undefined) {
                    c._end = r.t
                    c.open = false
                    c.endReason = r.info.reason ?? r.phase
                }
                break
            default:
                break
        }
    }
    return [...byConn.values()]
        .sort((a, b) => a.conn - b.conn)
        .map(({ _start, _end, ...c }) => ({ ...c, timing: { ...c.timing, totalMs: Math.max(0, (_end ?? endT) - _start) } }))
}

/** One line a person can read: what the request was and what came back. */
export function describeRequest(r: RequestInfo): string {
    const parts = [`${r.method} ${r.url || '(no request recorded)'}`]
    parts.push(r.response ? `${r.response.status} ${r.response.contentType || 'no content type'}` : 'no response')
    if (r.sentLastEventId) parts.push(`resumed from id ${r.sentLastEventId}`)
    return parts.join(' → ')
}
