import { describe, expect, it } from 'vitest'
import { analyze } from '../engine'
import type { EngineInput } from '../streamModel'
import { healthyStart } from '../../testing/captureBuilder'

// S17: a capture is a file somebody sent. A record that is missing a field must not take the analysis down.

const KINDS = ['connect', 'response', 'phase', 'chunk', 'comment', 'heartbeatSeries', 'retry', 'event', 'violation', 'reconnect', 'consumer'] as const

/** One record of each kind with only the fields every record has, then each one with every other field set to null. */
const hostile = (kind: string, seq: number): Array<Record<string, unknown>> => [
    { seq, t: seq * 10, conn: 0, kind },
    { seq, t: seq * 10, conn: 0, kind, url: null, headers: null, info: null, text: null, code: null, severity: null, extracted: null, source: null, phase: null },
]

describe('analysis of records that are missing fields', () => {
    it.each(KINDS)('does not throw on a bare %s record', (kind) => {
        const good = healthyStart().frame('tick', '1').frame('tick', '2').build()
        for (const bad of hostile(kind, 100)) {
            const analysis = analyze([...good, bad as unknown as EngineInput], {})
            expect(Array.isArray(analysis.findings)).toBe(true)
            expect(analysis.coverage.length).toBeGreaterThan(0)
        }
    })

    it('says which check stopped, so a check that failed never looks like one that passed', () => {
        const records = [
            { seq: 0, t: 0, conn: 0, kind: 'connect' },
            { seq: 1, t: 1, conn: 0, kind: 'response', status: 200, contentType: 'text/event-stream', headers: null },
            { seq: 2, t: 2, conn: 0, kind: 'violation', severity: 'info' },
        ] as unknown as EngineInput[]
        const { coverage } = analyze(records, {})
        const failed = coverage.filter((c) => c.status === 'not-evaluated' && /stopped/.test(c.notes.join(' ')))
        expect(failed.length).toBeGreaterThan(0)
        for (const c of failed) expect(c.notes.join(' ')).toMatch(/could not read/)
    })

    it('keeps analysing the rest after one rule fails', () => {
        const good = healthyStart().frame('tick', '1').build()
        const withBad = [...good, { seq: 50, t: 50, conn: 0, kind: 'response' } as unknown as EngineInput]
        const clean = analyze(good, {}).coverage.filter((c) => c.status === 'evaluated').length
        const dirty = analyze(withBad, {}).coverage.filter((c) => c.status === 'evaluated').length
        expect(dirty).toBeGreaterThan(0)
        expect(dirty).toBeLessThanOrEqual(clean)
    })
})
