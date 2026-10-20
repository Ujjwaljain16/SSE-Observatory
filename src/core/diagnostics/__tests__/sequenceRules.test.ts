import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { analyze, createEngine } from '../engine'
import type { Finding } from '../finding'
import { defaultRules } from '../rules'
import { sequenceIntegrity } from '../rules/r09SequenceIntegrity'
import { resumeLastEventId } from '../rules/r08ResumeLastEventId'
import { SequenceTracker } from '../sequenceTracker'
import type { StreamProfile } from '../thresholds'
import type { EngineInput } from '../streamModel'
import { healthyStart, type CaptureBuilder } from '../../testing/captureBuilder'

const RULES = [...defaultRules, sequenceIntegrity, resumeLastEventId]
const declared: StreamProfile = { sequence: { useSseId: true, policy: 'consecutive' } }

/** Gives each event record its number (from the SSE id) and a payload hash (from its byte count), as the payload probe would. */
const withSeq = (records: EngineInput[], partitionOf?: (id: number) => string): EngineInput[] =>
    records.map((r) => (r.kind === 'event' && /^\d+$/.test(r.sseId)
        ? { ...r, dataHash: `h${r.dataBytes}`, extracted: { seq: Number(r.sseId), ...(partitionOf ? { partition: partitionOf(Number(r.sseId)) } : {}) } }
        : r))

const NO_CONTRACT: StreamProfile = {}
const run = (b: CaptureBuilder, profile: StreamProfile = declared, partitionOf?: (id: number) => string) =>
    analyze(withSeq(b.build(), partitionOf), { rules: RULES, profile, endT: b.now })
const find = (findings: Finding[], key: string) => findings.find((f) => f.key === key)
const keys = (findings: Finding[]) => findings.map((f) => f.key).filter((k) => k.startsWith('seq.') || k.startsWith('resume.'))
/** Payload size (hence hash) varies with the id, so identical numbers carry identical data and different numbers do not. */
const frames = (b: CaptureBuilder, ids: number[], bytes?: number) => { ids.forEach((id) => { b.silence(100); b.frame('tick', String(id), bytes ?? 10 + (id % 7)) }); return b }

describe('R09 seq.integrity under a declared contract', () => {
    it('reports a gap as loss, with the missing numbers and the records around it', () => {
        const a = run(frames(healthyStart(), [1, 2, 3, 5, 6, ...Array.from({ length: 60 }, (_, i) => 7 + i)]))
        const gap = find(a.findings, 'seq.integrity:gap')!
        expect(gap.severity).toBe('error')
        expect(gap.summary).toContain('1 number never arrived')
        expect(gap.summary).toContain('4')
        expect(gap.facts[0]!.evidence).toHaveLength(2)
        expect(gap.deductions.every((d) => d.statement.startsWith('Likely:'))).toBe(true)
    })

    it('does not call a late arrival loss: the number that fills the gap in time makes it a reorder note', () => {
        const a = run(frames(healthyStart(), [1, 2, 4, 3, 5, 6]))
        expect(find(a.findings, 'seq.integrity:gap')).toBeUndefined()
        expect(find(a.findings, 'seq.integrity:reorder')!.severity).toBe('info')
    })

    it('confirms a gap that is still open when the capture ends, and says so', () => {
        const a = run(frames(healthyStart(), [1, 2, 4]))
        const gap = find(a.findings, 'seq.integrity:gap')!
        expect(gap.limits.join(' ')).toMatch(/capture ended/)
    })

    it('tells a redelivery from a conflict, and a duplicate from replay after a reconnect', () => {
        const dup = run(frames(healthyStart(), [1, 2, 2, 3]))
        expect(find(dup.findings, 'seq.integrity:duplicate')!.severity).toBe('warning')
        expect(find(dup.findings, 'seq.integrity:conflict')).toBeUndefined()

        const b = healthyStart(); frames(b, [1, 2, 3])
        b.frame('tick', '2', 99) // same number, different payload
        expect(find(run(b).findings, 'seq.integrity:conflict')!.severity).toBe('error')

        const r = healthyStart(); frames(r, [1, 2, 3, 4, 5]); r.silence(10).phase('reconnecting').reconnect({ lastEventIdSent: '5' }).connect({ sentLastEventId: '5' }).response()
        frames(r, [4, 5, 6, 7])
        const replay = run(r)
        expect(find(replay.findings, 'seq.integrity:duplicate')).toBeUndefined()
        expect(find(replay.findings, 'seq.integrity:replay')!.severity).toBe('info')
        expect(find(replay.findings, 'seq.integrity:gap')).toBeUndefined()
        // the same replay is a problem if the stream promised exactly-once delivery
        expect(find(run(r, { ...declared, delivery: 'exactly_once' }).findings, 'seq.integrity:replay')!.severity).toBe('warning')
    })

    it('under "monotonic" a jump is fine and only going backwards is a finding', () => {
        const monotonic: StreamProfile = { sequence: { useSseId: true, policy: 'monotonic' } }
        expect(keys(run(frames(healthyStart(), [104, 111, 112]), monotonic).findings)).toEqual([])
        expect(find(run(frames(healthyStart(), [111, 104]), monotonic).findings, 'seq.integrity:regression')!.severity).toBe('warning')
    })

    it('numbers each partition on its own', () => {
        const ids = [1, 101, 2, 102, 3, 103, 4, 104]
        const a = run(frames(healthyStart(), ids), { sequence: { useSseId: true, policy: 'consecutive', partitionBy: '$event' } }, (n) => (n > 100 ? 'b' : 'a'))
        expect(keys(a.findings)).toEqual([])
        const mixed = run(frames(healthyStart(), ids)) // same events without partitions: looks like gaps
        expect(find(mixed.findings, 'seq.integrity:gap')).toBeDefined()
    })

    it('says an unreadable sequence value is a problem with the declaration, not with the stream', () => {
        const b = healthyStart().frame('tick', 'abc').frame('tick', 'def').frame('tick', 'ghi')
        const a = run(b)
        expect(find(a.findings, 'seq.integrity:unreadable')!.severity).toBe('warning')
        expect(a.coverage.find((c) => c.ruleId === 'seq.integrity')!.status).toBe('not-evaluated')
    })
})

