/**
 * sseProxyUrl.ts — Single source of truth for SSE proxy URL construction.
 *
 * Previously, URL-building logic was duplicated in four places:
 *   useEventStream.ts, useSharedStream.ts, useMultiStream.ts, sharedSSEWorker.ts
 *
 * This utility centralises the logic:
 *   - Local URLs (starting with `/` or `http://localhost:3001`) are used directly
 *     (their pathname is extracted for fetch-API compatibility)
 *   - All other URLs are proxied through the Vite dev-server at `/api/sse?url=…`
 *
 * NOTE: sharedSSEWorker.ts runs as a SharedWorker bundle and CANNOT import this
 * utility because Workers are bundled separately by Vite. Its copy of this logic
 * is kept in sync manually (see the comment in sharedSSEWorker.ts).
 */

const LOCAL_ORIGINS = ['http://localhost:3001', 'http://127.0.0.1:3001']

/**
 * Given a raw URL string entered by the user, returns the SSE URL that the
 * browser EventSource should connect to.
 *
 * @param rawUrl  The URL as typed in the connection panel, e.g.:
 *                  "/events"
 *                  "http://localhost:3001/events"
 *                  "https://api.example.com/v1/events"
 * @returns  A URL string suitable for `new EventSource(…)`
 */
export function buildSSEProxyUrl(rawUrl: string): string {
    // Relative paths connect directly (handled by the dev server)
    if (rawUrl.startsWith('/')) return rawUrl

    // Absolute localhost URLs — strip to pathname so EventSource doesn't hit CORS
    try {
        const parsed = new URL(rawUrl)
        if (LOCAL_ORIGINS.some(o => rawUrl.startsWith(o))) {
            return parsed.pathname + parsed.search
        }
    } catch {
        // Not a valid absolute URL — fall through to proxy
    }

    // All external URLs route through the Vite SSE proxy plugin at /api/sse
    return `/api/sse?url=${encodeURIComponent(rawUrl)}`
}
