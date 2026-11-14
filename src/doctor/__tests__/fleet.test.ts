import { describe, expect, it } from 'vitest'
import { buildFleet, fleetJson } from '../fleet'
import type { DoctorView } from '../doctorSession'

const open = (o: Partial<Record<'info' | 'warning' | 'error' | 'critical', number>> = {}) => ({ info: 0, warning: 0, error: 0, critical: 0, ...o })

function view(over: { phase?: string; events?: number; reconnects?: number; lastEventAgeMs?: number | null; worst?: DoctorView['worst']; open?: ReturnType<typeof open>; lag?: number | null; bytes?: number } = {}): DoctorView {
    return {
        streamId: 'x', captureId: 'c', profile: undefined, nowT: 0, findings: [], coverage: [],
        open: over.open ?? open(), worst: over.worst ?? null, evaluated: 0, notEvaluated: 0,
        health: {
            phase: over.phase ?? 'open', attempt: 0, phaseAgeMs: 0, lastByteAgeMs: null, lastOriginAgeMs: null, lastEventAgeMs: over.lastEventAgeMs === undefined ? 100 : over.lastEventAgeMs,
            proxyBeatAgeMs: null, originBeats: 0, proxyBeats: 0, originBeatMedianMs: null, events: over.events ?? 10, reconnects: over.reconnects ?? 0,
            consumer: over.lag === undefined || over.lag === null ? null : { samples: 5, p95LagMs: over.lag, queueDepth: 0 },
            capture: { records: 20, retainedBytes: over.bytes ?? 1000, capBytes: 8_388_608, dropped: 0 },
        },
    }
}

const lanes = [{ id: 'a', name: 'orders' }, { id: 'b', name: 'prices' }, { id: 'c', name: 'audit' }]

describe('buildFleet', () => {
    it('adds the lanes up: events, reconnects, open findings, bytes, and counts them by phase', () => {
        const views = new Map([
            ['a', view({ events: 100, reconnects: 1, open: open({ warning: 2 }), worst: 'warning', bytes: 500 })],
            ['b', view({ events: 50, phase: 'reconnecting', open: open({ error: 1, info: 3 }), worst: 'error', bytes: 700 })],
            ['c', view({ events: 5, phase: 'failed' })],
        ])
        const f = buildFleet(lanes, views)
        expect(f.events).toBe(155)
        expect(f.reconnects).toBe(1)
        expect(f.open).toEqual({ info: 3, warning: 2, error: 1, critical: 0 })
        expect(f.worst).toBe('error')
        expect(f.retainedBytes).toBe(2200)
        expect(f.byPhase).toEqual({ open: 1, reconnecting: 1, failed: 1 })
    })

    it('names the lane that has gone longest without an event, among open lanes only', () => {
        const views = new Map([
            ['a', view({ lastEventAgeMs: 400 })],
            ['b', view({ lastEventAgeMs: 9000 })],
            ['c', view({ lastEventAgeMs: 90_000, phase: 'failed' })], // not open: it is failing, not quiet
        ])
        expect(buildFleet(lanes, views).stalest).toEqual({ name: 'prices', ageMs: 9000 })
    })

    it('has no stalest lane when none is open or none has had an event', () => {
        expect(buildFleet(lanes, new Map([['a', view({ phase: 'ended' })]])).stalest).toBeNull()
        expect(buildFleet(lanes, new Map([['a', view({ lastEventAgeMs: null })]])).stalest).toBeNull()
    })

    it('names the lane whose page processing is slowest', () => {
        const views = new Map([['a', view({ lag: 20 })], ['b', view({ lag: 480 })], ['c', view({ lag: null })]])
        expect(buildFleet(lanes, views).slowest).toEqual({ name: 'prices', p95LagMs: 480 })
    })

    it('says "not recorded" for a lane the Doctor has nothing for, and "not started" for one that has not begun', () => {
        const f = buildFleet(lanes, new Map([['a', view({ phase: 'idle' })]]))
        expect(f.lanes.map((l) => l.phase)).toEqual(['not started', 'not recorded', 'not recorded'])
        expect(f.byPhase).toEqual({ 'not started': 1, 'not recorded': 2 })
    })

    it('is empty and calm with no lanes', () => {
        const f = buildFleet([], new Map())
        expect(f).toMatchObject({ lanes: [], events: 0, worst: null, stalest: null, slowest: null })
    })

    it('does not change the views it was given', () => {
        const v = view({ open: open({ warning: 1 }), worst: 'warning' })
        buildFleet(lanes, new Map([['a', v], ['b', v]]))
        expect(v.open).toEqual({ info: 0, warning: 1, error: 0, critical: 0 })
    })
})

describe('fleetJson', () => {
    it('is a file with the totals and one entry per lane, and holds no URL or payload', () => {
        const f = buildFleet(lanes, new Map([['a', view({ events: 7, worst: 'warning', open: open({ warning: 1 }) })]]))
        const parsed = JSON.parse(fleetJson(f, new Date('2026-01-02T03:04:05Z'), 12.34))
        expect(parsed).toMatchObject({ schemaVersion: 1, takenAt: '2026-01-02T03:04:05.000Z', lanes: 3, events: 7, eventsPerSecond: 12.3, worst: 'warning' })
        expect(parsed.perLane).toHaveLength(3)
        expect(parsed.perLane[0]).toMatchObject({ name: 'orders', phase: 'open', events: 7 })
        expect(JSON.stringify(parsed)).not.toMatch(/https?:\/\//)
    })

    it('leaves the rate out when it was not measured', () => {
        expect(JSON.parse(fleetJson(buildFleet([], new Map()), new Date(0)))).not.toHaveProperty('eventsPerSecond')
    })
})
