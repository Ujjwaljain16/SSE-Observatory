/**
 * Keeps recent observations within a memory cap, and says plainly what it had to drop.
 *
 * A stream can produce thousands of records a second, so the store is bounded. When it goes over its cap it gives up
 * detail in a fixed order, cheapest evidence first, and never silently:
 *   1. `chunk` records (sizes and times of network reads), oldest first
 *   2. `event` records (per-event metadata), oldest first
 *   3. heartbeat comments are folded into `heartbeatSeries` records (count, first/last time, gap statistics)
 * Every drop is recorded in a `truncated` marker (one per kind of detail, placed where the first drop happened) and in
 * `stats`, and running totals keep counting everything ever seen, so analysis can still say "5 million events".
 *
 * Connections, responses, phases, reconnects, retry hints and marks are never evicted (reconnect loops are slow enough
 * that they stay small). Violations are kept per code up to a limit, because a producer bug can raise one on every line.
 */

import { FifoQueue } from '../fifoQueue'
import type { Observation, ObservationKind } from './observation'

const DEFAULT_CAP_BYTES = 8 * 1024 * 1024
/** How many violation records to keep per code; the rest are counted. */
const VIOLATIONS_PER_CODE = 100

export interface CaptureStats {
    /** Records ever appended, evicted or not. */
    total: number
    byKind: Partial<Record<ObservationKind, number>>
    /** Network bytes over every chunk ever seen. */
    chunkBytesTotal: number
    /** Estimated memory held by the retained records. */
    retainedBytes: number
    capBytes: number
    /** Records dropped (or folded away) per kind of detail. */
    dropped: { chunk: number; event: number; heartbeat: number; violation: number }
}

type Marker = Extract<Observation, { kind: 'truncated' }>
type Series = Extract<Observation, { kind: 'heartbeatSeries' }>
const digitsToHash = (text: string) => text.replace(/\d+/g, '#')

// Calibrated against measured V8 heap use per retained record (object, map entry, strings), so the cap bounds real memory.
function estimateBytes(o: Observation): number {
    switch (o.kind) {
        case 'chunk': return 120
        case 'event': return 120 + o.sseId.length + o.event.length + (o.dataHash ? 24 : 0) + (o.extracted ? 48 : 0)
        case 'comment': return 128 + o.text.length
        case 'violation': return 144 + o.detail.length
        case 'connect': return 120 + o.url.length + o.headerNames.join('').length
        case 'response': return 120 + Object.entries(o.headers).reduce((n, [k, v]) => n + k.length + v.length, 0)
        case 'phase': return 152 + (o.info.reason?.length ?? 0)
        case 'reconnect': return 160 + o.reason.length
        case 'heartbeatSeries': return 136 + o.text.length
        default: return 120
    }
}

export class CaptureStore {
    private readonly capBytes: number
    private readonly records = new Map<number, Observation>() // insertion order == seq order; keys are seq numbers
    private bytes = 0
    private total = 0
    private chunkBytesTotal = 0
    private readonly byKind: Partial<Record<ObservationKind, number>> = {}
    private readonly dropped = { chunk: 0, event: 0, heartbeat: 0, violation: 0 }

    private readonly chunkQueue = new FifoQueue<number>()
    private readonly eventQueue = new FifoQueue<number>()
    private readonly commentQueue = new FifoQueue<number>()
    private readonly violationQueues = new Map<string, FifoQueue<number>>()
    private readonly markers = new Map<Marker['what'], Marker>()
    private readonly series = new Map<string, { record: Series; sumGapMs: number }>()
    private readonly commentsPerKey = new Map<string, number>()

    constructor(options: { capBytes?: number } = {}) {
        this.capBytes = options.capBytes ?? DEFAULT_CAP_BYTES
    }

    append(o: Observation): void {
        this.total++
        this.byKind[o.kind] = (this.byKind[o.kind] ?? 0) + 1
        this.records.set(o.seq, o)
        this.bytes += estimateBytes(o)

        switch (o.kind) {
            case 'chunk': this.chunkBytesTotal += o.bytes; this.chunkQueue.push(o.seq); break
            case 'event': this.eventQueue.push(o.seq); break
            case 'comment': {
                this.commentQueue.push(o.seq)
                const key = `${o.source}|${digitsToHash(o.text)}`
                this.commentsPerKey.set(key, (this.commentsPerKey.get(key) ?? 0) + 1)
                break
            }
            case 'violation': this.limitViolations(o); break
        }
        if (this.bytes > this.capBytes) this.enforceCap()
    }

