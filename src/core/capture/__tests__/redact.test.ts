// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { bytesToBase64 } from '../base64'
import { newHeader, serializeCapture, type Capture } from '../format'
import { importV1 } from '../importV1'
import { redactCapture, scanResidual } from '../redact'
import { looksLikeRandomToken } from '../secrets'
import type { RedactedCapture } from '../redacted'
import { connectionTexts, framesOf } from '../streamText'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'
const CANARIES = ['hunter2-canary', JWT, 'abcDEF1234567890xyz', 'canary-hb-token-12345', 'AKIAIOSFODNN7EXAMPLE', 'pass-canary']

const STREAM = [
    ': hb token=canary-hb-token-12345\n\n',
    'id: 1\ndata: {"user":"ann","password":"hunter2-canary","note":"ok"}\n\n',
    `id: 2\nevent: login\ndata: {"jwt":"${JWT}","key":"AKIAIOSFODNN7EXAMPLE"}\n\n`,
    'id: 3\ndata: Authorization: Bearer abcDEF1234567890xyz\n\n',
    'id: 4\ndata: see https://user:pass-canary@host.test/x\n\n',
    'id: 5\ndata: {"n":5}\n\n',
].join('')
const BYTES = new TextEncoder().encode(STREAM)

const captureWithCuts = (cuts: number[]): Capture => {
    const points = [0, ...cuts, BYTES.length]
    const records = points.slice(0, -1).map((start, i) => {
        const part = BYTES.slice(start, points[i + 1])
        return { seq: i, t: i * 10, conn: 0, kind: 'chunk' as const, bytes: part.length, b64: bytesToBase64(part) }
    })
    return { header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }), records }
}

const everything = (c: Capture): string => serializeCapture(c)

describe('redactCapture: secrets split across chunks', () => {
    it('leaves no canary anywhere in the output, wherever the chunk boundary falls', () => {
        for (let cut = 1; cut < BYTES.length; cut++) {
            const { capture } = redactCapture(captureWithCuts([cut]))
            const text = everything(capture)
            for (const canary of CANARIES) expect(text, `cut at ${cut}`).not.toContain(canary)
        }
    })

    it('gives the same redacted stream however it was chunked, and keeps original byte counts', () => {
        const whole = connectionTexts(redactCapture(captureWithCuts([])).capture.records).get(0)!
        expect(whole).toContain('[REDACTED_')
        for (const cuts of [[1], [5, 6], [40, 41, 200], [BYTES.length - 1], Array.from({ length: 40 }, (_, i) => (i + 1) * 7)]) {
            const input = captureWithCuts(cuts)
            const { capture } = redactCapture(input)
            expect(connectionTexts(capture.records).get(0), `cuts ${cuts.slice(0, 4)}`).toBe(whole)
            expect(capture.records.map((r) => (r as { bytes: number }).bytes)).toEqual(input.records.map((r) => (r as { bytes: number }).bytes))
            expect(capture.records.every((r) => (r as { b64?: string }).b64 === undefined)).toBe(true)
        }
    })

    it('keeps the events: count, names and ids are the same before and after', () => {
        const input = captureWithCuts([33, 90])
        const { capture } = redactCapture(input)
        const before = framesOf(input).map((f) => [f.event, f.id])
        expect(framesOf(capture).map((f) => [f.event, f.id])).toEqual(before)
        expect(before).toHaveLength(5)
    })

    it('keeps the JSON valid where a string value was replaced', () => {
        const { capture } = redactCapture(captureWithCuts([]))
        const first = framesOf(capture)[0]!
        expect(JSON.parse(first.data)).toMatchObject({ user: 'ann', note: 'ok', password: expect.stringMatching(/^\[REDACTED_\d+\]$/) })
    })
})

describe('redactCapture: placeholders', () => {
    it('numbers placeholders per export, repeats one for an equal secret, and derives nothing from the secret', () => {
        const text = ': a token=same-secret-value\n\n: b token=same-secret-value\n\n: c token=other-secret-value\n\n'
        const bytes = new TextEncoder().encode(text)
        const input: Capture = { header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }), records: [{ seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: bytes.length, b64: bytesToBase64(bytes) }] }
        const { capture, report } = redactCapture(input)
        const out = connectionTexts(capture.records).get(0)!
        expect(out).toBe(': a token=[REDACTED_1]\n\n: b token=[REDACTED_1]\n\n: c token=[REDACTED_2]\n\n')
        expect(report.placeholders).toBe(2)
        expect(JSON.stringify(capture)).not.toMatch(/same-secret|other-secret/)
        expect(capture.header.redaction).toMatchObject({ policy: 'default', placeholders: 2 })
    })

    it('is idempotent: redacting a redacted capture changes nothing', () => {
        const once = redactCapture(captureWithCuts([50])).capture
        const twice = redactCapture(once).capture
        expect(connectionTexts(twice.records).get(0)).toBe(connectionTexts(once.records).get(0))
    })
})