describe('R09 without a declared contract', () => {
    it('never reports a gap, and says continuity could not be verified', () => {
        const a = run(frames(healthyStart(), [1, 2, 4, 9]), NO_CONTRACT)
        expect(keys(a.findings)).toEqual([])
        expect(a.coverage.find((c) => c.ruleId === 'seq.integrity')!.notes.join(' ')).toMatch(/not verified/)
    })

    it('hints, at info level only, that ids which count up could be declared', () => {
        const a = run(frames(healthyStart(), Array.from({ length: 12 }, (_, i) => i + 1)), NO_CONTRACT)
        const hint = find(a.findings, 'seq.integrity:hint')!
        expect(hint.severity).toBe('info')
        expect(hint.nextCheck?.description).toContain('useSseId')
    })

    it('stays silent for opaque ids', () => {
        const b = healthyStart(); ['a1', 'b7', 'c3'].forEach((id) => b.silence(100).frame('tick', id))
        expect(keys(run(b, NO_CONTRACT).findings)).toEqual([])
    })
})

describe('R08 resume.last-event-id', () => {
    const reconnectWith = (b: CaptureBuilder, sent: string) => b.silence(10).phase('reconnecting').reconnect({ lastEventIdSent: sent }).connect({ sentLastEventId: sent }).response()

    it('notices a resume that skipped events, only under a declared contract', () => {
        const b = healthyStart(); frames(b, [1, 2, 3]); reconnectWith(b, '3'); frames(b, [7, 8])
        const a = run(b)
        const skipped = find(a.findings, 'resume.last-event-id:skipped')!
        expect(skipped.severity).toBe('error')
        expect(skipped.summary).toContain('4-6')
        expect(find(a.findings, 'seq.integrity:gap')).toBeUndefined() // the jump at the boundary is reported once, here
        expect(find(run(b, NO_CONTRACT).findings, 'resume.last-event-id:skipped')).toBeUndefined()
    })

    it('a correct resume produces nothing; replay is a note', () => {
        const ok = healthyStart(); frames(ok, [1, 2, 3]); reconnectWith(ok, '3'); frames(ok, [4, 5])
        expect(keys(run(ok).findings)).toEqual([])
        const overlap = healthyStart(); frames(overlap, [1, 2, 3]); reconnectWith(overlap, '3'); frames(overlap, [2, 3, 4, 5])
        expect(find(run(overlap).findings, 'resume.last-event-id:overlap')!.severity).toBe('info')
    })

    it('spots a server that ignores Last-Event-ID (the stream starts over)', () => {
        const b = healthyStart(); frames(b, [1, 2, 3]); reconnectWith(b, '3'); frames(b, [1, 2, 3, 4])
        const f = find(run(b, NO_CONTRACT).findings, 'resume.last-event-id:ignored')!
        expect(f.severity).toBe('warning')
        expect(f.deductions[0]!.statement).toMatch(/^Likely:/)
    })

    it('flags a reconnect that did not send an id although events had them', () => {
        const b = healthyStart(); frames(b, [1, 2]); reconnectWith(b, ''); frames(b, [3])
        expect(find(run(b, NO_CONTRACT).findings, 'resume.last-event-id:not-sent')!.severity).toBe('warning')
    })

    it('flags ids that change with every connection while the data repeats', () => {
        const b = healthyStart(); frames(b, [1, 2, 3], 11); reconnectWith(b, '3'); frames(b, [11, 12, 13], 11)
        // same payload sizes -> same hashes, new ids
        const dataBytes = [21, 22, 23]
        const c = healthyStart(); dataBytes.forEach((n, i) => c.silence(100).frame('tick', String(i + 1), n)); reconnectWith(c, '3'); dataBytes.forEach((n, i) => c.silence(100).frame('tick', String(100 + i), n))
        expect(find(run(c, NO_CONTRACT).findings, 'resume.last-event-id:synthetic-ids')).toBeDefined()
    })

    it('says there was nothing to judge when the stream never reconnected', () => {
        const a = run(frames(healthyStart(), [1, 2, 3]))
        expect(a.coverage.find((c) => c.ruleId === 'resume.last-event-id')!.notes.join(' ')).toMatch(/did not reconnect/)
    })
})

