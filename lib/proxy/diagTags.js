// Canonical wire format of the proxy's own SSE comments and diagnostic headers.
// Plain JS and import-free so the Docker image (server.js, lib, dist only) and the Vercel function can load it.
// src/core/proxyTags.ts mirrors these constants; a contract test fails if the two drift apart.

/** Every proxy-written comment starts with this text; the browser client labels such comments as proxy bytes. */
export const PROXY_COMMENT_PREFIX = 'sse-proxy'
export const PING_TEXT = 'sse-proxy-ping'
export const HEARTBEAT_TEXT_PREFIX = 'sse-proxy hb '
export const CAP_TEXT_PREFIX = 'sse-proxy cap '
export const META_TEXT_PREFIX = 'sse-proxy-meta '
/** The proxy's notice that it ended the stream and why (a comment, never an event): `: sse-proxy error {"error":"<reason>"}`. */
export const ERROR_TEXT_PREFIX = 'sse-proxy error '
/** Plain keep-alive text, used when diagnostics are switched off: it is outside the reserved namespace on purpose, so it reads as the upstream's. */
export const LEGACY_KEEPALIVE_TEXT = 'keep-alive'
/** Inserted right after the colon of an upstream comment that is in the reserved namespace: `: sse-proxy hb` becomes `: upstream: sse-proxy hb`. */
export const UPSTREAM_ESCAPE = ' upstream:'

export const PROXY_ID = 'observatory/1'
export const HEADER = {
    proxy: 'X-SSE-Proxy',
    heartbeatMs: 'X-SSE-Proxy-Heartbeat-Ms',
    maxDuration: 'X-SSE-Proxy-Max-Duration',
    upstreamStatus: 'X-SSE-Upstream-Status',
    upstreamContentType: 'X-SSE-Upstream-Content-Type',
    upstreamEncoding: 'X-SSE-Upstream-Encoding',
    upstreamTtfbMs: 'X-SSE-Upstream-Ttfb-Ms',
}

const wire = (text) => `: ${text}\n\n`
const whole = (n) => Math.max(0, Math.round(n))

export const pingComment = () => wire(PING_TEXT)
export const legacyKeepAliveComment = () => wire(LEGACY_KEEPALIVE_TEXT)
export const heartbeatComment = (upIdleMs, n) => wire(`${HEARTBEAT_TEXT_PREFIX}up_idle=${whole(upIdleMs)} n=${n}`)
export const capComment = (durationMs) => wire(`${CAP_TEXT_PREFIX}duration=${whole(durationMs)}`)
/** JSON.stringify never emits a raw newline, so the meta object always fits in one comment line. */
export const metaComment = (meta) => wire(META_TEXT_PREFIX + JSON.stringify(meta))
/** The reason travels as JSON, which never contains a raw CR or LF, so the notice is always exactly one comment line. */
export const errorComment = (message) => wire(ERROR_TEXT_PREFIX + JSON.stringify({ error: String(message) }))

// ---------- the reserved namespace belongs to the proxy ----------

const NAMESPACE = Buffer.from(PROXY_COMMENT_PREFIX)
const BOM = [0xef, 0xbb, 0xbf]
const CR = 0x0d
const LF = 0x0a
/** How many spaces or tabs after the colon are looked past. The client labels only `:` + at most one space + `sse-proxy`; this is wider on purpose. */
const MAX_LEADING_WHITESPACE = 32

/**
 * Rewrites the upstream's comment lines that are in the proxy's reserved namespace, so an upstream cannot pass for the proxy: a comment line is
 * `:`, then optional spaces or tabs, then `sse-proxy` in any letter case. Such a line gets UPSTREAM_ESCAPE right after its colon; every other byte is
 * passed through as it came. It works on bytes, one line at a time, and decides as soon as it has seen enough of a line: a line that is not a comment is
 * forwarded at once, a comment is held back only while its first bytes could still turn out to be the namespace (at most 1 + 32 + 8 bytes), so a comment
 * cut across network chunks is judged by its whole start. `flush()` returns what is still held when the stream ends, unchanged.
 * Line ends are LF, CR or CRLF (a leading byte order mark is skipped, as the parser does), the same as the SSE parser's.
 */
