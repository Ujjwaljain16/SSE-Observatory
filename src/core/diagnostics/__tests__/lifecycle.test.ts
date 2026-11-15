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

describe("the limit a stall is judged by is the stream's own rhythm, and a stall already reported is not part of it (decided: results Q13)", () => {
    it('in a stream with only a dozen gaps of history, a first 8 s stall does not become the p95: the same stall again is reported too', () => {
        const b = talking(12)
        const live = liveOf(b)
        live.feedNew(); live.tick(b.now + 8000)
        expect(of(live.shot(), 'stall.silent:bytes')).toMatchObject({ status: 'open', occurrences: 1 })
        b.silence(8000).frame('tick', '13').silence(1000).frame('tick', '14').silence(8000)
        live.feedNew(); live.tick(b.now)
        expect(of(live.shot(), 'stall.silent:bytes'), 'the second, identical stall is judged by the rhythm the stream had before the first').toMatchObject({ status: 'open', occurrences: 2 })
    })

    it('the same holds when the second stall is finished and the capture is analysed after the fact (both are counted, the limit stays 3 x the usual gap)', () => {
        const b = talking(12).silence(8000).frame('tick', '13').silence(1000).frame('tick', '14').silence(8000).frame('tick', '15')
        const { findings, model } = analyze(b.build())
        expect(findings.find((f) => f.key === 'stall.silent:bytes')).toMatchObject({ status: 'resolved', occurrences: 2 })
        expect(model.baseline.byte.p95(), 'the baseline holds the 1 s ticks and neither stall').toBe(1000)
        expect(model.baseline.byte.count).toBe(12) // the 11 gaps between the 12 ticks and the 1 s tick after the first stall; the stalls are left out
    })

    it('with forty gaps of history the limit never moved, and still does not (the variant that always worked)', () => {
        const b = talking(40).silence(8000).frame('tick', '41').silence(1000).frame('tick', '42').silence(8000)
        const live = liveOf(b)
        live.feedNew(); live.tick(b.now)
        expect(of(live.shot(), 'stall.silent:bytes')).toMatchObject({ status: 'open', occurrences: 2 })
    })

    it('a gap is left out of the baseline when it was a stall by the rule\'s own verdict (longer than the limit that applied), not when it is merely long: 3000 ms stays, 3001 ms goes', () => {
        const justUnder = analyze(talking(12).silence(3000).frame('tick', '13').build())
        expect(justUnder.findings.some((f) => f.key.startsWith('stall.silent')), 'a gap equal to the limit is not a stall').toBe(false)
        expect(justUnder.model.baseline.byte.count, 'so it is part of the rhythm').toBe(12)
        expect(justUnder.model.baseline.byte.maxEver).toBe(3000)

        const justOver = analyze(talking(12).silence(3001).frame('tick', '13').build())
        expect(justOver.findings.find((f) => f.key === 'stall.silent:bytes')).toMatchObject({ status: 'resolved', occurrences: 1 })
        expect(justOver.model.baseline.byte.count, 'a gap one millisecond over the limit is a stall and is not part of the rhythm').toBe(11)
        expect(justOver.model.baseline.byte.maxEver).toBe(1000)
        // The longest gap is still known to those who ask for it (R10 and R11 read it), the stall is only not taught to the detector.
        expect(justOver.model.gaps.byte.maxEver).toBe(3001)
    })

    it('a gap that is long but under the limit of a stream that is itself slow stays in the baseline (the limit is the stream\'s, not a fixed number)', () => {
        const b = healthyStart()
        for (let i = 0; i < 12; i++) b.silence(5000).frame('tick', String(i + 1))
        b.silence(14_000).frame('tick', '13') // 14 s is long, but the limit here is 3 x 5 s = 15 s
        const { findings, model } = analyze(b.build())
        expect(findings.some((f) => f.key.startsWith('stall.silent'))).toBe(false)
        expect(model.baseline.byte.count).toBe(12)
    })

    it('the limit a stream declares for itself is the same edge: a gap of exactly the declared longest silence stays, one millisecond more is left out', () => {
        const profile = { expected: { maxSilenceMs: 5000 } }
        const at = analyze(healthyStart().silence(1000).frame('a').silence(1000).frame('b').silence(5000).frame('c').build(), { profile })
        expect(at.findings.some((f) => f.key.startsWith('stall.silent'))).toBe(false)
        expect(at.model.baseline.byte.count).toBe(2)
        const over = analyze(healthyStart().silence(1000).frame('a').silence(1000).frame('b').silence(5001).frame('c').build(), { profile })
        expect(over.findings.find((f) => f.key === 'stall.silent:bytes')).toMatchObject({ occurrences: 1 })
        expect(over.model.baseline.byte.count).toBe(1)
    })

    it('a stream that only just began (too few gaps for its own rhythm) uses the default limit, and a gap over it is also kept out', () => {
        const { findings, model } = analyze(healthyStart().silence(1000).frame('tick', '1').silence(1000).frame('tick', '2').silence(40_000).frame('tick', '3').build())
        expect(findings.find((f) => f.key === 'stall.silent:bytes')).toMatchObject({ occurrences: 1 })
        expect(model.baseline.byte.count, 'the 1 s gap is in, the 40 s one is not').toBe(1)
    })
})

