import { describe, expect, it } from 'vitest'
import { replayCopy } from '../replayCopy'
import { localCapture } from '../../core/capture/build'
import { parseCapture, serializeCapture, type CaptureRecord } from '../../core/capture/format'
import { healthyStart } from '../../core/testing/captureBuilder'
import { validateSession } from '../../../lib/mock/session.js'

const capture = (profile?: Parameters<typeof localCapture>[1]['profile']) => {
    const b = healthyStart()
    b.frame('tick', '1', 40).frame('tick', '2', 2).frame('other', '3', 0)
    const records = (b.observations() as CaptureRecord[]).map((r) => (r.kind === 'event' ? { ...r, extracted: { seq: Number((r as { sseId: string }).sseId), ts: 1_700_000_000_000 } } : r)) as CaptureRecord[]
    return serializeCapture(localCapture(records, { source: { kind: 'browser-app' }, request: { url: 'https://stream.test/e' }, ...(profile ? { profile } : {}) }))
}

describe('replayCopy: a capture the mock server will play', () => {
    it('gives every event a body of its original size, valid JSON, and says it is synthetic', () => {
        const { text, filled } = replayCopy(capture())
        expect(filled).toBe(3)
        const parsed = parseCapture(text).capture
        expect(parsed.header.source.synthetic).toBe(true)
        const events = parsed.records.filter((r) => r.kind === 'event') as unknown as Array<{ data: string; dataBytes: number }>
        for (const e of events) {
            expect(() => JSON.parse(e.data)).not.toThrow()
        }
        expect(events[0]!.data.length).toBe(40)
    })

    it('carries the numbers the profile reads, so a sequence or timestamp field survives', () => {
        const { text } = replayCopy(capture({ sequence: { field: '$.data.seq', policy: 'consecutive' }, timestampField: '$.ts' }))
        const events = parseCapture(text).capture.records.filter((r) => r.kind === 'event') as unknown as Array<{ data: string }>
        const first = JSON.parse(events[0]!.data) as { data: { seq: number }; ts: number }
        expect(first.data.seq).toBe(1)
        expect(first.ts).toBe(1_700_000_000_000)
        expect((JSON.parse(events[1]!.data) as { data: { seq: number } }).data.seq).toBe(2)
    })

    it('leaves an event that already has a body alone, and a capture of such events unmarked', () => {
        const records = (healthyStart().frame('tick', '1').observations() as CaptureRecord[]).map((r) => (r.kind === 'event' ? { ...r, data: '{"real":true}' } : r)) as CaptureRecord[]
        const text = serializeCapture(localCapture(records, { source: { kind: 'browser-app' } }))
        const out = replayCopy(text)
        expect(out.filled).toBe(0)
        expect(out.text).toContain('{\\"real\\":true}')
        expect(parseCapture(out.text).capture.header.source.synthetic).toBeUndefined()
    })

    it('ignores a profile path it cannot build an object from, instead of inventing one', () => {
        const { text } = replayCopy(capture({ sequence: { field: '$.items[0].n', policy: 'consecutive' } }))
        const events = parseCapture(text).capture.records.filter((r) => r.kind === 'event') as unknown as Array<{ data: string }>
        expect(Object.keys(JSON.parse(events[0]!.data) as object).every((k) => k === '')).toBe(true)
    })

    it('is accepted by the mock server, which refuses the same capture without it', () => {
        expect(validateSession(capture()).error ?? validateSession(capture() as unknown as object).error).toBeTruthy()
        const copy = replayCopy(capture()).text
        const accepted = validateSession(copy)
        expect(accepted.error).toBeUndefined()
        expect(accepted.session).toBeDefined()
    })
})