describe('redactCapture: metadata', () => {
    const base = (): Capture => ({
        header: newHeader({
            kind: 'local-full',
            source: { kind: 'cli' },
            request: { url: 'https://user:pw@api.test/stream?token=abc123&x=1#frag', method: 'GET', headers: { Authorization: 'Bearer abc.def.ghi-123', Cookie: 'sid=cookie-canary', Accept: 'text/event-stream', 'X-Tenant': 'acme-corp' } },
        }),
        records: [
            { seq: 0, t: 0, conn: 0, kind: 'connect', attempt: 0, url: 'https://api.test/stream?token=[redacted]', method: 'GET', headerNames: ['accept'], sentLastEventId: '' },
            { seq: 1, t: 5, conn: 0, kind: 'response', status: 200, contentType: 'text/event-stream', redirected: false, headers: { 'content-type': 'text/event-stream', 'set-cookie': 'sid=resp-canary' }, ttfbMs: 5 },
            { seq: 2, t: 6, conn: 0, kind: 'comment', text: 'password=comment-canary', source: 'upstream' },
            { seq: 3, t: 7, conn: 0, kind: 'event', event: 'message', sseId: JWT, dataBytes: 3, dataHash: 'abc', extracted: { seq: 1, partition: 'user-4711' } },
            { seq: 4, t: 8, conn: 0, kind: 'mystery', secret: 'mystery-canary', note: 'Bearer zzzzYYYYxxxx9999' } as never,
        ],
    })

    it('replaces unsafe request headers and credentials in the URL, keeps safe ones', () => {
        const { capture } = redactCapture(base())
        const request = capture.header.request!
        expect(request.url).toBe('https://api.test/stream?token=[redacted]&x=[redacted]')
        expect(request.headers['Accept']).toBe('text/event-stream')
        for (const name of ['Authorization', 'Cookie', 'X-Tenant']) expect(request.headers[name]).toMatch(/^\[REDACTED_\d+\]$/)
        expect(capture.header.kind).toBe('sanitized')
    })

    it('redacts response headers, comments, partitions and the strings of record kinds it does not know', () => {
        const text = JSON.stringify(redactCapture(base()).capture.records)
        for (const canary of ['resp-canary', 'comment-canary', 'user-4711', 'zzzzYYYYxxxx9999']) expect(text).not.toContain(canary)
        expect(JSON.parse(text)[4].kind).toBe('mystery') // an unknown kind is kept
        expect(JSON.parse(text)[3].extracted.seq).toBe(1)
    })

    it('keeps ordinary event ids readable, replaces an id that is a credential, and says so', () => {
        const { capture } = redactCapture(base())
        expect((capture.records[3] as { sseId: string }).sseId).toMatch(/^\[REDACTED_\d+\]$/)
        const ordinary = redactCapture({ ...base(), records: [{ seq: 0, t: 0, conn: 0, kind: 'event', event: 'message', sseId: '1042', dataBytes: 1 }] })
        expect((ordinary.capture.records[0] as { sseId: string }).sseId).toBe('1042')
        const withFrames = captureWithCuts([])
        const text = new TextEncoder().encode(`id: ${JWT}\ndata: x\n\n`)
        withFrames.records = [{ seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: text.length, b64: bytesToBase64(text) }]
        const result = redactCapture(withFrames)
        expect(result.report.idWarnings.length).toBeGreaterThan(0)
        expect(result.report.idWarnings.join(' ')).not.toContain(JWT)
    })

    it('does not change its input', () => {
        const input = base()
        const before = JSON.stringify(input)
        redactCapture(input)
        expect(JSON.stringify(input)).toBe(before)
    })

    it('redacts the payload text of an imported v1 recording', () => {
        const v1 = importV1({ version: '1.0', events: [{ type: 'login', data: '{"password":"v1-canary","ok":true}', sseId: '1', deltaMs: 0 }] })
        const { capture } = redactCapture(v1)
        expect(JSON.stringify(capture)).not.toContain('v1-canary')
        expect(framesOf(capture)[0]!.event).toBe('login')
    })
})

describe('scanResidual', () => {
    it('reports an unrecognised random token without printing it', () => {
        const odd = 'q8Zr3kT9vB2mXc7LpW4nYd6HsJ1fGa5e'
        const input = captureWithCuts([])
        const bytes = new TextEncoder().encode(`data: order ${odd} created\n\n`)
        input.records = [{ seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: bytes.length, b64: bytesToBase64(bytes) }]
        const hits = scanResidual(input)
        expect(hits.map((h) => h.rule)).toContain('random-token')
        expect(JSON.stringify(hits)).not.toContain(odd)
    })

    it('finds nothing in a redacted capture of ordinary data', () => {
        const { report } = redactCapture(captureWithCuts([10, 120]))
        expect(report.residual).toEqual([])
    })

    it('does not mistake a UUID or a placeholder for a secret', () => {
        const input = captureWithCuts([])
        const bytes = new TextEncoder().encode('data: {"id":"3f2b8c1e-9d4a-4e7b-8a21-5c6d7e8f9a0b","token":"[REDACTED_1]"}\n\n')
        input.records = [{ seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: bytes.length, b64: bytesToBase64(bytes) }]
        expect(scanResidual(input)).toEqual([])
    })
})

