/**
 * The texts a registered secret can come back as. A secret is recognised by value, so every way a server, a proxy or a log line may have written
 * it back has to be one of these strings (see `SecretRegistry`). Each family is bounded by what the value holds: a value without a space has no
 * `+` form, a value without non-ASCII has no `\uXXXX` form, and so on, so an ordinary token gets a few dozen forms and no more.
 *
 * A form must be something an ordinary text does not contain by chance: the hex forms are at least 8 characters, a base64 fragment taken from
 * the inside of a larger value is at least MIN_FRAGMENT characters, and nothing here is shorter than the value it came from, except those
 * fragments.
 */

/** A base64 fragment that stands for the secret at a position inside a larger value must be this long, or it would match unrelated base64. */
export const MIN_FRAGMENT = 8

const lowerHex = (s: string) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())
const hex4 = (code: number) => code.toString(16).padStart(4, '0')
/** Every subset of `items` (the empty one first), each as a Set: 2^items.length of them, and the callers pass at most five items. */
function subsets<T>(items: readonly T[]): Array<Set<T>> {
    const out: Array<Set<T>> = []
    for (let mask = 0; mask < 1 << items.length; mask++) out.push(new Set(items.filter((_, i) => mask & (1 << i))))
    return out
}

/** The same bytes written as hexadecimal, in either case (Go `%x` / `%X`, `xxd -p`, a hash-style dump). */
function hexForms(value: string): string[] {
    const hex = Buffer.from(value, 'utf8').toString('hex')
    return [hex, hex.toUpperCase()]
}

/**
 * Characters `encodeURIComponent` leaves alone and other encoders (URLSearchParams, Python `urlencode`, PHP, Go, Java) write as `%XX`. The encoders
 * agree on `! ' ( )` (all four or none) and differ on `*` and on `~`, so each group is either plain or encoded.
 */
const SOMETIMES_ENCODED: ReadonlyArray<readonly string[]> = [["!", "'", "(", ")"], ["*"], ["~"]]

function percentEncode(value: string, encoded: ReadonlySet<string>, space: string): string {
    let out = ''
    for (const ch of value) {
        if (ch === ' ') out += space
        else if (encoded.has(ch)) out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
        else out += encodeURIComponent(ch)
    }
    return out
}

/**
 * Percent-encoding as the encoders in use write it: a space as `%20` or `+`; `! ' ( )`, `*` and `~` each written plain or as `%XX` (every
 * combination of the groups the value holds); upper- or lower-case hex; and the same encoded a second time (a gateway that re-encodes the target
 * it forwards: `%` becomes `%25`).
 */
function percentForms(value: string): string[] {
    const present = SOMETIMES_ENCODED.filter((group) => group.some((c) => value.includes(c)))
    const spaces = value.includes(' ') ? ['%20', '+'] : ['%20']
    const single = new Set<string>()
    for (const groups of subsets(present)) for (const space of spaces) {
        const form = percentEncode(value, new Set([...groups].flat()), space)
        single.add(form)
        single.add(lowerHex(form))
    }
    const forms = new Set(single)
    for (const form of single) {
        const twice = encodeURIComponent(form)
        forms.add(twice)
        forms.add(lowerHex(twice))
    }
    return [...forms]
}

/** What Go's json.Marshal escapes beyond JSON.stringify: < > & and U+2028, U+2029 (built from their codes so that no line separator sits in this file). */
const GO_ESCAPED = new RegExp('[<>&' + String.fromCharCode(0x2028, 0x2029) + ']', 'g')

/**
 * Inside a JSON string, as the encoders write it: `JSON.stringify`; with `\uXXXX` for every non-ASCII character (Python `json.dumps`, PHP; an astral
 * character becomes a surrogate pair); with a backslash before each slash (PHP); with the escapes for < > & and for the line and paragraph separators (Go `json.Marshal`); every
 * combination of the three that the value gives a reason for; and the `\u` digits in upper case.
 */
