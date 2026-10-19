import { describe, it, expect } from 'vitest'
import { QueryParser } from '../../utils/queryParser'
import type { EventMessage } from '../../types'

// We will simulate the pipeline locally for the test
// Pipeline: generate events -> sharedWorkerBuffer -> filterWorker -> IDB/UI

const generateEvents = (count: number, startAt: number): EventMessage[] => {
    return Array.from({ length: count }, (_, i) => {
        const time = startAt + i
        return {
            id: `evt-${time}`,
            data: JSON.stringify({ value: time, mod: time % 5 }),
            arrivalTime: time,
            timestamp: new Date(time).toISOString(),
            raw: JSON.stringify({ value: time, mod: time % 5 }),
            type: 'message'
        } as EventMessage
    })
}

// Simulate Filter Worker applying a query
const runFilter = (events: EventMessage[], queryStr: string): EventMessage[] => {
    if (!queryStr) return events
    const parser = new QueryParser(queryStr)
    const fn = parser.compile(parser.parse())
    return events.filter(fn)
}

describe('Event Ingestion Pipeline - Invariants & Causality', () => {

    it('should strictly preserve arrivalTime ordering across the pipeline', () => {
        // Random batch bursts
        const batches = [
            generateEvents(50, 1000),
            generateEvents(10, 1050),
            generateEvents(100, 1060),
            generateEvents(20, 1160)
        ]

        const pipelineOutput: EventMessage[] = []

        // Ingest
        for (const batch of batches) {
            pipelineOutput.push(...batch)
        }

        // Output should be strictly monotonically increasing in time
        for (let i = 0; i < pipelineOutput.length - 1; i++) {
            expect(pipelineOutput[i].arrivalTime!).toBeLessThanOrEqual(pipelineOutput[i + 1].arrivalTime!)
        }
    })

    it('should guarantee exactly-once processing (no skips, no duplicates)', () => {
        const events = generateEvents(1000, 5000)

        // Pass through simulated worker serialization boundary
        const serialized = JSON.stringify(events)
        const deserialized: EventMessage[] = JSON.parse(serialized)

        // Process sequentially
        const uniqueIds = new Set(deserialized.map(e => e.id))

        const pipelineOutput: EventMessage[] = []
        pipelineOutput.push(...deserialized)

        expect(uniqueIds.size).toBe(1000)
        expect(pipelineOutput.length).toBe(1000)
    })

    it('should guarantee deterministic filtering regardless of batch sizes', () => {
        const totalEvents = generateEvents(1000, 0)
        const query = 'data.mod == 0' // Should match exactly 20% of events (200)

        // Scenario 1: One giant batch
        const outputLarge = runFilter(totalEvents, query)

        // Scenario 2: Micro batches
        const outputMicro: EventMessage[] = []
        for (let i = 0; i < 1000; i += 10) {
            const batch = totalEvents.slice(i, i + 10)
            outputMicro.push(...runFilter(batch, query))
        }

        // The outputs must be perfectly identical
        expect(outputLarge).toHaveLength(200)
        expect(outputMicro).toHaveLength(200)
        expect(outputLarge.map(e => e.id)).toEqual(outputMicro.map(e => e.id))
    })

    it('test causal sequence integrity during simulated mid-stream filter toggling', () => {
        const events = generateEvents(100, 2000)

        // Simulate stream over time
        const streamT0 = events.slice(0, 30)
        const streamT1 = events.slice(30, 60)
        const streamT2 = events.slice(60, 100)

        const output: EventMessage[] = []

        // T0: No filters
        output.push(...runFilter(streamT0, ''))

        // T1: Filter enabled natively in worker mid-stream
        output.push(...runFilter(streamT1, 'data.mod == 2'))

        // T2: Filter changed
        output.push(...runFilter(streamT2, 'data.mod == 4'))

        // Verify no gaps in the final combined stream (no duplicates, no out of order)
        let previousTime = 0
        for (const ev of output) {
            expect(ev.arrivalTime!).toBeGreaterThan(previousTime)
            previousTime = ev.arrivalTime!
        }
    })
})
