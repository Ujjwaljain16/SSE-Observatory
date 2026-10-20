/**
 * Incremental Server-Sent Events parser following the WHATWG spec
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream).
 *
 * Feed it bytes or strings in arbitrary chunks; it emits one message per dispatched event.
 * Handles LF, CR and CRLF line endings (including a CRLF split across chunks), a UTF-8 BOM,
 * multi-line data, comments, `event`, `id` and `retry` fields. Unlike the browser's EventSource it
 * reports the event *name*, so named events (`event: order`) are not lost.
 *
 * It can also report what the spec tells a client to ignore or drop silently (comments, unknown fields, bad retry
 * values, an unterminated final event...) through the optional `onComment` and `onViolation` handlers. Without those
 * handlers it behaves exactly as before and does no extra work.
 */

import { utf8Length } from './utf8'
import type { ParserViolationCode } from './violations'

export interface SSEMessage {
    /** Event name; "message" when the stream did not specify one. */
    event: string
    data: string
    /** Last event id in effect when the event was dispatched (persists across events, per spec). */
    id: string
    /** Raw wire form of the event (field lines only, no comments), useful for display/export. */
    raw: string
}

export interface SSEViolation {
    code: ParserViolationCode
    /** Human-readable specifics (the field name, how many bytes were dropped...). */
    detail: string
    /** Index of the chunk being parsed when it was noticed, as given to `feed`. */
    chunk: number
}

export interface SSEParserHandlers {
    onMessage: (message: SSEMessage) => void
    /** Reconnection time requested by the server (`retry:` field), in milliseconds. */
    onRetry?: (ms: number) => void
    /** A comment line (`: text`), without the colon and one optional leading space. Heartbeats are usually comments. */
    onComment?: (text: string) => void
    /** Something the spec ignores or drops, or a likely producer mistake. See violations.ts for the severities. */
    onViolation?: (violation: SSEViolation) => void
}

export class SSEParserError extends Error {}

const KNOWN_FIELDS = new Set(['event', 'data', 'id', 'retry'])
type LineEnding = 'LF' | 'CRLF' | 'CR'

export class SSEParser {
    private decoder = new TextDecoder('utf-8')
    private buffer = ''
    private pendingCR = false
    private sawFirstChunk = false

    private dataLines: string[] = []
    private eventName = ''
    private rawLines: string[] = []
    private lastEventId = ''

    // Diagnostics bookkeeping. Only touched when a diagnostics handler is attached.
    private readonly diagnostics: boolean
    private feedCount = 0
    private currentChunk = 0
    private lineEnding: LineEnding | null = null
    private mixedEndingsReported = false
    private frameHadId = false
    private frameHadOtherField = false

    constructor(private readonly handlers: SSEParserHandlers, private readonly maxBufferBytes = 16 * 1024 * 1024) {
        this.diagnostics = handlers.onViolation !== undefined || handlers.onComment !== undefined
    }

    get lastId() { return this.lastEventId }

    /** True when everything fed so far ended exactly at the end of an event (nothing is half-received). */
    get atBoundary(): boolean {
        return this.buffer === '' && this.dataLines.length === 0 && this.rawLines.length === 0
    }

    /** UTF-8 bytes of an event (or a line) that has started but not finished. 0 at a boundary. */
    get pendingBytes(): number {
        let bytes = utf8Length(this.buffer)
        for (const line of this.rawLines) bytes += utf8Length(line) + 1
        return bytes
    }

    /** Seed the last event id (e.g. from a previous connection). */
    setLastEventId(id: string) { this.lastEventId = id }

    /** `chunkIndex` labels any violation noticed while parsing this piece; by default chunks are numbered by call. */
    feed(chunk: Uint8Array | string, chunkIndex?: number): void {
        this.currentChunk = chunkIndex ?? this.feedCount++
        // TextDecoder drops a leading byte order mark by itself, so for bytes it has to be noticed before decoding.
        const startsWithBom = typeof chunk !== 'string' && !this.sawFirstChunk && chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf
        let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
        if (!this.sawFirstChunk && (text.length > 0 || startsWithBom)) {
            this.sawFirstChunk = true
            if (startsWithBom) this.violation('BOM_STRIPPED', 'A UTF-8 byte order mark was removed from the start of the stream.')
            else if (text.charCodeAt(0) === 0xfeff) {
                text = text.slice(1)
                this.violation('BOM_STRIPPED', 'A UTF-8 byte order mark was removed from the start of the stream.')
            }
        }
        if (this.pendingCR) {
            // A CR at the end of the previous chunk already terminated a line; swallow the LF of a CRLF pair.
            const crlf = text.startsWith('\n')
            if (crlf) text = text.slice(1)
            this.pendingCR = false
            if (this.diagnostics && text.length + (crlf ? 1 : 0) > 0) this.noteLineEnding(crlf ? 'CRLF' : 'CR')
        }
        // Text with no line ending cannot complete a line: keep it and wait. Reading characters out of a long, repeatedly extended
        // buffer would copy the whole buffer every time (a string built from many pieces is flattened on first read).
        if (!text.includes('\n') && !text.includes('\r')) {
            this.buffer += text
            this.checkLimit()
            return
        }
        // What is left in the buffer has no line ending in it, so only the new text needs scanning. Scanning the whole buffer
        // again for every piece made one very long line quadratic (a 20 MB line without a newline took many seconds).
        const scanFrom = this.buffer.length
        this.buffer += text

        let start = 0
        const buf = this.buffer
        for (let i = scanFrom; i < buf.length; i++) {
            const c = buf.charCodeAt(i)
            if (c === 10 || c === 13) {
                this.processLine(buf.slice(start, i))
                if (c === 13) {
                    if (i + 1 < buf.length) {
                        const crlf = buf.charCodeAt(i + 1) === 10
                        if (crlf) i++
                        if (this.diagnostics) this.noteLineEnding(crlf ? 'CRLF' : 'CR')
                    } else {
                        this.pendingCR = true // CR or the first half of CRLF: decided when the next chunk arrives
                    }
                } else if (this.diagnostics) {
                    this.noteLineEnding('LF')
                }
                start = i + 1
            }
        }
        this.buffer = buf.slice(start)
        this.checkLimit()
    }

