import { performanceClock, type Clock } from '../clock'
import type { Observation, ObservationDraft, Stamp } from './observation'

/** What it costs to record: measured on every Nth record, so measuring does not become the cost. */
export interface RecorderOverhead {
    /** Mean microseconds spent recording one observation (stamping plus the sink). */
    avgUs: number
    /** 99th percentile of the sampled costs, in microseconds. */
    p99Us: number
    recordsPerSec: number
    /** How many records were sampled. */
    sampled: number
}

const SAMPLE_EVERY = 64
const SAMPLE_WINDOW = 256

export interface RecorderOptions {
    clock?: Clock | undefined
    domain?: Stamp['domain']
    /** Receives every stamped record, synchronously, in order. */
    onRecord?: ((observation: Observation) => void) | undefined
}

/**
 * Stamps drafts with a sequence number, a monotonic timestamp and a connection index.
 *
 * `t` is clamped so it never decreases even if a clock misbehaves. The connection index advances on every `connect`
 * record. The wall-clock start is read once, here, and kept for display only.
 */
export class Recorder {
    readonly startedAtEpochMs: number
    private readonly clock: Clock
    private readonly origin: number
    private readonly domain: Stamp['domain']
    private readonly onRecord: ((observation: Observation) => void) | undefined
    private nextSeq = 0
    private conn = -1
    private lastT = 0
    private readonly costs: number[] = []
    private costSum = 0
    private costCount = 0

    constructor(options: RecorderOptions = {}) {
        this.clock = options.clock ?? performanceClock
        this.domain = options.domain
        this.onRecord = options.onRecord
        this.origin = this.clock.now()
        this.startedAtEpochMs = this.clock.epoch()
    }

    /** Number of records produced so far. */
    get count(): number { return this.nextSeq }

    /** Monotonic milliseconds since the capture started. */
    elapsed(): number {
        this.lastT = Math.max(this.lastT, this.clock.now() - this.origin)
        return this.lastT
    }

    /** Cost of recording so far; see RecorderOverhead. */
    overhead(): RecorderOverhead {
        const sorted = [...this.costs].sort((a, b) => a - b)
        const seconds = Math.max(this.elapsed() / 1000, 1e-9)
        return {
            avgUs: this.costCount === 0 ? 0 : (this.costSum / this.costCount) * 1000,
            p99Us: sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0) * 1000,
            recordsPerSec: this.nextSeq / seconds,
            sampled: this.costCount,
        }
    }

    record(draft: ObservationDraft): Observation {
        const sample = this.nextSeq % SAMPLE_EVERY === 0
        const started = sample ? this.clock.now() : 0
        const observation = this.stampAndDeliver(draft)
        if (sample) {
            const cost = this.clock.now() - started
            this.costSum += cost
            this.costCount++
            this.costs.push(cost)
            if (this.costs.length > SAMPLE_WINDOW) this.costs.shift()
        }
        return observation
    }

    private stampAndDeliver(draft: ObservationDraft): Observation {
        if (draft.kind === 'connect') this.conn++
        const stamp: Stamp = { seq: this.nextSeq++, t: this.elapsed(), conn: Math.max(this.conn, 0) }
        if (this.domain !== undefined) stamp.domain = this.domain
        const observation = { ...stamp, ...draft } as Observation
        this.onRecord?.(observation)
        return observation
    }
}
