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

const LOCAL_ORIGINS = [
    'http://localhost:3001', 'http://127.0.0.1:3001',
    'http://localhost:4000', 'http://127.0.0.1:4000',
]

export function buildSSEProxyUrl(rawUrl: string): string {
    // Relative paths connect directly (handled by the dev server)
    if (rawUrl.startsWith('/')) return rawUrl

    // Absolute localhost URLs — strip to pathname so EventSource doesn't hit CORS
    try {
        const parsed = new URL(rawUrl)
        if (LOCAL_ORIGINS.some(o => rawUrl.startsWith(o))) {
            // Only strip origin if it matches our current origin (same-origin request)
            const currentOrigin = typeof window !== 'undefined' ? window.location.origin : (typeof self !== 'undefined' ? self.location.origin : '');
            if (currentOrigin && rawUrl.startsWith(currentOrigin)) {
                return parsed.pathname + parsed.search
            }
            // For other local ports (e.g. port 4000 vs 3001), return full URL
            return rawUrl
        }
    } catch {
        // Not a valid absolute URL — fall through to proxy
    }

    // All external URLs route through the Vite SSE proxy plugin at /api/sse
    return `/api/sse?url=${encodeURIComponent(rawUrl)}`
}

export async function obtainSSEProxyTicket(rawUrl: string, token?: string): Promise<string> {
    // Relative paths connect directly
    if (rawUrl.startsWith('/')) {
        return token ? `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}` : rawUrl;
    }

    try {
        const currentOrigin = typeof window !== 'undefined' ? window.location.origin : (typeof self !== 'undefined' ? self.location.origin : '');
        if (currentOrigin && rawUrl.startsWith(currentOrigin)) {
            const parsed = new URL(rawUrl);
            const local = parsed.pathname + parsed.search;
            return token ? `${local}${local.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}` : local;
        }
    } catch { }

    // Use direct proxy URL with URL and Auth parameters.
    // The server-side proxy handles Origin/Referer validation for security.
    const baseUrl = `/api/sse?url=${encodeURIComponent(rawUrl)}`;
    return token ? `${baseUrl}&auth=${encodeURIComponent(token)}` : baseUrl;
}

