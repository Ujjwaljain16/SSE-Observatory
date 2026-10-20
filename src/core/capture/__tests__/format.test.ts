// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { sha256Hex } from '../sha256'
import { base64ToBytes, bytesToBase64 } from '../base64'
import { newHeader, parseCapture, serializeCapture, CaptureFormatError, type Capture } from '../format'
import { importV1 } from '../importV1'
import { connectionTexts, framesOf } from '../streamText'
import { analyze } from '../../diagnostics'

describe('sha256', () => {
    it('matches node:crypto, including block-boundary lengths and multi-byte text', () => {
        for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'héllo wörld ✓ 𝄞']) {
            expect(sha256Hex(text), text.slice(0, 10)).toBe(createHash('sha256').update(text).digest('hex'))
        }
    })
})

describe('base64', () => {
    it('round-trips every length and byte value, and matches Buffer', () => {
        for (let n = 0; n < 40; n++) {
            const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff)
            const text = bytesToBase64(bytes)
            expect(text).toBe(Buffer.from(bytes).toString('base64'))
            expect([...base64ToBytes(text)]).toEqual([...bytes])
        }
        expect(() => base64ToBytes('a$b=')).toThrow(/not Base64/)
    })
})

const sample = (): Capture => ({
    header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }),
    records: [
        { seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: 10 },
        { seq: 1, t: 5, conn: 0, kind: 'future-thing', payload: { a: 1 } },
        { seq: 2, t: 9, conn: 0, kind: 'event', event: 'message', sseId: '1', dataBytes: 3 },
    ],
})

describe('NDJSON capture file', () => {
    it('round-trips, keeps unknown record kinds, and verifies the integrity hash', () => {
        const text = serializeCapture(sample())
        expect(text.split('\n')).toHaveLength(6) // header, 3 records, footer, trailing newline
        const parsed = parseCapture(text)
        expect(parsed.integrity).toBe('ok')
        expect(parsed.warnings).toEqual([])
        expect(parsed.capture.records).toEqual(sample().records)
        expect(parsed.capture.footer?.counts).toEqual({ chunk: 1, 'future-thing': 1, event: 1 })
        expect(parsed.capture.header.capabilities).toContain('chunks')
    })

    it('notices a record that was changed after writing', () => {
        const text = serializeCapture(sample()).replace('"bytes":10', '"bytes":11')
        const parsed = parseCapture(text)
        expect(parsed.integrity).toBe('mismatch')
        expect(parsed.warnings.join(' ')).toMatch(/integrity/)
    })

    it('reads a file cut off by a crash: complete lines are kept, the broken last line is dropped, the missing footer is reported', () => {
        const lines = serializeCapture(sample()).trimEnd().split('\n')
        const cut = [...lines.slice(0, 3), lines[3]!.slice(0, 20)].join('\n')
        const parsed = parseCapture(cut)
        expect(parsed.capture.records).toHaveLength(2)
        expect(parsed.integrity).toBe('absent')
        expect(parsed.warnings.join(' ')).toMatch(/cut off/)
        expect(parsed.warnings.join(' ')).toMatch(/no footer/)
    })

    it('rejects what is not a capture, with a line number', () => {
        expect(() => parseCapture('')).toThrow(CaptureFormatError)
        expect(() => parseCapture('hello')).toThrow(/not JSON/)
        expect(() => parseCapture('{"format":"other"}')).toThrow(/not an sse-capture/)
        expect(() => parseCapture('{"format":"sse-capture","version":"3.0"}')).toThrow(/unsupported capture version/)
        const header = JSON.stringify(newHeader({ kind: 'local-full', source: { kind: 'cli' } }))
        expect(() => parseCapture(`${header}\n{"kind":"chunk"}\n{"kind":"chunk","seq":1,"t":1}`)).toThrow(/line 2/)
    })

    it('accepts a newer minor version with a note, and keeps header fields it does not know', () => {
        const header = { ...newHeader({ kind: 'local-full', source: { kind: 'cli' } }), version: '2.4', extraField: 7 }
        const parsed = parseCapture(`${JSON.stringify(header)}\n`)
        expect(parsed.warnings.join(' ')).toMatch(/2\.4/)
        expect((parsed.capture.header as unknown as { extraField: number }).extraField).toBe(7)
    })
})

