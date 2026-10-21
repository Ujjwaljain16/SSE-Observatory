/**
 * `fetch` for requests that carry secrets. The platform's fetch drops `Authorization` and `Cookie` when a redirect goes
 * to another origin, and forwards every other header, so a key sent in `X-Api-Key` follows the redirect to whoever the
 * server named. This follows redirects itself (a few hops) and, once the origin changes, sends only headers that hold
 * nothing secret. A redirect to another origin is allowed, because a CDN hop is normal; what it never gets is the key.
 */

const MAX_HOPS = 5
/** The headers a client sets itself or that describe the request, not the caller. Everything else is the caller's, and stays with the origin it was meant for. */
const SAFE_ACROSS_ORIGINS = new Set(['accept', 'accept-encoding', 'accept-language', 'cache-control', 'last-event-id', 'user-agent', 'pragma'])

export async function safeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    let url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const origin = url.origin
    let headers = new Headers(init.headers)
    let hops = 0
    for (;;) {
        const response = await fetch(url, { ...init, headers, redirect: 'manual' })
        const location = response.headers.get('location')
        if (response.status < 300 || response.status >= 400 || response.status === 304 || !location) {
            if (hops > 0) Object.defineProperty(response, 'redirected', { value: true })
            return response
        }
        if (++hops > MAX_HOPS) throw new Error(`Too many redirects (more than ${MAX_HOPS}).`)
        await response.body?.cancel().catch(() => undefined)
        const next = new URL(location, url)
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('A redirect to a URL that is not http or https was refused.')
        if (next.origin !== origin) {
            const kept = new Headers()
            for (const [name, value] of headers) if (SAFE_ACROSS_ORIGINS.has(name.toLowerCase())) kept.set(name, value)
            headers = kept
        }
        url = next
    }
}
