/**
 * The URL as it is safe to record: no credentials in the userinfo, no fragment, and every query VALUE replaced.
 * Parameter names are kept because they are diagnostic ("this URL carries a token parameter"); values are not,
 * because that is where tokens live. Relative URLs are kept relative.
 */
export function redactUrl(raw: string): string {
    const placeholder = '[redacted]'
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    let url: URL
    try {
        url = new URL(raw, 'http://placeholder.invalid')
    } catch {
        return raw.split(/[?#]/)[0] ?? ''
    }
    url.username = ''
    url.password = ''
    url.hash = ''
    const names = [...new Set([...url.searchParams.keys()])]
    url.search = ''
    const query = names.map((name) => `${encodeURIComponent(name)}=${placeholder}`).join('&')
    const base = hasScheme ? `${url.origin}${url.pathname}` : url.pathname
    return query ? `${base}?${query}` : base
}
