import { performanceClock, type Clock } from '../clock'
import type { Observation, ObservationDraft, Stamp } from './observation'

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

    record(draft: ObservationDraft): Observation {
        if (draft.kind === 'connect') this.conn++
        const stamp: Stamp = { seq: this.nextSeq++, t: this.elapsed(), conn: Math.max(this.conn, 0) }
        if (this.domain !== undefined) stamp.domain = this.domain
        const observation = { ...stamp, ...draft } as Observation
        this.onRecord?.(observation)
        return observation
    }
}
