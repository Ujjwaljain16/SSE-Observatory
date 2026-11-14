// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createEngine, analyze } from '../engine'
import type { Finding } from '../finding'
import type { EngineInput } from '../streamModel'
import { healthyStart, type CaptureBuilder } from '../../testing/captureBuilder'
import { build, plan } from '../../testing/randomCapture'

// Campaign C2: the life of a finding while a stream is being watched. A live host feeds records and ticks the clock; a finding appears,
// may resolve when the stream recovers, may come back, and survives a reconnect or a clock jump without being doubled, losing its count, or
// reappearing without something new having happened. Each scenario is read as the sequence of snapshots a person looking at the screen would see.

type Snapshot = Array<{ key: string; status: Finding['status']; occurrences: number; severity: Finding['severity'] }>
const snapshot = (findings: Finding[]): Snapshot => findings.map((f) => ({ key: f.key, status: f.status, occurrences: f.occurrences, severity: f.severity })).sort((a, b) => a.key.localeCompare(b.key))
const of = (snap: Snapshot, key: string) => snap.find((f) => f.key === key)

/** Feeds `records` and ticks at each record and at the end; returns what is on screen after every step. */
function watch(b: CaptureBuilder, endT: number): Snapshot[] {
    const engine = createEngine()
    const shots: Snapshot[] = []
    for (const o of b.build()) { engine.feed(o); engine.tick(o.t); shots.push(snapshot(engine.findings())) }
    engine.tick(endT)
    shots.push(snapshot(engine.findings()))
    return shots
}

/** A stream that talks every second, so its own rhythm is known (a stall is then anything beyond 3 s, an error beyond 5 s). */
const talking = (n: number): CaptureBuilder => { const b = healthyStart(); for (let i = 0; i < n; i++) b.silence(1000).frame('tick', String(i + 1)); return b }

/** A live engine fed in steps: records as a builder grows, ticks at chosen moments. */
function liveOf(b: CaptureBuilder) {
    const engine = createEngine()
    let fed = 0
    return {
        /** Feed what the builder gained since the last call (ticking at each record, as a host does). */
        feedNew() { const all = b.build(); for (const o of all.slice(fed)) { engine.feed(o); engine.tick(o.t) } fed = all.length },
        tick(t: number) { engine.tick(t) },
        shot: (): Snapshot => snapshot(engine.findings()),
    }
}

describe('a stall comes, goes, and comes again', () => {
    it('is open, then resolved when the stream resumes, then open again as a second occurrence (a stream with enough history that one stall does not move its own limit)', () => {
        const b = talking(40)
        const live = liveOf(b)
        live.feedNew()
        live.tick(b.now + 8000)
        expect(of(live.shot(), 'stall.silent:bytes'), 'the first silence').toMatchObject({ status: 'open', occurrences: 1 })

        b.silence(8000).frame('tick', '13') // the stream resumes
        live.feedNew()
        expect(of(live.shot(), 'stall.silent:bytes'), 'after it resumed').toMatchObject({ status: 'resolved', occurrences: 1 })

        b.silence(1000).frame('tick', '14').silence(8000) // and goes quiet again
        live.feedNew()
        live.tick(b.now)
        const second = live.shot()
        expect(of(second, 'stall.silent:bytes'), 'the second silence').toMatchObject({ status: 'open', occurrences: 2 })
        expect(second.filter((f) => f.key === 'stall.silent:bytes'), 'one finding, not two').toHaveLength(1)
    })
})

describe("the limit a stall is judged by is the stream's own rhythm, and an early stall is part of it", () => {
    it('KNOWN LIMIT: in a stream with only a dozen gaps of history, a first 8 s stall becomes the p95, so the same stall again is not reported (3 x 8 s = 24 s)', () => {
        const b = talking(12)
        const live = liveOf(b)
        live.feedNew(); live.tick(b.now + 8000)
        expect(of(live.shot(), 'stall.silent:bytes')).toMatchObject({ status: 'open', occurrences: 1 })
        b.silence(8000).frame('tick', '13').silence(1000).frame('tick', '14').silence(8000)
        live.feedNew(); live.tick(b.now)
        expect(of(live.shot(), 'stall.silent:bytes'), 'the second, identical stall is inside the new limit').toMatchObject({ status: 'resolved', occurrences: 1 })
    })
})

describe('a reconnect while a silence is open', () => {
    it('keeps one finding per key at every step, and a silence that ended with the connection closing stays open after a healthy reconnect (an open question for the owner: results Q12)', () => {
        const b = talking(12).silence(8000)
        const shots = watch(b, b.now)
        expect(of(shots.at(-1)!, 'stall.silent:bytes')).toMatchObject({ status: 'open' })
        b.reconnect({ delayMs: 500 }).silence(500).connect({ sentLastEventId: '12' }).response().frame('tick', '13')
        const all = watch(b, b.now + 500)
        // today: the silence ended because the connection closed, not because data resumed on it, so it is not "resolved" even though the new
        // connection is healthy. Whether a recovery on a NEW connection should resolve it is a product decision; this pins what happens now.
        expect(of(all.at(-1)!, 'stall.silent:bytes')).toMatchObject({ status: 'open', occurrences: 1 })
        for (const s of all) expect(new Set(s.map((f) => f.key)).size, 'one finding per key').toBe(s.length)
    })
})