function jsonForms(value: string): string[] {
    const base = JSON.stringify(value).slice(1, -1)
    const flags = [
        /[^\x00-\x7f]/.test(base) ? 'ascii' : null,
        base.includes('/') ? 'slash' : null,
        base.search(GO_ESCAPED) >= 0 ? 'html' : null,
    ].filter((f): f is string => f !== null)
    const forms = new Set<string>()
    for (const on of subsets(flags)) {
        let form = base
        if (on.has('html')) form = form.replace(GO_ESCAPED, (c) => '\\u' + hex4(c.charCodeAt(0)))
        if (on.has('ascii')) form = form.replace(/[^\x00-\x7f]/g, (c) => '\\u' + hex4(c.charCodeAt(0)))
        if (on.has('slash')) form = form.replace(/\//g, '\\/')
        forms.add(form)
        forms.add(form.replace(/\\u([0-9a-f]{4})/g, (_, h: string) => '\\u' + h.toUpperCase()))
    }
    return [...forms]
}

const NAMED_ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const APOSTROPHE_ENTITIES = ['&#39;', '&#x27;', '&#039;', '&apos;']

/**
 * As an HTML page that echoes the value escapes it: `& < > "` as named entities and the apostrophe in any of its four spellings, for every
 * subset of those characters the value holds (escapers differ in which they touch). Numeric entities for other characters are not covered.
 */
function htmlForms(value: string): string[] {
    const present = ['&', '<', '>', '"', "'"].filter((c) => value.includes(c))
    const forms = new Set<string>()
    for (const escaped of subsets(present)) {
        if (escaped.size === 0) continue
        for (const apostrophe of escaped.has("'") ? APOSTROPHE_ENTITIES : [APOSTROPHE_ENTITIES[0]!]) {
            let form = ''
            for (const ch of value) form += escaped.has(ch) ? (ch === "'" ? apostrophe : NAMED_ENTITY[ch]!) : ch
            forms.add(form)
        }
    }
    return [...forms]
}

/**
 * The secret written as base64 inside a larger value, at any of the three alignments (base64 turns 3 bytes into 4 characters, so the same bytes
 * give different text after 0, 1 or 2 other bytes: `user:` + secret, `x` + secret + `y`). Only the characters that the secret alone determines
 * are used: the first characters of the secret's span share bits with the byte before it, and the last one with the byte after it. Both are
 * given in base64 and base64url, with the tail included (the secret ends the value) and without (more follows). A fragment shorter than
 * MIN_FRAGMENT characters is not used, so a secret of fewer than about 7 bytes is found only at the alignment its own base64 gives.
 */
function base64Fragments(value: string): string[] {
    const bytes = Buffer.from(value, 'utf8')
    const forms = new Set<string>()
    const url = (s: string) => s.replace(/\+/g, '-').replace(/\//g, '_')
    for (const offset of [0, 1, 2]) {
        const unpadded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64').replace(/=+$/, '')
        const lead = [0, 2, 3][offset]!
        const partialTail = (offset + bytes.length) % 3 === 0 ? 0 : 1
        const fragments = [unpadded.slice(lead), unpadded.slice(lead, unpadded.length - partialTail)]
        for (const fragment of fragments) {
            if (fragment.length < (offset === 0 ? 4 : MIN_FRAGMENT)) continue
            forms.add(fragment)
            forms.add(url(fragment))
        }
    }
    return [...forms]
}

/** Every form of a value that is not the value itself, base64 as given and the claimed forms. Longer than MIN_SECRET_LENGTH is the caller's check. */
export function encodedForms(value: string): string[] {
    const b64 = Buffer.from(value, 'utf8').toString('base64')
    return [
        // the first campaign's list: percent-encoded in both cases, base64 padded and unpadded, base64url, JSON-escaped
        encodeURIComponent(value), b64, JSON.stringify(value).slice(1, -1),
        b64.replace(/=+$/, ''), b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
        ...hexForms(value), ...percentForms(value), ...jsonForms(value), ...htmlForms(value), ...base64Fragments(value),
    ]
}
