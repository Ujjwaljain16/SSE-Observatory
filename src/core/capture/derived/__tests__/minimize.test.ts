import { describe, it, expect } from 'vitest'
import { analyze } from '../../../diagnostics/engine'
import type { EngineInput } from '../../../diagnostics/streamModel'
import type { StreamProfile } from '../../../diagnostics/thresholds'
import { capture, healthyStart } from '../../../testing/captureBuilder'
import { newHeader, type Capture } from '../../format'
import { minimizeCapture } from '../minimize'

const asCapture = (records: ReturnType<ReturnType<typeof capture>['build']>, profile?: StreamProfile): Capture =>
    ({ header: newHeader({ kind: 'local-full', source: { kind: 'fixture' }, ...(profile ? { profile } : {}) }), records })

const declared: StreamProfile = { sequence: { useSseId: true, policy: 'consecutive' } }
const withSeq = (records: ReturnType<ReturnType<typeof capture>['build']>) =>
    records.map((r) => (r.kind === 'event' ? { ...r, extracted: { seq: Number(r.sseId) }, dataHash: `h${r.dataBytes}` } : r))

describe('minimizeCapture', () => {
    it('shrinks a long stream with one hole in its numbering to the records that show the hole', () => {
        const b = healthyStart()
        for (let id = 1; id <= 60; id++) { if (id === 31) continue; b.silence(100).frame('tick', String(id), 10 + (id % 5)) }
        const c = asCapture(withSeq(b.build()), declared)
        const result = minimizeCapture(c, 'seq.integrity:gap')
        expect(result.reproduced).toBe(true)
        expect(result.complete).toBe(true)
        expect(result.originalRecords).toBeGreaterThan(100)
        expect(result.minimalRecords).toBeLessThanOrEqual(4) // the event before the hole and the one after it, and nothing else
        const again = analyze(result.capture.records as EngineInput[], { profile: declared, endT: result.capture.records.at(-1)!.t })
        expect(again.findings.some((f) => f.key === 'seq.integrity:gap')).toBe(true)
        // every record that is left is needed: dropping any one of them loses the finding
        for (let i = 0; i < result.capture.records.length; i++) {
            const rest = result.capture.records.filter((_, j) => j !== i) as EngineInput[]
            const kept = analyze(rest, { profile: declared, endT: result.capture.records.at(-1)!.t }).findings.some((f) => f.key === 'seq.integrity:gap')
            expect(kept, `record ${i} is not needed`).toBe(false)
        }
    })

    it('shrinks a wrong content type to the response that carries it', () => {
        const b = capture().connect().response({ contentType: 'text/html' })
        for (let i = 0; i < 20; i++) b.silence(50).chunk(30)
        const result = minimizeCapture(asCapture(b.build()), 'proto.content-type')
        expect(result.minimalRecords).toBeLessThanOrEqual(3)
        expect(result.capture.records.some((r) => r.kind === 'violation' || r.kind === 'response')).toBe(true) // the client's own violation record is enough
    })

    it('keeps the silence at the end that a stall finding is made of', () => {
        const b = healthyStart().repeat(12, 1000, (x, i) => x.frame('tick', String(i + 1))).silence(120_000)
        const records = b.build()
        const lastT = records.at(-1)!.t
        const c = asCapture(records.concat([{ kind: 'phase', phase: 'open', info: { attempt: 0 }, seq: records.length, t: lastT + 120_000, conn: 0 } as never]))
        const result = minimizeCapture(c, 'stall.silent')
        expect(result.reproduced).toBe(true)
        expect(result.minimalRecords).toBeLessThan(c.records.length)
    })

    it('says so when the capture does not show the finding, and leaves it alone', () => {
        const c = asCapture(healthyStart().repeat(3, 1000, (x, i) => x.frame('tick', String(i + 1))).build())
        const result = minimizeCapture(c, 'seq.integrity:gap')
        expect(result.reproduced).toBe(false)
        expect(result.capture).toBe(c)
    })

    it('is deterministic, and stops at the run limit with the best result so far', () => {
        const b = healthyStart()
        for (let id = 1; id <= 40; id++) { if (id === 20) continue; b.silence(100).frame('tick', String(id)) }
        const c = asCapture(withSeq(b.build()), declared)
        const a1 = minimizeCapture(c, 'seq.integrity:gap')
        const a2 = minimizeCapture(c, 'seq.integrity:gap')
        expect(a1.capture.records).toEqual(a2.capture.records)
        const limited = minimizeCapture(c, 'seq.integrity:gap', { maxRuns: 4 })
        expect(limited.complete).toBe(false)
        expect(limited.reproduced).toBe(true)
        expect(limited.minimalRecords).toBeGreaterThanOrEqual(a1.minimalRecords)
    })
})
