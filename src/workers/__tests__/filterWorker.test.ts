import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    encodeFilterWorkerRequest,
    decodeFilterWorkerResponse,
} from '../contractSchemas'
import type { FilterWorkerRequest, FilterWorkerResponse } from '../contracts'

// Mute console logs during tests
vi.spyOn(console, 'log').mockImplementation(() => { })

describe('filterWorker.ts - Typed Protocol Contracts & Execution', () => {

    let workerOnMessage: (e: MessageEvent<any>) => void
    let postMessageSpy: ReturnType<typeof vi.fn>

    beforeEach(async () => {
        vi.resetModules()

        // Mock the self.postMessage and addEventListener
        postMessageSpy = vi.fn()
            ; (global as any).postMessage = postMessageSpy
            ; (global as any).self = (global as any).self || {}
            ; (global as any).self.postMessage = postMessageSpy
            ; (global as any).self.addEventListener = (event: string, cb: any) => {
                if (event === 'message') {
                    (global as any).self.onmessage = cb
                }
            }

        // Import the handler directly to bypass JSDOM/Vite module caching listener attachment issues
        const { _onMessage } = await import('../filterWorker')
        workerOnMessage = _onMessage
    })

    const sendRequest = (req: FilterWorkerRequest) => {
        // Encode (validates schema)
        const encoded = encodeFilterWorkerRequest(req)

        // Dispatch to worker
        workerOnMessage({ data: encoded } as MessageEvent)
    }

    const expectResponses = (): FilterWorkerResponse[] => {
        const calls = postMessageSpy.mock.calls.map(call => call[0])
        postMessageSpy.mockClear()
        // Decode (validates output schema)
        return calls.map(call => decodeFilterWorkerResponse(call))
    }

    it('should initialize and respond to PING with READY', () => {
        sendRequest({ type: 'PING' })

        const responses = expectResponses()
        expect(responses).toHaveLength(1)
        expect(responses[0].type).toBe('READY')
    })

    it('should store events and return them if no query active', () => {
        sendRequest({ type: 'ADD_EVENTS', events: [{ id: '1', data: 'test', raw: 'test', type: 'message', timestamp: '12:00:00 AM' } as any] })

        const responses = expectResponses()
        expect(responses).toHaveLength(1)
        expect(responses[0].type).toBe('FILTERED_EVENTS')

        const payload = responses[0] as Extract<FilterWorkerResponse, { type: 'FILTERED_EVENTS' }>
        expect(payload.events).toHaveLength(1)
        expect(payload.events[0].id).toBe('1')
        expect(payload.execMs).toBeGreaterThanOrEqual(0)
    })

    it('should clear stored events on CLEAR', () => {
        sendRequest({ type: 'ADD_EVENTS', events: [{ id: '1', data: '', raw: '', type: 'msg', timestamp: '12' } as any, { id: '2', data: '', raw: '', type: 'msg', timestamp: '12' } as any] })
        expectResponses() // flush

        sendRequest({ type: 'CLEAR' })

        const responses = expectResponses()
        expect(responses[0].type).toBe('FILTERED_EVENTS')
        const payload = responses[0] as Extract<FilterWorkerResponse, { type: 'FILTERED_EVENTS' }>
        expect(payload.events).toHaveLength(0)
    })

    it('should successfully apply query parser and filter heavy payloads', () => {
        sendRequest({ type: 'CLEAR' })
        expectResponses()

        const events = [
            { id: '1', type: 'message', timestamp: '12:00:00', data: '{"level":"error", "code": 500}', raw: '{"level":"error", "code": 500}', _searchIndex: 'error 500' },
            { id: '2', type: 'message', timestamp: '12:00:01', data: '{"level":"info", "code": 200}', raw: '{"level":"info", "code": 200}', _searchIndex: 'info 200' },
            { id: '3', type: 'message', timestamp: '12:00:02', data: '{"level":"error", "code": 502}', raw: '{"level":"error", "code": 502}', _searchIndex: 'error 502' }
        ] as any[]

        // Add events
        sendRequest({ type: 'ADD_EVENTS', events })
        expectResponses() // Ignore initial unfiltered return

        // Set query to level == error
        sendRequest({ type: 'QUERY_UPDATE', query: { type: 'comparison', operator: '==', left: 'level', right: 'error' }, search: '' })

        const responses = expectResponses()
        expect(responses[0].type).toBe('FILTERED_EVENTS')

        const payload = responses[0] as Extract<FilterWorkerResponse, { type: 'FILTERED_EVENTS' }>
        expect(payload.events).toHaveLength(2)
        expect(payload.events[0].id).toBe('3') // Newest first
        expect(payload.events[1].id).toBe('1')
    })
})
