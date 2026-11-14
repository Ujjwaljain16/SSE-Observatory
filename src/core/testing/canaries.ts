/**
 * Planted secrets for the canary sweep (plan E1). Each canary is a value the test knows, put somewhere a real secret could be, so that every place
 * data leaves the tool can be searched for it. Values are assembled at run time from fragments, so the repository holds nothing that looks like a
 * secret (and a secret scanner has nothing to match).
 *
 * Three classes, because the tool makes three different promises:
 *   R  must NOT survive: the shape is one redaction recognises, or the place is one it always clears (an Authorization header, a cookie, a
 *      `password` key, URL credentials).
 *   F  must be FLAGGED: a random-looking token in free text that no rule can know is a secret; redaction keeps it, and the residual scan must say
 *      "something here still looks secret" (without printing it).
 *   L  a documented LIMIT: low-entropy free text (a sentence that happens to be a secret). It survives, and is not flagged. Pinned so the limit
 *      stays written down, and so an improvement flips it on purpose.
 */

export type CanaryClass = 'R' | 'F' | 'L'

export interface Canary {
    /** Where it was planted, for messages. */
    placement: string
    cls: CanaryClass
    value: string
}

/** A small deterministic generator, so a failing run can be repeated exactly. */
function prng(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const HEX = '0123456789abcdef'

export function canaries(seed = 1): Record<string, Canary> {
    const rnd = prng(seed)
    const pick = (pool: string, n: number): string => Array.from({ length: n }, () => pool[Math.floor(rnd() * pool.length)]).join('')
    const make = (placement: string, cls: CanaryClass, value: string): Canary => ({ placement, cls, value })
    const part = () => pick(ALNUM, 12)
    return {
        authorization: make('Authorization request header', 'R', `Bearer ${pick(ALNUM, 30)}`),
        cookie: make('Cookie request header', 'R', `sid=${pick(HEX, 32)}`),
        apiKey: make('X-Api-Key request header', 'R', [['sk', 'live'].join('_'), pick(ALNUM, 24)].join('_')),
        proxyAuth: make('Proxy-Authorization request header', 'R', `Basic ${pick(ALNUM, 20)}`),
        urlToken: make('?token= query value of the URL', 'R', pick(ALNUM, 32)),
        urlApiKey: make('?api_key= query value of the URL', 'R', pick(ALNUM, 28)),
        userinfo: make('password in the URL userinfo', 'R', pick(ALNUM, 18)),
        setCookie: make('Set-Cookie response header', 'R', `sid=${pick(HEX, 32)}`),
        jwtInPayload: make('JWT in an event payload', 'R', [`eyJhbGciOiJIUzI1NiJ9`, `eyJzdWIiOiI${pick(ALNUM, 12)}`, pick(ALNUM, 27)].join('.')),
        passwordNested: make('a nested "password" key in an event payload', 'R', pick(ALNUM, 20)),
        tokenInArray: make('a "token" key inside an array of an event payload', 'R', pick(ALNUM, 26)),
        keyValueComment: make('api_key=value in a comment line', 'R', pick(ALNUM, 24)),
        jwtInId: make('JWT in an event id', 'R', [`eyJhbGciOiJIUzI1NiJ9`, `eyJzdWIiOiI${pick(ALNUM, 12)}`, pick(ALNUM, 27)].join('.')),
        // free text no rule can know about, or a token where only its randomness gives it away (an event id)
        idToken: make('a random token used as an event id', 'F', pick(ALNUM, 32)),
        freeToken: make('a random 32-character token in free text', 'F', pick(ALNUM, 32)),
        // a limit written down
        sentence: make('a low-entropy secret sentence in free text', 'L', `DO_NOT_LEAK_TOKEN_${pick(HEX, 6)}`),
        unused: make('unused', 'R', part()),
    }
}

/** The forms a value may take on its way out: as written, percent-encoded, base64, base64url, and as the inside of a JSON string. */
export function formsOf(value: string): string[] {
    const b64 = Buffer.from(value, 'utf8').toString('base64')
    return [...new Set([
        value,
        encodeURIComponent(value),
        b64,
        b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
        JSON.stringify(value).slice(1, -1),
    ])].filter((f) => f.length >= 8)
}

/** The value as it would be searched in: the secret part only for headers like `Bearer x` (a secret is the token, not the scheme word). */
export function secretPart(value: string): string {
    return value.replace(/^(Bearer|Basic)\s+/i, '').replace(/^sid=/, '')
}

/** Every place in `text` where any form of the canary appears. */
export function survivors(text: string, c: Canary): string[] {
    const found: string[] = []
    for (const form of formsOf(secretPart(c.value))) if (text.includes(form)) found.push(form)
    return found
}
