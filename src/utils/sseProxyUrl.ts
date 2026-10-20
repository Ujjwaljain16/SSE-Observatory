/**
 * Builds the HTTP request used to open a stream. Single source of truth, shared by the SharedWorker,
 * the in-page fallback and the multi-stream lanes.
 *
 *  - same-origin / relative URLs are requested directly (Vite dev proxy, mock server, ...)
 *  - "Use Server Proxy" off → direct request to the target (needs CORS on the target)
 *  - "Use Server Proxy" on  → POST /api/sse with {url, token}; the token travels in the body, never in a URL
 */

import type { SSERequestInit } from './sseClient'

const PROXY_PATH = '/api/sse'

/** "abc" → "Bearer abc"; values that already carry a scheme ("Bearer abc", "Basic xyz") are sent as typed. */
export function authorizationHeader(token?: string | null): string | undefined {
    const t = (token ?? '').trim()
    if (!t) return undefined
    return /^[A-Za-z][\w-]*\s+\S/.test(t) ? t : `Bearer ${t}`
}

const currentOrigin = (): string => {
    const loc = (globalThis as { location?: { origin?: string } }).location
    return loc?.origin && loc.origin !== 'null' ? loc.origin : ''
}

export function buildSSERequest(rawUrl: string, token?: string | null, useProxy = true): SSERequestInit {
    const url = rawUrl.trim()
    const auth = authorizationHeader(token)
    const authHeaders: Record<string, string> = auth ? { Authorization: auth } : {}

    // Relative path → same-origin.
    if (url.startsWith('/')) return { url, headers: authHeaders, credentials: 'same-origin' }

    let parsed: URL | null = null
    try { parsed = new URL(url) } catch { /* handled below */ }
    const origin = currentOrigin()
    if (parsed && origin && parsed.origin === origin) {
        return { url: parsed.pathname + parsed.search, headers: authHeaders, credentials: 'same-origin' }
    }

    if (!useProxy) return { url, headers: authHeaders, credentials: 'omit' }

    return {
        url: PROXY_PATH,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(auth ? { url, token: auth } : { url }),
        credentials: 'same-origin',
    }
}
