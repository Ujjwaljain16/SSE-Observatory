/**
 * The virtualizer remembers a measured height for every row key it has measured and never forgets one. A list keyed by event id on a
 * long stream therefore holds an entry for every event that was ever drawn. This drops the entries of keys that are no longer in the
 * list, in place, once the cache is clearly larger than the list (so the scan is not paid on every batch). Returns how many it removed.
 */
export function pruneSizeCache(cache: Map<unknown, number>, liveCount: number, liveKeys: () => Iterable<unknown>): number {
    if (cache.size <= liveCount * 2 + 200) return 0
    const live = new Set(liveKeys())
    let removed = 0
    for (const key of cache.keys()) {
        if (!live.has(key)) { cache.delete(key); removed++ }
    }
    return removed
}
