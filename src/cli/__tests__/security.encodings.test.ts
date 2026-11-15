// @vitest-environment node
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { main, type CliIo } from '../index'
import { MIN_SECRET_LENGTH, SecretRegistry, scrubbedIo } from '../secretRegistry'

// Campaign E2, the forms in which a secret can come back. Every secret the CLI resolves is registered once, and every sink (stdout, stderr, files)
// is scrubbed by value. The registry claims a fixed list of encodings (secretRegistry.ts: raw, percent-encoded in both cases, base64 padded and
// unpadded, base64url, JSON-escaped, and the value behind `Bearer`). This file does two things:
//   1. every claimed form is scrubbed, for several secrets, in realistic carriers (a JSON body, a query string, a header line);
//   2. every form the registry does NOT claim is written down as an executable statement: a normal test that pins the leak and proves the set-up
//      is sound (it runs the real call, so a typo cannot hide), and an `it.fails` test that holds the behaviour we would want. When a gap is closed
//      both flip, deliberately, and this file says so by failing.
// The gaps are listed in the campaign report and belong in docs/guide/cli.md ("Secrets").

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
// Known gaps. Each case: `pin` (a normal test) registers the secret, runs the real scrub, checks the registry did register it and that the plain
// value IS scrubbed (so the set-up is sound and the function ran without throwing), and states that today the form survives. `wanted` is
// `it.fails`: it holds what we want. A fix flips both: `pin` fails (update it) and `wanted` fails ("expected to fail but passed").
// ---------------------------------------------------------------------------------------------------------------------------------------------
interface Gap { name: string; secret: string; form: (s: string) => string; why: string }
const GAPS: Gap[] = [
    { name: 'hex (lower-case)', secret: 'plain-secret-value-123', form: hex, why: 'a server or log line that prints the bytes as hex (a hash-style dump, a Go %x)' },
    { name: 'hex (upper-case)', secret: 'plain-secret-value-123', form: (s) => hex(s).toUpperCase(), why: 'the same, in upper case (%X)' },
    { name: 'form-encoded: space as "+"', secret: 'secret with spaces 99', form: formEncoded, why: 'URLSearchParams, HTML forms and Python urlencode write a space as + (encodeURIComponent writes %20)' },
    { name: 'form-encoded: ! \' ( ) * ~ as %XX', secret: "tok!en(x)*'~value", form: formEncoded, why: 'URLSearchParams percent-encodes !\'()*~ that encodeURIComponent leaves alone' },
    { name: 'JSON with \\uXXXX escapes for non-ASCII (ensure_ascii, Python json.dumps)', secret: 'héllo-wörld-key', form: (s) => s.replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')), why: 'JSON.stringify leaves é raw, so the registry holds only that form' },
    { name: 'JSON with surrogate-pair escapes for an astral character', secret: 'smile-😀-secret', form: (s) => s.replace(/[^\x00-\x7f]/gu, (c) => [...c].map((ch) => ch.codePointAt(0)! > 0xffff ? '\\u' + ((ch.codePointAt(0)! - 0x10000 >> 10) + 0xd800).toString(16) + '\\u' + ((ch.codePointAt(0)! - 0x10000 & 0x3ff) + 0xdc00).toString(16) : ch).join('')), why: 'Python and PHP escape U+1F600 as \\ud83d\\ude00' },
    { name: 'JSON with an escaped slash (PHP json_encode, \\/)', secret: 'path/like/secret-key', form: (s) => s.replace(/\//g, '\\/'), why: 'PHP escapes / as \\/ by default' },
    { name: 'JSON with HTML-safe escapes (Go json.Marshal: < > & as \\u003c \\u003e \\u0026)', secret: 'a<b>&c-secret-key', form: (s) => s.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'), why: 'Go escapes < > & inside JSON strings' },
    { name: 'HTML-entity encoded (&amp; &quot; &lt;)', secret: 'a&b"c<d-secret', form: (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'), why: 'an HTML error page that echoes the request' },
    { name: 'percent-encoded twice (a redirect that re-encodes the query)', secret: 'pa"ss word+1', form: (s) => encodeURIComponent(encodeURIComponent(s)), why: 'a gateway that re-encodes the target it forwards' },
    { name: 'base64 of "user:secret" (Basic auth built by the caller, not by --auth-env)', secret: 'basic-auth-password-1', form: (s) => b64(`user:${s}`), why: 'the secret sits at an unaligned offset inside a larger base64 value, so its own base64 is not a substring' },
    { name: 'base64 of the secret inside a larger base64 value at offset 1', secret: 'embedded-secret-value', form: (s) => b64(`x${s}y`), why: 'same: base64 is not position-independent' },
]

describe('E2: known gaps, forms the registry does not claim', () => {
    for (const gap of GAPS) {
        describe(gap.name, () => {
            const claimedForms = (s: string) => Object.values(CLAIMED).map((encode) => encode(s))
            const text = (form: string) => `before ${form} after`

            it(`pin: the form is real text, different from every claimed form, and today it survives (${gap.why})`, () => {
                const form = gap.form(gap.secret)
                expect(form.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH)
                expect(claimedForms(gap.secret), 'the case would not be a gap if the registry already claimed this form').not.toContain(form)
                const registry = registryWith(gap.secret)
                // the set-up is sound: the raw secret, which is claimed, is scrubbed by this very registry
                expect(registry.scrub(text(gap.secret))).toBe(`before ${MASK} after`)
                // and the unclaimed form is still readable in the output
                expect(registry.scrub(text(form))).toContain(form)
            })

            // KNOWN GAP (see the report and docs/guide/cli.md "Secrets"): a server that echoes the secret in this form defeats the scrubber.
            it.fails('wanted: the form is scrubbed', () => {
                const form = gap.form(gap.secret)
                const registry = registryWith(gap.secret)
                expect(registry.scrub(text(form))).not.toContain(form)
            })
        })
    }

    describe('a secret split over two writes', () => {
        const secret = 'split-secret-value-4711'
        const half = Math.floor(secret.length / 2)
        const parts = [secret.slice(0, half), secret.slice(half)]
        const drive = () => {
            const seen: string[] = []
            const io = scrubbedIo({ out: (t) => { seen.push(t) }, err: () => undefined }, registryWith(secret))
            return { io, seen }
        }

        it('pin: each write is scrubbed on its own, so a value written whole is caught and a value written in two halves is not', () => {
            const whole = drive()
            whole.io.out(`x ${secret} y`)
            expect(whole.seen.join('')).toBe(`x ${MASK} y`)
            const split = drive()
            for (const p of parts) split.io.out(p)
            expect(parts[0]!.length).toBeGreaterThan(MIN_SECRET_LENGTH)
            expect(split.seen.join('')).toBe(secret) // today: the halves are written as they are
        })

        // KNOWN GAP: `scrubbedIo` has no memory between calls. Today no command writes a value in pieces, so this is a hazard, not a leak.
        it.fails('wanted: the joined output holds no secret', () => {
            const split = drive()
            for (const p of parts) split.io.out(p)
            expect(split.seen.join('')).not.toContain(secret)
        })
    })

    describe('overlapping secrets (neither contains the other)', () => {
        const a = 'secret-AAAA'
        const b = 'AAAA-tail99'
        it('pin: the text covered by the longer one goes, the rest of the other stays', () => {
            const registry = registryWith(a, b)
            expect(registry.scrub('secret-AAAA-tail99')).toBe(`${MASK}-tail99`)
            expect(registry.scrub(`only ${a}`)).toBe(`only ${MASK}`)
            expect(registry.scrub(`only ${b}`)).toBe(`only ${MASK}`)
        })

        // KNOWN GAP: a fragment of the second secret survives when two secrets overlap in the text. Merging overlapping matches would close it.
        it.fails('wanted: no part of either secret beyond the overlap survives', () => {
            const registry = registryWith(a, b)
            expect(registry.scrub('secret-AAAA-tail99')).not.toContain('tail99')
        })
    })
})
