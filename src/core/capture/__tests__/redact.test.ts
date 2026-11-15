// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { bytesToBase64 } from '../base64'
import { newHeader, serializeCapture, type Capture } from '../format'
import { importV1 } from '../importV1'
import { redactCapture, scanResidual } from '../redact'
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

describe('the RedactedCapture brand', () => {
    it('cannot be satisfied by a plain capture', () => {
        const share = (_c: RedactedCapture): void => {}
        // @ts-expect-error a local capture must not be accepted where a redacted one is required
        share(captureWithCuts([]))
        share(redactCapture(captureWithCuts([])).capture)
        expect(true).toBe(true)
    })
})
