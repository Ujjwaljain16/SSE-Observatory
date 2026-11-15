import type { Clock } from '../clock'

/** A clock that only moves when told to, for deterministic tests of anything that measures time. */
export class TestClock implements Clock {
    constructor(private monotonic = 0, private wall = 0) {}

    now(): number { return this.monotonic }
    epoch(): number { return this.wall }

    advance(ms: number): this {
        this.monotonic += ms
        this.wall += ms
        return this
    }

    /** Jump the monotonic clock without touching wall time (or the reverse), to model odd clock behaviour. */
    set(monotonic: number, wall: number = this.wall): this {
        this.monotonic = monotonic
        this.wall = wall
        return this
    }
}
