import { SEVERITY_RANK, type Severity } from '../core/diagnostics/finding'
import type { DoctorView } from './doctorSession'

/** One lane of Multi-Stream as the fleet sees it. */
export interface FleetLane {
    id: string
    name: string
    /** The connection phase, or "not recorded" when the Doctor has nothing for this lane (not started, or recording is off). */
    phase: string
    events: number
    reconnects: number
    /** Time since this lane's newest event; null when it has had none. */
    lastEventAgeMs: number | null
    worst: Severity | null
    open: Record<Severity, number>
    p95LagMs: number | null
    retainedBytes: number
    records: number
}

export interface Fleet {
    lanes: FleetLane[]
    /** Lanes by connection phase. */
    byPhase: Record<string, number>
    events: number
    reconnects: number
    open: Record<Severity, number>
    worst: Severity | null
    /** The lane that has gone longest without an event, among lanes that are open. */
    stalest: { name: string; ageMs: number } | null
    /** The lane whose page processing is slowest. */
    slowest: { name: string; p95LagMs: number } | null
    retainedBytes: number
}

const empty = (): Record<Severity, number> => ({ info: 0, warning: 0, error: 0, critical: 0 })

/** What the fleet is, from each lane's Doctor view. Pure: the strip, the table and the exported file all come from this. */
export function buildFleet(lanes: ReadonlyArray<{ id: string; name: string }>, views: ReadonlyMap<string, DoctorView>): Fleet {
    const out: FleetLane[] = lanes.map((l) => {
        const v = views.get(l.id)
        if (!v) return { id: l.id, name: l.name, phase: 'not recorded', events: 0, reconnects: 0, lastEventAgeMs: null, worst: null, open: empty(), p95LagMs: null, retainedBytes: 0, records: 0 }
        return {
            id: l.id, name: l.name, phase: v.health.phase === 'idle' ? 'not started' : v.health.phase, events: v.health.events, reconnects: v.health.reconnects,
            lastEventAgeMs: v.health.lastEventAgeMs, worst: v.worst, open: v.open, p95LagMs: v.health.consumer?.p95LagMs ?? null,
            retainedBytes: v.health.capture.retainedBytes, records: v.health.capture.records,
        }
    })
    const byPhase: Record<string, number> = {}
    const open = empty()
    let worst: Severity | null = null
    let stalest: Fleet['stalest'] = null
    let slowest: Fleet['slowest'] = null
    for (const l of out) {
        byPhase[l.phase] = (byPhase[l.phase] ?? 0) + 1
        for (const k of Object.keys(open) as Severity[]) open[k] += l.open[k]
        if (l.worst && (worst === null || SEVERITY_RANK[l.worst] > SEVERITY_RANK[worst])) worst = l.worst
        if (l.phase === 'open' && l.lastEventAgeMs !== null && (stalest === null || l.lastEventAgeMs > stalest.ageMs)) stalest = { name: l.name, ageMs: l.lastEventAgeMs }
        if (l.p95LagMs !== null && (slowest === null || l.p95LagMs > slowest.p95LagMs)) slowest = { name: l.name, p95LagMs: l.p95LagMs }
    }
    return {
        lanes: out, byPhase, events: out.reduce((n, l) => n + l.events, 0), reconnects: out.reduce((n, l) => n + l.reconnects, 0),
        open, worst, stalest, slowest, retainedBytes: out.reduce((n, l) => n + l.retainedBytes, 0),
    }
}

/** The fleet as a file: when it was taken, the rates, and one entry per lane. Names and counts only: no URLs, no payloads. */
export function fleetJson(fleet: Fleet, takenAt: Date, ratePerSecond?: number): string {
    return JSON.stringify({
        schemaVersion: 1,
        takenAt: takenAt.toISOString(),
        lanes: fleet.lanes.length,
        byPhase: fleet.byPhase,
        events: fleet.events,
        ...(ratePerSecond !== undefined ? { eventsPerSecond: Math.round(ratePerSecond * 10) / 10 } : {}),
        reconnects: fleet.reconnects,
        openFindings: fleet.open,
        worst: fleet.worst,
        stalest: fleet.stalest,
        slowestConsumer: fleet.slowest,
        perLane: fleet.lanes.map((l) => ({ name: l.name, phase: l.phase, events: l.events, reconnects: l.reconnects, lastEventAgeMs: l.lastEventAgeMs, worst: l.worst, openFindings: l.open, p95LagMs: l.p95LagMs })),
    }, null, 2) + '\n'
}
