// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { analyze, createEngine } from '../engine'
import type { Finding } from '../finding'
import { healthyStart, type CaptureBuilder } from '../../testing/captureBuilder'

// Results Q13, second stage (decided): gaps that were stalls stay out of the stream's rhythm (stage 1), but a cadence that has really changed
// is recognised after THREE consecutive gaps that were all stalls and agree with each other (each within 25% of their median). Then the baseline
// is rebuilt from those three gaps, the stall is kept as resolved history, and an informational finding says the cadence was inferred to have
// changed. A declared longest silence (the profile's `expected.maxSilenceMs`) is never overridden. Sporadic interruptions are never learned.

const STALL = 'stall.silent:bytes'
const CHANGED = 'cadence.changed:bytes'
const find = (findings: Finding[], key: string) => findings.find((f) => f.key === key)

/** A stream that talks every second (twelve events: eleven gaps, enough for its own rhythm: a stall is anything beyond 3 s). */
const talking = (n = 12): CaptureBuilder => { const b = healthyStart(); for (let i = 0; i < n; i++) b.silence(1000).frame('tick', String(i + 1)); return b }
/** Gaps of the given lengths, each ended by an event. */
const gaps = (b: CaptureBuilder, ...ms: number[]): CaptureBuilder => { for (const g of ms) b.silence(g).frame('tick'); return b }
const result = (b: CaptureBuilder, options: Parameters<typeof analyze>[1] = {}) => analyze(b.build(), { endT: b.now, ...options })

describe('a single abnormal stall is not a new cadence', () => {
    it('is reported once, stays out of the rhythm, and nothing about a cadence is said', () => {
        const a = result(gaps(talking(), 8000, 1000, 1000))
        expect(find(a.findings, STALL)).toMatchObject({ status: 'resolved', occurrences: 1 })
        expect(a.findings.some((f) => f.key.startsWith('cadence.changed'))).toBe(false)
        expect(a.model.baseline.byte.p95()).toBe(1000)
    })

    it('two consecutive stalls are both reported, still open as a silence goes on, and are not yet a cadence (three are needed)', () => {
        const a = result(gaps(talking(), 8000, 8000))
        expect(find(a.findings, STALL)).toMatchObject({ status: 'resolved', occurrences: 2 })
        expect(a.findings.some((f) => f.key.startsWith('cadence.changed'))).toBe(false)
        expect(a.model.baseline.byte.count, 'the stalls are not in the rhythm').toBe(11)
        // a third silence that is going on is a stall in progress, judged against the old rhythm
        const b = gaps(talking(), 8000, 8000)
        const engine = createEngine()
        for (const o of b.build()) { engine.feed(o); engine.tick(o.t) }
        engine.tick(b.now + 8000)
        expect(find(engine.findings(), STALL)).toMatchObject({ status: 'open', occurrences: 3 })
    })
})

