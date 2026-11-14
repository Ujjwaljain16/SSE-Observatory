/**
 * What the fixture server actually did, recorded by the server itself and independent of every client component. Every claim of the form "the
 * pipeline lost nothing" or "the Doctor's number is right" is checked against this.
 *
 * The log is written where every response passes (the request handler wraps `write`, `end` and `destroy`), so no fixture needs to change. It holds,
 * for each request the server accepted: the route and query, the request headers (a secret header is recorded as its presence and length, never
 * its value), when it was accepted, every write with its time and bytes, and how the connection ended and when.
 *
 * `frameLog` reads the writes back into events with a small framer of its own. It deliberately does not use `SSEParser`: the point is a second
 * opinion about where events begin and end.
 */

export type EndedBy = 'server-end' | 'server-destroy' | 'client-closed' | 'open'

export interface LoggedWrite {
    /** `performance.now()` when the write was made. */
    atMs: number
    /** `Date.now()` when the write was made: the clock a capture's `startedAtEpochMs` shares. */
    epochMs: number
    bytes: number
    /** The write's bytes, capped at 64 KiB (the byte count above is exact). Decode a connection's writes as one stream: a character can be split across writes. */
    raw: Uint8Array
    /** The write decoded on its own, for reading a log by eye. A character split across writes shows as U+FFFD here; `frameLog` does not use this. */
    text: string
}

export interface LoggedConnection {
    /** 0-based, in the order requests were accepted. */
    index: number
    route: string
    path: string
    query: Record<string, string>
    requestHeaders: Record<string, string>
    acceptedAtMs: number
    acceptedEpochMs: number
    status: number | undefined
    writes: LoggedWrite[]
    endedBy: EndedBy
    endedAtMs: number | undefined
}

/** A frame as the oracle reads it. */
export interface Frame {
    /** The `id:` the frame itself carried, or null. */
    id: string | null
    /** The last event id in effect once the frame is dispatched (an id persists until another one changes it). */
    effectiveId: string
    event: string
    /** UTF-8 bytes of the data lines joined by a line feed. */
    dataBytes: number
    dataText: string
    /** True when the frame had a blank line after it. */
    terminated: boolean
    /** Index of the write holding the frame's first and last byte. */
    firstWrite: number
    lastWrite: number
    /** A frame of comments only (or nothing at all) is not an event. */
    isComment: boolean
    /** At least one `data` line. A frame without one is not dispatched as an event. */
    hasData: boolean
}

const SECRET_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token'])
const RAW_CAP = 64 * 1024

export class GroundTruth {
    readonly connections: LoggedConnection[] = []

    /** Starts a connection record; the server calls this once per accepted request. */
    open(init: { route: string; path: string; query: Record<string, string>; headers: Record<string, string | string[] | undefined> }): LoggedConnection {
        const requestHeaders: Record<string, string> = {}
        for (const [name, raw] of Object.entries(init.headers)) {
            const value = Array.isArray(raw) ? raw.join(', ') : raw ?? ''
            const key = name.toLowerCase()
            requestHeaders[key] = SECRET_HEADERS.has(key) ? `<present, ${value.length} characters>` : value
        }
        const connection: LoggedConnection = {
            index: this.connections.length, route: init.route, path: init.path, query: init.query, requestHeaders,
            acceptedAtMs: performance.now(), acceptedEpochMs: Date.now(), status: undefined, writes: [], endedBy: 'open', endedAtMs: undefined,
        }
        this.connections.push(connection)
        return connection
    }

    write(c: LoggedConnection, chunk: Uint8Array | string): void {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
        const raw = Uint8Array.from(buffer.subarray(0, RAW_CAP))
        c.writes.push({ atMs: performance.now(), epochMs: Date.now(), bytes: buffer.length, raw, text: Buffer.from(raw).toString('utf8') })
    }

    end(c: LoggedConnection, by: Exclude<EndedBy, 'open'>): void {
        if (c.endedBy !== 'open') return // the first reason wins: a server end followed by the socket closing is still a server end
        c.endedBy = by
        c.endedAtMs = performance.now()
    }

