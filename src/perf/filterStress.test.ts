import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FilterWorkerRequest } from '../workers/contracts'

describe('Filter Worker - Throughput Stress', () => {

    let workerOnMessage: (e: MessageEvent<any>) => void
    let postMessageSpy: ReturnType<typeof vi.fn>

    beforeEach(async () => {
        vi.resetModules()

        postMessageSpy = vi.fn()
            ; (global as any).postMessage = postMessageSpy
            ; (global as any).self = (global as any).self || {}
            ; (global as any).self.postMessage = postMessageSpy
            ; (global as any).self.addEventListener = (event: string, cb: any) => {
                if (event === 'message') {
                    (global as any).self.onmessage = cb
                }
            }

        const { _onMessage } = await import('../workers/filterWorker')
        workerOnMessage = _onMessage
    })

    const sendRequest = (req: FilterWorkerRequest) => {
        workerOnMessage({ data: req } as MessageEvent)
    }

    const expectResponses = (): any[] => {
        const calls = postMessageSpy.mock.calls.map(call => call[0])
        postMessageSpy.mockClear()
        return calls
    }

    it('should handle 100k events and complex filters without dropping events', () => {
        // Generate 100k events
        const EVENTS_COUNT = 100_000
        const events = Array.from({ length: EVENTS_COUNT }, (_, i) => ({
            id: `sys-${i}`,
            type: 'message',
            timestamp: `12:00:00`,
            data: `{"level": "info", "latency": ${i % 1000}, "service": "auth"}`,
            raw: `{"level": "info", "latency": ${i % 1000}, "service": "auth"}`,
            _searchIndex: `info ${i % 1000} auth`
        })) as any[]

        // Send in 10 batches of 10k to simulate burst pressure
        for (let i = 0; i < 10; i++) {
            const batch = events.slice(i * 10000, (i + 1) * 10000)
            sendRequest({ type: 'ADD_EVENTS', events: batch })
        }

        expectResponses() // clear unfiltered broadcast spam

        // Apply a query that forces it to parse and scan all 100k
        // "latency >= 500 AND service == 'auth'"
        const startMs = Date.now()

        sendRequest({
            type: 'QUERY_UPDATE',
            query: {
                type: 'logical',
                operator: 'AND',
                left: { type: 'comparison', operator: '>=', left: 'latency', right: 500 },
                right: { type: 'comparison', operator: '==', left: 'service', right: 'auth' }
            },
            search: ''
        })

        const responses = expectResponses()
        const endMs = Date.now()
        const workerProcessingTime = endMs - startMs

        const finalResponse = responses.find(r => r.type === 'FILTERED_EVENTS')
        expect(finalResponse).toBeDefined()

        // 50% hit rate of 100k
        expect(finalResponse.events).toHaveLength(50_000)

        // Processing should be extremely fast, < 200ms usually on modern engines, give it < 500ms safety
        expect(finalResponse.execMs).toBeLessThan(500)
        expect(workerProcessingTime).toBeLessThan(1000) // Total latency

        const droppedEventCount = EVENTS_COUNT - (finalResponse.events.length * 2) // Since 50% hit rate
        expect(droppedEventCount).toBe(0) // No dropped events
    })
})
