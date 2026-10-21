/**
 * What counts as a secret, in one place. The redactor uses it to replace values, and the residual scanner uses it to
 * check that nothing was missed. Patterns are deliberately conservative: a missed secret leaks, a redacted harmless
 * value only costs a little context.
 */

export interface SecretPattern {
    name: string
    regex: RegExp
    /** Capture group holding the secret itself; 0 = the whole match. */
    group: number
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
    { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, group: 0 },
    { name: 'bearer', regex: /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi, group: 1 },
    { name: 'aws-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0 },
    { name: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, group: 0 },
    { name: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, group: 0 },
    { name: 'stripe-key', regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, group: 0 },
    { name: 'google-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, group: 0 },
    { name: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, group: 0 },
    // The scheme is bounded: an unbounded one made every word boundary scan to the end of a long a-a-a-a run (quadratic).
    { name: 'url-credentials', regex: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:([^\s/@]+)@/gi, group: 1 },
    // A user name alone (https://TOKEN@host/) is how some APIs take a key; user names in URLs are not worth keeping.
    { name: 'url-userinfo', regex: /\b[a-z][a-z0-9+.-]{0,31}:\/\/([^\s/:@]{1,200})@/gi, group: 1 },
]

const SENSITIVE_NAMES = new Set([
    'password', 'passwd', 'pwd', 'passphrase', 'secret', 'token', 'apikey', 'accesskey', 'secretkey', 'privatekey', 'clientsecret',
    'authorization', 'auth', 'bearer', 'credential', 'credentials', 'session', 'sessionid', 'cookie', 'setcookie', 'signature', 'otp',
    'xapikey', 'xauthtoken', 'proxyauthorization',
    'secretaccesskey', 'sessionkey', 'authkey', 'sid', 'signingkey', 'ticket', 'sig', 'passcode', 'licensekey', 'connectsid', 'accesstoken', 'refreshtoken', 'idtoken',
])
const SENSITIVE_SUFFIXES = ['token', 'secret', 'password', 'passwd', 'apikey', 'privatekey']

/** `access_token`, `Api-Key`, `clientSecret`, `X-Auth-Token`: separators and case do not matter. */
export function isSensitiveName(name: string, extra: readonly string[] = []): boolean {
    const normal = name.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (normal.length === 0) return false
    // tokens, secrets, credentials: a list of them is as secret as one
    const one = normal.length > 3 && normal.endsWith('s') ? normal.slice(0, -1) : normal
    if (SENSITIVE_NAMES.has(normal) || SENSITIVE_NAMES.has(one) || SENSITIVE_SUFFIXES.some((s) => normal.endsWith(s) || one.endsWith(s))) return true
    return extra.some((e) => e.toLowerCase().replace(/[^a-z0-9]/g, '') === normal)
}

export const PLACEHOLDER_MARK = '[REDACTED_'
export const hasPlaceholder = (text: string): boolean => text.includes(PLACEHOLDER_MARK)

/** Shannon entropy in bits per character. */
export function entropy(text: string): number {
    if (text.length === 0) return 0
    const counts = new Map<string, number>()
    for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    let bits = 0
    for (const n of counts.values()) {
        const p = n / text.length
        bits -= p * Math.log2(p)
    }
    return bits
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A long, random-looking token that no pattern recognised. Flagged by the residual scan, never auto-replaced. */
export function looksLikeRandomToken(token: string): boolean {
    if (token.length < 24 || UUID.test(token) || hasPlaceholder(token)) return false
    // A long run of hex is a hash, a trace id or a key, and its entropy is capped at 4 bits, so it never reaches the test below.
    if (/^[0-9a-f]{32,}$/i.test(token)) return true
    if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) return false
    return entropy(token) >= 4.0
}

/** Header values that are safe to keep in a shared capture. Everything else becomes a placeholder. */
export const SAFE_REQUEST_HEADERS: readonly string[] = [
    'accept', 'accept-encoding', 'accept-language', 'cache-control', 'connection', 'content-type', 'pragma', 'user-agent', 'last-event-id',
]
