import { describe, expect, it } from 'vitest'
import { analyze, createEngine } from '../../engine'
import type { EngineInput } from '../../streamModel'
import { healthyStart } from '../../../testing/captureBuilder'
import { shapeOfValue } from '../../../observe/payloadShape'

const KEY = (name: string) => `schema.drift:${name}`
const base = { id: 1, price: 9.5, qty: 2 }

interface E { name?: string; payload: unknown }

/** A healthy stream whose events carry the shape of the given payloads, in order. */
function stream(events: E[]): { records: EngineInput[]; endT: number } {
    const b = healthyStart()
    for (const e of events) b.silence(100).frame(e.name ?? 'tick', '')
    const records = b.build()
    let i = 0
    return { records: records.map((r) => (r.kind === 'event' ? { ...r, extracted: { shape: shapeOfValue(events[i++]!.payload) } } : r)), endT: b.now }
}
const many = (n: number, payload: unknown, name?: string): E[] => Array.from({ length: n }, () => ({ payload, ...(name ? { name } : {}) }))
const run = (events: E[]) => { const { records, endT } = stream(events); return analyze(records, { endT }) }
const drift = (events: E[], name = 'tick') => run(events).findings.find((f) => f.key === KEY(name))
const coverage = (events: E[]) => run(events).coverage.find((c) => c.ruleId === 'schema.drift')!

describe('R16 schema.drift', () => {
    it('says nothing about a stream whose events keep their shape', () => {
        expect(drift(many(60, base))).toBeUndefined()
        expect(coverage(many(60, base)).status).toBe('evaluated')
    })

    it('reports a field that is gone, as a warning, with what it was and the events that show it', () => {
        const events = [...many(20, base), ...many(10, { id: 1, qty: 2 })]
        const f = drift(events)!
        expect(f).toBeDefined()
        expect(f.severity).toBe('warning')
        expect(f.title).toBe('Payload format changed: tick')
        expect(f.summary).toContain('1 field gone (price)')
        expect(f.facts[0]!.text).toMatch(/first 20 "tick" events had the fields .*price/)
        expect(f.facts[1]!.text).toMatch(/10 of the last 10 "tick" events share a different shape/)
        expect(f.deductions[0]!.statement).toMatch(/^Likely: the producer changed the payload format/)
        expect(f.deductions[0]!.alternatives.length).toBeGreaterThan(1)
        expect(f.limits[0]).toMatch(/structure of JSON payloads/)
        expect(f.status).toBe('open')
    })

    it('points its evidence at records that are in the capture, an event before the change and one after it', () => {
        const { records, endT } = stream([...many(20, base), ...many(10, { id: 1, qty: 2 })])
        const f = analyze(records, { endT }).findings.find((x) => x.key === KEY('tick'))!
        const seqs = new Set(records.map((r) => r.seq))
        const evidence = f.facts.flatMap((x) => x.evidence)
        expect(evidence.length).toBeGreaterThan(1)
        for (const e of evidence) {
            expect(seqs.has(e.seq)).toBe(true)
            expect(records.find((r) => r.seq === e.seq)!.t).toBe(e.t)
        }
    })

    it('calls a new field alone an info note, not a warning', () => {
        const f = drift([...many(20, base), ...many(10, { ...base, discount: 0.1 })])!
        expect(f.severity).toBe('info')
        expect(f.summary).toContain('1 field new (discount)')
    })

    it('reports a field that changed kind, and says from what to what', () => {
        const f = drift([...many(20, base), ...many(10, { ...base, qty: '2' })])!
        expect(f.severity).toBe('warning')
        expect(f.summary).toContain('qty: a number → text')
    })

    it('is not moved by a single odd event, such as an error payload', () => {
        const events = [...many(20, base), ...many(4, base), { payload: { error: 'x' } }, ...many(5, base)]
        expect(drift(events)).toBeUndefined()
    })

    it('does not call it a change when the recent shape is one the baseline already had (an optional field)', () => {
        const withTag = { ...base, tag: 'a' }
        const baseline = [...many(14, base), ...many(6, withTag)] // the tag is optional: 30% of the baseline has it
        expect(drift([...baseline, ...many(10, withTag)])).toBeUndefined()
        expect(drift([...baseline, ...many(10, base)])).toBeUndefined()
    })

    it('does not depend on the order a producer writes its keys in', () => {
        const events = [...many(20, { a: 1, b: 2, c: 3 }), ...many(10, { c: 3, b: 2, a: 1 })]
        expect(drift(events)).toBeUndefined()
    })

    it('resolves the finding when the events go back to the shape they had', () => {
        const f = drift([...many(20, base), ...many(10, { id: 1, qty: 2 }), ...many(10, base)])!
        expect(f.status).toBe('resolved')
        expect(f.summary).toMatch(/back to the shape/)
    })

    it('keeps each event name apart: a change in one does not mark the other', () => {
        const events = [...many(20, base, 'tick'), ...many(20, { sku: 'a', n: 1 }, 'order'), ...many(10, { id: 1, qty: 2 }, 'tick'), ...many(10, { sku: 'a', n: 2 }, 'order')]
        const r = run(events)
        expect(r.findings.find((f) => f.key === KEY('tick'))).toBeDefined()
        expect(r.findings.find((f) => f.key === KEY('order'))).toBeUndefined()
    })

    it('names an event without a name "message"', () => {
        const b = healthyStart()
        for (let i = 0; i < 30; i++) b.silence(100).frame('message', '')
        const records = b.build()
        let i = 0
        const marked = records.map((r) => (r.kind === 'event' ? { ...r, event: '', extracted: { shape: shapeOfValue(i++ < 20 ? base : { id: 1 }) } } : r))
        expect(analyze(marked, { endT: b.now }).findings.some((f) => f.key === KEY('message'))).toBe(true)
    })

    it('is not evaluated before an event name has a baseline, or when no event carries a shape, and says why', () => {
        const few = coverage(many(8, base))
        expect(few.status).toBe('not-evaluated')
        expect(few.notes.join(' ')).toMatch(/reached 20 events/)
        const none = coverage(Array.from({ length: 30 }, () => ({ payload: 'plain text' })))
        expect(none.status).toBe('not-evaluated')
        expect(none.notes.join(' ')).toMatch(/No event carried a payload shape/)
    })

    it('gives the same findings fed live as analysed offline', () => {
        const { records, endT } = stream([...many(20, base), ...many(10, { id: 1, qty: 2 }), ...many(10, base)])
        const engine = createEngine({})
        records.forEach((o, i) => { if (i % 3 === 0) engine.tick(o.t); engine.feed(o) })
        engine.tick(endT)
        engine.end(endT)
        const live = engine.findings().filter((f) => f.ruleId === 'schema.drift')
        const batch = analyze(records, { endT }).findings.filter((f) => f.ruleId === 'schema.drift')
        expect(live).toEqual(batch)
    })

    it('stays bounded for a stream whose every event has a different shape', () => {
        const events = Array.from({ length: 3000 }, (_, i) => ({ payload: { id: i, [`f${i}`]: i } }))
        const t0 = performance.now()
        expect(() => run(events)).not.toThrow()
        expect(performance.now() - t0).toBeLessThan(5000)
    })
})
