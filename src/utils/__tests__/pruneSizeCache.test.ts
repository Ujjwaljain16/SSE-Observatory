import { describe, expect, it } from 'vitest'
import { pruneSizeCache } from '../pruneSizeCache'

// The virtualizer keeps a measured height for every row key it has ever measured and never forgets one. The list keys rows by event id, and
// on a long stream the oldest events leave the list, so the cache grew by one entry per event that was ever drawn (about 0.4 MB a minute at
// 200 events/s in the 90-minute soak, issue 100).
const cacheOf = (keys: string[]) => new Map(keys.map((k) => [k, 100] as [string, number]))
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `e${from + i}`)

describe('pruneSizeCache', () => {
    it('drops the heights of rows that are no longer in the list, and keeps the live ones', () => {
        const live = ids(901, 1000)
        const cache = cacheOf([...ids(1, 900), ...live])
        const removed = pruneSizeCache(cache, live.length, () => live)
        expect(removed).toBe(900)
        expect([...cache.keys()]).toEqual(live)
    })

    it('does nothing while the cache is not much larger than the list (no scan on every batch)', () => {
        const live = ids(1, 100)
        const cache = cacheOf([...ids(1, 100), ...ids(101, 150)])
        let scanned = false
        expect(pruneSizeCache(cache, live.length, () => { scanned = true; return live })).toBe(0)
        expect(scanned).toBe(false)
        expect(cache.size).toBe(150)
    })

    it('keeps a measured height for a live row when the list is empty of other keys', () => {
        const cache = cacheOf(ids(1, 1000))
        expect(pruneSizeCache(cache, 3, () => ['e5', 'e6', 'e7'])).toBe(997)
        expect([...cache.keys()]).toEqual(['e5', 'e6', 'e7'])
    })

    it('empties the cache when the list is empty', () => {
        const cache = cacheOf(ids(1, 500))
        pruneSizeCache(cache, 0, () => [])
        expect(cache.size).toBe(0)
    })
})