// Issue 78: a stream whose ids are structured (the public Wikimedia stream sends a JSON array of topics, partitions and offsets) printed one warning per
// event, 462 for 468 events. A structured id is not a token, and what is still a token is reported once, with a count.
describe('redactCapture: event id warnings', () => {
    const captureOfIds = (ids: string[]): Capture => {
        const bytes = new TextEncoder().encode(ids.map((id, i) => `id: ${id}\nevent: message\ndata: {"n":${i}}\n\n`).join(''))
        return { header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }), records: [{ seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: bytes.length, b64: bytesToBase64(bytes) }] }
    }
    const wikimediaId = (i: number): string => JSON.stringify([
        { topic: 'eqiad.mediawiki.recentchange', partition: 0, offset: -1 },
        { topic: 'codfw.mediawiki.recentchange', partition: 0, timestamp: 1794769472912 + i },
    ])
    const TOKENS = Array.from({ length: 50 }, (_, i) => {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        let s = 'k' + i // a different, random-looking 32 character token each
        for (let j = 0; s.length < 32; j++) s += alphabet[(i * 7919 + j * 104729 + j * j * 31) % alphabet.length]
        return s
    })

    it('does not warn about 468 structured (Wikimedia style) ids, and the redacted capture is the same as the input', () => {
        const ids = Array.from({ length: 468 }, (_, i) => wikimediaId(i))
        const input = captureOfIds(ids)
        const { capture, report } = redactCapture(input)
        expect(report.idWarnings).toEqual([])
        expect(report.residual).toEqual([])
        expect(report.placeholders).toBe(0)
        expect(framesOf(capture).map((f) => f.id)).toEqual(ids)
    })

    it('reports 50 genuinely random ids as ONE summary line that counts them, names the first position, and never shows an id', () => {
        const { capture, report } = redactCapture(captureOfIds(TOKENS))
        expect(report.idWarnings).toHaveLength(1)
        expect(report.idWarnings[0]).toBe('50 event ids look like random tokens but match no known secret format, so they were kept; check them before sharing (first: event id #1)')
        for (const t of TOKENS) expect(report.idWarnings.join('\n')).not.toContain(t)
        expect(framesOf(capture).map((f) => f.id)).toEqual(TOKENS) // kept, as before: the redaction policy for a real token is unchanged
    })

    it('names the position of the first token among structured ids, and uses the singular for one', () => {
        const ids = [wikimediaId(0), wikimediaId(1), TOKENS[3]!, wikimediaId(2)]
        const { report } = redactCapture(captureOfIds(ids))
        expect(report.idWarnings).toEqual(['1 event id looks like a random token but matches no known secret format, so it was kept; check it before sharing (event id #3)'])
    })

    it('counts every event whose id is a token, not the distinct ones, and says once that credential ids were replaced', () => {
        const same = captureOfIds([TOKENS[0]!, TOKENS[0]!, TOKENS[0]!, `${JWT}`, `${JWT}`])
        const { report } = redactCapture(same)
        expect(report.idWarnings).toHaveLength(2)
        expect(report.idWarnings[0]).toMatch(/^3 event ids look like random tokens .*\(first: event id #1\)$/)
        expect(report.idWarnings[1]).toBe('2 event ids were credentials and were replaced; sequence checks on this stream cannot use ids (first: event id #4)')
        expect(report.idWarnings.join('\n')).not.toContain(JWT)
    })
})

describe('looksLikeRandomToken', () => {
    it('does not fire on a structured value: JSON, or text with whitespace, quotes, braces, brackets or separators', () => {
        for (const v of [
            '[{"topic":"eqiad.mediawiki.recentchange","partition":0,"offset":-1}]',
            '{"a":"b","c":12345678901234567890}',
            'topic=eqiad.mediawiki.recentchange partition=0 offset=1794769472912',
            '"q8Zr3kT9vB2mXc7LpW4nYd6HsJ1fGa5e"',
            '[q8Zr3kT9vB2mXc7LpW4nYd6HsJ1fGa5e]',
            'q8Zr3kT9vB2mXc7L,pW4nYd6HsJ1fGa5e',
        ]) expect(looksLikeRandomToken(v), v).toBe(false)
    })

    it('still fires on a long base64, url-safe, hex or mixed token with no structure', () => {
        for (const v of ['q8Zr3kT9vB2mXc7LpW4nYd6HsJ1fGa5e', 'q8Zr3kT9vB2mXc7LpW4nYd6HsJ1fGa5e+/9=', 'q8Zr3kT9vB2mXc7LpW4n-d6HsJ1fGa_e', '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08']) expect(looksLikeRandomToken(v), v).toBe(true)
    })
})

describe('the RedactedCapture brand', () => {
    it('cannot be satisfied by a plain capture', () => {
        const share = (_c: RedactedCapture): void => {}
        // @ts-expect-error a local capture must not be accepted where a redacted one is required
        share(captureWithCuts([]))
        share(redactCapture(captureWithCuts([])).capture)
        expect(true).toBe(true)
    })
})
