import type { EventMessage } from '../types'

/**
 * Events per second over the last `windowMs`, from the arrival times (wall-clock milliseconds) of the events held.
 * Counts the events that arrived in the window and divides by the window, or by the time since the oldest held event
 * when the stream is younger than the window, so a stream that just started is not reported as slow.
 */
export function eventRate(events: readonly EventMessage[], nowMs: number, windowMs = 5000): number {
    if (events.length === 0 || windowMs <= 0) return 0
    const from = nowMs - windowMs
    let count = 0
    let oldest = nowMs
    for (const e of events) {
        const t = e.arrivalTime
        if (t === undefined || t > nowMs) continue
        if (t < from) continue
        count++
        if (t < oldest) oldest = t
    }
    if (count === 0) return 0
    // A stream that started inside the window: divide by how long it has been running, at least one second.
    const span = Math.max(1000, Math.min(windowMs, nowMs - oldest))
    return count / (span / 1000)
}

export function formatRate(perSecond: number): string {
    if (perSecond === 0) return '0 events/s'
    if (perSecond >= 100) return `${Math.round(perSecond)} events/s`
    if (perSecond >= 10) return `${perSecond.toFixed(0)} events/s`
    return `${perSecond.toFixed(1)} events/s`
}

export interface TypeShare {
    type: string
    count: number
    /** 0..1 of all events. */
    share: number
}

/** Every event type with its count and share, largest first; the tail beyond `limit` is folded into one "other" row. */
export function typeShares(events: readonly EventMessage[], limit = 8, typeOf: (e: EventMessage) => string = (e) => e.parsedType || e.type): TypeShare[] {
    // a Map: an event named __proto__ or constructor is an ordinary key
    const counts = new Map<string, number>()
    for (const e of events) {
        const type = typeOf(e)
        counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    const total = events.length
    if (total === 0) return []
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const head = sorted.slice(0, limit).map(([type, count]) => ({ type, count, share: count / total }))
    const rest = sorted.slice(limit).reduce((n, [, c]) => n + c, 0)
    return rest > 0 ? [...head, { type: 'other', count: rest, share: rest / total }] : head
}

export interface EventRow {
    /** The newest event of the run. */
    event: EventMessage
    /** How many identical events in a row this row stands for (1 when nothing was collapsed). */
    count: number
    /** Every event of the run, newest first. */
    members: readonly EventMessage[]
}

const sameContent = (a: EventMessage, b: EventMessage) => a.type === b.type && a.data === b.data && a.streamId === b.streamId

/**
 * The list as rows. With `collapse`, consecutive events with the same name and the same data (a heartbeat, a polled value that did not
 * change) become one row with a count. Only a run of neighbours is collapsed: two identical events with something different between
 * them stay two rows, because the difference is part of what happened. The list is newest first, as the event list is.
 */
export function toRows(events: readonly EventMessage[], collapse: boolean): EventRow[] {
    if (!collapse) return events.map((event) => ({ event, count: 1, members: [event] }))
    const rows: EventRow[] = []
    let run: EventMessage[] = []
    const flush = () => {
        if (run.length > 0) rows.push({ event: run[0]!, count: run.length, members: run })
        run = []
    }
    for (const e of events) {
        if (run.length > 0 && !sameContent(run[run.length - 1]!, e)) flush()
        run.push(e)
    }
    flush()
    return rows
}