describe('a reconnect while a silence is open (decided: results Q12)', () => {
    /** A healthy stream that went quiet for 8 s, was closed, and was reconnected. */
    const closedAfterSilence = () => talking(12).silence(8000).reconnect({ delayMs: 500 }).silence(500).connect({ sentLastEventId: '12' }).response()

    it('keeps one finding per key at every step; the silence stays open while the new connection has delivered nothing, and is resolved by its first event', () => {
        const b = closedAfterSilence()
        const waiting = watch(b, b.now + 500)
        expect(of(waiting.at(-1)!, 'stall.silent:bytes'), 'the new connection is open but has delivered nothing yet').toMatchObject({ status: 'open', occurrences: 1 })

        b.frame('tick', '13')
        const all = watch(b, b.now + 500)
        expect(of(all.at(-1)!, 'stall.silent:bytes'), 'the new connection delivered an event').toMatchObject({ status: 'resolved', occurrences: 1 })
        for (const s of all) expect(new Set(s.map((f) => f.key)).size, 'one finding per key').toBe(s.length)
    })

    it('a resolved stall is history, not deletion: it keeps its duration, its evidence and its count, and says what resolved it', () => {
        const open = analyze(closedAfterSilence().build(), { endT: 40_000 }).findings.find((f) => f.key === 'stall.silent:bytes')!
        expect(open.status).toBe('open')
        const b = closedAfterSilence().frame('tick', '13')
        const resolved = analyze(b.build()).findings.find((f) => f.key === 'stall.silent:bytes')!
        expect(resolved.status).toBe('resolved')
        // What the stall was is unchanged: the same summary, severity, count, times and the same facts (with their evidence), in the same order.
        for (const field of ['summary', 'severity', 'occurrences', 'firstSeenT', 'lastSeenT', 'title', 'deductions'] as const) expect(resolved[field], field).toEqual(open[field])
        expect(resolved.facts.slice(0, open.facts.length)).toEqual(open.facts)
        expect(resolved.facts[0]!.text, 'the duration of the stall').toContain('8 s')
        // The one thing added is what ended it, pointing at the event that did.
        const added = resolved.facts.slice(open.facts.length)
        expect(added).toHaveLength(1)
        const recovered = b.build().filter((o) => o.kind === 'event').at(-1)!
        expect(added[0]!.evidence).toEqual([{ seq: recovered.seq, t: recovered.t, note: 'a later connection delivered an event' }])
    })

    it('the open findings (what the exit-code gate and the Doctor count) stop holding the stall for a stream that recovered, and still hold it for a stream that ends in a stall (the command line itself: commands.test.ts)', () => {
        const recovered = analyze(closedAfterSilence().frame('tick', '13').build()).findings
        expect(recovered.filter((f) => f.status === 'open' && f.severity !== 'info'), 'recovered: the stall is history').toEqual([])

        // The recovered connection goes quiet in its turn and the capture ends there: the earlier stall is history, the new one is open.
        const stillStalled = analyze(closedAfterSilence().build(), { endT: 60_000 }).findings
        expect(stillStalled.filter((f) => f.status === 'open' && f.ruleId === 'stall.silent').length, 'the capture ends with the new connection silent').toBeGreaterThan(0)

        // A recovery followed by a new silence on the new connection: the finding comes back open, with its count raised.
        const again = analyze(closedAfterSilence().frame('tick', '13').silence(1000).frame('tick', '14').silence(8000).build(), { endT: 70_000 }).findings
        expect(again.find((f) => f.key === 'stall.silent:bytes')).toMatchObject({ status: 'open', occurrences: 2 })
    })

    it('a connection that opens and delivers only heartbeats does not resolve it (the decision names an event)', () => {
        const heartbeatsOnly = analyze(closedAfterSilence().beat().silence(1000).beat().build(), { endT: 30_000 }).findings
        expect(heartbeatsOnly.find((f) => f.key === 'stall.silent:bytes')).toMatchObject({ status: 'open' })
    })

    it('every kind of silence is resolved the same way: no data at all after the connection opened, and the open stall of a connection that never delivered anything', () => {
        // Opened, never sent a byte, closed; the next connection delivers.
        const b = talking(12).reconnect({ delayMs: 500 }).connect({ sentLastEventId: '12' }).response().silence(40_000).reconnect({ delayMs: 500 }).connect().response().silence(1000).frame('tick', '13')
        const f = analyze(b.build()).findings.find((x) => x.key === 'stall.silent:no-bytes')!
        expect(f).toMatchObject({ status: 'resolved', occurrences: 1 })
    })

    it('a live engine and a batch analysis agree after a recovery, at every point', () => {
        const b = closedAfterSilence().frame('tick', '13').silence(1000).frame('tick', '14')
        const records = b.build()
        const engine = createEngine()
        for (const o of records) { engine.feed(o); engine.tick(o.t) }
        engine.tick(b.now + 500)
        engine.end(b.now + 500)
        expect(engine.findings()).toEqual(analyze(records, { endT: b.now + 500 }).findings)
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
