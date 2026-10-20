/**
 * The engine's running picture of a stream, updated once per observation. Rules read it; they never write to it.
 *
 * Three silence clocks are kept per connection, because "nothing is arriving" means different things:
 *  - byte    any bytes at all (including a proxy's heartbeat);
 *  - origin  bytes that come from the origin. Proxy-tagged comments never advance it. Once a proxy comment has been
 *            seen on a connection, only parsed origin output (events, origin comments, retry hints) advances it;
 *  - event   a complete event was dispatched.
 *
 * When a gap on a clock ends (the next byte, or the connection leaving `open`) the model describes it in `delta`
 * for the rules to judge. A gap that has not ended yet is available from `openGaps()`. Ticks never change the model,
 * which is what makes live analysis and batch analysis agree.
 */

import type { Observation, Stamp } from '../observe/observation'
import type { SSEPhase } from '../sse/sseClient'
import { RollingStats, type StatSnapshot } from './stats'
import type { Thresholds } from './thresholds'

/** Raised by a host that noticed the clock jump (a laptop woke up, a tab was frozen). Not an `Observation` kind: records of unknown kind are allowed to pass through a capture. */
export interface ClockDiscontinuityRecord extends Stamp {
    kind: 'clock.discontinuity'
    /** How far the clock jumped, in milliseconds, when known. */
    gapMs?: number | undefined
    reason?: string | undefined
}

export type EngineInput = Observation | ClockDiscontinuityRecord

export interface Mark { t: number; seq: number }
export type ClockName = 'byte' | 'origin' | 'event'
export type StartKind = 'byte' | 'open' | 'discontinuity'
export type HeartbeatSource = 'proxy' | 'upstream'

/** A stretch of silence on one clock, finished (`endT` set) or still going. */
export interface GapInfo {
    clock: ClockName
    conn: number
    startT: number
    startSeq: number
    /** `byte`: began at a real record. `open`: the connection opened and nothing came yet. `discontinuity`: restarted at a clock jump. */
    startKind: StartKind
    /** The clock's gap statistics as they were before this gap ended. */
    stats: StatSnapshot
    /** Median interval of origin comments, once enough were seen. */
    hbMedianMs?: number | undefined
    /** Proxy comments that arrived since the origin clock last advanced. */
    proxyCount: number
    /** Chunks that arrived since the last event, not counting the one carrying the event that ended this gap. */
    aliveChunks: number
    /** Time of the latest byte on this connection, and the longest gap between bytes since the last event. */
    lastByteT?: number | undefined
    maxByteGapMs: number
    endT?: number | undefined
    endSeq?: number | undefined
    via?: 'next' | 'close' | undefined
}

export interface HeartbeatClose {
    source: HeartbeatSource
    conn: number
    prev: Mark
    cur: Mark
    intervalMs: number
    medianBefore?: number | undefined
    intervalsBefore: number
}

export interface Delta {
    gaps: GapInfo[]
    heartbeat?: HeartbeatClose | undefined
}

export interface ConnectionState {
    conn: number
    attempt: number
    connect?: (Mark & { url: string; method: string; sentLastEventId: string }) | undefined
    response?: (Mark & { status: number; contentType: string; redirected: boolean; headers: Record<string, string>; ttfbMs: number }) | undefined
    openT?: number | undefined
    openSeq?: number | undefined
    open: boolean
    firstChunk?: Mark | undefined
    firstEvent?: Mark | undefined
    lastByte?: Mark | undefined
    lastOrigin?: Mark | undefined
    /** The origin clock before a chunk moved it, so a chunk that turns out to be a proxy heartbeat can be taken back. */
    originBeforeChunk?: Mark | undefined
    lastEvent?: Mark | undefined
    /** When the connection stopped being `open` (or failed before opening). */
    endedT?: number | undefined
    endedSeq?: number | undefined
    endPhase?: SSEPhase | undefined
    chunks: number
    bytes: number
    events: number
    comments: { proxy: number; upstream: number }
    violations: number
    retryHints: number
    chunksSinceEvent: number
    maxByteGapSinceEvent: number
    proxySinceOrigin: number
    sawProxy: boolean
    lastHb: Partial<Record<HeartbeatSource, Mark>>
}

