/**
 * The last address the person connected to, kept in this browser so a reload does not leave the URL field empty.
 *
 * It is a convenience, not a credential store: the bearer token is never written here, and neither is an address that
 * carries a credential. The rule is deliberately simple and conservative (it would rather forget a harmless address than
 * keep one with a secret in it): refuse user info (`user:pass@host`), any query or fragment parameter whose name suggests
 * a secret, and any parameter value of 20 or more characters (a token, a signature, a session id).
 */

export const LAST_URL_KEY = 'sse.lastUrl'

const SECRET_NAME = /token|key|secret|password|auth|sig/i
const LONG_VALUE = 20

const hasSecretParams = (text: string): boolean => {
    for (const [name, value] of new URLSearchParams(text)) {
        if (SECRET_NAME.test(name) || value.length >= LONG_VALUE) return true
    }
    return false
}

/** True when the address is safe to keep: not blank, no user info, and no parameter that looks like a secret. */
export function isRememberableUrl(url: string): boolean {
    const text = url.trim()
    if (!text) return false
    // User info is whatever sits between "scheme://" and the "@" before the first "/", "?" or "#".
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(text)) return false
    const hash = text.indexOf('#')
    const beforeHash = hash < 0 ? text : text.slice(0, hash)
    const query = beforeHash.indexOf('?')
    if (query >= 0 && hasSecretParams(beforeHash.slice(query + 1))) return false
    if (hash >= 0 && hasSecretParams(text.slice(hash + 1))) return false
    return true
}

/** The remembered address, or an empty string (nothing stored, storage unavailable, or a stored value that is not safe). */
export function readLastUrl(): string {
    try {
        const stored = localStorage.getItem(LAST_URL_KEY) ?? ''
        return isRememberableUrl(stored) ? stored : ''
    } catch {
        return ''
    }
}

/** Keeps the address when it is safe to keep; otherwise forgets the earlier one, so a reload never offers a stale address. */
export function rememberLastUrl(url: string): void {
    try {
        if (isRememberableUrl(url)) localStorage.setItem(LAST_URL_KEY, url.trim())
        else localStorage.removeItem(LAST_URL_KEY)
    } catch { /* storage unavailable or full: the form just starts empty next time */ }
}
