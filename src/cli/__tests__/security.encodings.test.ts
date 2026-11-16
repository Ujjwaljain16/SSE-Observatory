// @vitest-environment node
import fc from 'fast-check'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { main, type CliIo } from '../index'
import { MIN_SECRET_LENGTH, SecretRegistry, scrubbedIo } from '../secretRegistry'

// Campaign E2, the forms in which a secret can come back. Every secret the CLI resolves is registered once, and every sink (stdout, stderr, files)
// is scrubbed by value. This file does three things:
//   1. every form the registry claimed in the first campaign is scrubbed, for several secrets, in realistic carriers (a JSON body, a query string, a
//      header line);
//   2. every form that campaign found NOT to be claimed (hex, form encoding, JSON unicode escapes, PHP and Go escapes, HTML entities, double
//      percent-encoding, base64 inside a larger value, a secret split over two writes, two secrets that overlap) was written down as a pair of tests:
//      one that pinned the leak, and an `it.fails` that held the behaviour wanted. Closing a gap flipped both on purpose, and the section "forms
//      added after the first campaign" below holds what is left: a normal test that the form is scrubbed, and for each form a healthy-path test that
//      ordinary text which merely resembles the encoding (a hash, a `+`, `\/`, an `&amp;`) is not altered;
//   3. what is still not covered stays in the last describe, as a statement of the limit rather than a promise.
// The limits belong in docs/guide/cli.md ("What the scrub covers, and what it does not").

const MASK = '[REDACTED]'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const b64url = (s: string) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex')
const pctLower = (s: string) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())
const jsonEscaped = (s: string) => JSON.stringify(s).slice(1, -1)
/** What `application/x-www-form-urlencoded` (a browser form, URLSearchParams, Python's urlencode) writes. */
const formEncoded = (s: string) => new URLSearchParams({ k: s }).toString().slice(2)

function registryWith(...secrets: string[]): SecretRegistry {
    const r = new SecretRegistry()
    for (const s of secrets) expect(r.register(s), `set-up: "${s}" is long enough to register`).toBe(true)
    return r
}

/** Secrets chosen so that each encoding differs from the raw value: quotes, backslash, plus, slash, space, newline, control, non-ASCII, astral. */
const SECRETS: Record<string, string> = {
    plain: 'plain-secret-value-123',
    'quote, backslash, slash, plus, equals': 'pa"ss\\word/with+odd=chars',
    'newline, tab, control character': 'multi\nline\ttab\u0001ctl',
    'space, accents, CJK, astral': 'héllo wörld 日本語 😀 key',
    'bytes whose base64 has + and /': '>>>???~~~',
}

const CLAIMED: Record<string, (s: string) => string> = {
    raw: (s) => s,
    'percent-encoded (upper-case hex, encodeURIComponent)': (s) => encodeURIComponent(s),
    'percent-encoded (lower-case hex)': pctLower,
    base64: b64,
    'base64 without padding': (s) => b64(s).replace(/=+$/, ''),
    base64url: b64url,
    'JSON-escaped (inside a string: quote, backslash, \\n, \\u0001)': jsonEscaped,
}