describe('a clock jump during a silence', () => {
    it('reports the jump, restarts the measuring, and does not double the stall or lose it', () => {
        const b = talking(12).silence(8000).discontinuity(60_000).silence(8000)
        const shots = watch(b, b.now)
        const last = shots.at(-1)!
        expect(of(last, 'clock.discontinuity')).toBeDefined()
        expect(last.filter((f) => f.key.startsWith('stall.silent')).length).toBeGreaterThan(0)
        for (const s of shots) expect(new Set(s.map((f) => f.key)).size).toBe(s.length)
    })
})

describe('what is on screen over the life of any stream', () => {
    it('for random streams watched live: one finding per key; what a record commits only grows and stays; a tick only adds to it; a resolved finding reopens only with later evidence', () => {
        const problems = new Set<string>()
        type Seen = { status: Finding['status']; occurrences: number; lastSeenT: number }
        const view = (findings: Finding[]): Map<string, Seen> => new Map(findings.map((f) => [f.key, { status: f.status, occurrences: f.occurrences, lastSeenT: f.lastSeenT }]))
        fc.assert(
            fc.property(plan, (p) => {
                const b = build(p)
                const engine = createEngine()
                let committed = new Map<string, Seen>() // what the last record left on screen (no provisional findings)
                let shown = new Map<string, Seen>() // what was on screen last, tick or record
                const unique = (stage: string, findings: Finding[]) => { if (new Set(findings.map((f) => f.key)).size !== findings.length) problems.add(`${stage}: a key appears twice`) }
                const reopened = (stage: string, now: Map<string, Seen>) => {
                    for (const [key, f] of now) { const before = shown.get(key); if (before?.status === 'resolved' && f.status === 'open' && !(f.lastSeenT > before.lastSeenT)) problems.add(`${stage}: ${key} reopened with nothing later than what it was resolved on`) }
                }
                for (const o of b.build() as EngineInput[]) {
                    engine.tick(o.t)
                    const t = engine.findings(); unique('tick', t)
                    const tv = view(t)
                    for (const [key, c] of committed) { const now = tv.get(key); if (!now) problems.add(`tick: ${key} (committed) is not on screen`); else if (now.occurrences < c.occurrences) problems.add(`tick: ${key} shows fewer occurrences than were committed`) }
                    reopened('tick', tv); shown = tv

                    engine.feed(o)
                    const f = engine.findings(); unique('record', f)
                    const fv = view(f)
                    for (const [key, c] of committed) { const now = fv.get(key); if (!now) problems.add(`record: ${key} disappeared once committed`); else if (now.occurrences < c.occurrences) problems.add(`record: ${key} occurrences went down once committed`) }
                    reopened('record', fv); committed = fv; shown = fv
                }
                engine.tick(b.now + 60_000)
                unique('late tick', engine.findings())
                engine.end(b.now + 60_000)
                const end = view(engine.findings()); unique('end', engine.findings())
                for (const [key, c] of committed) { const now = end.get(key); if (!now) problems.add(`end: ${key} disappeared`); else if (now.occurrences < c.occurrences) problems.add(`end: ${key} occurrences went down`) }
            }),
            { seed: 61, numRuns: 400 },
        )
        expect([...problems].map((x) => x.replace(/\d+/g, '#'))).toEqual([])
    })

    it('once the capture has ended, more records and more ticks change nothing', () => {
        fc.assert(
            fc.property(plan, (p) => {
                const b = build(p)
                const records = b.build() as EngineInput[]
                const engine = createEngine()
                for (const o of records) { engine.feed(o); engine.tick(o.t) }
                engine.end(b.now + 10_000)
                const frozen = JSON.stringify(engine.findings())
                for (const o of records) engine.feed({ ...o, seq: o.seq + 10_000, t: o.t + b.now + 50_000 })
                engine.tick(b.now + 500_000)
                engine.end(b.now + 900_000)
                expect(JSON.stringify(engine.findings())).toBe(frozen)
            }),
            { seed: 62, numRuns: 200 },
        )
    })

    it('a capture analysed in pieces by a fresh engine each time, with the same records, always gives the same findings', () => {
        fc.assert(
            fc.property(plan, (p) => {
                const b = build(p)
                const records = b.build() as EngineInput[]
                const a = analyze(records, { endT: b.now + 10_000 }).findings
                const c = analyze(records, { endT: b.now + 10_000 }).findings
                expect(c).toEqual(a)
            }),
            { seed: 63, numRuns: 100 },
        )
    })
})
