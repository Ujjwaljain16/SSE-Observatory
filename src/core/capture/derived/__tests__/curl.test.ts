// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { toCurl, envNameFor } from '../curl'
import { newHeader, type CaptureHeader } from '../../format'
import { capture } from '../../../testing/captureBuilder'
import { redacted } from './helpers'

function make(request: CaptureHeader['request'] | undefined, connect: Parameters<ReturnType<typeof capture>['connect']>[0] = {}) {
    const b = capture().connect(connect).response()
    return redacted({ header: newHeader({ kind: 'sanitized', source: { kind: 'fixture' }, request }), records: b.build() })
}

const request = (over: Partial<NonNullable<CaptureHeader['request']>> = {}): NonNullable<CaptureHeader['request']> => ({
    url: 'https://api.test/stream?token=[redacted]&room=[redacted]',
    method: 'GET',
    headers: { Authorization: 'Bearer SECRET-VALUE', 'X-Api-Key': 'KEY-VALUE' },
    ...over,
})

describe('toCurl (posix)', () => {
    it('writes placeholders for headers and query values, never the values', () => {
        const cmd = toCurl(make(request()))
        expect(cmd).toContain('curl -N')
        expect(cmd).toContain(`-H 'Accept: text/event-stream'`)
        expect(cmd).toContain('-H "Authorization: ${STREAM_AUTHORIZATION}"')
        expect(cmd).toContain('-H "X-Api-Key: ${STREAM_X_API_KEY}"')
        expect(cmd).toContain('"https://api.test/stream?token=${STREAM_TOKEN}&room=${STREAM_ROOM}"')
        expect(cmd).not.toContain('SECRET-VALUE')
        expect(cmd).not.toContain('KEY-VALUE')
        expect(cmd).not.toContain('[redacted]')
    })

    it('turns percent-encoded placeholders into variables too, and decodes the name for the variable', () => {
        const cmd = toCurl(make(request({ url: 'https://api.test/s?a%20b=%5Bredacted%5D', headers: {} })))
        expect(cmd).toContain('"https://api.test/s?a%20b=${STREAM_A_B}"')
    })

    it('single-quotes a URL without placeholders, and uses -X only for a method other than GET', () => {
        expect(toCurl(make(request({ url: "https://h.test/it's", headers: {} })))).toContain(`'https://h.test/it'\\''s'`)
        expect(toCurl(make(request()))).not.toContain('-X')
        expect(toCurl(make(request({ method: 'POST' })))).toContain(`-X 'POST'`)
    })

    it('adds Last-Event-ID only when the first connect sent one, quoting the value', () => {
        expect(toCurl(make(request()))).not.toContain('Last-Event-ID')
        const cmd = toCurl(make(request({ headers: { 'Last-Event-ID': 'x' } }), { sentLastEventId: "it's 7" }))
        expect(cmd).toContain(`-H 'Last-Event-ID: it'\\''s 7'`)
        expect(cmd.match(/Last-Event-ID/g)).toHaveLength(1) // the captured header is not repeated
    })

    it('does not repeat an Accept header the capture already had', () => {
        const cmd = toCurl(make(request({ headers: { accept: 'text/event-stream', Authorization: 'x' } })))
        expect(cmd.match(/Accept/gi)).toHaveLength(1)
    })

    it('escapes hostile header names and URLs for double quotes', () => {
        const cmd = toCurl(make(request({ url: 'https://h.test/a"$(id)`x!y?k=[redacted]', headers: { [`X-A'b "c" $(x)`]: 'v' } })))
        expect(cmd).toContain(`-H "X-A'b \\"c\\" \\$(x): \${STREAM_X_A_B_C_X}"`)
        expect(cmd).toContain(`"https://h.test/a\\"\\$(id)\\\`x"'!'"y?k=\${STREAM_K}"`)
    })

    it('derives the request from the first connect record when the header has none', () => {
        const cmd = toCurl(make(undefined, { url: 'https://c.test/s?x=[redacted]', method: 'POST', headerNames: ['authorization', 'x-trace'] }))
        expect(cmd).toContain('-X \'POST\'')
        expect(cmd).toContain('-H "authorization: ${STREAM_AUTHORIZATION}"')
        expect(cmd).toContain('-H "x-trace: ${STREAM_X_TRACE}"')
        expect(cmd).toContain('"https://c.test/s?x=${STREAM_X}"')
    })

    it('falls back to a URL variable when the capture has no request at all', () => {
        const cmd = toCurl(redacted({ header: newHeader({ kind: 'sanitized', source: { kind: 'fixture' } }), records: [] }))
        expect(cmd).toContain('"${STREAM_URL}"')
    })

    it('produces a command a real shell reads as the intended words', () => {
        const cmd = toCurl(make(request({ url: "https://h.test/it's?k=[redacted]", headers: { [`X-A'b "c" $(x)`]: 'v' } }), { sentLastEventId: "7'; echo pwned; '" }))
        let out: string
        try {
            out = execFileSync('sh', ['-c', `set -- ${cmd.replace(/^curl/, '')} ; for a in "$@"; do printf '%s\\n' "$a"; done`], { env: { ...process.env, STREAM_K: 'secret&k', STREAM_X_A_B_C_X: 'hv' }, encoding: 'utf8' })
        } catch { return } // no POSIX shell on this machine
        const words = out.trimEnd().split('\n')
        expect(words).toContain('-N')
        expect(words).toContain(`X-A'b "c" $(x): hv`)
        expect(words).toContain(`Last-Event-ID: 7'; echo pwned; '`)
        expect(words[words.length - 1]).toBe(`https://h.test/it's?k=secret&k`)
    })
})