describe('E2: the forms the registry claims are scrubbed', () => {
    for (const [secretName, secret] of Object.entries(SECRETS)) {
        describe(`secret with ${secretName}`, () => {
            for (const [formName, encode] of Object.entries(CLAIMED)) {
                const form = encode(secret)
                it(`${formName}`, () => {
                    // set-up: the form is real text and the test is not vacuous (for the plain secret several forms equal the raw one, which is fine)
                    expect(form.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH)
                    const registry = registryWith(secret)
                    const text = `before ${form} after`
                    expect(registry.scrub(text)).toBe(`before ${MASK} after`)
                })
            }
        })
    }

    it('in realistic carriers: a JSON error body, a query string, a header line, several times in one text', () => {
        const secret = SECRETS['quote, backslash, slash, plus, equals']!
        const registry = registryWith(secret)
        const carriers = [
            `{"error":"bad credential ${jsonEscaped(secret)}","retry":false}`,
            `GET /stream?token=${encodeURIComponent(secret)}&x=1 HTTP/1.1`,
            `Authorization: Bearer ${secret}`,
            `${secret} ${secret} ${b64(secret)} ${secret}`,
        ]
        for (const carrier of carriers) {
            const out = registry.scrub(carrier)
            for (const [name, encode] of Object.entries(CLAIMED)) expect(out, `${name} survived in: ${carrier}`).not.toContain(encode(secret))
            expect(out).toContain(MASK)
        }
    })

    it('the value behind a scheme (Bearer, Basic, Token, ApiKey) is a secret on its own', () => {
        for (const scheme of ['Bearer', 'Basic', 'Token', 'ApiKey', 'bearer']) {
            const registry = registryWith(`${scheme} tok_abcdef0123`)
            expect(registry.scrub(`echo: tok_abcdef0123 / ${scheme} tok_abcdef0123`), scheme).toBe(`echo: ${MASK} / ${MASK}`)
        }
    })

    it('scrubs by value wherever it appears: file text, stdout, stderr (scrubbedIo)', async () => {
        const secret = 'sink-secret-value-9'
        const registry = registryWith(secret)
        const seen: Record<string, string> = {}
        const raw: CliIo = {
            out: (t) => { seen['out'] = (seen['out'] ?? '') + t }, err: (t) => { seen['err'] = (seen['err'] ?? '') + t },
            writeText: async (p, t) => { seen[p] = t },
        }
        const io = scrubbedIo(raw, registry)
        io.out(`o ${secret}\n`); io.err(`e ${b64(secret)}\n`); await io.writeText!('f.txt', `f ${encodeURIComponent(secret)}`)
        expect(seen).toEqual({ out: `o ${MASK}\n`, err: `e ${MASK}\n`, 'f.txt': `f ${MASK}` })
    })

    it('what a scrub produces holds none of the forms again, and scrubbing it twice changes nothing (property)', () => {
        const alphabet = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 "\\/+=.-_:;,?&%é日'.split(''))
        fc.assert(fc.property(
            fc.string({ unit: alphabet, minLength: MIN_SECRET_LENGTH, maxLength: 24 }),
            fc.string({ unit: alphabet, maxLength: 30 }), fc.string({ unit: alphabet, maxLength: 30 }),
            (secret, before, after) => {
                const registry = new SecretRegistry()
                expect(registry.register(secret)).toBe(true)
                for (const encode of Object.values(CLAIMED)) {
                    const form = encode(secret)
                    const out = registry.scrub(`${before}|${form}|${after}`)
                    // the separators keep the neighbours from forming a new copy; the lone secret survives only if it was already part of `before`/`after`
                    const unchanged = `${before}|${after}`
                    if (!unchanged.includes(secret) && !unchanged.includes(form)) expect(out).not.toContain(form)
                    expect(registry.scrub(out)).toBe(out)
                }
            },
        ), { numRuns: 300 })
    })
})

describe('E2: short, empty and overlapping secrets', () => {
    it('a value under 4 characters is refused (false) and changes nothing; exactly 4 is registered', () => {
        const registry = new SecretRegistry()
        for (const short of ['a', 'ab', 'abc', '😀']) expect(registry.register(short), short).toBe(false)
        expect(registry.size).toBe(0)
        expect(registry.scrub('a ab abc 😀 text')).toBe('a ab abc 😀 text')
        expect(registry.register('abcd')).toBe(true)
        expect(registry.scrub('xabcdx')).toBe(`x${MASK}x`)
    })

    it('"4 characters" counts UTF-16 units: two emoji are registered, one is not', () => {
        const registry = new SecretRegistry()
        expect(registry.register('😀')).toBe(false)
        expect(registry.register('😀😀')).toBe(true)
        expect(registry.scrub('a 😀😀 b')).toBe(`a ${MASK} b`)
    })

    it('undefined and the empty string are "nothing to register": true, and nothing is replaced', () => {
        const registry = new SecretRegistry()
        expect(registry.register(undefined)).toBe(true)
        expect(registry.register('')).toBe(true)
        expect(registry.size).toBe(0)
        expect(registry.scrub('some text')).toBe('some text')
    })

    it('the CLI warns (stderr, no value) when an environment secret is too short, and says it cannot be scrubbed', async () => {
        const short = 'xyz'
        let out = ''; let err = ''
        const io: CliIo = { out: (t) => { out += t }, err: (t) => { err += t }, env: { SHORT: short } }
        // nothing listens on port 1: the warning is printed while the request is being prepared, before any connection
        await main(['probe', 'http://127.0.0.1:1/x', '--auth-env', 'SHORT', '--duration', '2'], io)
        expect(err).toMatch(/warning: the value of SHORT is shorter than 4 characters and cannot be scrubbed from output reliably/)
        expect(err).not.toContain(short + '\n')
        expect(out + err).not.toMatch(/Bearer xyz/)
    }, 30_000)

    it('the same value that is too short is NOT scrubbed from output (documented limit): it is the warning that protects the user', () => {
        const registry = new SecretRegistry()
        expect(registry.register('xyz')).toBe(false)
        expect(registry.scrub('the server echoed xyz back')).toBe('the server echoed xyz back')
    })

    it('a secret that contains another is replaced whole, whatever the order of registration', () => {
        for (const order of [['abcd-1234', 'abcd-1234-extra'], ['abcd-1234-extra', 'abcd-1234']]) {
            const registry = registryWith(...order)
            expect(registry.scrub('x abcd-1234-extra y abcd-1234 z'), order.join(' then ')).toBe(`x ${MASK} y ${MASK} z`)
        }
    })

    it('the same secret registered twice is one set of forms', () => {
        const registry = registryWith('abcd-1234')
        const size = registry.size
        registry.register('abcd-1234')
        expect(registry.size).toBe(size)
    })

    it('a secret that is itself part of the mask does not loop or crash, and does not survive', () => {
        const registry = registryWith('abcd-1234', 'DACT')
        const out = registry.scrub('a abcd-1234 b DACT c')
        expect(out).not.toContain('abcd-1234')
        expect(out).not.toMatch(/(^|[^\[R-Z])DACT(?!ED)/)
    })

    it('a secret that is only a fragment of a longer secret leaves the rest of the longer one masked too', () => {
        // longest first: the whole value goes before its part is looked for
        const registry = registryWith('part', 'part-of-a-longer-secret')
        expect(registry.scrub('see part-of-a-longer-secret and part')).toBe(`see ${MASK} and ${MASK}`)
    })
})


// ---------------------------------------------------------------------------------------------------------------------------------------------
// Forms added after the first campaign. They were the known gaps; each had a test that pinned the leak and an `it.fails` for the wanted behaviour,
// and both were replaced by what is below. For every form: (1) it is scrubbed, alone, several times in one text and in three carriers; (2) text that
// only resembles it (a hash, a lone `+`, `\/`, `&amp;`, `%2520`, a base64 string that is not the secret) is NOT altered. The registry still has its
// 4-character minimum; a short value is refused as before.
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** `\uXXXX` for each non-ASCII UTF-16 unit, as Python `json.dumps` and PHP write it (an astral character becomes a surrogate pair). */
const asciiEscaped = (s: string, digits: (h: string) => string = (h) => h) => s.replace(/[^\x00-\x7f]/g, (c) => '\\u' + digits(c.charCodeAt(0).toString(16).padStart(4, '0')))
/** PHP's `\/`. */
const phpSlash = (s: string) => s.replace(/\//g, '\\/')
/** Go's json.Marshal: < > & as \u003c \u003e \u0026. */
const goEscaped = (s: string) => s.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
const htmlEscaped = (s: string, apostrophe = '&#39;') => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, apostrophe)
/** Python `urllib.parse.quote`: everything but letters, digits and `-_.` is %XX (a space is %20), the six characters encodeURIComponent keeps included. */
const strictPercent = (s: string) => encodeURIComponent(s).replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
const lowerPercent = (s: string) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())
const SHA256 = '3b4f9c1d2e7a8b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c'
const SEPARATOR = String.fromCharCode(0x2028)

