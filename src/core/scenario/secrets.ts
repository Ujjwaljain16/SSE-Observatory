/**
 * Scenarios are meant to be committed and shared, so a secret in one is an error, not a warning. The only way to name
 * a secret is a `${ENV:NAME}` placeholder, filled in from the environment when the scenario runs.
 *
 * The messages never repeat the offending value.
 */

import type { ValidationError } from './validate'

const NAME = '[A-Za-z_][A-Za-z0-9_]*'
export const PLACEHOLDER_RE = new RegExp(`\\$\\{ENV:${NAME}\\}`, 'g')

const ONLY_PLACEHOLDERS = new RegExp(`^(?:\\$\\{ENV:${NAME}\\})+$`)
/** `Bearer ${ENV:X}`, `Basic ${ENV:X}`, `session=${ENV:X}`: one scheme word or cookie name, then placeholders only. */
const WORD_THEN_PLACEHOLDERS = new RegExp(`^(?:[A-Za-z][A-Za-z0-9._-]*[ =])?(?:\\$\\{ENV:${NAME}\\})+$`)

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'proxy-authorization', 'set-cookie'])
const SENSITIVE_HEADER_PARTS = new Set(['token', 'secret', 'password', 'auth', 'session', 'jwt'])
const SENSITIVE_PARAMS = new Set(['token', 'key', 'secret', 'password', 'auth', 'session', 'jwt', 'api_key', 'access_token'])

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/
const HEX_RE = /\b[0-9a-fA-F]{32,}\b/
const BASE64_RE = /[A-Za-z0-9_+-]{40,}={0,2}/g
const URLISH_RE = /^\S*\?\S*=\S*$/
const USERINFO_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s@:]*:([^/?#\s@]+)@/

const isSensitiveHeader = (name: string): boolean => {
    const lower = name.toLowerCase()
    if (SENSITIVE_HEADERS.has(lower)) return true
    if (lower.replace(/[-_]/g, '').includes('apikey')) return true
    return lower.split(/[-_]/).some((part) => SENSITIVE_HEADER_PARTS.has(part))
}

const escapePointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1')

/** A long token with upper case, lower case and digits is far more likely a key than a word or a path segment. */
const looksLikeBase64Token = (text: string): boolean => {
    for (const m of text.matchAll(BASE64_RE)) {
        const t = m[0]
        if (/[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t)) return true
    }
    return false
}

function scanString(text: string, pointer: string, out: ValidationError[]): void {
    const add = (message: string): void => { out.push({ pointer, message, code: 'secret' }) }
    const bare = text.replace(PLACEHOLDER_RE, '')

    if (URLISH_RE.test(text)) {
        const query = text.slice(text.indexOf('?') + 1).split('#')[0]!
        for (const pair of query.split('&')) {
            const eq = pair.indexOf('=')
            if (eq < 0) continue
            const name = decodeLoose(pair.slice(0, eq)).toLowerCase().replace(/-/g, '_')
            const val = pair.slice(eq + 1)
            if (SENSITIVE_PARAMS.has(name) && val !== '' && !ONLY_PLACEHOLDERS.test(val)) {
                add(`the URL has a literal value for the "${name}" query parameter; use \${ENV:NAME} so the secret stays out of the file`)
            }
        }
    }
    const userinfo = USERINFO_RE.exec(text)
    if (userinfo && !ONLY_PLACEHOLDERS.test(userinfo[1]!)) add('the URL has a literal password in its user info; use ${ENV:NAME}')

    if (JWT_RE.test(bare)) add('this looks like a JWT; secrets must be written as ${ENV:NAME}')
    else if (HEX_RE.test(bare) || looksLikeBase64Token(bare)) add('this looks like a key or token; secrets must be written as ${ENV:NAME}')
}

function decodeLoose(s: string): string {
    try { return decodeURIComponent(s) } catch { return s }
}

/**
 * Finds literal secrets anywhere in a parsed scenario. Header rules apply to `target.headers`; the URL and
 * token-shape rules apply to every string value in the document.
 */
export function findSecrets(doc: unknown): ValidationError[] {
    const out: ValidationError[] = []

    const target = (doc as { target?: unknown } | null)?.target
    const headers = target && typeof target === 'object' ? (target as { headers?: unknown }).headers : undefined
    const headerPointers = new Set<string>()
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
        for (const [name, value] of Object.entries(headers)) {
            if (typeof value !== 'string' || !isSensitiveHeader(name)) continue
            const pointer = `/target/headers/${escapePointer(name)}`
            if (!WORD_THEN_PLACEHOLDERS.test(value)) {
                out.push({ pointer, code: 'secret', message: `the "${name}" header has a literal value; write it as a placeholder such as "Bearer \${ENV:STREAM_TOKEN}"` })
                headerPointers.add(pointer)
            }
        }
    }

    const walk = (v: unknown, pointer: string): void => {
        if (typeof v === 'string') {
            // The header rule already said it; a second message about the same value would only be noise.
            if (pointer === '/$schema' || headerPointers.has(pointer)) return
            scanString(v, pointer, out)
        } else if (Array.isArray(v)) {
            v.forEach((item, i) => walk(item, `${pointer}/${i}`))
        } else if (v && typeof v === 'object') {
            for (const [k, item] of Object.entries(v)) walk(item, `${pointer}/${escapePointer(k)}`)
        }
    }
    walk(doc, '')
    return out
}