describe('three consecutive, consistent stalls are recognised as a new cadence', () => {
    const shifted = () => result(gaps(talking(), 8000, 8000, 8000))

    it('keeps the stall as resolved history (every number kept), says the cadence changed, and rebuilds the rhythm from the three gaps', () => {
        const a = shifted()
        const stall = find(a.findings, STALL)!
        expect(stall).toMatchObject({ status: 'resolved', occurrences: 3, severity: 'error' })
        expect(stall.facts[0]!.text, 'what the stall was').toContain('No bytes arrived for 8 s')
        const note = stall.facts.at(-1)!
        expect(note.text).toMatch(/cadence was then recognised as changed/)
        expect(note.text).toContain('cadence.changed:bytes')
        expect(a.model.baseline.byte.count).toBe(3)
        expect(a.model.baseline.byte.p95()).toBe(8000)
        expect(a.model.gaps.byte.maxEver, 'the longest gap ever seen is still known').toBe(8000)
    })

    it('emits one informational finding with the old and the new cadence, the three gaps with evidence, and says it is inferred', () => {
        const f = find(shifted().findings, CHANGED)!
        expect(f).toMatchObject({ severity: 'info', status: 'open', occurrences: 1, title: 'Delivery cadence changed' })
        expect(f.summary).toBe('The gaps between bytes changed from about 1 s to about 8 s, inferred from three consecutive silences.')
        expect(f.facts.map((x) => x.text)).toEqual([
            'Before, the stream\'s own rhythm was a p95 gap of 1 s over 11 gaps, so a silence beyond 3 s was a stall.',
            'Three consecutive silences were each beyond that limit and agree with each other within 25% of their median: 8 s, 8 s and 8 s (median 8 s).',
            'Silence 1: 8 s, after the last byte at t=12 s.',
            'Silence 2: 8 s, after the last byte at t=20 s.',
            'Silence 3: 8 s, after the last byte at t=28 s.',
            'From here on the stream\'s own rhythm is the new one: a silence beyond 24 s is a stall.',
        ])
        // the three silences point at real records: the last byte before and the byte that ended each
        for (const fact of f.facts.slice(2, 5)) expect(fact.evidence).toHaveLength(2)
        expect(f.facts[2]!.evidence.map((e) => e.note)).toEqual(['last byte', 'data resumed'])
        expect(f.deductions[0]!.statement).toMatch(/^Likely: /)
        expect(f.deductions[0]!.statement).toContain('not proof of what the producer intended')
        expect(f.limits.join(' ')).toMatch(/inferred from the stream's own intervals/)
        expect(f.firstSeenT).toBe(f.lastSeenT)
    })

    it('after the change, gaps like the new ones are not stalls (they would have been under the old limit)', () => {
        const a = result(gaps(talking(), 8000, 8000, 8000, 8000, 9000, 7000))
        expect(find(a.findings, STALL)).toMatchObject({ status: 'resolved', occurrences: 3 })
        expect(a.model.baseline.byte.count).toBe(6)
    })

    it('a silence in progress after the change is judged by the new rhythm: not a stall at 24 s, a stall beyond', () => {
        const b = gaps(talking(), 8000, 8000, 8000)
        const live = createEngine()
        for (const o of b.build()) { live.feed(o); live.tick(o.t) }
        live.tick(b.now + 24_000)
        expect(find(live.findings(), STALL), 'at the limit').toMatchObject({ status: 'resolved', occurrences: 3 })
        live.tick(b.now + 24_001)
        expect(find(live.findings(), STALL), 'a millisecond beyond').toMatchObject({ status: 'open', occurrences: 4 })
    })

    it('a new stall after the change is judged against the new rhythm, and reopens the finding with its count raised', () => {
        const justInside = result(gaps(talking(), 8000, 8000, 8000, 24_000))
        expect(find(justInside.findings, STALL)).toMatchObject({ status: 'resolved', occurrences: 3 })
        const justOutside = result(gaps(talking(), 8000, 8000, 8000, 24_001))
        expect(find(justOutside.findings, STALL)).toMatchObject({ status: 'resolved', occurrences: 4 })
        const ongoing = result(gaps(talking(), 8000, 8000, 8000).silence(30_000))
        expect(find(ongoing.findings, STALL)).toMatchObject({ status: 'open', occurrences: 4 })
    })

    it('a live engine and a batch analysis give the same findings at the end, and what a record committed stays', () => {
        const b = gaps(talking(), 8000, 8000, 8000, 1000, 1000)
        const records = b.build()
        const engine = createEngine()
        let committed = 0
        for (const o of records) {
            engine.tick(o.t)
            engine.feed(o)
            const n = engine.findings().filter((f) => f.key.startsWith('cadence.changed')).length
            expect(n, 'a recognised change does not go away').toBeGreaterThanOrEqual(committed)
            committed = n
        }
        engine.tick(b.now); engine.end(b.now)
        expect(engine.findings()).toEqual(analyze(records, { endT: b.now }).findings)
    })

    it('another change later is a second occurrence of the same finding, with the newer numbers', () => {
        const a = result(gaps(talking(), 8000, 8000, 8000, 60_000, 60_000, 60_000))
        const f = find(a.findings, CHANGED)!
        expect(f).toMatchObject({ occurrences: 2, severity: 'info' })
        expect(f.summary).toContain('about 8 s to about 60 s')
    })
})

describe('sporadic interruptions are never learned', () => {
    it.each([
        ['stall, normal, stall, normal, stall', [8000, 1000, 8000, 1000, 8000], 3],
        ['stall, stall, normal, stall', [8000, 8000, 1000, 8000], 3],
        ['many stalls, each separated by a normal gap', [8000, 1000, 8000, 1000, 8000, 1000, 8000, 1000], 4],
    ])('%s', (_name, lengths, stalls) => {
        const a = result(gaps(talking(), ...lengths))
        expect(find(a.findings, STALL)).toMatchObject({ occurrences: stalls })
        expect(a.findings.some((f) => f.key.startsWith('cadence.changed'))).toBe(false)
        expect(a.model.baseline.byte.p95(), 'the rhythm is still the old one').toBe(1000)
    })

    it('three stalls that do not agree with each other are not a cadence: 8, 12 and 20 s', () => {
        const a = result(gaps(talking(), 8000, 12_000, 20_000))
        expect(find(a.findings, STALL)).toMatchObject({ occurrences: 3 })
        expect(a.findings.some((f) => f.key.startsWith('cadence.changed'))).toBe(false)
    })

    it('three consecutive stalls need to be on one connection: a reconnect starts the count again', () => {
        const b = gaps(talking(), 8000, 8000).reconnect({ delayMs: 500 }).silence(500).connect({ sentLastEventId: '14' }).response().frame('tick')
        gaps(b, 8000)
        const a = result(b)
        expect(find(a.findings, STALL)).toMatchObject({ occurrences: 3 })
        expect(a.findings.some((f) => f.key.startsWith('cadence.changed')), 'two before the reconnect and one after are not three on a connection').toBe(false)
        // while three on the new connection are
        const c = gaps(talking(), 8000, 8000).reconnect({ delayMs: 500 }).silence(500).connect({ sentLastEventId: '14' }).response().frame('tick')
        gaps(c, 8000, 8000, 8000)
        expect(find(result(c).findings, CHANGED)).toBeDefined()
    })

    it('a stall that ended with the connection closing breaks the run', () => {
        const b = gaps(talking(), 8000, 8000).silence(8000).reconnect({ delayMs: 500 }).silence(500).connect().response().frame('tick')
        gaps(b, 8000)
        expect(result(b).findings.some((f) => f.key.startsWith('cadence.changed'))).toBe(false)
    })
})

describe('how consistent three gaps must be: each within 25% of their median', () => {
    it.each([
        ['8, 8 and 10 s (+25% of the median, the edge)', [8000, 8000, 10_000], true],
        ['8, 8 and 10.001 s (just outside)', [8000, 8000, 10_001], false],
        ['6, 8 and 8 s (-25%, the edge)', [6000, 8000, 8000], true],
        ['5.999, 8 and 8 s (just outside)', [5999, 8000, 8000], false],
        ['order does not matter: 10, 8, 8 s', [10_000, 8000, 8000], true],
        ['jitter inside the band: 7.5, 8 and 8.7 s', [7500, 8000, 8700], true],
    ])('%s', (_name, lengths, recognised) => {
        const a = result(gaps(talking(), ...lengths))
        expect(find(a.findings, STALL)).toMatchObject({ occurrences: 3 })
        expect(find(a.findings, CHANGED) !== undefined).toBe(recognised)
        expect(a.model.baseline.byte.count).toBe(recognised ? 3 : 11)
    })

    it('the last three gaps are what counts: 8, 12, 8, 8, 8 s is recognised after the fifth (8, 12, 8 are not consistent, 12, 8, 8 are not either)', () => {
        const a = result(gaps(talking(), 8000, 12_000, 8000, 8000, 8000))
        expect(find(a.findings, CHANGED)).toMatchObject({ occurrences: 1 })
        expect(find(a.findings, STALL)).toMatchObject({ occurrences: 5 })
    })
})

describe("a declared longest silence is authoritative: a cadence that breaks it is never learned", () => {
    const declared = (maxSilenceMs: number) => ({ profile: { expected: { maxSilenceMs } } })

    it('the same three 8 s gaps are learned when 10 s is declared, and never when 5 s is', () => {
        const learned = result(gaps(talking(), 8000, 8000, 8000), declared(10_000))
        expect(find(learned.findings, CHANGED)).toBeDefined()
        const refused = result(gaps(talking(), 8000, 8000, 8000), declared(5000))
        expect(find(refused.findings, STALL)).toMatchObject({ occurrences: 3 })
        expect(refused.findings.some((f) => f.key.startsWith('cadence.changed'))).toBe(false)
        expect(refused.model.baseline.byte.p95()).toBe(1000)
    })

    it('and goes on reporting every further 8 s silence as a stall, however many come', () => {
        const a = result(gaps(talking(), 8000, 8000, 8000, 8000, 8000, 8000), declared(5000))
        expect(find(a.findings, STALL)).toMatchObject({ occurrences: 6 })
        expect(a.findings.some((f) => f.key.startsWith('cadence.changed'))).toBe(false)
    })

    it('the edge is the declared value itself: three gaps of exactly 8 s are learned under a declared 8 s, not under 7.999 s', () => {
        expect(find(result(gaps(talking(), 8000, 8000, 8000), declared(8000)).findings, CHANGED)).toBeDefined()
        expect(find(result(gaps(talking(), 8000, 8000, 8000), declared(7999)).findings, CHANGED)).toBeUndefined()
    })

    it('one gap over the declared limit is enough to refuse the three, even if the median is inside it', () => {
        // 8, 8 and 9 s agree with each other; 9 s is over a declared 8.5 s
        expect(find(result(gaps(talking(), 8000, 8000, 9000), declared(8500)).findings, CHANGED)).toBeUndefined()
        expect(find(result(gaps(talking(), 8000, 8000, 9000), declared(9000)).findings, CHANGED)).toBeDefined()
    })
})
