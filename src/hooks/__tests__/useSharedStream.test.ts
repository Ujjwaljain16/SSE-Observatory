import { renderHook, act, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useSharedStream } from '../useSharedStream'
import type { EventMessage } from '../../types'

const mockPort = { start: vi.fn(), postMessage: vi.fn(), onmessage: null as ((e: MessageEvent) => void) | null }
const mockWorker: { port: typeof mockPort; onerror: unknown } = { port: mockPort, onerror: null }

vi.mock('../../utils/workerRegistry', () => ({
    workerRegistry: { create: vi.fn(() => mockWorker), release: vi.fn() },
}))

// Stand-in for the in-page fallback client
const clients: Array<{ opts: any; started: number; stopped: number }> = []
vi.mock('../../utils/sseClient', () => ({
    SSEClient: class {
        started = 0
        stopped = 0
        constructor(public opts: any) { clients.push(this) }
        start() { this.started++ }
        stop() { this.stopped++ }
    },
}))

const KEY = 'http://test.com::tok'
const deliver = (data: unknown) => act(() => { mockPort.onmessage?.({ data } as MessageEvent) })
const status = (phase: string, extra: object = {}) => deliver({ type: 'status', key: KEY, phase, ...extra })
const sse = (data: string, seq: number, extra: object = {}) =>
    deliver({ type: 'event', key: KEY, payload: { event: 'message', data, id: '', raw: `data: ${data}`, arrivalTime: 1000 + seq, seq, ...extra } })

describe('useSharedStream (SharedWorker transport)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockPort.onmessage = null
        clients.length = 0
    })

    const setup = (...args: Parameters<typeof useSharedStream>) => {
        const hook = renderHook(() => useSharedStream(...args))
        act(() => { hook.result.current.connect('http://test.com', 'tok') })
        return hook
    }
    const data = (r: { current: { events: EventMessage[] } }) => r.current.events.map((e) => e.data)

    it('asks the worker to connect and reports the connecting state', () => {
        const { result } = setup()
        expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'connect', url: 'http://test.com', token: 'tok', useProxy: true })
        expect(result.current.isLoading).toBe(true)
        expect(result.current.status).toBe('connecting')
    })

    it('maps worker status messages to connected / reconnecting / failed / ended', () => {
        const { result } = setup()
        status('open')
        expect(result.current).toMatchObject({ connected: true, isLoading: false, reconnecting: false, error: '' })

        status('reconnecting', { attempt: 2, delayMs: 4000, reason: 'HTTP 503' })
        expect(result.current).toMatchObject({ connected: false, reconnecting: true })
        expect(result.current.error).toMatch(/HTTP 503.*Retrying in 4s \(attempt 2\)/)

        status('open')
        expect(result.current.error).toBe('')

        status('failed', { reason: 'HTTP 401 – Unauthorized' })
        expect(result.current).toMatchObject({ connected: false, isLoading: false, reconnecting: false, status: 'failed', error: 'HTTP 401 – Unauthorized' })

        status('ended', { reason: 'The server ended the stream' })
        expect(result.current).toMatchObject({ status: 'ended', isLoading: false })
        expect(result.current.error).toMatch(/ended the stream/)
    })

    it('never leaves the UI stuck in "loading" after a failed first attempt', () => {
        const { result } = setup()
        status('failed', { reason: 'HTTP 404' })
        expect(result.current.isLoading).toBe(false)
    })

    it('ingests events newest-first, preserving arrival order within a burst, with names and ids', async () => {
        const { result } = setup()
        status('open')
        act(() => { for (let i = 1; i <= 50; i++) mockPort.onmessage?.({ data: { type: 'event', key: KEY, payload: { event: i % 2 ? 'odd' : 'even', data: `e${i}`, id: String(i), raw: '', arrivalTime: i, seq: i } } } as MessageEvent) })
        await waitFor(() => expect(result.current.events).toHaveLength(50))
        expect(result.current.events[0].data).toBe('e50')
        expect(result.current.events[49].data).toBe('e1')
        expect(result.current.events[0].type).toBe('even') // the SSE event name is kept
        expect(result.current.events[0].sseId).toBe('50')
    })

    it('parses JSON once: parsedType and a search index are set', async () => {
        const { result } = setup()
        sse('{"type":"order","n":1}', 1)
        await waitFor(() => expect(result.current.events).toHaveLength(1))
        expect(result.current.events[0].parsedType).toBe('order')
        expect(result.current.events[0]._searchIndex).toBe('{"type":"order","n":1}')
    })

    it('still delivers events when animation frames never fire (hidden tab or pane)', async () => {
        vi.stubGlobal('requestAnimationFrame', () => 0)
        vi.stubGlobal('cancelAnimationFrame', () => undefined)
        try {
            const { result } = setup()
            sse('a', 1); sse('b', 2)
            await waitFor(() => expect(data(result)).toEqual(['b', 'a']), { timeout: 1000 })
        } finally {
            vi.unstubAllGlobals()
        }
    })

    it('spreads a large burst over several flushes instead of one long task', async () => {
        const { result } = setup(5000)
        const N = 3000
        act(() => { for (let i = 1; i <= N; i++) mockPort.onmessage?.({ data: { type: 'event', key: KEY, payload: { event: 'message', data: 'e' + i, id: '', raw: '', arrivalTime: i, seq: i } } } as MessageEvent) })
        await waitFor(() => expect(result.current.events).toHaveLength(N), { timeout: 5000 })
        expect(result.current.events[0].data).toBe('e' + N)
        expect(result.current.events[N - 1].data).toBe('e1')
        expect(result.current.receivedCount).toBe(N)
    })

    it('respects the ring buffer size', async () => {
        const { result } = setup(5)
        for (let i = 1; i <= 12; i++) sse(`e${i}`, i)
        await waitFor(() => expect(data(result)).toEqual(['e12', 'e11', 'e10', 'e9', 'e8']))
    })

    it('ignores messages from a stream the tab has left and drops duplicate sequence numbers', async () => {
        const { result } = setup()
        deliver({ type: 'event', key: 'other::', payload: { event: 'message', data: 'stale', id: '', raw: '', arrivalTime: 1, seq: 1 } })
        sse('a', 10)
        sse('a-again', 10)
        sse('older', 9)
        sse('b', 11)
        await waitFor(() => expect(data(result)).toEqual(['b', 'a']))
    })

    it('replays catch-up events in chronological order, once', async () => {
        const { result } = setup()
        const mk = (n: number) => ({ event: 'message', data: `c${n}`, id: '', raw: '', arrivalTime: n, seq: n })
        deliver({ type: 'catchup', key: KEY, events: [mk(1), mk(2), mk(3)] })
        await waitFor(() => expect(data(result)).toEqual(['c3', 'c2', 'c1']))
        deliver({ type: 'catchup', key: KEY, events: [mk(1), mk(2), mk(3), mk(4)] }) // same tab asks again
        await waitFor(() => expect(data(result)).toEqual(['c4', 'c3', 'c2', 'c1']))
    })

    it('runs interceptors in arrival order even when they finish out of order, and drops nulls', async () => {
        const interceptor = vi.fn(async (e: EventMessage) => {
            await new Promise((r) => setTimeout(r, e.data === 'slow' ? 40 : 1))
            return e.data === 'drop' ? null : { ...e, data: `${e.data}!` }
        })
        const { result } = setup(100, interceptor)
        sse('slow', 1); sse('drop', 2); sse('fast', 3)
        await waitFor(() => expect(data(result)).toEqual(['fast!', 'slow!']))
        expect(interceptor).toHaveBeenCalledTimes(3)
    })

    it('keeps the event when an interceptor throws', async () => {
        const { result } = setup(100, async () => { throw new Error('boom') })
        sse('x', 1)
        await waitFor(() => expect(data(result)).toEqual(['x']))
    })

    it('persists every accepted event', async () => {
        const persist = vi.fn()
        setup(100, undefined, persist)
        sse('a', 1); sse('b', 2)
        await waitFor(() => expect(persist).toHaveBeenCalledTimes(2))
    })

    it('connect clears history by default; clearHistory=false keeps it', async () => {
        const { result } = setup()
        sse('a', 1)
        await waitFor(() => expect(result.current.events).toHaveLength(1))
        act(() => { result.current.connect('http://test.com', 'tok', false) })
        expect(result.current.events).toHaveLength(1)
        act(() => { result.current.connect('http://test.com', 'tok') })
        expect(result.current.events).toHaveLength(0)
    })

    it('disconnect tells the worker and returns to idle', () => {
        const { result } = setup()
        status('open')
        act(() => { result.current.disconnect() })
        expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'disconnect' })
        expect(result.current).toMatchObject({ connected: false, status: 'idle', isLoading: false })
    })

    it('rejects an empty URL without touching the worker', () => {
        const { result } = renderHook(() => useSharedStream())
        act(() => { result.current.connect('   ') })
        expect(mockPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'connect' }))
        expect(result.current.status).toBe('failed')
        expect(result.current.error).toMatch(/valid URL/)
    })
})