interface Closed { name: string; secret: string; form: (s: string) => string; why: string; unrelated: string[] }
const CLOSED: Closed[] = [
    { name: 'hex (lower-case)', secret: 'plain-secret-value-123', form: hex, why: 'a server or log line that prints the bytes as hex (a hash-style dump, a Go %x)',
      unrelated: [SHA256, '123e4567-e89b-12d3-a456-426614174000', 'deadbeef 0xcafe', hex('plain-secret-value-124'), `0x${'ab'.repeat(24)}`] },
    { name: 'hex (upper-case)', secret: 'plain-secret-value-123', form: (s) => hex(s).toUpperCase(), why: 'the same, in upper case (%X)',
      unrelated: [SHA256.toUpperCase(), hex('plain-secret-value-124').toUpperCase(), 'DEADBEEF 0xCAFE'] },
    { name: 'hex of a non-ASCII value (the bytes are UTF-8)', secret: 'héllo-wörld-key', form: hex, why: 'hex is of the UTF-8 bytes, not of the UTF-16 units',
      unrelated: [hex('hello-world-key'), SHA256] },
    { name: 'form-encoded: space as "+"', secret: 'secret with spaces 99', form: formEncoded, why: 'URLSearchParams, HTML forms and Python urlencode write a space as + (encodeURIComponent writes %20)',
      unrelated: ['secret+with+spaces+98', 'secret+with', '1+1=2 and a+b+c', 'secret with spaces 98'] },
    { name: 'form-encoded: ! \' ( ) * ~ as %XX (URLSearchParams leaves * plain)', secret: "tok!en(x)*'~value", form: formEncoded, why: 'URLSearchParams percent-encodes !\'()~ that encodeURIComponent leaves alone',
      unrelated: ["tok%21en%28y%29*%27%7Evalue", "tok!en(y)*'~value"] },
    { name: 'percent-encoded with every one of ! \' ( ) * ~ as %XX (Python quote, Go QueryEscape, PHP urlencode)', secret: "tok!en(x)*'~value", form: strictPercent, why: 'encoders that leave none of the six plain',
      unrelated: ['tok%21en%28y%29%2A%27%7Evalue', '%21%27%28%29%2A%7E'] },
    { name: 'form-encoded with a space as "+" and every ! \' ( ) * ~ as %XX (Python quote_plus)', secret: "my tok!en(x)*'~value", form: (s) => strictPercent(s).replace(/%20/g, '+'), why: 'quote_plus',
      unrelated: ['my+tok%21en%28y%29%2A%27%7Evalue'] },
    { name: 'form-encoded in lower-case hex', secret: 'a/b c+d!e (f)', form: (s) => lowerPercent(formEncoded(s)), why: 'a server that writes %2f',
      unrelated: ['a%2fb+c%2bd%21e+%28g%29'] },
    { name: 'JSON with \\uXXXX escapes for non-ASCII (ensure_ascii, Python json.dumps)', secret: 'héllo-wörld-key', form: (s) => asciiEscaped(s), why: 'JSON.stringify leaves é raw, so the registry held only that form',
      unrelated: ['h\\u00e9llo-w\\u00f6rld-kez', '\\u00e9\\u00f6 and caf\\u00e9'] },
    { name: 'JSON with \\uXXXX escapes written in upper case', secret: 'héllo-wörld-key', form: (s) => asciiEscaped(s, (h) => h.toUpperCase()), why: 'JSON allows either case',
      unrelated: ['h\\u00E9llo-w\\u00F6rld-kez'] },
    { name: 'JSON with surrogate-pair escapes for an astral character', secret: 'smile-😀-secret', form: (s) => asciiEscaped(s), why: 'Python and PHP escape U+1F600 as \\ud83d\\ude00',
      unrelated: ['\\ud83d\\ude00', 'smile-\\ud83d\\ude01-secret'] },
    { name: 'JSON with an escaped slash (PHP json_encode, \\/)', secret: 'path/like/secret-key', form: phpSlash, why: 'PHP escapes / as \\/ by default',
      unrelated: ['http:\\/\\/example.com\\/path', 'path\\/like\\/other-key'] },
    { name: 'JSON as PHP json_encode writes it by default (escaped slash and \\uXXXX)', secret: 'päth/like/sécret-key', form: (s) => phpSlash(asciiEscaped(s)), why: 'both escapes at once',
      unrelated: ['p\\u00e4th\\/like\\/s\\u00e9cret-kez'] },
    { name: 'JSON with HTML-safe escapes (Go json.Marshal: < > & as \\u003c \\u003e \\u0026)', secret: 'a<b>&c-secret-key', form: goEscaped, why: 'Go escapes < > & inside JSON strings',
      unrelated: ['x\\u003cy\\u003e\\u0026z', 'a\\u003cb\\u003e\\u0026c-other-key'] },
    { name: 'JSON with Go\'s escapes for the line and paragraph separators', secret: `line${SEPARATOR}sep-secret`, form: (s) => s.replace(SEPARATOR, '\\u2028'), why: 'Go escapes U+2028 and U+2029',
      unrelated: ['line\\u2028sep-other'] },
    { name: 'HTML-entity encoded (&amp; &quot; &lt;)', secret: 'a&b"c<d-secret', form: (s) => htmlEscaped(s), why: 'an HTML error page that echoes the request',
      unrelated: ['<p>Fish &amp; chips &quot;with&quot; &lt;b&gt;</p>', 'a&amp;b&quot;c&lt;d-other'] },
    { name: 'HTML with only the ampersand escaped (an attribute value)', secret: 'a&b"c<d-secret', form: (s) => s.replace(/&/g, '&amp;'), why: 'href="?a=1&amp;b=2"',
      unrelated: ['a&amp;b"c<d-other'] },
    ...['&#39;', '&#x27;', '&#039;', '&apos;'].map((apostrophe): Closed => ({
        name: `HTML with the apostrophe written ${apostrophe}`, secret: 'it\'s <a> & "b" secret', form: (s) => htmlEscaped(s, apostrophe), why: 'escapers spell the apostrophe four ways',
        unrelated: [`it${apostrophe}s &lt;a&gt; &amp; &quot;b&quot; other`],
    })),
    { name: 'percent-encoded twice (a redirect that re-encodes the query)', secret: 'pa"ss word+1', form: (s) => encodeURIComponent(encodeURIComponent(s)), why: 'a gateway that re-encodes the target it forwards',
      unrelated: ['%2520', 'pa%2522ss%2520word%252B2', '100%25'] },
    { name: 'percent-encoded twice, in lower-case hex', secret: 'pa"ss word+1', form: (s) => encodeURIComponent(lowerPercent(encodeURIComponent(s))), why: 'the same with %22 written %22 and a re-encoded %2b',
      unrelated: ['pa%2522ss%2520word%252b2'] },
    { name: 'form-encoded, then percent-encoded (+ becomes %2B)', secret: 'secret with spaces 99', form: (s) => encodeURIComponent(formEncoded(s)), why: 'a gateway that re-encodes a form-encoded query',
      unrelated: ['secret%2Bwith%2Bspaces%2B98'] },
]

