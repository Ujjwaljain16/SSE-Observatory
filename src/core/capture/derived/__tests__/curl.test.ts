// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { toCurl, envNameFor } from '../curl'
import { newHeader, type CaptureHeader } from '../../format'
import { capture } from '../../../testing/captureBuilder'
import { redacted, proxiedCapture, PROXY_CANARY } from './helpers'

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

// #76: a capture made through the app's server proxy has no address of its own (the request is `POST /api/sse`), so the command must say so
// instead of printing a relative path that cannot be run.
describe('toCurl for a capture made through the app proxy', () => {
    it('writes a runnable command on $STREAM_URL, with a comment that says why and what to set', () => {
        const cmd = toCurl(proxiedCapture())
        expect(cmd).toBe([
            `# This stream went through the app's server proxy, so its address was not recorded (it may carry a secret). Set STREAM_URL to the address you gave the app.`,
            `curl -N \\\n  -H 'Accept: text/event-stream' \\\n  "\${STREAM_URL}"`,
        ].join('\n'))
        expect(cmd).not.toContain('/api/sse')
        expect(cmd).not.toContain('-X')
        expect(cmd).not.toContain('Content-Type')
    })

    it('does the same in PowerShell, with $env: and a # comment', () => {
        const cmd = toCurl(proxiedCapture(), { shell: 'powershell' })
        expect(cmd.split('\n')[0]).toMatch(/^# This stream went through the app's server proxy/)
        expect(cmd).toContain('curl.exe -N')
        expect(cmd).toContain('"$env:STREAM_URL"')
        expect(cmd).not.toContain('/api/sse')
    })

    it('recognises the proxy by its path alone, and by its response header alone', () => {
        expect(toCurl(proxiedCapture({ viaHeader: false }))).toContain('"${STREAM_URL}"')
        expect(toCurl(proxiedCapture({ url: '/somewhere/else' }))).toContain('"${STREAM_URL}"')
        expect(toCurl(proxiedCapture({ url: '/api/sse?x=1' }))).toContain('"${STREAM_URL}"')
    })

    it('holds none of the values the request had', () => {
        for (const shell of ['posix', 'powershell'] as const) expect(toCurl(proxiedCapture(), { shell })).not.toContain(PROXY_CANARY)
    })

    it('keeps the real URL when the stream did not go through the proxy, exactly as before', () => {
        const direct = redacted({ header: newHeader({ kind: 'sanitized', source: { kind: 'fixture' }, request: request() }), records: capture().connect({ url: 'https://api.test/stream?token=[redacted]&room=[redacted]' }).response().build() })
        const cmd = toCurl(direct)
        expect(cmd).not.toContain('went through')
        expect(cmd).not.toContain('# ')
        expect(cmd).toContain('"https://api.test/stream?token=${STREAM_TOKEN}&room=${STREAM_ROOM}"')
        expect(cmd).toContain('-H "Authorization: ${STREAM_AUTHORIZATION}"')
        // a relative path of the user's own, without the proxy's path or header, is also left alone
        expect(toCurl(make(request({ url: '/events?x=[redacted]', headers: {} })))).toContain('"/events?x=${STREAM_X}"')
    })

    it('keeps an absolute URL even when the response carries the proxy header (a proxy the person runs and addressed directly)', () => {
        const c = redacted({ header: newHeader({ kind: 'sanitized', source: { kind: 'cli' }, request: request({ url: 'https://proxy.test/api/sse?u=[redacted]', headers: {} }) }), records: capture().connect({ url: 'https://proxy.test/api/sse?u=[redacted]' }).response({ headers: { 'x-sse-proxy': 'observatory/1' } }).build() })
        const cmd = toCurl(c)
        expect(cmd).toContain('"https://proxy.test/api/sse?u=${STREAM_U}"')
        expect(cmd).not.toContain('went through')
    })
})

describe('envNameFor', () => {
    it.each([['Authorization', 'STREAM_AUTHORIZATION'], ['x-api-key', 'STREAM_X_API_KEY'], ['  weird..name ', 'STREAM_WEIRD_NAME'], ['', 'STREAM_VALUE'], ['é', 'STREAM_VALUE']])('%s -> %s', (name, expected) => {
        expect(envNameFor(name)).toBe(expected)
    })
})