describe('useSharedStream (in-page fallback)', () => {
    beforeEach(() => { vi.clearAllMocks(); clients.length = 0; vi.stubGlobal('SharedWorker', undefined) })
    afterEach(() => vi.unstubAllGlobals())

    it('runs an SSEClient in the page when SharedWorker is not available', async () => {
        const { result } = renderHook(() => useSharedStream())
        act(() => { result.current.connect('http://api.test/stream', 'tok', true, true) })
        expect(mockPort.postMessage).not.toHaveBeenCalled()
        expect(clients).toHaveLength(1)
        expect(clients[0].started).toBe(1)
        expect(clients[0].opts.request('')).toMatchObject({ url: '/api/sse', method: 'POST' }) // proxied, token in the body
        expect(JSON.parse(clients[0].opts.request('').body)).toEqual({ url: 'http://api.test/stream', token: 'Bearer tok' })

        act(() => { clients[0].opts.onPhase('open', { attempt: 0 }) })
        expect(result.current.connected).toBe(true)
        act(() => { clients[0].opts.onMessage({ event: 'order', data: '{"a":1}', id: '5', raw: '' }) })
        await waitFor(() => expect(result.current.events).toHaveLength(1))
        expect(result.current.events[0].type).toBe('order')

        act(() => { result.current.disconnect() })
        expect(clients[0].stopped).toBeGreaterThan(0)
        expect(result.current.status).toBe('idle')
    })

    it('reconnecting replaces the old client', () => {
        const { result } = renderHook(() => useSharedStream())
        act(() => { result.current.connect('http://a.test/s') })
        act(() => { result.current.connect('http://b.test/s') })
        expect(clients).toHaveLength(2)
        expect(clients[0].stopped).toBeGreaterThan(0)
        expect(clients[1].started).toBe(1)
    })
})
