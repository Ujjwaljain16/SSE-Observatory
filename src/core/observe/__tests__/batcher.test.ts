import { describe, it, expect, vi, afterEach } from 'vitest'
import { createBatcher } from '../batcher'
import { Recorder } from '../recorder'
import { TestClock } from '../../testing/clock'

afterEach(() => { vi.useRealTimers() })

describe('createBatcher', () => {
    it('hands over a batch after flushMs, in order, and starts a new one', () => {
        vi.useFakeTimers()
        const batches: number[][] = []
        const b = createBatcher<number>(100, 50, (batch) => batches.push(batch))
        b.push(1); b.push(2)
        vi.advanceTimersByTime(99)
        expect(batches).toEqual([])
        vi.advanceTimersByTime(1)
        expect(batches).toEqual([[1, 2]])
        b.push(3)
        vi.advanceTimersByTime(100)
        expect(batches).toEqual([[1, 2], [3]])
    })

    it('flushes immediately when a batch is full', () => {
        vi.useFakeTimers()
        const batches: number[][] = []
        const b = createBatcher<number>(100, 3, (batch) => batches.push(batch))
        b.push(1); b.push(2)
        expect(batches).toEqual([])
        b.push(3)
        expect(batches).toEqual([[1, 2, 3]])
        vi.advanceTimersByTime(500) // the old timer is gone: no empty or duplicate batch
        expect(batches).toHaveLength(1)
    })

    it('flush() and stop() hand over what is pending now, and never emit an empty batch', () => {
        vi.useFakeTimers()
        const batches: number[][] = []
        const b = createBatcher<number>(100, 50, (batch) => batches.push(batch))
        b.flush()
        b.push(1)
        b.stop()
        b.stop()
        expect(batches).toEqual([[1]])
        b.push(2) // still usable after stop
        vi.advanceTimersByTime(100)
        expect(batches).toEqual([[1], [2]])
    })
})

describe('Recorder.overhead', () => {
    it('reports the cost of recording from sampled records, in microseconds', () => {
        const clock = new TestClock()
        // the sink "takes" 2 microseconds (0.002 ms) of the monotonic clock each time it runs
        const recorder = new Recorder({ clock, onRecord: () => { clock.advance(0.002) } })
        for (let i = 0; i < 640; i++) recorder.record({ kind: 'chunk', bytes: 1 })
        const o = recorder.overhead()
        expect(o.sampled).toBe(10) // every 64th record
        expect(o.avgUs).toBeCloseTo(2, 3)
        expect(o.p99Us).toBeCloseTo(2, 3)
        expect(o.recordsPerSec).toBeGreaterThan(0)
    })

    it('is zero before anything was sampled, and does not change the records', () => {
        const recorder = new Recorder({ clock: new TestClock() })
        expect(recorder.overhead()).toMatchObject({ avgUs: 0, p99Us: 0, sampled: 0 })
        const a = recorder.record({ kind: 'chunk', bytes: 1 })
        expect(a.seq).toBe(0)
    })
})
