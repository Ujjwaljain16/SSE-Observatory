import { describe, it, expect } from 'vitest'
import { PatternEngine, typeMatches, type BurstRule, type SequenceRule } from '../patternEngine'
import type { EventMessage } from '../../types'

let n = 0
const ev = (type: string, t: number, parsedType?: string): EventMessage =>
    ({ id: `e${n++}`, type, timestamp: '', data: '', raw: '', arrivalTime: t, ...(parsedType ? { parsedType } : {}) })

const burst = (over: Partial<BurstRule> = {}): BurstRule =>
    ({ id: 'b', kind: 'burst', name: 'burst', eventType: 'error', count: 3, windowMs: 1000, enabled: true, ...over })
const seq = (pattern: string[], over: Partial<SequenceRule> = {}): SequenceRule =>
    ({ id: 's', kind: 'sequence', name: 'seq', pattern, enabled: true, ...over })

describe('typeMatches', () => {
    it('matches the SSE event name or the JSON type, with * and prefix wildcards', () => {
        expect(typeMatches({ type: 'message', parsedType: 'order.created' }, 'order.created')).toBe(true)
        expect(typeMatches({ type: 'error' }, 'error')).toBe(true)
        expect(typeMatches({ type: 'message', parsedType: 'payment_failed' }, 'payment_*')).toBe(true)
        expect(typeMatches({ type: 'x' }, '*')).toBe(true)
        expect(typeMatches({ type: 'x' }, 'y')).toBe(false)
    })
})

describe('burst rules', () => {
    it('raises ONE alert per burst, not one per extra event', () => {
        const engine = new PatternEngine()
        const alerts = engine.process([1, 2, 3, 4, 5, 6, 7].map((i) => ev('error', i * 10)), [burst()])
        expect(alerts).toHaveLength(1)
        expect(alerts[0].eventCount).toBe(3)
        expect(alerts[0].kind).toBe('burst')
    })

    it('re-arms after the rate drops, so the next burst alerts again', () => {
        const engine = new PatternEngine()
        const first = engine.process([ev('error', 0), ev('error', 100), ev('error', 200)], [burst()])
        expect(first).toHaveLength(1)
        // long silence, then a second burst
        const second = engine.process([ev('error', 5000), ev('error', 5100), ev('error', 5200)], [burst()])
        expect(second).toHaveLength(1)
    })

    it('does not fire when events are spread wider than the window', () => {
        const engine = new PatternEngine()
        const alerts = engine.process([0, 600, 1200, 1800, 2400, 3000].map((t) => ev('error', t)), [burst({ count: 3, windowMs: 1000 })])
        expect(alerts).toHaveLength(0)
    })

    it('ignores other event types and works with historical timestamps (replay)', () => {
        const engine = new PatternEngine()
        const t0 = 1_000_000_000_000
        const alerts = engine.process([ev('info', t0), ev('error', t0 + 1), ev('error', t0 + 2), ev('info', t0 + 3), ev('error', t0 + 4)], [burst()])
        expect(alerts).toHaveLength(1)
    })

    it('processes incrementally: feeding events in pieces equals feeding them at once', () => {
        const events = [0, 10, 20, 30, 5000, 5010, 5020].map((t) => ev('error', t))
        const whole = new PatternEngine().process(events, [burst()])
        const pieces = new PatternEngine()
        const got = [...pieces.process(events.slice(0, 2), [burst()]), ...pieces.process(events.slice(2, 5), [burst()]), ...pieces.process(events.slice(5), [burst()])]
        expect(got).toHaveLength(whole.length)
        expect(got).toHaveLength(2)
    })

    it('caps the events attached to an alert but reports the true count', () => {
        const alerts = new PatternEngine().process(Array.from({ length: 500 }, (_, i) => ev('error', i)), [burst({ count: 200, windowMs: 10_000 })])
        expect(alerts[0].eventCount).toBe(200)
        expect(alerts[0].events).toHaveLength(50)
    })
})

describe('sequence rules', () => {
    it('detects consecutive events in order, including wildcards', () => {
        const engine = new PatternEngine()
        const events = [ev('a', 1), ev('x', 2), ev('payment_failed', 3), ev('retry', 4), ev('retry', 5), ev('b', 6)]
        const alerts = engine.process(events, [seq(['payment_*', 'retry', '*'])])
        expect(alerts).toHaveLength(1)
        expect(alerts[0].events.map((e) => e.type)).toEqual(['payment_failed', 'retry', 'retry'])
    })

    it('matches do not overlap', () => {
        const alerts = new PatternEngine().process([ev('a', 1), ev('a', 2), ev('a', 3), ev('a', 4), ev('a', 5)], [seq(['a', 'a'])])
        expect(alerts).toHaveLength(2)
    })

    it('does not match when something else sits in between', () => {
        expect(new PatternEngine().process([ev('a', 1), ev('x', 2), ev('b', 3)], [seq(['a', 'b'])])).toHaveLength(0)
    })

    it('an empty pattern never fires', () => {
        expect(new PatternEngine().process([ev('a', 1)], [seq([])])).toHaveLength(0)
    })
})

describe('rule management', () => {
    it('a newly added rule is evaluated against the existing buffer (backlog), others only see new events', () => {
        const engine = new PatternEngine()
        const history = [ev('error', 0), ev('error', 10), ev('error', 20)]
        expect(engine.process(history, [])).toHaveLength(0)
        const alerts = engine.process([], [burst()], () => history)
        expect(alerts).toHaveLength(1)
        // same rule again with no new events: nothing more
        expect(engine.process([], [burst()], () => history)).toHaveLength(0)
    })

    it('editing a rule resets its state; disabled rules are ignored', () => {
        const engine = new PatternEngine()
        const history = [ev('error', 0), ev('error', 10), ev('error', 20)]
        expect(engine.process(history, [burst()], () => history)).toHaveLength(1)
        expect(engine.process([], [burst({ count: 2 })], () => history)).toHaveLength(1) // edited → re-evaluated
        expect(engine.process([], [burst({ count: 2, enabled: false })], () => history)).toHaveLength(0)
    })

    it('reset() forgets everything', () => {
        const engine = new PatternEngine()
        const history = [ev('error', 0), ev('error', 10), ev('error', 20)]
        engine.process(history, [burst()], () => history)
        engine.reset()
        expect(engine.process([], [burst()], () => history)).toHaveLength(1)
    })
})
