// Canonical wire format of the proxy's own SSE comments and diagnostic headers.
// Plain JS and import-free so the Docker image (server.js, lib, dist only) and the Vercel function can load it.
// src/core/proxyTags.ts mirrors these constants; a contract test fails if the two drift apart.

/** Every proxy-written comment starts with this text; the browser client labels such comments as proxy bytes. */
export const PROXY_COMMENT_PREFIX = 'sse-proxy'
export const PING_TEXT = 'sse-proxy-ping'
export const HEARTBEAT_TEXT_PREFIX = 'sse-proxy hb '
export const CAP_TEXT_PREFIX = 'sse-proxy cap '
export const META_TEXT_PREFIX = 'sse-proxy-meta '
/** Original (untagged) keep-alive text, still used when diagnostics are switched off. */
export const LEGACY_KEEPALIVE_TEXT = 'keep-alive'

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
