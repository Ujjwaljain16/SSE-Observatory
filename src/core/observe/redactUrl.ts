/**
 * The URL as it is safe to record: no credentials in the userinfo, no fragment, every query VALUE replaced, and any piece
 * that looks like a token replaced wherever it sits. Parameter names are kept because they are diagnostic ("this URL carries
 * a token parameter"), unless the name is itself a token; values are not kept, because that is where tokens live. Relative
 * URLs are kept relative.
 */

const PLACEHOLDER = '[redacted]'

/**
 * A path segment or parameter name that looks like a secret rather than a word: long, only URL-safe characters, and
 * both letters and digits (a slug of words has no digits, a version like `v1` is short). Webhook-style APIs put the
 * token in the path, and a query with a bare token has that token as its parameter name.
 */
export function looksLikeTokenSegment(segment: string): boolean {
    return segment.length >= 20 && /^[A-Za-z0-9_~-]+$/.test(segment) && /[A-Za-z]/.test(segment) && /\d/.test(segment)
}

export function redactUrl(raw: string): string {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    let url: URL
    try {
        url = new URL(raw, 'http://placeholder.invalid')
    } catch {
        // Not a URL the platform can read (a typo, an odd scheme): keep what is plainly safe, never the userinfo or the query.
        return (raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1').split(/[?#]/)[0] ?? '').replace(/\/[A-Za-z0-9_~-]{20,}(?=\/|$)/g, (m) => (looksLikeTokenSegment(m.slice(1)) ? `/${PLACEHOLDER}` : m))
    }
    url.username = ''
    url.password = ''
    url.hash = ''
    const names = [...new Set([...url.searchParams.keys()])]
    url.search = ''
    const query = names.map((name) => `${looksLikeTokenSegment(name) ? PLACEHOLDER : encodeURIComponent(name)}=${PLACEHOLDER}`).join('&')
    const path = url.pathname.split('/').map((segment) => (looksLikeTokenSegment(segment) ? PLACEHOLDER : segment)).join('/')
    const base = hasScheme ? `${url.origin}${path}` : path
    return query ? `${base}?${query}` : base
}
