/**
 * Incremental Server-Sent Events parser following the WHATWG spec
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream).
 *
 * Feed it bytes or strings in arbitrary chunks; it emits one message per dispatched event.
 * Handles LF, CR and CRLF line endings (including a CRLF split across chunks), a UTF-8 BOM,
 * multi-line data, comments, `event`, `id` and `retry` fields. Unlike the browser's EventSource it
 * reports the event *name*, so named events (`event: order`) are not lost.
 */

export interface SSEMessage {
    /** Event name; "message" when the stream did not specify one. */
    event: string
    data: string
    /** Last event id in effect when the event was dispatched (persists across events, per spec). */
    id: string
    /** Raw wire form of the event (field lines only, no comments), useful for display/export. */
    raw: string
}

export interface SSEParserHandlers {
    onMessage: (message: SSEMessage) => void
    /** Reconnection time requested by the server (`retry:` field), in milliseconds. */
    onRetry?: (ms: number) => void
}

export class SSEParserError extends Error {}

export class SSEParser {
    private decoder = new TextDecoder('utf-8')
    private buffer = ''
    private pendingCR = false
    private sawFirstChunk = false

    private dataLines: string[] = []
    private eventName = ''
    private rawLines: string[] = []
    private lastEventId = ''

    constructor(private readonly handlers: SSEParserHandlers, private readonly maxBufferBytes = 16 * 1024 * 1024) {}

    get lastId() { return this.lastEventId }

    /** Seed the last event id (e.g. from a previous connection). */
    setLastEventId(id: string) { this.lastEventId = id }

    feed(chunk: Uint8Array | string): void {
        let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
        if (!this.sawFirstChunk && text.length > 0) {
            this.sawFirstChunk = true
            if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        }
        if (this.pendingCR) {
            // A CR at the end of the previous chunk already terminated a line; swallow the LF of a CRLF pair.
            if (text.startsWith('\n')) text = text.slice(1)
            this.pendingCR = false
        }
        this.buffer += text

        let start = 0
        const buf = this.buffer
        for (let i = 0; i < buf.length; i++) {
            const c = buf.charCodeAt(i)
            if (c === 10 || c === 13) {
                this.processLine(buf.slice(start, i))
                if (c === 13) {
                    if (i + 1 < buf.length) { if (buf.charCodeAt(i + 1) === 10) i++ } else this.pendingCR = true
                }
                start = i + 1
            }
        }
        this.buffer = buf.slice(start)
        if (this.buffer.length > this.maxBufferBytes) {
            this.buffer = ''
            throw new SSEParserError('SSE line exceeds the maximum buffer size')
        }
    }

    /** Call when the connection ends: an unterminated event is discarded, per spec. */
    end(): void {
        this.buffer = ''
        this.pendingCR = false
        this.dataLines = []
        this.eventName = ''
        this.rawLines = []
        this.decoder = new TextDecoder('utf-8')
        this.sawFirstChunk = false
    }

    private processLine(line: string) {
        if (line === '') return this.dispatch()
        if (line.charCodeAt(0) === 58) return // ":" comment

        const colon = line.indexOf(':')
        let field: string
        let value: string
        if (colon === -1) {
            field = line
            value = ''
        } else {
            field = line.slice(0, colon)
            value = line.slice(colon + 1)
            if (value.charCodeAt(0) === 32) value = value.slice(1)
        }

        switch (field) {
            case 'event':
                this.eventName = value
                this.rawLines.push(line)
                break
            case 'data':
                this.dataLines.push(value)
                this.rawLines.push(line)
                break
            case 'id':
                if (!value.includes('\0')) this.lastEventId = value
                this.rawLines.push(line)
                break
            case 'retry':
                if (/^\d+$/.test(value)) this.handlers.onRetry?.(Number(value))
                break
            default:
                break // unknown fields are ignored
        }
    }

    private dispatch() {
        const hasData = this.dataLines.length > 0
        const message: SSEMessage | null = hasData
            ? {
                event: this.eventName || 'message',
                data: this.dataLines.join('\n'),
                id: this.lastEventId,
                raw: this.rawLines.join('\n'),
            }
            : null
        this.dataLines = []
        this.eventName = ''
        this.rawLines = []
        if (message) this.handlers.onMessage(message)
    }
}
