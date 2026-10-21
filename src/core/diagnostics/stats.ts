export interface StatSnapshot {
    /** Samples ever added (not just those kept). */
    count: number
    median?: number | undefined
    p95?: number | undefined
}

/**
 * A bounded window of samples with cheap quantiles. The window is kept sorted as samples come and go (a binary search and one
 * shift of at most `cap` numbers), so a quantile is an index lookup. Sorting the window again for every quantile asked after every
 * new sample was most of the Doctor's cost on a fast stream (measured: about 3 s of 8 s of main-thread time at 20,000 events/s).
 */
export class RollingStats {
    private readonly buf: number[] = []
    private head = 0
    private total = 0
    private max = 0
    private readonly sorted: number[] = []

    constructor(private readonly cap = 256) {}

    get count(): number { return this.total }
    get maxEver(): number { return this.max }

    /** Index of the first element that is not below `v`. */
    private lowerBound(v: number): number {
        let lo = 0
        let hi = this.sorted.length
        while (lo < hi) {
            const mid = (lo + hi) >>> 1
            if (this.sorted[mid]! < v) lo = mid + 1
            else hi = mid
        }
        return lo
    }

    push(v: number): void {
        if (this.buf.length < this.cap) this.buf.push(v)
        else {
            const old = this.buf[this.head]!
            this.sorted.splice(this.lowerBound(old), 1) // the sample that leaves the window
            this.buf[this.head] = v
            this.head = (this.head + 1) % this.cap
        }
        this.sorted.splice(this.lowerBound(v), 0, v)
        this.total++
        if (v > this.max) this.max = v
    }

    quantile(q: number): number | undefined {
        const s = this.sorted
        if (s.length === 0) return undefined
        return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
    }

    median(): number | undefined { return this.quantile(0.5) }
    p95(): number | undefined { return this.quantile(0.95) }

    /** Mean absolute deviation from the median: how far intervals stray from the usual one. */
    jitter(): number | undefined {
        const m = this.median()
        if (m === undefined) return undefined
        let sum = 0
        for (const v of this.buf) sum += Math.abs(v - m)
        return sum / this.buf.length
    }

    snapshot(): StatSnapshot { return { count: this.total, median: this.median(), p95: this.p95() } }
}
