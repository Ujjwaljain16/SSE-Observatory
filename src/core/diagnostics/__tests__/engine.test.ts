import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { analyze, createEngine } from '../engine'
import type { EngineInput } from '../streamModel'
import { capture, healthyStart, type CaptureBuilder } from '../../testing/captureBuilder'

type Step =
    | { op: 'frame' | 'beat' | 'proxyBeat' | 'chunk' | 'event' | 'retry' | 'violation' | 'discontinuity' | 'reconnect' | 'end'; dt: number }
interface Plan { steps: Step[]; ticks: number[][]; headers: 'ok' | 'html' | 'status' }

const OPS = ['frame', 'frame', 'frame', 'beat', 'proxyBeat', 'chunk', 'event', 'retry', 'violation', 'discontinuity', 'reconnect', 'end'] as const

const step = fc.record({
    op: fc.constantFrom(...OPS),
    dt: fc.oneof({ weight: 6, arbitrary: fc.integer({ min: 0, max: 1500 }) }, { weight: 2, arbitrary: fc.integer({ min: 1500, max: 12_000 }) }, { weight: 1, arbitrary: fc.integer({ min: 12_000, max: 90_000 }) }),
}) as fc.Arbitrary<Step>

const plan = fc.record({
    steps: fc.array(step, { minLength: 0, maxLength: 80 }),
    ticks: fc.array(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 3 }), { minLength: 90, maxLength: 90 }),
    headers: fc.constantFrom('ok', 'ok', 'ok', 'html', 'status'),
}) as fc.Arbitrary<Plan>

/** A valid capture: connections open, speak, and are dropped and reopened. */
function build(p: Plan): CaptureBuilder {
    const b = capture().connect()
    if (p.headers === 'html') b.response({ contentType: 'text/html' })
    else if (p.headers === 'status') b.response({ status: 503 })
    else b.response()
    let id = 0
    let open = p.headers === 'ok'
    for (const s of p.steps) {
        b.silence(s.dt)
        if (!open && s.op !== 'reconnect' && s.op !== 'discontinuity') continue
        switch (s.op) {
            case 'frame': b.frame('tick', String(++id)); break
            case 'beat': b.beat(); break
            case 'proxyBeat': b.beat('proxy'); break
            case 'chunk': b.chunk(7); break
            case 'event': b.event('tick', String(++id)); break
            case 'retry': b.retry(3000); break
            case 'violation': b.violation(id % 2 ? 'UNKNOWN_FIELD' : 'WRONG_CASE_FIELD'); break
            case 'discontinuity': b.discontinuity(s.dt); break
            case 'reconnect': b.reconnect({ lastEventIdSent: String(id) }).silence(500).connect({ sentLastEventId: String(id) }).response(); open = true; break
            case 'end': b.end(); open = false; break
        }
    }
    return b
}

const thresholds = { stallNoCadenceMs: 6000, stallMinSilenceMs: 400, connectToHeadersMs: 1500, headersToFirstByteMs: 1500, firstByteToEventMs: 2500, stallMinSamples: 5 }

/** Feeds records as a live host would: observations as they happen, ticks at arbitrary moments in between. */
function live(records: EngineInput[], ticks: number[][], endT: number) {
    const engine = createEngine({ thresholds })
    let prevT = 0
    records.forEach((o, i) => {
        for (const f of ticks[i % ticks.length] ?? []) engine.tick(prevT + f * (o.t - prevT))
        engine.feed(o)
        if ((ticks[i % ticks.length] ?? []).length % 2 === 1) engine.tick(o.t)
        prevT = o.t
    })
    engine.tick(endT)
    engine.end(endT)
    return { findings: engine.findings(), coverage: engine.coverage() }
}

describe('determinism: live incremental analysis equals batch analyze()', () => {
    it('for random valid captures, whatever moments the host ticks at', () => {
        fc.assert(fc.property(plan, (p) => {
            const b = build(p)
            const records = b.build()
            const endT = b.now + 20_000
            const batch = analyze(records, { thresholds, endT })
            const incremental = live(records, p.ticks, endT)
            expect(incremental.findings).toEqual(batch.findings)
            expect(incremental.coverage).toEqual(batch.coverage)
        }), { numRuns: 300 })
    })

    it('analysing the same capture twice gives identical results', () => {
        fc.assert(fc.property(plan, (p) => {
            const b = build(p)
            expect(analyze(b.build(), { thresholds, endT: b.now })).toEqual(analyze(b.build(), { thresholds, endT: b.now }))
        }), { numRuns: 100 })
    })

    it('every deduction is worded as a deduction, and every finding has evidence or a stated limit', () => {
        fc.assert(fc.property(plan, (p) => {
            const b = build(p)
            for (const f of analyze(b.build(), { thresholds, endT: b.now + 60_000 }).findings) {
                for (const d of f.deductions) expect(d.statement).toMatch(/^Likely:/)
                expect(f.facts.length).toBeGreaterThan(0)
                expect(f.limits.length > 0 || f.facts.some((x) => x.evidence.length > 0)).toBe(true)
                expect(f.lastSeenT).toBeGreaterThanOrEqual(f.firstSeenT)
            }
        }), { numRuns: 100 })
    })
})

describe('engine mechanics', () => {
    it('shows what is still going on at tick time, and a later observation replaces it', () => {
        const b = healthyStart().frame().silence(40_000)
        const engine = createEngine()
        for (const o of b.build()) engine.feed(o)
        expect(engine.findings()).toEqual([])
        engine.tick(b.now)
        expect(engine.findings().map((f) => f.key)).toContain('stall.silent:bytes')
        // data resumes: the open stall is closed by the observation, the provisional copy is gone
        const resumed = b.frame().build().slice(-2)
        for (const o of resumed) engine.feed(o)
        const stall = engine.findings().find((f) => f.key === 'stall.silent:bytes')!
        expect(stall.status).toBe('resolved')
        expect(stall.occurrences).toBe(1)
    })

    it('a tick on its own never changes what the next observation produces', () => {
        const b = healthyStart().frame().silence(40_000).frame()
        const records = b.build()
        const plain = createEngine(); const ticked = createEngine()
        for (const o of records.slice(0, -2)) { plain.feed(o); ticked.feed(o) }
        for (let t = 5000; t < 40_000; t += 5000) ticked.tick(t)
        for (const o of records.slice(-2)) { plain.feed(o); ticked.feed(o) }
        expect(ticked.findings()).toEqual(plain.findings())
    })

    it('ignores records after end, and orders findings by severity', () => {
        const b = capture().connect().response({ status: 502 }).connect().response({ contentType: 'text/html' }).frame()
        const engine = createEngine()
        for (const o of b.build()) engine.feed(o)
        engine.end(b.now)
        const before = engine.findings()
        engine.feed(capture().frame().build()[0]!)
        expect(engine.findings()).toEqual(before)
        const ranks = before.map((f) => ({ info: 0, warning: 1, error: 2, critical: 3 })[f.severity])
        expect([...ranks].sort((x, y) => y - x)).toEqual(ranks)
    })
})
