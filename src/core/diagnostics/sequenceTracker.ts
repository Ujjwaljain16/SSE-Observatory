/**
 * Follows one numbered sequence (one partition of one stream) and reports what is wrong with it: gaps, duplicates,
 * numbers that went backwards, and numbers that arrived late.
 *
 * It only ever judges numbers it was told are a sequence (a declared contract). Memory is bounded: the last `window`
 * numbers are remembered to tell a duplicate from a new number, and open gaps are kept as ranges, so a jump of a
 * million costs one entry.
 *
 * A gap is not reported when it appears: a late event may still fill it. It is confirmed once `reorderWindowEvents`
 * more events or `reorderWindowMs` have passed, or when the capture ends. Everything is decided from the records fed
 * in, in order, so live analysis and batch analysis agree.
 */

export interface Ref { seq: number; t: number }

export type SequencePolicy = 'consecutive' | 'monotonic'

export type TrackerOutput =
    /** Numbers `from..to` never arrived within the reorder window. */
    | { kind: 'gap'; from: number; to: number; before: Ref; after: Ref }
    /** The first event of a new connection jumped past the last number seen: the resume skipped events. Reported to the resume rule, not as a gap. */
    | { kind: 'boundary-gap'; from: number; to: number; before: Ref; after: Ref }
    | { kind: 'duplicate'; value: number; conflict: boolean; replay: boolean; first: Ref; again: Ref }
    | { kind: 'regression'; from: number; to: number; before: Ref; after: Ref }
    | { kind: 'reorder'; value: number; late: Ref; opened: Ref }

export interface TrackerOptions {
    policy: SequencePolicy
    reorderWindowEvents: number
    reorderWindowMs: number
    window: number
}

const MAX_PENDING = 64

interface Pending { lo: number; hi: number; before: Ref; opened: Ref; openedCount: number }

export interface AcceptContext {
    /** First event on a connection after the first: a jump here is the resume's doing. */
    boundary?: boolean
    /** The connection is still replaying numbers at or below what an earlier connection delivered. */
    replay?: boolean
}

export class SequenceTracker {
    private high: number | undefined
    private highRef: Ref = { seq: -1, t: 0 }
    private readonly seen = new Map<number, { hash: string; ref: Ref }>()
    private pending: Pending[] = []
    private count = 0
    private readonly out: TrackerOutput[] = []

    constructor(private readonly options: TrackerOptions) {}

    get events(): number { return this.count }
    get highest(): number | undefined { return this.high }

    accept(value: number, hash: string, ref: Ref, ctx: AcceptContext = {}): TrackerOutput[] {
        this.out.length = 0
        this.count++
        if (this.high === undefined) {
            this.remember(value, hash, ref)
            this.high = value
            this.highRef = ref
            return this.drain()
        }

        const known = this.seen.get(value)
        if (known) {
            const conflict = known.hash !== '' && hash !== '' && known.hash !== hash
            this.out.push({ kind: 'duplicate', value, conflict, replay: Boolean(ctx.replay), first: known.ref, again: ref })
        } else if (this.fill(value, ref)) {
            this.remember(value, hash, ref)
        } else if (value > this.high) {
            if (this.options.policy === 'consecutive' && value > this.high + 1) {
                const range = { lo: this.high + 1, hi: value - 1 }
                if (ctx.boundary) this.out.push({ kind: 'boundary-gap', from: range.lo, to: range.hi, before: this.highRef, after: ref })
                else {
                    this.pending.push({ ...range, before: this.highRef, opened: ref, openedCount: this.count })
                    // Scattered losses must not grow memory: past the cap the oldest open gap is confirmed at once.
                    if (this.pending.length > MAX_PENDING) {
                        const oldest = this.pending.shift()!
                        this.out.push({ kind: 'gap', from: oldest.lo, to: oldest.hi, before: oldest.before, after: oldest.opened })
                    }
                }
            }
            this.remember(value, hash, ref)
            this.high = value
            this.highRef = ref
        } else if (ctx.replay) {
            this.remember(value, hash, ref) // an old number the window no longer holds, sent again after a reconnect: expected
        } else {
            // Lower than anything still pending and not seen: the numbering went backwards (a producer restart, a reset).
            this.out.push({ kind: 'regression', from: this.high, to: value, before: this.highRef, after: ref })
            this.seen.clear()
            this.pending = []
            this.remember(value, hash, ref)
            this.high = value
            this.highRef = ref
        }
        this.expire(ref.t)
        return this.drain()
    }

    /** The capture ended: whatever is still open can no longer be filled. */
    finish(): TrackerOutput[] {
        this.out.length = 0
        for (const p of this.pending) this.out.push({ kind: 'gap', from: p.lo, to: p.hi, before: p.before, after: p.opened })
        this.pending = []
        return this.drain()
    }

    /**
     * Open gaps that the reorder window will have closed by `now` on time alone (no further event needed). For a live view of a
     * stream that went quiet right after a gap. Does not change anything.
     */
    dueGaps(now: number): TrackerOutput[] {
        return this.pending
            .filter((p) => now - p.opened.t >= this.options.reorderWindowMs)
            .map((p): TrackerOutput => ({ kind: 'gap', from: p.lo, to: p.hi, before: p.before, after: p.opened }))
    }

    /** Gaps that are still open (not yet confirmed), for a provisional view. Does not change anything. */
    openGaps(): Array<{ from: number; to: number }> {
        return this.pending.map((p) => ({ from: p.lo, to: p.hi }))
    }

    private remember(value: number, hash: string, ref: Ref): void {
        this.seen.set(value, { hash, ref })
        if (this.seen.size > this.options.window) this.seen.delete(this.seen.keys().next().value as number)
    }

    /** A late number inside an open gap fills it (splitting the range if it was in the middle). */
    private fill(value: number, late: Ref): boolean {
        const i = this.pending.findIndex((p) => value >= p.lo && value <= p.hi)
        if (i < 0) return false
        const p = this.pending[i]!
        const parts: Pending[] = []
        if (value > p.lo) parts.push({ ...p, hi: value - 1 })
        if (value < p.hi) parts.push({ ...p, lo: value + 1 })
        this.pending.splice(i, 1, ...parts)
        this.out.push({ kind: 'reorder', value, late, opened: p.opened })
        return true
    }

    private expire(now: number): void {
        if (this.pending.length === 0) return
        const keep: Pending[] = []
        for (const p of this.pending) {
            if (this.count - p.openedCount >= this.options.reorderWindowEvents || now - p.opened.t >= this.options.reorderWindowMs) {
                this.out.push({ kind: 'gap', from: p.lo, to: p.hi, before: p.before, after: p.opened })
            } else keep.push(p)
        }
        this.pending = keep
    }

    private drain(): TrackerOutput[] {
        return this.out.slice()
    }
}