describe('determinism: live incremental equals batch', () => {
    it('for random streams with gaps, duplicates and reconnects', () => {
        fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 5, maxLength: 60 }), fc.array(fc.integer({ min: 0, max: 59 }), { maxLength: 3 }), (ids, cuts) => {
            const b = healthyStart()
            ids.forEach((id, i) => {
                if (cuts.includes(i)) b.silence(10).phase('reconnecting').reconnect({ lastEventIdSent: String(id) }).connect({ sentLastEventId: String(id) }).response()
                b.silence(50).frame('tick', String(id), 10 + (id % 3))
            })
            const records = withSeq(b.build())
            const batch = analyze(records, { rules: RULES, profile: declared, endT: b.now })
            const engine = createEngine({ rules: RULES, profile: declared })
            for (const r of records) { engine.feed(r); engine.tick(r.t) }
            engine.end(b.now)
            expect(engine.findings()).toEqual(batch.findings)
        }), { numRuns: 150 })
    })
})

describe('SequenceTracker against a naive oracle', () => {
    const options = { policy: 'consecutive' as const, reorderWindowEvents: 50, reorderWindowMs: 2000, window: 4096 }

    it('finds exactly the numbers that never arrive, for any arrival order within the window', () => {
        fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 80 }), { minLength: 1, maxLength: 40 }), (raw) => {
            // Numbers below the first one seen are a restart, not a gap; they have their own finding. Keep the domain to a sequence that starts at its lowest.
            const arrivals = raw.map((v) => Math.max(v, raw[0]!))
            const tracker = new SequenceTracker(options)
            const reported = new Set<number>()
            const collect = (outs: ReturnType<SequenceTracker['accept']>) => { for (const o of outs) if (o.kind === 'gap') for (let n = o.from; n <= o.to; n++) reported.add(n) }
            arrivals.forEach((v, i) => collect(tracker.accept(v, '', { seq: i, t: i })))
            collect(tracker.finish())
            // oracle: a number is missing when it lies between the smallest and the largest arrival and never arrived
            // (a first arrival anywhere is the start, so numbers below the first value only count if later ones arrive)
            const arrived = new Set(arrivals)
            const first = arrivals[0]!
            const high = Math.max(...arrivals)
            const expected = new Set<number>()
            for (let n = first + 1; n < high; n++) if (!arrived.has(n)) expected.add(n)
            // numbers below the first arrival are regressions, not gaps; numbers never arriving above `first` are gaps
            for (const n of expected) expect(reported.has(n), `missing ${n}`).toBe(true)
            for (const n of reported) expect(arrived.has(n), `${n} arrived but reported`).toBe(false)
        }), { numRuns: 300 })
    })
})