describe('v1 import', () => {
    const v1 = { version: '1.0', createdAt: '2025-01-01T00:00:00.000Z', totalEvents: 3, durationMs: 700, events: [
        { id: 'u1', type: 'order', data: '{"n":1}', sseId: '10', deltaMs: 0 },
        { id: 'u2', type: 'message', data: 'héllo', deltaMs: 200 },
        { id: 'u3', type: 'order', data: '{"n":3}', sseId: '12', deltaMs: 500 },
    ] }

    it('rebuilds a synthetic timeline of event records, keeping names, ids and payload text', () => {
        const capture = importV1(v1)
        expect(capture.header.source).toEqual({ kind: 'import-v1', synthetic: true })
        expect(capture.records.map((r) => [r.t, r.kind, (r as { event: string }).event, (r as { sseId: string }).sseId])).toEqual([[0, 'event', 'order', '10'], [200, 'event', 'message', ''], [700, 'event', 'order', '12']])
        expect((capture.records[1] as { dataBytes: number }).dataBytes).toBe(6) // UTF-8 bytes, not characters
        expect(framesOf(capture).map((f) => f.data)).toEqual(['{"n":1}', 'héllo', '{"n":3}'])
    })

    it('survives a write and read, and the engine reports what it could not evaluate', () => {
        const parsed = parseCapture(serializeCapture(importV1(v1))).capture
        const analysis = analyze(parsed.records as never)
        const notEvaluated = analysis.coverage.filter((c) => c.status === 'not-evaluated')
        expect(notEvaluated.length).toBeGreaterThan(0) // no chunks, response or phases: never shown as healthy
    })

    it('refuses things that are not v1 recordings', () => {
        expect(() => importV1({ nope: 1 })).toThrow(/not an \.sse-record/)
        expect(() => importV1({ version: '2.0', events: [] })).toThrow(/unsupported/)
    })
})

describe('stream text', () => {
    it('rebuilds frames from Base64 chunks split inside a multi-byte character, per connection', () => {
        const bytes = new TextEncoder().encode('id: 1\ndata: h€llo\n\nid: 2\ndata: two\n\n')
        const cut = 14 // inside the three-byte euro sign
        const capture: Capture = { header: newHeader({ kind: 'local-full', source: { kind: 'fixture' } }), records: [
            { seq: 0, t: 0, conn: 0, kind: 'chunk', bytes: cut, b64: bytesToBase64(bytes.slice(0, cut)) },
            { seq: 1, t: 1, conn: 0, kind: 'chunk', bytes: bytes.length - cut, b64: bytesToBase64(bytes.slice(cut)) },
        ] }
        expect(connectionTexts(capture.records).get(0)).toBe('id: 1\ndata: h€llo\n\nid: 2\ndata: two\n\n')
        expect(framesOf(capture).map((f) => [f.id, f.data])).toEqual([['1', 'h€llo'], ['2', 'two']])
    })
})

describe('files that went through an editor, git on Windows or a PowerShell redirect', () => {
    it('read the same with CRLF line endings and a byte order mark, and the integrity hash still matches', () => {
        const text = serializeCapture(sample())
        for (const variant of [text.replace(/\n/g, '\r\n'), '\ufeff' + text, '\ufeff' + text.replace(/\n/g, '\r\n')]) {
            const parsed = parseCapture(variant)
            expect(parsed.integrity).toBe('ok')
            expect(parsed.warnings).toEqual([])
            expect(parsed.capture.records).toEqual(sample().records)
        }
    })
})
