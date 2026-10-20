import { describe, it, expect } from 'vitest'
import { FifoQueue } from '../fifoQueue'

describe('FifoQueue', () => {
    it('is first in, first out and tracks its length', () => {
        const q = new FifoQueue<number>()
        for (let i = 0; i < 10; i++) q.push(i)
        expect(q.length).toBe(10)
        expect(q.take(3)).toEqual([0, 1, 2])
        expect(q.length).toBe(7)
        expect(q.take(100)).toEqual([3, 4, 5, 6, 7, 8, 9])
        expect(q.length).toBe(0)
        expect(q.take(5)).toEqual([])
    })

    it('dropOldest discards from the front and reports how many', () => {
        const q = new FifoQueue<number>()
        for (let i = 0; i < 6; i++) q.push(i)
        expect(q.dropOldest(2)).toBe(2)
        expect(q.dropOldest(100)).toBe(4)
        expect(q.length).toBe(0)
        q.push(9)
        expect(q.take(1)).toEqual([9])
    })

    it('stays correct across compaction while pushing and taking interleaved', () => {
        const q = new FifoQueue<number>()
        let next = 0
        let expected = 0
        for (let round = 0; round < 50; round++) {
            for (let i = 0; i < 3000; i++) q.push(next++)
            for (const v of q.take(2500)) expect(v).toBe(expected++)
        }
        expect(q.length).toBe(next - expected)
        for (const v of q.take(q.length)) expect(v).toBe(expected++)
        expect(expected).toBe(next)
    })

    it('clear empties it', () => {
        const q = new FifoQueue<string>()
        q.push('a'); q.push('b')
        q.clear()
        expect(q.length).toBe(0)
        expect(q.take(1)).toEqual([])
    })

    it('draining a deep queue is linear, not quadratic', () => {
        const q = new FifoQueue<number>()
        for (let i = 0; i < 200_000; i++) q.push(i)
        const t0 = performance.now()
        while (q.length > 0) q.take(50)
        // splice(0, 50) on a 200k array 4000 times takes seconds; this should take a few milliseconds
        expect(performance.now() - t0).toBeLessThan(500)
    })
})