export class NamespaceEscaper {
    constructor() {
        /** 'start': nothing yet (a byte order mark may come first); 'line': at the start of a line; 'body': inside a line that is not a candidate; 'cand': a comment line whose first bytes are held. */
        this.state = 'start'
        this.held = []
        this.whitespace = 0
        this.matched = 0
    }

    /** @param {Buffer | Uint8Array | string} chunk @returns {Buffer} the bytes that may be written now */
    push(chunk) {
        const input = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length)
        if (input.length === 0) return input
        // Fast path: nothing held and no colon in the chunk, so no comment can begin in it.
        if ((this.state === 'line' || this.state === 'body') && input.indexOf(0x3a) === -1) {
            const last = input[input.length - 1]
            this.state = last === LF || last === CR ? 'line' : 'body'
            return input
        }
        const total = this.held.length + input.length
        const out = Buffer.allocUnsafe(total + UPSTREAM_ESCAPE.length * (Math.floor(total / (NAMESPACE.length + 1)) + 1))
        let o = 0
        const release = () => { for (const h of this.held) out[o++] = h; this.held = [] }
        for (let i = 0; i < input.length; i++) {
            const b = input[i]
            for (let again = true; again;) {
                again = false
                switch (this.state) {
                    case 'start':
                        if (b === BOM[this.held.length]) {
                            this.held.push(b)
                            if (this.held.length === BOM.length) { release(); this.state = 'line' }
                        } else {
                            // Not a byte order mark (or half of one): those bytes are ordinary text of the first line.
                            this.state = this.held.length > 0 ? 'body' : 'line'
                            release()
                            again = true
                        }
                        break
                    case 'line':
                        if (b === 0x3a) { this.held.push(b); this.whitespace = 0; this.matched = 0; this.state = 'cand' } else { out[o++] = b; if (b !== LF && b !== CR) this.state = 'body' }
                        break
                    case 'body':
                        out[o++] = b
                        if (b === LF || b === CR) this.state = 'line'
                        break
                    default: { // 'cand'
                        const lower = b >= 0x41 && b <= 0x5a ? b + 0x20 : b
                        if (this.matched === 0 && (b === 0x20 || b === 0x09) && this.whitespace < MAX_LEADING_WHITESPACE) {
                            this.held.push(b)
                            this.whitespace++
                        } else if (lower === NAMESPACE[this.matched]) {
                            this.held.push(b)
                            if (++this.matched === NAMESPACE.length) {
                                out[o++] = this.held[0]
                                for (let k = 0; k < UPSTREAM_ESCAPE.length; k++) out[o++] = UPSTREAM_ESCAPE.charCodeAt(k)
                                for (let k = 1; k < this.held.length; k++) out[o++] = this.held[k]
                                this.held = []
                                this.state = 'body'
                            }
                        } else {
                            // Not the namespace: what was held goes out as it came, and this byte is an ordinary byte of the line.
                            release()
                            this.state = 'body'
                            again = true
                        }
                    }
                }
            }
        }
        return out.subarray(0, o)
    }

    /** What is still held at the end of the stream, unchanged (it never became the namespace). */
    flush() {
        const rest = Buffer.from(this.held)
        this.held = []
        this.state = 'body'
        return rest
    }
}

/** Strips anything that is not printable ASCII so an upstream value can never break response headers. */
export const headerSafe = (value) => String(value ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 256)

/**
 * @param {{ status: number, contentType: string, encoding: string, ttfbMs: number, heartbeatMs: number, maxDurationMs: number }} d
 */
export function diagnosticHeaders(d) {
    return {
        [HEADER.proxy]: PROXY_ID,
        [HEADER.heartbeatMs]: String(d.heartbeatMs),
        [HEADER.maxDuration]: String(d.maxDurationMs || 0),
        [HEADER.upstreamStatus]: String(d.status),
        [HEADER.upstreamContentType]: headerSafe(d.contentType),
        [HEADER.upstreamEncoding]: headerSafe(d.encoding),
        [HEADER.upstreamTtfbMs]: String(whole(d.ttfbMs)),
    }
}
