export interface StatSnapshot {
    /** Samples ever added (not just those kept). */
    count: number
    median?: number | undefined
    p95?: number | undefined
}

/** A bounded window of samples with cheap quantiles. Sorting happens lazily and only when a new sample arrived. */
export class RollingStats {
    private readonly buf: number[] = []
    private head = 0
    private total = 0
    private max = 0
    private sorted: number[] | null = null

    constructor(private readonly cap = 256) {}

    get count(): number { return this.total }
    get maxEver(): number { return this.max }

    push(v: number): void {
        if (this.buf.length < this.cap) this.buf.push(v)
        else { this.buf[this.head] = v; this.head = (this.head + 1) % this.cap }
        this.total++
        if (v > this.max) this.max = v
        this.sorted = null
    }

    private order(): number[] {
        return (this.sorted ??= [...this.buf].sort((a, b) => a - b))
    }

    quantile(q: number): number | undefined {
        const s = this.order()
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