    /** Retained records in order, including `truncated` markers and `heartbeatSeries` summaries. */
    snapshot(): Observation[] {
        return [...this.records.values()]
    }

    get stats(): CaptureStats {
        return { total: this.total, byKind: { ...this.byKind }, chunkBytesTotal: this.chunkBytesTotal, retainedBytes: this.bytes, capBytes: this.capBytes, dropped: { ...this.dropped } }
    }

    clear(): void {
        this.records.clear()
        this.bytes = 0
        this.total = 0
        this.chunkBytesTotal = 0
        for (const k of Object.keys(this.byKind)) delete this.byKind[k as ObservationKind]
        this.dropped.chunk = this.dropped.event = this.dropped.heartbeat = this.dropped.violation = 0
        this.chunkQueue.clear()
        this.eventQueue.clear()
        this.commentQueue.clear()
        this.violationQueues.clear()
        this.markers.clear()
        this.series.clear()
        this.commentsPerKey.clear()
    }

    private enforceCap() {
        while (this.bytes > this.capBytes) {
            if (this.evict(this.chunkQueue, 'chunk')) continue
            if (this.evict(this.eventQueue, 'event')) continue
            if (this.compactHeartbeat()) continue
            break // only records that are never evicted remain
        }
    }

    private evict(queue: FifoQueue<number>, what: 'chunk' | 'event' | 'violation'): boolean {
        const seq = queue.shift()
        if (seq === undefined) return false
        const record = this.records.get(seq)
        if (!record) return true
        this.bytes -= estimateBytes(record)
        this.dropped[what]++
        this.markDropped(what, record)
        return true
    }

    /** Remove a record, leaving a single truncation marker at the position of the first drop of that kind. */
    private markDropped(what: Marker['what'], record: Observation) {
        const existing = this.markers.get(what)
        if (existing) {
            existing.dropped++
            this.records.delete(record.seq)
            return
        }
        const marker: Marker = { seq: record.seq, t: record.t, conn: record.conn, kind: 'truncated', what, dropped: 1 }
        this.markers.set(what, marker)
        this.records.set(record.seq, marker) // same key, same position
        this.bytes += estimateBytes(marker)
    }

    private limitViolations(o: Extract<Observation, { kind: 'violation' }>) {
        let queue = this.violationQueues.get(o.code)
        if (!queue) { queue = new FifoQueue<number>(); this.violationQueues.set(o.code, queue) }
        queue.push(o.seq)
        if (queue.length > VIOLATIONS_PER_CODE) this.evict(queue, 'violation')
    }

    /** Fold the oldest comment into a heartbeat series. Always makes progress while comments remain. */
    private compactHeartbeat(): boolean {
        const seq = this.commentQueue.shift()
        if (seq === undefined) return false
        const comment = this.records.get(seq)
        if (!comment || comment.kind !== 'comment') return true

        const key = `${comment.source}|${digitsToHash(comment.text)}`
        const remaining = (this.commentsPerKey.get(key) ?? 1) - 1
        this.commentsPerKey.set(key, remaining)
        // Repeated text folds into its own series; unique texts fold into one catch-all series per source.
        const seriesKey = this.series.has(key) || remaining >= 1 ? key : `${comment.source}|*`
        const text = seriesKey.endsWith('|*') ? '(various)' : digitsToHash(comment.text)
        const existing = this.series.get(seriesKey)

        if (existing) {
            const gap = Math.max(0, comment.t - existing.record.lastT)
            existing.sumGapMs += gap
            const s = existing.record
            s.count++
            s.minGapMs = s.count === 2 ? gap : Math.min(s.minGapMs, gap)
            s.maxGapMs = Math.max(s.maxGapMs, gap)
            s.meanGapMs = existing.sumGapMs / (s.count - 1)
            s.lastT = Math.max(s.lastT, comment.t)
            this.bytes -= estimateBytes(comment)
            this.dropped.heartbeat++
            this.markDropped('heartbeat', comment)
            return true
        }

        const record: Series = {
            seq: comment.seq, t: comment.t, conn: comment.conn, kind: 'heartbeatSeries', text, source: comment.source,
            count: 1, firstT: comment.t, lastT: comment.t, minGapMs: 0, maxGapMs: 0, meanGapMs: 0,
            ...(comment.domain !== undefined ? { domain: comment.domain } : {}),
        }
        this.series.set(seriesKey, { record, sumGapMs: 0 })
        this.bytes += estimateBytes(record) - estimateBytes(comment)
        this.records.set(comment.seq, record)
        return true
    }
}