describe('toCurl (powershell)', () => {
    it('uses $env: placeholders, curl.exe and backtick continuations', () => {
        const cmd = toCurl(make(request()), { shell: 'powershell' })
        expect(cmd.startsWith('curl.exe -N')).toBe(true)
        expect(cmd).toContain(' `\n  -H')
        expect(cmd).toContain('-H "Authorization: $env:STREAM_AUTHORIZATION"')
        expect(cmd).toContain('"https://api.test/stream?token=$env:STREAM_TOKEN&room=$env:STREAM_ROOM"')
        expect(cmd).toContain(`-H 'Accept: text/event-stream'`)
        expect(cmd).not.toContain('SECRET-VALUE')
    })

    it('doubles single quotes in literal text and backtick-escapes in expandable strings', () => {
        expect(toCurl(make(request({ url: "https://h.test/it's", headers: {} }), { sentLastEventId: "a'b" }), { shell: 'powershell' })).toContain(`'https://h.test/it''s'`)
        const cmd = toCurl(make(request({ url: 'https://h.test/a"$x`y?k=[redacted]', headers: { [`X-A'b "c" $(x)`]: 'v' } }), { sentLastEventId: "a'b" }), { shell: 'powershell' })
        expect(cmd).toContain(`-H 'Last-Event-ID: a''b'`)
        expect(cmd).toContain('-H "X-A\'b `"c`" `$(x): $env:STREAM_X_A_B_C_X"')
        expect(cmd).toContain('"https://h.test/a`"`$x``y?k=$env:STREAM_K"')
    })

    it('treats typographic quotes as quotes, which PowerShell does', () => {
        const cmd = toCurl(make(request({ url: 'https://h.test/’x', headers: {} })), { shell: 'powershell' })
        expect(cmd).toContain("'https://h.test/’’x'")
    })

    it('keeps a variable apart from a word character that follows it', () => {
        const cmd = toCurl(make(request({ url: 'https://h.test/s?a=[redacted]', headers: {} })), { shell: 'powershell' })
        expect(cmd).toContain('$env:STREAM_A"')
    })
})

describe('envNameFor', () => {
    it.each([['Authorization', 'STREAM_AUTHORIZATION'], ['x-api-key', 'STREAM_X_API_KEY'], ['  weird..name ', 'STREAM_WEIRD_NAME'], ['', 'STREAM_VALUE'], ['é', 'STREAM_VALUE']])('%s -> %s', (name, expected) => {
        expect(envNameFor(name)).toBe(expected)
    })
})
