// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { analyze, createEngine } from '../engine'
import type { Finding } from '../finding'
import { healthyStart, type CaptureBuilder } from '../../testing/captureBuilder'

// Results Q13, second stage: the finding that says a cadence changed is honest (its evidence is real) and deterministic (live equals batch).

const STALL = 'stall.silent:bytes'
const CHANGED = 'cadence.changed:bytes'
const find = (findings: Finding[], key: string) => findings.find((f) => f.key === key)
const talking = (): CaptureBuilder => { const b = healthyStart(); for (let i = 0; i < 12; i++) b.silence(1000).frame('tick', String(i + 1)); return b }
const gaps = (b: CaptureBuilder, ...ms: number[]): CaptureBuilder => { for (const g of ms) b.silence(g).frame('tick'); return b }

describe('the cadence finding is honest and deterministic', () => {
    it('every piece of evidence it cites is a real record at the time it names, of the kind its note says', () => {
        const b = gaps(talking(), 8000, 8000, 8000)
        const records = new Map(b.build().map((o) => [o.seq, o]))
        const f = find(analyze(b.build(), { endT: b.now }).findings, CHANGED)!
        let cited = 0
        for (const fact of f.facts) {
            for (const e of fact.evidence) {
                const r = records.get(e.seq)
                expect(r, `seq ${e.seq}`).toBeDefined()
                expect(r!.t).toBe(e.t)
                expect(r!.kind, e.note).toBe('chunk')
                cited++
            }
        }
        expect(cited).toBe(6)
        expect(f.deductions[0]!.basis.every((seq) => records.has(seq))).toBe(true)
    })

    it('for random runs of gaps watched live: the same findings as a batch analysis, one finding per key, and a recognised change is never lost', () => {
        fc.assert(
            fc.property(fc.array(fc.constantFrom(1000, 1000, 4000, 8000, 8500, 9000, 12_000, 20_000), { minLength: 1, maxLength: 14 }), (lengths) => {
                const b = gaps(talking(), ...lengths)
                const records = b.build()
                const engine = createEngine()
                let changes = 0
                for (const o of records) {
                    engine.tick(o.t)
                    engine.feed(o)
                    const found = engine.findings()
                    expect(new Set(found.map((x) => x.key)).size).toBe(found.length)
                    const n = find(found, CHANGED)?.occurrences ?? 0
                    expect(n).toBeGreaterThanOrEqual(changes)
                    changes = n
                }
                engine.tick(b.now)
                engine.end(b.now)
                expect(engine.findings()).toEqual(analyze(records, { endT: b.now }).findings)
                // a change needs three stalls in the stream: never more changes than a third of the stalls
                const stalls = find(engine.findings(), STALL)?.occurrences ?? 0
                expect(changes * 3).toBeLessThanOrEqual(stalls)
            }),
            { seed: 71, numRuns: 300 },
        )
    })
})