    /** Connections to a route (by id), in order. */
    of(route: string): LoggedConnection[] { return this.connections.filter((c) => c.route === route) }

    /** The `Last-Event-ID` each request carried, in order ('' when it had none). */
    lastEventIdHeaders(route?: string): string[] {
        return (route ? this.of(route) : this.connections).map((c) => c.requestHeaders['last-event-id'] ?? '')
    }

    /** Everything written on a connection as one string, decoded as one stream (exact for writes under 64 KiB each). */
    body(c: LoggedConnection): string { return decodePieces(c).join('') }

    totals(c?: LoggedConnection): { writes: number; bytes: number; frames: number } {
        const list = c ? [c] : this.connections
        return {
            writes: list.reduce((n, x) => n + x.writes.length, 0),
            bytes: list.reduce((n, x) => n + x.writes.reduce((b, w) => b + w.bytes, 0), 0),
            frames: list.reduce((n, x) => n + frameLog(x).filter((f) => !f.isComment && f.terminated).length, 0),
        }
    }
}

/** Each write's text, decoded as part of one stream: a character split across writes is completed by the write that finishes it. */
function decodePieces(c: LoggedConnection): string[] {
    const decoder = new TextDecoder('utf-8')
    return c.writes.map((w) => decoder.decode(w.raw, { stream: true }))
}

const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)
const NUL = String.fromCharCode(0)

/**
 * Reads the writes of one connection back into frames. Line endings are made one kind first (CRLF is ONE ending, so it cannot be mistaken for
 * two), remembering which write each character came from; then the text is split on a blank line, and `id:`, `event:` and `data:` lines are read
 * with a regular expression. The last piece, if it is not empty and no blank line follows it, is an unterminated frame.
 */
export function frameLog(c: LoggedConnection): Frame[] {
    const pieces = decodePieces(c)
    const joined = pieces.join('')
    const writeOf: number[] = []
    pieces.forEach((piece, i) => { for (let k = 0; k < piece.length; k++) writeOf.push(i) })

    // one character per line ending, each tagged with the write it came from
    const owner: number[] = []
    let text = ''
    for (let i = 0; i < joined.length; i++) {
        const ch = joined[i]!
        if (ch === CR) {
            text += LF
            owner.push(writeOf[i]!)
            if (joined[i + 1] === LF) i++ // CRLF is one ending
        } else {
            text += ch
            owner.push(writeOf[i]!)
        }
    }

    const frames: Frame[] = []
    let effectiveId = ''
    const emit = (raw: string, start: number, terminated: boolean): void => {
        let id: string | null = null
        let event = ''
        const data: string[] = []
        let isComment = true
        for (const line of raw.split(LF)) {
            if (line === '') continue
            if (!line.startsWith(':')) isComment = false
            const m = /^(id|event|data)(?::[ ]?(.*))?$/.exec(line)
            if (!m) continue
            const value = m[2] ?? ''
            if (m[1] === 'id' && !value.includes(NUL)) id = value
            else if (m[1] === 'event') event = value
            else if (m[1] === 'data') data.push(value)
        }
        if (id !== null) effectiveId = id
        const dataText = data.join(LF)
        frames.push({
            id, effectiveId, event: event || 'message', dataBytes: Buffer.byteLength(dataText, 'utf8'), dataText, terminated, isComment, hasData: data.length > 0,
            firstWrite: owner[Math.min(start, owner.length - 1)] ?? 0, lastWrite: owner[Math.max(0, Math.min(start + raw.length - 1, owner.length - 1))] ?? 0,
        })
    }
    let from = 0
    for (;;) {
        const blank = text.indexOf(LF + LF, from)
        if (blank === -1) break
        emit(text.slice(from, blank), from, true)
        from = blank + 2
    }
    if (from < text.length) emit(text.slice(from), from, false)
    return frames
}