export interface ReconnectInfo {
    seq: number
    t: number
    conn: number
    attempt: number
    delayMs: number
    reason: string
    lastEventIdSent: string
    serverRetryMs?: number | undefined
    status?: number | undefined
}

export interface HeartbeatStats {
    count: number
    intervals: RollingStats
}

const isProxyHeartbeat = (text: string): boolean => text.startsWith('sse-proxy') && !text.startsWith('sse-proxy cap') && !text.startsWith('sse-proxy-meta')

export class StreamModel {
    phase: SSEPhase | 'idle' = 'idle'
    phaseSinceT = 0
    nowT = 0
    lastSeq = -1
    readonly seenKinds = new Set<string>()
    readonly conns = new Map<number, ConnectionState>()
    private latest = -1
    readonly reconnects: ReconnectInfo[] = []
    readonly discontinuities: Array<Mark & { gapMs?: number | undefined; reason?: string | undefined }> = []
    lastDisc: Mark | undefined

    /** Capture-wide clocks (the most recent value on any connection). */
    lastByteT: number | undefined
    lastOriginByteT: number | undefined
    lastCompleteEventT: number | undefined

    readonly gaps: Record<ClockName, RollingStats> = { byte: new RollingStats(), origin: new RollingStats(), event: new RollingStats() }
    readonly heartbeats: Record<HeartbeatSource, HeartbeatStats> = {
        proxy: { count: 0, intervals: new RollingStats() },
        upstream: { count: 0, intervals: new RollingStats() },
    }

    /** Names (never values) of the query parameters on every request URL seen. */
    readonly requestParamNames = new Set<string>()
    /** What changed in the most recent `update`. */
    delta: Delta = { gaps: [] }

    constructor(private readonly thresholds: Thresholds) {}

    /** The connection of the latest `connect` record (or the one a stray record names). */
    current(): ConnectionState | undefined { return this.conns.get(this.latest) }
    conn(index: number): ConnectionState | undefined { return this.conns.get(index) }

    private ensure(index: number): ConnectionState {
        let c = this.conns.get(index)
        if (!c) {
            c = { conn: index, attempt: 0, open: false, chunks: 0, bytes: 0, events: 0, comments: { proxy: 0, upstream: 0 }, violations: 0, retryHints: 0, chunksSinceEvent: 0, maxByteGapSinceEvent: 0, proxySinceOrigin: 0, sawProxy: false, lastHb: {} }
            this.conns.set(index, c)
            if (index > this.latest) this.latest = index
        }
        return c
    }

    /** Median interval of origin comments, once enough intervals were seen to trust it. */
    originHeartbeatMedian(): number | undefined {
        const h = this.heartbeats.upstream.intervals
        return h.count >= this.thresholds.heartbeatMinIntervals ? h.median() : undefined
    }

    private startOf(c: ConnectionState, clock: ClockName): (Mark & { kind: StartKind }) | undefined {
        const real = clock === 'byte' ? c.lastByte : clock === 'origin' ? c.lastOrigin : c.lastEvent
        let start: (Mark & { kind: StartKind }) | undefined = real
            ? { ...real, kind: 'byte' }
            : c.openT !== undefined && c.openSeq !== undefined ? { t: c.openT, seq: c.openSeq, kind: 'open' } : undefined
        // A clock jump makes the time since before it meaningless, so measuring restarts at the jump.
        if (start && this.lastDisc && this.lastDisc.seq > start.seq) start = { t: this.lastDisc.t, seq: this.lastDisc.seq, kind: 'discontinuity' }
        return start
    }

