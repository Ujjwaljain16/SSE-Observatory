// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createBatcher } from '../batcher'

// Campaign B5: whoever receives the records is not allowed to break the stream. Found by the non-interference test: a sink that threw escaped
// as an uncaught exception from the flush timer.

describe('a batcher whose sink throws', () => {
    it('does not throw out of push, flush or stop, and keeps delivering later batches', () => {
        const delivered: number[][] = []
        let failNext = true
        const batcher = createBatcher<number>(1000, 2, (batch) => { if (failNext) { failNext = false; throw new Error('sink failure') } delivered.push(batch) })
        expect(() => { batcher.push(1); batcher.push(2) }).not.toThrow() // the full batch flushes inside push, and the sink throws
        expect(() => { batcher.push(3); batcher.push(4) }).not.toThrow()
        expect(delivered).toEqual([[3, 4]])
        batcher.push(5)
        expect(() => batcher.stop()).not.toThrow()
        expect(delivered).toEqual([[3, 4], [5]])
    })

    it('does not raise an uncaught exception when the timer is what flushes it', async () => {
        const uncaught: unknown[] = []
        const onUncaught = (e: unknown) => { uncaught.push(e) }
        process.on('uncaughtException', onUncaught)
        try {
            const batcher = createBatcher<number>(5, 100, () => { throw new Error('sink failure') })
            batcher.push(1)
            await new Promise((r) => setTimeout(r, 40))
        } finally { process.off('uncaughtException', onUncaught) }
        expect(uncaught).toEqual([])
    })
})
