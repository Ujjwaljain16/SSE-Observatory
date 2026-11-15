/**
 * Collects records and hands them over in batches: when a batch is full, or `flushMs` after the first record arrived.
 * One message per batch (to a page, a worker port, a store) instead of one per record keeps the cost flat when a stream
 * produces thousands of records a second. `flush()` and `stop()` hand over whatever is pending immediately.
 */
export interface Batcher<T> {
    push(item: T): void
    /** Hand over what is pending right now. */
    flush(): void
    /** Flush, then cancel any timer. The batcher can still be used afterwards. */
    stop(): void
}

export function createBatcher<T>(flushMs: number, maxBatch: number, sink: (batch: T[]) => void): Batcher<T> {
    let pending: T[] = []
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
        if (timer !== null) { clearTimeout(timer); timer = null }
        if (pending.length === 0) return
        const batch = pending
        pending = []
        // Whoever receives the records is not allowed to break the stream: a sink that throws (a failed post to another thread, a bug in a
        // listener) would otherwise surface as an uncaught exception from a timer, which ends a Node process, or as an error inside the
        // client's own read loop. The batch is lost to that sink; the stream and every other consumer carry on.
        try { sink(batch) } catch { /* swallowed on purpose */ }
    }

    return {
        push(item) {
            pending.push(item)
            if (pending.length >= maxBatch) return flush()
            if (timer === null) {
                timer = setTimeout(flush, flushMs)
                ;(timer as { unref?: () => void }).unref?.() // a pending flush must not keep a Node process alive
            }
        },
        flush,
        stop: flush,
    }
}