    private describeGap(c: ConnectionState, clock: ClockName, start: Mark & { kind: StartKind }): GapInfo {
        return {
            clock, conn: c.conn, startT: start.t, startSeq: start.seq, startKind: start.kind,
            stats: this.gaps[clock].snapshot(), hbMedianMs: this.originHeartbeatMedian(),
            proxyCount: c.proxySinceOrigin, aliveChunks: c.chunksSinceEvent, lastByteT: c.lastByte?.t, maxByteGapMs: c.maxByteGapSinceEvent,
        }
    }

    /** Ends a gap on a clock. A gap that ends with a byte adds a sample to that clock's statistics, unless it began at a synthetic start. */
    private closeGap(c: ConnectionState, clock: ClockName, o: Observation, via: 'next' | 'close', aliveChunks?: number): void {
        const start = this.startOf(c, clock)
        if (!start) return
        const gap = this.describeGap(c, clock, start)
        gap.endT = o.t
        gap.endSeq = o.seq
        gap.via = via
        if (aliveChunks !== undefined) gap.aliveChunks = aliveChunks
        this.delta.gaps.push(gap)
        if (via === 'next' && start.kind === 'byte') this.gaps[clock].push(o.t - start.t)
    }

    /** Gaps still going on the connection that is currently open. */
    openGaps(): GapInfo[] {
        const c = this.current()
        if (!c || !c.open) return []
        const out: GapInfo[] = []
        for (const clock of ['byte', 'origin', 'event'] as const) {
            const start = this.startOf(c, clock)
            if (start) out.push(this.describeGap(c, clock, start))
        }
        return out
    }

    /** Open silence since the last comment from a source on the current connection, when the connection is open. */
    openHeartbeatGap(source: HeartbeatSource): { prev: Mark; intervals: number; median: number | undefined; conn: number } | undefined {
        const c = this.current()
        const prev = c?.open ? c.lastHb[source] : undefined
        if (!c || !prev) return undefined
        if (this.lastDisc && this.lastDisc.seq > prev.seq) return undefined
        const stats = this.heartbeats[source].intervals
        return { prev, intervals: stats.count, median: stats.median(), conn: c.conn }
    }

