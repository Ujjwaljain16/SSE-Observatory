import { describe, expect, it } from 'vitest'
import { redactCapture, scanResidual } from '../redact'
import { serializeCapture, type CaptureRecord } from '../format'
import { localCapture } from '../build'
import { buildReport } from '../derived/report'
import { analyze } from '../../diagnostics/engine'
import type { EngineInput } from '../../diagnostics/streamModel'
import { redactUrl } from '../../observe/redactUrl'
import { healthyStart } from '../../testing/captureBuilder'

// Secret-shaped values are built at run time so this file holds none.
const S = ['CANARY', 'Zq8vK2mPx4', 'Tn7bW9'].join('')

/** A capture whose comment, reconnect reason and event id carry `text`, redacted and written out. */
function leaks(text: string): boolean {
    const b = healthyStart()
    b.frame('tick', '1').comment(text).reconnect({ reason: text })
    const c = localCapture(b.observations() as CaptureRecord[], { source: { kind: 'browser-app' }, request: { url: 'https://stream.test/e' } })
    return serializeCapture(redactCapture(c).capture).includes(S)
}

describe('S01: a credential inside a URL in free text', () => {
    it.each([
        [`see https://cdn.example.com/dl?token=${S}&x=1`],
        [`Location: https://other.example/x?access_token=${S}`],
        [`GET http://h/p?a=1&api_key=${S}`],
        [`failed: https://u.example/?session=${S}#frag`],
        [`redirected to //cdn.example.com/p?token=${S}`],
    ])('does not keep it: %s', (text) => expect(leaks(text)).toBe(false))
})

describe('S02: redaction stays fast on long runs of word characters', () => {
    it.each([['a-'], ['a.'], ['a1-'], ['ab.']])('200 KB of %s repeated', (unit) => {
        const text = unit.repeat(100_000)
        const t0 = performance.now()
        const b = healthyStart()
        b.comment(text)
        const c = localCapture(b.observations() as CaptureRecord[], { source: { kind: 'browser-app' } })
        const { capture } = redactCapture(c)
        scanResidual(capture)
        expect(performance.now() - t0, `${unit} took too long`).toBeLessThan(3000)
    })
})

describe('S05: shapes and names that were missed', () => {
    it.each([
        [`{"tokens":["${S}"]}`],
        [`{"apiKey":["${S}","other"]}`],
        [`{"credentials":{"user":"bob","blob":"${S}"}}`],
        [`{"payload":"{\\"token\\":\\"${S}\\"}"}`],
        [`{'password': '${S}'}`],
        [`Authorization: Token ${S}`],
        [`Authorization: Digest ${S}`],
        [`connecting to https://${S}@host.example/stream`],
        [`{"secretAccessKey":"${S}"}`],
        [`{"sessionKey":"${S}"}`],
        [`sid=${S}`],
        [`signingKey: ${S}`],
        [`connect.sid=${S}`],
    ])('does not keep it: %s', (text) => expect(leaks(text)).toBe(false))

    it('keeps ordinary text readable', () => {
        const b = healthyStart()
        b.comment('keep-alive 12 ms').comment('status: ok')
        const c = localCapture(b.observations() as CaptureRecord[], { source: { kind: 'browser-app' } })
        const out = serializeCapture(redactCapture(c).capture)
        expect(out).toContain('keep-alive 12 ms')
        expect(out).toContain('status: ok')
    })

    it('still produces JSON that parses where it replaced a container', () => {
        const b = healthyStart()
        b.comment(`{"tokens":["${S}"],"n":1}`)
        const c = localCapture(b.observations() as CaptureRecord[], { source: { kind: 'browser-app' } })
        const comment = redactCapture(c).capture.records.find((r) => r.kind === 'comment') as { text: string }
        expect(() => JSON.parse(comment.text)).not.toThrow()
        expect(JSON.parse(comment.text)).toMatchObject({ n: 1 })
    })
})

describe('S06: URL parts', () => {
    it.each([
        ['https://api.example.com/v1/a3f9c2d1b7e84f60a1b2c3d4e5f60718/stream', 'https://api.example.com/v1/[redacted]/stream'],
        ['https://hooks.example.com/services/T0123ABCDEF4567GHIJK/B0123XYZ', 'https://hooks.example.com/services/[redacted]/B0123XYZ'],
        ['https://api.example.com/v1/orders/stream', 'https://api.example.com/v1/orders/stream'],
        ['https://api.example.com/this-is-a-long-readable-article-slug', 'https://api.example.com/this-is-a-long-readable-article-slug'],
        ['https://api.example.com/s?room=7&token=abc', 'https://api.example.com/s?room=[redacted]&token=[redacted]'],
        ['https://api.example.com/s?Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg', 'https://api.example.com/s?[redacted]=[redacted]'],
        ['/relative/path?k=v', '/relative/path?k=[redacted]'],
    ])('%s', (input, expected) => expect(redactUrl(input)).toBe(expected))

    it('never keeps userinfo or a query of a URL the platform cannot parse', () => {
        const out = redactUrl(`http://user:${S}@[bad/x?token=${S}`)
        expect(out).not.toContain(S)
        expect(out).not.toContain('user')
        expect(out).toBe('http://[bad/x')
    })

    it('the residual scan flags a long hex token that redaction kept', () => {
        const hex = 'a3f9c2d1b7e84f60a1b2c3d4e5f60718'
        const b = healthyStart()
        b.comment(`token id ${hex}`)
        const c = localCapture(b.observations() as CaptureRecord[], { source: { kind: 'browser-app' } })
        expect(scanResidual(c).length).toBeGreaterThan(0)
    })
})

describe('S08: a hostile severity in a capture file', () => {
    const hostile = 'info"><meta http-equiv="refresh" content="0;url=https://evil.example/x"><b x="'
    const records = () => {
        const b = healthyStart()
        b.frame('tick', '1')
        b.violation('UNKNOWN_FIELD', 'a field name')
        return (b.observations() as unknown as Array<Record<string, unknown>>).map((r) => (r['kind'] === 'violation' ? { ...r, severity: hostile } : r)) as unknown as CaptureRecord[]
    }

    it('is shown as info, so nothing from the file reaches an attribute or a label', () => {
        const capture = localCapture(records(), { source: { kind: 'cli' }, request: { url: 'https://stream.test/e' } })
        const { capture: safe } = redactCapture(capture)
        const analysis = analyze(safe.records as EngineInput[], {})
        for (const f of analysis.findings) expect(['info', 'warning', 'error', 'critical']).toContain(f.severity)
        const html = buildReport(safe, analysis, { format: 'html' })
        expect(html).not.toContain('evil.example')
        expect(html).not.toMatch(/<meta http-equiv="refresh"/i)
        expect(html).toContain("form-action 'none'")
        expect(html).toContain("base-uri 'none'")
        expect(buildReport(safe, analysis, { format: 'md' })).not.toContain('evil.example')
    })
})
