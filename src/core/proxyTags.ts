// TypeScript mirror of lib/proxy/diagTags.js (the proxy cannot import from src/). A contract test keeps them equal.

export const PROXY_COMMENT_PREFIX = 'sse-proxy'
export const PING_TEXT = 'sse-proxy-ping'
export const HEARTBEAT_TEXT_PREFIX = 'sse-proxy hb '
export const CAP_TEXT_PREFIX = 'sse-proxy cap '
export const META_TEXT_PREFIX = 'sse-proxy-meta '

export const PROXY_ID = 'observatory/1'
export const PROXY_HEADER = {
    proxy: 'X-SSE-Proxy',
    heartbeatMs: 'X-SSE-Proxy-Heartbeat-Ms',
    maxDuration: 'X-SSE-Proxy-Max-Duration',
    upstreamStatus: 'X-SSE-Upstream-Status',
    upstreamContentType: 'X-SSE-Upstream-Content-Type',
    upstreamEncoding: 'X-SSE-Upstream-Encoding',
    upstreamTtfbMs: 'X-SSE-Upstream-Ttfb-Ms',
} as const

export type ProxyComment =
    | { kind: 'ping' }
    | { kind: 'hb'; upIdleMs: number; n: number }
    | { kind: 'cap'; durationMs: number }
    | { kind: 'meta'; meta: Record<string, unknown> }

const HB_RE = /^sse-proxy hb up_idle=(\d+) n=(\d+)$/
const CAP_RE = /^sse-proxy cap duration=(\d+)$/

/** Parses the text of a comment (without the leading ": ") written by the proxy; null for anything else. */
export function parseProxyComment(text: string): ProxyComment | null {
    if (text === PING_TEXT) return { kind: 'ping' }
    const hb = HB_RE.exec(text)
    if (hb) return { kind: 'hb', upIdleMs: Number(hb[1]), n: Number(hb[2]) }
    const cap = CAP_RE.exec(text)
    if (cap) return { kind: 'cap', durationMs: Number(cap[1]) }
    if (text.startsWith(META_TEXT_PREFIX)) {
        try {
            const meta: unknown = JSON.parse(text.slice(META_TEXT_PREFIX.length))
            if (meta && typeof meta === 'object' && !Array.isArray(meta)) return { kind: 'meta', meta: meta as Record<string, unknown> }
        } catch { /* malformed meta is not a proxy tag */ }
    }
    return null
}