    private checkLimit(): void {
        if (this.buffer.length > this.maxBufferBytes) {
            this.buffer = ''
            this.violation('LINE_TOO_LONG', `A line grew past ${this.maxBufferBytes} characters without a line ending.`)
            throw new SSEParserError('SSE line exceeds the maximum buffer size')
        }
    }

    /**
     * Call when the connection ends. An unterminated event is discarded, per spec, and reported as a violation
     * unless `report` is false (use that when WE ended the stream, e.g. the user pressed Stop mid-event).
     */
    end(report = true): void {
        if (report && this.diagnostics && !this.atBoundary) {
            this.violation('UNTERMINATED_FRAME', `The connection ended mid-event; ${this.pendingBytes} bytes of an incomplete event were discarded.`)
        }
        this.buffer = ''
        this.pendingCR = false
        this.dataLines = []
        this.eventName = ''
        this.rawLines = []
        this.decoder = new TextDecoder('utf-8')
        this.sawFirstChunk = false
        this.lineEnding = null
        this.mixedEndingsReported = false
        this.frameHadId = false
        this.frameHadOtherField = false
    }

    private violation(code: ParserViolationCode, detail: string) {
        this.handlers.onViolation?.({ code, detail, chunk: this.currentChunk })
    }

    private noteLineEnding(kind: LineEnding) {
        if (this.lineEnding === null) { this.lineEnding = kind; return }
        if (this.lineEnding !== kind && !this.mixedEndingsReported) {
            this.mixedEndingsReported = true
            this.violation('MIXED_LINE_ENDINGS', `Line endings changed from ${this.lineEnding} to ${kind}.`)
        }
    }

    private processLine(line: string) {
        if (line === '') return this.dispatch()
        if (line.charCodeAt(0) === 58) { // ":" comment
            if (this.handlers.onComment) this.handlers.onComment(line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1))
            return
        }
        if (this.diagnostics && line.charCodeAt(0) === 0xfeff) this.violation('BOM_MIDSTREAM', 'A byte order mark appeared at the start of a line.')

        const colon = line.indexOf(':')
        let field: string
        let value: string
        if (colon === -1) {
            field = line
            value = ''
            if (this.diagnostics) this.violation('LINE_NO_COLON', `The line "${truncate(line)}" has no colon.`)
        } else {
            field = line.slice(0, colon)
            value = line.slice(colon + 1)
            if (value.charCodeAt(0) === 32) value = value.slice(1)
        }

        switch (field) {
            case 'event':
                this.eventName = value
                this.rawLines.push(line)
                if (this.diagnostics) this.frameHadOtherField = true
                break
            case 'data':
                this.dataLines.push(value)
                this.rawLines.push(line)
                break
            case 'id':
                if (!value.includes('\0')) this.lastEventId = value
                else if (this.diagnostics) this.violation('NUL_IN_ID', 'An id field contained a NUL character and was ignored.')
                this.rawLines.push(line)
                if (this.diagnostics) this.frameHadId = true
                break
            case 'retry':
                if (/^\d+$/.test(value)) this.handlers.onRetry?.(Number(value))
                else if (this.diagnostics) this.violation('INVALID_RETRY', `The retry value "${truncate(value)}" is not a number of milliseconds.`)
                break
            default: // unknown fields are ignored
                if (this.diagnostics) {
                    this.frameHadOtherField = true
                    const lower = field.toLowerCase()
                    if (KNOWN_FIELDS.has(lower)) this.violation('WRONG_CASE_FIELD', `"${truncate(field)}" looks like "${lower}", but field names are case-sensitive, so the line was ignored.`)
                    else this.violation('UNKNOWN_FIELD', `The field "${truncate(field)}" is not part of the protocol and was ignored.`)
                }
                break
        }
    }

    private dispatch() {
        const hasData = this.dataLines.length > 0
        if (this.diagnostics) {
            if (!hasData && this.frameHadId) this.violation('ID_ONLY_FRAME', 'An event had an id but no data, so nothing was dispatched (the last event id still advanced).')
            else if (!hasData && this.frameHadOtherField) this.violation('FRAME_WITHOUT_DATA', 'An event had fields but no data, so nothing was dispatched.')
            this.frameHadId = false
            this.frameHadOtherField = false
        }
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

const truncate = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max)}...` : text)
