import type { Observation } from '../core/observe/observation'

/**
 * How events flowed through the page: when each arrived from the network, and how long the page took to process them. Pure, so the
 * drawing, the table under it and the tests all read the same figures.
 *
 * What is observed, and so shown: the time each event arrived (the recorder's clock), the bytes read between events, reconnects, and
 * the page's own processing batches (each batch says how many events it took, how long the oldest of them waited, and how many were
 * still queued). What is NOT observed, and never drawn: when the producer created or wrote an event, how long it sat in a proxy, and how
 * long the parser took (it is part of the wait, not separated from it). A batch's wait is for its oldest event, so it is an upper bound
 * for the rest of the batch.
 */

export interface FlowEvent {
    seq: number
    t: number
    conn: number
    /** Time since the previous event; null for the first. */
    gapMs: number | null
    /** Bytes read from the network since the previous event. */
    bytes: number
}

/** One run of the page's processing, in the recorder's clock. */
export interface FlowBatch {
    receivedT: number
    processedT: number
    n: number
    queueDepth: number
    lagMs: number
}

export interface Quantiles { p50: number; p95: number; max: number }

export interface Flow {
    events: FlowEvent[]
    batches: FlowBatch[]
    /** When the connection was made again, within the span. */
    reconnects: number[]
    span: { fromT: number; toT: number }
    summary: {
        events: number
        bytes: number
        eventsPerSecond: number
        gap: Quantiles | null
        page: { batches: number; processed: number; wait: Quantiles; slowShare: number; maxQueueDepth: number } | null
    }
}

export const FLOW_MAX_EVENTS = 200
/** A batch that waited longer than this is "slow" (the same limit the page-lag check uses). */
export const SLOW_WAIT_MS = 250

function quantiles(values: number[]): Quantiles | null {
    if (values.length === 0) return null
    const s = [...values].sort((a, b) => a - b)
    const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!
    return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1]! }
}

/** The newest `maxEvents` events of the recording and the page batches that fall in the same stretch of time. */
export function buildFlow(records: readonly Observation[], batches: readonly FlowBatch[], maxEvents = FLOW_MAX_EVENTS): Flow {
    const all: FlowEvent[] = []
    let prevT: number | null = null
    let bytes = 0
    for (const r of records) {
        if (r.kind === 'chunk') bytes += r.bytes
        else if (r.kind === 'event') {
            all.push({ seq: r.seq, t: r.t, conn: r.conn, gapMs: prevT === null ? null : Math.max(0, r.t - prevT), bytes })
            prevT = r.t
            bytes = 0
        }
    }
    const events = all.length > maxEvents ? all.slice(all.length - maxEvents) : all
    const fromT = events[0]?.t ?? 0
    const toT = events[events.length - 1]?.t ?? 0
    const inSpan = batches.filter((b) => b.processedT >= fromT && b.receivedT <= toT + SLOW_WAIT_MS * 4)
    const reconnects = records.filter((r) => r.kind === 'connect' && r.conn > 0 && r.t >= fromT && r.t <= toT).map((r) => r.t)

    const gaps = events.map((e) => e.gapMs).filter((g): g is number => g !== null)
    const waits = inSpan.map((b) => b.lagMs)
    const slow = inSpan.filter((b) => b.lagMs > SLOW_WAIT_MS).length
    const seconds = (toT - fromT) / 1000
    return {
        events, batches: inSpan, reconnects, span: { fromT, toT },
        summary: {
            events: events.length,
            bytes: events.reduce((n, e) => n + e.bytes, 0),
            eventsPerSecond: seconds > 0 ? (events.length - 1) / seconds : 0,
            gap: quantiles(gaps),
            page: inSpan.length === 0 ? null : {
                batches: inSpan.length, processed: inSpan.reduce((n, b) => n + b.n, 0), wait: quantiles(waits)!,
                slowShare: slow / inSpan.length, maxQueueDepth: inSpan.reduce((m, b) => Math.max(m, b.queueDepth), 0),
            },
        },
    }
}

/** The plain sentences under the drawing: what was measured, then what was not. */
export function flowStatements(flow: Flow): string[] {
    const s = flow.summary
    const out: string[] = []
    const ms = (n: number) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`)
    if (s.events === 0) return ['No events have arrived yet.']
    out.push(`${s.events.toLocaleString()} event${s.events === 1 ? '' : 's'} arrived over ${ms(flow.span.toT - flow.span.fromT)}${s.events > 1 ? `, about ${s.eventsPerSecond < 10 ? s.eventsPerSecond.toFixed(1) : Math.round(s.eventsPerSecond)} a second` : ''}.`)
    if (s.gap) out.push(`The time between events was ${ms(s.gap.p50)} in the middle, ${ms(s.gap.p95)} for the slowest 5%, and at most ${ms(s.gap.max)}.`)
    if (s.page) {
        out.push(`The page processed them in ${s.page.batches.toLocaleString()} batch${s.page.batches === 1 ? '' : 'es'}. The oldest event of a batch waited ${ms(s.page.wait.p50)} in the middle, ${ms(s.page.wait.p95)} for the slowest 5%, and at most ${ms(s.page.wait.max)}.`)
        if (s.page.slowShare > 0) out.push(`${Math.round(s.page.slowShare * 100)}% of the batches waited longer than ${SLOW_WAIT_MS} ms${s.page.maxQueueDepth > 0 ? `; up to ${s.page.maxQueueDepth.toLocaleString()} events were queued at once` : ''}.`)
        if (s.gap && s.page.wait.p95 > s.gap.p50 * 2 && s.page.wait.p95 > 100) out.push('The wait is longer than the usual time between events, so the page is processing events more slowly than they arrive.')
    } else out.push('The page has not reported processing times for these events, so how long they waited for it is not known.')
    out.push('Not measured: when the producer created or wrote each event, how long one sat in a proxy, and how long parsing took (it is part of the wait, not separated from it).')
    return out
}
