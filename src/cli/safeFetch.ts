/**
 * `fetch` for requests that carry secrets. The platform's fetch drops `Authorization` and `Cookie` when a redirect goes
 * to another origin, and forwards every other header, so a key sent in `X-Api-Key` follows the redirect to whoever the
 * server named. This follows redirects itself (a few hops) and, once the origin changes, sends only headers that hold
 * nothing secret.
 *
 * Whether a redirect to another origin is followed at all depends on the secrets (decision Q6): with none attached (a CDN hop is normal)
 * it is followed as always; with some attached it is REFUSED, unless the caller opted in (`--follow-redirects`), and then it is followed
 * and the secrets still do not go along. A redirect inside the same origin always continues, with the headers.
 */

const MAX_HOPS = 5
/** The headers a client sets itself or that describe the request, not the caller. Everything else is the caller's, and stays with the origin it was meant for. */
const SAFE_ACROSS_ORIGINS = new Set(['accept', 'accept-encoding', 'accept-language', 'cache-control', 'last-event-id', 'user-agent', 'pragma'])

/** What is known about a redirect that leaves the origin. Origins only (scheme, host, port): never a path or a query, which may hold a secret. */
export interface CrossOriginRedirect {
    status: number
    from: string
    to: string
}

export interface SafeFetchOptions {
    /** The options that supply a secret to this request, by name (never a value). Empty: nothing to protect. */
    secretOptions?: readonly string[]
    /** The explicit opt-in to follow a redirect to another origin although secrets are attached. They are still not sent there. */
    followRedirects?: boolean
    /** Called when a redirect to another origin is refused (the fetch then fails with `CrossOriginRedirectRefused`). */
    onRefused?: (error: CrossOriginRedirectRefused) => void
    /** Called when such a redirect is followed without the secrets, once per origin pair however often the request is repeated. */
    onWithheld?: (redirect: CrossOriginRedirect, secretOptions: readonly string[]) => void
}

/** A redirect to another origin that was not followed because a secret is attached. */
export class CrossOriginRedirectRefused extends Error {
    constructor(readonly redirect: CrossOriginRedirect, readonly secretOptions: readonly string[]) {
        super(`The server redirected to another origin (${redirect.to}), and this request carries credentials (${secretOptions.join(', ')}). Credentials are never sent to another origin, so the redirect was not followed. Add --follow-redirects to follow it without them, or give the address the stream is served from.`)
        this.name = 'CrossOriginRedirectRefused'
    }
}

export function createSafeFetch(options: SafeFetchOptions = {}) {
    const secrets = options.secretOptions ?? []
    const announced = new Set<string>()
    return async function safeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
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
            if (next.origin !== url.origin && secrets.length > 0) {
                const redirect: CrossOriginRedirect = { status: response.status, from: url.origin, to: next.origin }
                if (options.followRedirects !== true) {
                    const refusal = new CrossOriginRedirectRefused(redirect, secrets)
                    options.onRefused?.(refusal)
                    throw refusal
                }
                const key = `${redirect.from} ${redirect.to}`
                if (!announced.has(key)) { announced.add(key); options.onWithheld?.(redirect, secrets) }
            }
            if (next.origin !== origin) {
                const kept = new Headers()
                for (const [name, value] of headers) if (SAFE_ACROSS_ORIGINS.has(name.toLowerCase())) kept.set(name, value)
                headers = kept
            }
            url = next
        }
    }
}

/** The plain version: no secret is declared, so every redirect is followed, and the headers that could hold one are dropped once the origin changes. */
export const safeFetch = createSafeFetch()