describe('E2: forms the first campaign found unclaimed, now scrubbed', () => {
    for (const closed of CLOSED) {
        describe(closed.name, () => {
            const claimedForms = (s: string) => Object.values(CLAIMED).map((encode) => encode(s))
            const text = (form: string) => `before ${form} after`

            it(`is scrubbed, alone, repeated, and in a JSON body, a query string and a header line (${closed.why})`, () => {
                const form = closed.form(closed.secret)
                // set-up: the form is real text, differs from the secret and from every form the first campaign claimed, so this test cannot pass by an old rule
                expect(form.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH)
                expect(form).not.toBe(closed.secret)
                expect(claimedForms(closed.secret)).not.toContain(form)
                const registry = registryWith(closed.secret)
                expect(registry.scrub(text(closed.secret))).toBe(`before ${MASK} after`)
                expect(registry.scrub(text(form))).toBe(`before ${MASK} after`)
                expect(registry.scrub(`${form}|${closed.secret}|${form}`)).toBe(`${MASK}|${MASK}|${MASK}`)
                for (const carrier of [`{"error":"bad credential ${form}","retry":false}`, `GET /stream?token=${form}&x=1 HTTP/1.1`, `X-Debug: ${form}`]) {
                    expect(registry.scrub(carrier)).toBe(carrier.replace(form, MASK))
                }
            })

            it('healthy path: text that only resembles the encoding is not altered', () => {
                const registry = registryWith(closed.secret)
                expect(closed.unrelated.length).toBeGreaterThan(0)
                for (const unrelated of closed.unrelated) {
                    expect(unrelated, 'set-up: the text is not itself a form of the secret').not.toContain(closed.form(closed.secret))
                    expect(registry.scrub(unrelated), unrelated).toBe(unrelated)
                }
            })
        })
    }

    it('a value that does not hold the character gets no form for it: an ordinary token has few forms, the worst value a bounded number', () => {
        const ordinary = new SecretRegistry()
        ordinary.register('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
        expect(ordinary.size).toBeLessThanOrEqual(12)
        const worst = new SecretRegistry()
        worst.register(`a b/c é😀 ${SEPARATOR}<>&"'!()*~+%=`)
        expect(worst.size).toBeLessThanOrEqual(200)
        // and the registry does not grow per write or per scrub
        const before = worst.size
        worst.scrub('x'.repeat(1000))
        expect(worst.size).toBe(before)
    })

    it('hex of a 4-character secret (the registry minimum) is scrubbed; the hex of a 3-character value is not a form of anything', () => {
        const registry = registryWith('abcd')
        expect(registry.scrub('x 61626364 y 61626364 z')).toBe(`x ${MASK} y ${MASK} z`)
        const short = new SecretRegistry()
        expect(short.register('abc')).toBe(false)
        expect(short.scrub('616263')).toBe('616263')
    })

    it('hex is matched as the bytes of the value, so unrelated hex (hashes, ids, a different value) is never altered (property)', () => {
        const registry = registryWith('plain-secret-value-123', 'abcd', 'héllo-wörld-key')
        const hexDigit = fc.constantFrom(...'0123456789abcdefABCDEF'.split(''))
        fc.assert(fc.property(fc.string({ unit: hexDigit, minLength: 0, maxLength: 200 }), (digits) => {
            expect(registry.scrub(digits)).toBe(digits)
        }), { numRuns: 300 })
    })

    it('every new form of a random secret is scrubbed, and a scrubbed text is scrubbed again to itself (property)', () => {
        const alphabet = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 "\\/+=.-_:;,?&%é日<>!\'()*~'.split(''))
        const encoders: Array<(s: string) => string> = [
            hex, (s) => hex(s).toUpperCase(), formEncoded, strictPercent, (s) => strictPercent(s).replace(/%20/g, '+'),
            (s) => asciiEscaped(jsonEscaped(s)), (s) => phpSlash(asciiEscaped(jsonEscaped(s))), (s) => goEscaped(jsonEscaped(s)), (s) => htmlEscaped(s),
            (s) => encodeURIComponent(encodeURIComponent(s)), (s) => encodeURIComponent(formEncoded(s)),
        ]
        fc.assert(fc.property(
            fc.string({ unit: alphabet, minLength: MIN_SECRET_LENGTH, maxLength: 20 }), fc.string({ unit: alphabet, maxLength: 20 }), fc.string({ unit: alphabet, maxLength: 20 }),
            (secret, before, after) => {
                const registry = new SecretRegistry()
                expect(registry.register(secret)).toBe(true)
                for (const encode of encoders) {
                    const form = encode(secret)
                    const out = registry.scrub(`${before}|${form}|${after}`)
                    const unchanged = `${before}|${after}`
                    if (!unchanged.includes(secret) && !unchanged.includes(form)) expect(out).not.toContain(form)
                    expect(registry.scrub(out)).toBe(out)
                }
            },
        ), { numRuns: 400 })
    })

    it('the lab captures, the v1 samples and a battery of secrets: nothing in a real capture is altered by any new form', () => {
        const dirs = [new URL('../../../public/lab/', import.meta.url), new URL('../../core/capture/__tests__/v1Samples/', import.meta.url)]
        const files = dirs.flatMap((dir) => readdirSync(dir).map((name) => new URL(name, dir)))
        expect(files.length).toBeGreaterThan(30)
        const registry = registryWith('ghp_x7Kq92LmNpR4sTuV', 'hunter2!', 'Bearer tok_9f8e7d6c5b4a', 'pa"ss\\word/with+odd=chars', 'Zq9#', 'héllo wörld 😀 key', 'user:basic-auth-password-1')
        for (const file of files) {
            const content = readFileSync(file, 'utf8')
            expect(content.length).toBeGreaterThan(0)
            expect(registry.scrub(content), String(file)).toBe(content)
        }
    })
})

describe('E2: a secret inside a larger base64 value (base64 is not position-independent)', () => {
    const secret = 'basic-auth-password-1'

    it('base64 of "user:secret" (a Basic header built by hand): only the characters that hold the secret go; the ones shared with "user:" stay', () => {
        const registry = registryWith(secret)
        // "user:" is 5 bytes, so the secret starts 2 bytes into a group: "dXNl" "cjp" are the prefix (the third character already carries 2 bits of the secret's first byte, so it stays)
        expect(registry.scrub(`before ${b64(`user:${secret}`)} after`)).toBe(`before dXNlcjp${MASK}= after`)
        expect(registry.scrub(`Authorization: Basic ${b64url(`user:${secret}`)}`)).toBe(`Authorization: Basic dXNlcjp${MASK}`)
    })

    it('base64 of the secret with a byte before and a byte after: the last two characters carry the byte after, so they stay', () => {
        const registry = registryWith('embedded-secret-value')
        expect(registry.scrub(`before ${b64('xembedded-secret-valuey')} after`)).toBe(`before eG${MASK}Xk= after`)
    })

    it('at each of the three alignments, with and without something after it, in base64 and base64url, an independent bit-position oracle agrees (property)', () => {
        const printable = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:@#'.split(''))
        const letters = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))
        fc.assert(fc.property(
            fc.string({ unit: printable, minLength: 8, maxLength: 30 }),
            fc.string({ unit: letters, maxLength: 8 }), fc.string({ unit: letters, maxLength: 8 }), fc.boolean(),
            (secretValue, prefix, suffix, urlSafe) => {
                const registry = new SecretRegistry()
                expect(registry.register(secretValue)).toBe(true)
                const text = urlSafe ? b64url(prefix + secretValue + suffix) : b64(prefix + secretValue + suffix)
                // character i of base64 holds bits 6i .. 6i+5 of the bytes; it belongs to the secret alone when those bits are inside the secret's bytes
                const start = prefix.length
                const end = start + secretValue.length
                const first = Math.ceil((8 * start) / 6)
                const last = Math.floor((8 * end) / 6) - 1
                const unpaddedLength = text.replace(/=+$/, '').length
                let expected: string
                if (suffix === '') expected = start % 3 === 0 ? text.slice(0, first) + MASK : text.slice(0, first) + MASK + text.slice(unpaddedLength) // the padded form of an aligned value is a form of its own
                else expected = text.slice(0, first) + MASK + text.slice(last + 1)
                expect(registry.scrub(text)).toBe(expected)
            },
        ), { numRuns: 400 })
    })

    it('healthy path: base64 that does not hold the secret is not altered (a JWT, a hash, 64 KB of arbitrary bytes), for several secrets (property)', () => {
        const registry = registryWith(secret, 'embedded-secret-value', 'ghp_x7Kq92LmNpR4sTuV', 'abcdefg', 'user:basic-auth-password-1')
        expect(registry.scrub('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
        expect(registry.scrub(b64(SHA256))).toBe(b64(SHA256))
        fc.assert(fc.property(fc.uint8Array({ minLength: 0, maxLength: 4096 }), fc.boolean(), (bytes, urlSafe) => {
            const text = Buffer.from(bytes).toString('base64')
            const written = urlSafe ? text.replace(/\+/g, '-').replace(/\//g, '_') : text
            expect(registry.scrub(written)).toBe(written)
        }), { numRuns: 200 })
        let blob = ''
        let state = 12345
        for (let i = 0; i < 65_536; i++) { state = (state * 1103515245 + 12345) & 0x7fffffff; blob += String.fromCharCode(state >> 16 & 0xff) }
        const big = Buffer.from(blob, 'latin1').toString('base64')
        expect(registry.scrub(big)).toBe(big)
    })

    it('a value of 7 bytes or more is found at all three alignments; fewer is only found at its own (the fragment must be 8 characters)', () => {
        const registry = registryWith('abcdefg')
        for (const prefix of ['', 'x', 'xy']) for (const suffix of ['', 'Z']) {
            const text = b64(`${prefix}abcdefg${suffix}`)
            expect(registry.scrub(text), `${prefix}|${suffix}`).toContain(MASK)
        }
    })
})

describe('E2: two secrets that overlap without one containing the other', () => {
    const a = 'secret-AAAA'
    const b = 'AAAA-tail99'

    it('the text covered by either goes, and so does the rest of the other: one mask for the joined span', () => {
        const registry = registryWith(a, b)
        expect(registry.scrub('secret-AAAA-tail99')).toBe(MASK)
        expect(registry.scrub('x secret-AAAA-tail99 y')).toBe(`x ${MASK} y`)
        expect(registry.scrub(`only ${a}`)).toBe(`only ${MASK}`)
        expect(registry.scrub(`only ${b}`)).toBe(`only ${MASK}`)
        expect(registry.scrub(`${a} and ${b} and secret-AAAA-tail99`)).toBe(`${MASK} and ${MASK} and ${MASK}`)
        expect(registryWith(b, a).scrub('secret-AAAA-tail99')).toBe(MASK)
    })

    it('a chain of three, each overlapping the next, is one span', () => {
        const registry = registryWith('aaaa-bbbb', 'bbbb-cccc', 'cccc-dddd')
        expect(registry.scrub('<aaaa-bbbb-cccc-dddd>')).toBe(`<${MASK}>`)
    })

    it('the same form overlapping itself is one span, not a mask and a leftover', () => {
        const registry = registryWith('aaaa')
        expect(registry.scrub('xaaaaaax')).toBe(`x${MASK}x`)
    })

    it('secrets that touch without overlapping keep one mask each, as before', () => {
        const registry = registryWith('abcd-1234', '5678-wxyz')
        expect(registry.scrub('abcd-12345678-wxyz')).toBe(`${MASK}${MASK}`)
        expect(registry.scrub('abcd-1234 5678-wxyz')).toBe(`${MASK} ${MASK}`)
    })

    it('a mask is never scanned again: a secret that is a piece of the mask does not cut into it', () => {
        const registry = registryWith('abcd-1234', 'DACT')
        expect(registry.scrub('a abcd-1234 b DACT c')).toBe(`a ${MASK} b ${MASK} c`)
    })
})

describe('E2: a secret split over two writes', () => {
    const secret = 'split-secret-value-4711'
    const drive = (...secrets: string[]) => {
        const seen: string[] = []
        const seenErr: string[] = []
        const io = scrubbedIo({ out: (t) => { seen.push(t) }, err: (t) => { seenErr.push(t) } }, registryWith(...(secrets.length > 0 ? secrets : [secret])))
        return { io, seen, seenErr }
    }

    it('cut at every position, the joined output holds no secret and says what a single write says', () => {
        for (let cut = 1; cut < secret.length; cut++) {
            const { io, seen } = drive()
            io.out(`x ${secret.slice(0, cut)}`)
            io.out(`${secret.slice(cut)} y`)
            io.flush()
            expect(seen.join(''), `cut at ${cut}`).toBe(`x ${MASK} y`)
        }
    })

    it('the first piece is written as far as it is safe: only the part that could be the start of the secret waits', () => {
        const { io, seen } = drive()
        io.out('line one\nx split-sec')
        expect(seen).toEqual(['line one\nx '])
        io.out('ret-value-4711\n')
        expect(seen.join('')).toBe(`line one\nx ${MASK}\n`)
    })

    it('three pieces, and a base64 form split across two writes, are joined too', () => {
        const three = drive()
        for (const piece of ['a spl', 'it-secret-val', 'ue-4711 b']) three.io.out(piece)
        three.io.flush()
        expect(three.seen.join('')).toBe(`a ${MASK} b`)
        const encoded = drive()
        const form = b64(secret)
        encoded.io.out(`token=${form.slice(0, 11)}`)
        encoded.io.out(`${form.slice(11)}&x=1`)
        encoded.io.flush()
        expect(encoded.seen.join('')).toBe(`token=${MASK}&x=1`)
    })

    it('a secret split between a match and a longer secret is not half-written: the match waits for the next piece', () => {
        const { io, seen } = drive('secret-AAAA', 'AAAA-tail99')
        io.out('x secret-AAAA')
        expect(seen).toEqual(['x ']) // "AAAA" could still become "AAAA-tail99"
        io.out('-tail99 y')
        expect(seen.join('')).toBe(`x ${MASK} y`)
    })

    it('healthy path: a write that does not end in the start of a secret goes out at once; one that does is not changed, only held until the next write or flush', () => {
        const { io, seen } = drive()
        io.out('hello\n')
        io.out('world, split')
        io.out('\n')
        expect(seen).toEqual(['hello\n', 'world, ', 'split\n'])
        io.out('trailing spl')
        expect(seen).toEqual(['hello\n', 'world, ', 'split\n', 'trailing '])
        io.flush()
        expect(seen.join('')).toBe('hello\nworld, split\ntrailing spl')
        io.flush() // nothing is written twice
        expect(seen.join('')).toBe('hello\nworld, split\ntrailing spl')
    })

    it('an empty write is still a write, and nothing is lost when no secret is registered', () => {
        const none: string[] = []
        const plain = scrubbedIo({ out: (t) => { none.push(t) }, err: () => undefined }, new SecretRegistry())
        plain.out(''); plain.out('abc'); plain.flush()
        expect(none).toEqual(['', 'abc'])
    })

    it('standard output and standard error are separate: a half on each is not joined', () => {
        const { io, seen, seenErr } = drive()
        io.out('split-sec')
        io.err('ret-value-4711')
        io.flush()
        expect(seen.join('')).toBe('split-sec')
        expect(seenErr.join('')).toBe('ret-value-4711')
    })

    it('what is held at the end is written by flush, scrubbed, and a half that never completes is written as it is (the same as a truncated value in one write)', () => {
        const { io, seen } = drive()
        io.out(`x ${secret}`)
        io.flush()
        expect(seen.join('')).toBe(`x ${MASK}`)
        const half = drive()
        half.io.out('x split-sec')
        half.io.flush()
        expect(half.seen.join('')).toBe('x split-sec')
    })

    it('main() flushes: nothing a command wrote is lost when the last write ends where a secret could start', async () => {
        // A value that begins with a newline: every output ends in "\n", the start of this secret, so the end of every write is held until the command is done.
        const run = async (value: string) => {
            let out = ''; let err = ''
            const io: CliIo = { out: (t) => { out += t }, err: (t) => { err += t }, env: { TOK: value } }
            const code = await main(['probe', 'http://127.0.0.1:1/x', '--auth-env', 'TOK', '--duration', '2'], io)
            return { out, err, code }
        }
        const held = await run('\nzzzzzzzz')
        const control = await run('zzzzzzzz')
        expect(control.out.endsWith('\n')).toBe(true)
        expect(held.out.endsWith('\n')).toBe(true) // the last "\n" is what was held
        expect(held.out).toBe(control.out)
        expect(held.err).toBe(control.err)
        expect(held.code).toBe(control.code)
    }, 60_000)

    it('whatever the cuts, the pieces written one by one say what the whole text says (property, secrets chosen to overlap and to repeat)', () => {
        const alphabet = fc.constantFrom('a', 'b', '-', 'c')
        fc.assert(fc.property(
            fc.array(fc.string({ unit: alphabet, minLength: 4, maxLength: 6 }), { minLength: 1, maxLength: 3 }),
            fc.string({ unit: alphabet, maxLength: 40 }),
            fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 6 }),
            (secrets, whole, rawCuts) => {
                const registry = new SecretRegistry()
                for (const s of secrets) registry.register(s)
                const cuts = [...new Set(rawCuts.map((c) => Math.min(c, whole.length)))].sort((a, b) => a - b)
                const pieces = cuts.map((c, i) => whole.slice(i === 0 ? 0 : cuts[i - 1]!, c)).concat(whole.slice(cuts.length === 0 ? 0 : cuts[cuts.length - 1]!))
                expect(pieces.join('')).toBe(whole)
                const written: string[] = []
                const io = scrubbedIo({ out: (t) => { written.push(t) }, err: () => undefined }, registry)
                for (const piece of pieces) io.out(piece)
                io.flush()
                expect(written.join('')).toBe(registry.scrub(whole))
            },
        ), { numRuns: 600 })
    })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Still not covered. These are statements of the limit, not promises: each registers the secret, shows the plain value IS scrubbed (the set-up is
// sound), and shows the form survives. Closing one flips its test on purpose. docs/guide/cli.md ("What the scrub covers, and what it does not") says the same.
// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('E2: limits that remain', () => {
    const pin = (name: string, secret: string, form: (s: string) => string) => it(`pin: ${name} is not scrubbed`, () => {
        const registry = registryWith(secret)
        expect(registry.scrub(`before ${secret} after`)).toBe(`before ${MASK} after`)
        const text = `before ${form(secret)} after`
        expect(registry.scrub(text)).toBe(text)
    })
    pin('percent-encoded three times', 'pa"ss word+1', (s) => encodeURIComponent(encodeURIComponent(encodeURIComponent(s))))
    pin('hexadecimal with separators', 'plain-secret-value-123', (s) => hex(s).replace(/(..)(?=.)/g, '$1:'))
    pin('numeric HTML entities for ordinary characters', 'plain-secret-value-123', (s) => [...s].map((c) => `&#${c.charCodeAt(0)};`).join(''))
    pin('base64 wrapped over lines (MIME, 76 columns)', 'basic-auth-password-1', (s) => b64(`user:${s}`.repeat(4)).replace(/(.{20})/g, '$1\n'))
    pin('base64 of a secret too short to give an 8-character fragment (5 bytes) inside a larger value', 'abcde', (s) => b64(`user:${s}`))
    pin('hexadecimal of the base64 of the secret (two encodings chained)', 'plain-secret-value-123', (s) => hex(b64(s)))
})