    update(o: EngineInput): void {
        this.delta = { gaps: [] }
        this.lastSeq = o.seq
        this.nowT = Math.max(this.nowT, o.t)
        this.seenKinds.add(o.kind)
        const c = this.ensure(o.conn)
        const mark: Mark = { t: o.t, seq: o.seq }

        switch (o.kind) {
            case 'clock.discontinuity':
                this.lastDisc = mark
                this.discontinuities.push({ ...mark, gapMs: o.gapMs, reason: o.reason })
                break
            case 'connect':
                c.attempt = o.attempt
                c.connect = { ...mark, url: o.url, method: o.method, sentLastEventId: o.sentLastEventId }
                this.phase = 'connecting'
                this.phaseSinceT = o.t
                try {
                    const query = o.url.split('?')[1] ?? ''
                    for (const pair of query.split('&')) {
                        const name = pair.split('=')[0]
                        if (name) this.requestParamNames.add(decodeURIComponent(name))
                    }
                } catch { /* a malformed escape in a recorded URL is not worth failing for */ }
                break
            case 'response':
                c.response = { ...mark, status: o.status, contentType: o.contentType, redirected: o.redirected, headers: o.headers, ttfbMs: o.ttfbMs }
                break
            case 'phase':
                this.phase = o.phase
                this.phaseSinceT = o.t
                if (o.phase === 'open') {
                    c.open = true
                    c.openT = o.t
                    c.openSeq = o.seq
                } else {
                    if (c.open) {
                        this.closeGap(c, 'byte', o, 'close')
                        if (c.sawProxy) this.closeGap(c, 'origin', o, 'close')
                        this.closeGap(c, 'event', o, 'close')
                    }
                    if (o.phase !== 'connecting') {
                        c.open = false
                        c.endedT ??= o.t
                        c.endedSeq ??= o.seq
                        c.endPhase = o.phase
                    }
                }
                break
            case 'chunk': {
                this.closeGap(c, 'byte', o, 'next')
                const previous = c.lastByte?.t ?? c.openT
                if (previous !== undefined) c.maxByteGapSinceEvent = Math.max(c.maxByteGapSinceEvent, o.t - previous)
                c.lastByte = mark
                this.lastByteT = o.t
                c.firstChunk ??= mark
                c.chunks++
                c.bytes += o.bytes
                c.chunksSinceEvent++
                if (!c.sawProxy) {
                    c.originBeforeChunk = c.lastOrigin
                    this.advanceOrigin(c, o)
                }
                break
            }
            case 'comment':
                if (o.source === 'proxy') {
                    if (!c.sawProxy && c.lastOrigin && c.lastByte && c.lastOrigin.seq === c.lastByte.seq) {
                        // The chunk just before this comment was the proxy's: it was not the origin speaking.
                        c.lastOrigin = c.originBeforeChunk
                        this.lastOriginByteT = c.originBeforeChunk?.t
                    }
                    c.sawProxy = true
                    c.comments.proxy++
                    c.proxySinceOrigin++
                    if (isProxyHeartbeat(o.text)) this.heartbeat(c, 'proxy', o, 1)
                } else {
                    c.comments.upstream++
                    this.advanceOrigin(c, o)
                    this.heartbeat(c, 'upstream', o, 1)
                }
                break
            case 'heartbeatSeries': {
                // Many comments folded into one record. Counted, and their rhythm kept, but a folded run cannot close gaps precisely.
                const source: HeartbeatSource = o.source === 'proxy' ? 'proxy' : 'upstream'
                const stats = this.heartbeats[source]
                stats.count += o.count
                c.comments[source] += o.count
                if (o.count >= 2) for (const g of [o.minGapMs, o.meanGapMs, o.maxGapMs]) stats.intervals.push(g)
                c.lastHb[source] = { t: o.lastT, seq: o.seq }
                if (!c.lastByte || o.lastT > c.lastByte.t) { c.lastByte = { t: o.lastT, seq: o.seq }; this.lastByteT = o.lastT }
                if (source === 'upstream') { c.lastOrigin = { t: o.lastT, seq: o.seq }; this.lastOriginByteT = o.lastT }
                break
            }
            case 'retry':
                c.retryHints++
                this.advanceOrigin(c, o)
                break
            case 'event':
                this.advanceOrigin(c, o)
                this.closeGap(c, 'event', o, 'next', Math.max(0, c.chunksSinceEvent - 1))
                c.lastEvent = mark
                this.lastCompleteEventT = o.t
                c.firstEvent ??= mark
                c.events++
                c.chunksSinceEvent = 0
                c.maxByteGapSinceEvent = 0
                break
            case 'violation':
                c.violations++
                break
            case 'reconnect':
                this.reconnects.push({ seq: o.seq, t: o.t, conn: o.conn, attempt: o.attempt, delayMs: o.delayMs, reason: o.reason, lastEventIdSent: o.lastEventIdSent, serverRetryMs: o.serverRetryMs, status: o.status })
                break
            default:
                break
        }
    }

    /** The origin clock moves: close its gap, restart it, and forget the proxy comments seen meanwhile. */
    private advanceOrigin(c: ConnectionState, o: Observation): void {
        this.closeGap(c, 'origin', o, 'next')
        c.lastOrigin = { t: o.t, seq: o.seq }
        this.lastOriginByteT = o.t
        c.proxySinceOrigin = 0
    }

    private heartbeat(c: ConnectionState, source: HeartbeatSource, o: Observation, n: number): void {
        const stats = this.heartbeats[source]
        const prev = c.lastHb[source]
        const cur: Mark = { t: o.t, seq: o.seq }
        stats.count += n
        if (prev && !(this.lastDisc && this.lastDisc.seq > prev.seq)) {
            const intervalMs = o.t - prev.t
            this.delta.heartbeat = { source, conn: c.conn, prev, cur, intervalMs, medianBefore: stats.intervals.median(), intervalsBefore: stats.intervals.count }
            stats.intervals.push(intervalMs)
        }
        c.lastHb[source] = cur
    }
}
