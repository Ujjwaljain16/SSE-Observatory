import { renderHook, act, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useSharedStream } from '../useSharedStream'
import type { EventMessage } from '../../types'
import { observationRegistry, MAIN_STREAM } from '../../doctor/observationRegistry'

const mockPort = { start: vi.fn(), postMessage: vi.fn(), onmessage: null as ((e: MessageEvent) => void) | null }
const mockWorker: { port: typeof mockPort; onerror: unknown } = { port: mockPort, onerror: null }

vi.mock('../../utils/workerRegistry', () => ({
    workerRegistry: { create: vi.fn(() => mockWorker), release: vi.fn() },
}))

// Stand-in for the in-page fallback client
const clients: Array<{ opts: any; started: number; stopped: number }> = []
vi.mock('../../core/sse/sseClient', () => ({
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

    it('puts the observation batches of the worker into the registry, and ignores a stream the tab has left', () => {
        observationRegistry.reset(MAIN_STREAM)
        setup()
        const chunk = (seq: number) => ({ seq, t: seq, conn: 0, kind: 'chunk', bytes: 10 + seq })
        deliver({ type: 'observations', key: KEY, captureId: 'cap-1', batch: [chunk(0), chunk(1)] })
        deliver({ type: 'observations', key: 'other::', captureId: 'cap-x', batch: [chunk(9)] })
        const entry = observationRegistry.get(MAIN_STREAM)!
        expect(entry.captureId).toBe('cap-1')
        expect(entry.store.snapshot().map((o) => o.seq)).toEqual([0, 1])
    })

    it('with recording turned off the connect message says so, and the in-page client is not observed', async () => {
        localStorage.setItem('sse.recording', 'off')
        try {
            const hook = renderHook(() => useSharedStream())
            act(() => { hook.result.current.connect('http://test.com', 'tok') })
            expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'connect', url: 'http://test.com', token: 'tok', useProxy: true, recording: false })
        } finally { localStorage.removeItem('sse.recording') }
    })

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

    describe('worker watchdog', () => {
        afterEach(() => { vi.useRealTimers() })

        it('pings the worker and carries on in the page when the worker goes silent (killed workers raise no event)', () => {
            vi.useFakeTimers()
            setup()
            status('open')
            expect(clients).toHaveLength(0)
            act(() => { vi.advanceTimersByTime(5_000) })
            expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'ping' })
            // nothing ever comes back
            act(() => { vi.advanceTimersByTime(20_000) })
            expect(clients).toHaveLength(1)           // the same connection now runs inside the page
            expect(clients[0].started).toBe(1)
        })

        it('takes over with the last event id the worker delivered, so the stream resumes instead of restarting from scratch', () => {
            vi.useFakeTimers()
            setup()
            status('open')
            sse('a', 1, { id: '8' })
            sse('b', 2, { id: '9' })
            act(() => { vi.advanceTimersByTime(25_000) }) // the worker never answers: fall back to an in-page client
            expect(clients).toHaveLength(1)
            expect(clients[0].opts.initialLastEventId).toBe('9')
        })

        it('does not carry an id when no event with an id had arrived', () => {
            vi.useFakeTimers()
            setup()
            status('open')
            sse('a', 1) // no id on this stream
            act(() => { vi.advanceTimersByTime(25_000) })
            expect(clients[0].opts.initialLastEventId).toBe('')
        })

        it('keeps using the worker while it answers pings', () => {
            vi.useFakeTimers()
            setup()
            status('open')
            for (let i = 0; i < 12; i++) {
                act(() => { vi.advanceTimersByTime(5_000) })
                deliver({ type: 'pong' })
            }
            expect(clients).toHaveLength(0)
        })
    })

    it('takes a batched events message in order, skipping sequence numbers it already has', async () => {
        const { result } = setup()
        const p = (n: number) => ({ event: 'message', data: `e${n}`, id: '', raw: '', arrivalTime: n, seq: n })
        sse('e1', 1)
        deliver({ type: 'events', key: KEY, payloads: [p(1), p(2), p(3)] }) // 1 repeats what already arrived
        deliver({ type: 'events', key: 'other::', payloads: [p(99)] })      // a stream this tab left
        deliver({ type: 'events', key: KEY, payloads: [p(3), p(4)] })
        await waitFor(() => expect(data(result)).toEqual(['e4', 'e3', 'e2', 'e1']))
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

    it('records in the page too: the in-page client is observed, adopted by the registry, and events point at their records', async () => {
        observationRegistry.reset(MAIN_STREAM)
        const { result } = renderHook(() => useSharedStream())
        act(() => { result.current.connect('http://api.test/stream') })
        expect(typeof clients[0].opts.onObservation).toBe('function')
        act(() => {
            clients[0].opts.onObservation({ kind: 'chunk', bytes: 30 })
            clients[0].opts.onObservation({ kind: 'event', event: 'order', sseId: '5', dataBytes: 3 }) // seq 1
            clients[0].opts.onMessage({ event: 'order', data: 'abc', id: '5', raw: '' })
        })
        await waitFor(() => expect(result.current.events).toHaveLength(1))
        expect(result.current.events[0].obsSeq).toBe(1)
        const entry = observationRegistry.get(MAIN_STREAM)!
        expect(entry.store.snapshot().map((o) => o.kind)).toEqual(['chunk', 'event'])
        // a fresh connect forgets the previous stream's records
        act(() => { result.current.connect('http://other.test/stream') })
        expect(observationRegistry.get(MAIN_STREAM)!.store.snapshot()).toEqual([])
    })

    it('a new connection starts fresh: the previous stream\'s event id is not carried over', async () => {
        const { result } = renderHook(() => useSharedStream())
        act(() => { result.current.connect('http://a.test/s') })
        expect(clients[0].opts.initialLastEventId).toBe('')
        act(() => { clients[0].opts.onMessage({ event: 'message', data: 'x', id: '77', raw: '' }) })
        act(() => { result.current.connect('http://b.test/s') })
        expect(clients[1].opts.initialLastEventId).toBe('')
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
