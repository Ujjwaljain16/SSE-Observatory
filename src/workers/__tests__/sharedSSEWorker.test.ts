import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { _clearConnectionsForTesting } from '../sharedSSEWorker'

// Mock the SSE proxy ticket so openConnection resolves without network
vi.mock('../../utils/sseProxyUrl', () => ({
    obtainSSEProxyTicket: vi.fn(async (url: string) => url)
}))

// Deterministic async flush: drain microtasks then advance timers
const flushWorker = async () => {
    vi.runAllTicks()          // flush process.nextTick / Promise microtasks
    await Promise.resolve()   // wait one more tick for async resolution
    await vi.runAllTimersAsync() // advance any setTimeout/setInterval callbacks
}

describe('sharedSSEWorker.ts - Multi-tab Connection Logic', () => {

    let workerOnConnect: ((e: MessageEvent) => void)

    beforeAll(async () => {
        // Must be a proper function constructor (not arrow fn) for `new EventSource(...)` to work
        // Each instance needs addEventListener/close etc. for the worker to function
        ; (global as any).EventSource = vi.fn(function (this: any) {
            this.onopen = null
            this.onmessage = null
            this.onerror = null
            this.readyState = 1 // OPEN
            this.close = vi.fn()
            this.addEventListener = vi.fn()
            this.removeEventListener = vi.fn()
            return this
        })
            ; (global as any).EventSource.CLOSED = 2
            ; (global as any).EventSource.OPEN = 1

        await import('../sharedSSEWorker')

        workerOnConnect = (globalThis as any).onconnect ?? (globalThis as any).self?.onconnect
        if (!workerOnConnect) throw new Error('sharedSSEWorker did not register onconnect on globalThis')
    })

    beforeEach(() => {
        vi.useFakeTimers()
        // Clear accumulated connections from previous tests
        _clearConnectionsForTesting()
            // Reinstall constructor mock with fresh method stubs per test
            ; (global as any).EventSource = vi.fn(function (this: any) {
                this.onopen = null
                this.onmessage = null
                this.onerror = null
                this.readyState = 1
                this.close = vi.fn()
                this.addEventListener = vi.fn()
                this.removeEventListener = vi.fn()
                return this
            })
            ; (global as any).EventSource.CLOSED = 2
            ; (global as any).EventSource.OPEN = 1
    })

    afterEach(() => {
        vi.clearAllMocks()
        vi.useRealTimers()
    })

    const createPort = () => ({
        start: vi.fn(),
        postMessage: vi.fn(),
        onmessage: null as any,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    })

    const connectTab = (port: ReturnType<typeof createPort>, url: string, token?: string) => {
        workerOnConnect({ ports: [port] } as unknown as MessageEvent)
        port.onmessage?.({ data: { type: 'connect', url, token } } as unknown as MessageEvent)
    }

    // Access the EventSource instance that the worker actually got — handlers are on 'this'
    const getESInstance = (callIndex = 0) =>
        vi.mocked(global.EventSource as any).mock.instances[callIndex] as any

    it('should open new EventSource and broadcast connected', async () => {
        const port = createPort()
        connectTab(port, '/events')

        await flushWorker()

        expect(global.EventSource).toHaveBeenCalledWith('/events')

        const es = getESInstance()
        expect(es.onopen).not.toBeNull()
        es.onopen()

        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'connected' })
        )
    })

    it('should not open a second EventSource for the same URL+Token', async () => {
        const port1 = createPort()
        connectTab(port1, '/events', 'token1')
        await flushWorker()

        const es1 = getESInstance()
        es1.readyState = 1 // OPEN
        es1.onopen()

        const port2 = createPort()
        connectTab(port2, '/events', 'token1')
        await flushWorker()

        // Only one EventSource should be created
        expect(global.EventSource).toHaveBeenCalledTimes(1)
        // Second port gets 'connected' immediately (connection already open)
        expect(port2.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'connected' })
        )
    })

    it('should multiplex events to all active ports', async () => {
        const port1 = createPort()
        const port2 = createPort()

        connectTab(port1, '/events')
        await flushWorker()

        connectTab(port2, '/events')
        await flushWorker()

        const es = getESInstance()
        expect(es.onmessage).not.toBeNull()
        es.onmessage({ data: '{"test":true}' })

        expect(port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'event' }))
        expect(port2.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'event' }))
    })

    it('should send catch-up buffer to late joiners', async () => {
        const port1 = createPort()
        connectTab(port1, '/events')
        await flushWorker()

        const es = getESInstance()
        es.onmessage({ data: 'event1' })
        es.onmessage({ data: 'event2' })
        es.onmessage({ data: 'event3' })

        const port2 = createPort()
        connectTab(port2, '/events')
        await flushWorker()

        expect(port2.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'catchup',
                events: expect.arrayContaining([
                    expect.objectContaining({ raw: 'event1' }),
                    expect.objectContaining({ raw: 'event3' }),
                ])
            })
        )
    })

    it('should initiate Zombie cleanup when all ports disconnect', async () => {
        const port = createPort()
        connectTab(port, '/events')
        await flushWorker()

        const es = getESInstance()
        es.close = vi.fn() // Fresh mock so we only catch zombie-triggered close

        port.onmessage?.({ data: { type: 'disconnect' } } as unknown as MessageEvent)
        await flushWorker()

        // Advance past ZOMBIE_TIMEOUT_MS (60s)
        vi.advanceTimersByTime(65_000)
        await vi.runAllTimersAsync()

        expect(es.close).toHaveBeenCalled()
    })

    it('should not duplicate events during reconnect storm', async () => {
        const port = createPort()
        connectTab(port, '/events')
        await flushWorker()

        const es1 = getESInstance(0)
        es1.onmessage({ data: 'event1' })

        // Simulate stream error and tab reconnect
        port.onmessage?.({ data: { type: 'disconnect' } } as unknown as MessageEvent)
        await flushWorker()
        _clearConnectionsForTesting()

        connectTab(port, '/events')
        await flushWorker()

        const instances = vi.mocked(global.EventSource as any).mock.instances
        const es2 = instances[instances.length - 1] as any
        es2?.onmessage?.({ data: 'event2' })

        // event2 should be broadcast exactly once
        expect(port.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'event', payload: expect.objectContaining({ raw: 'event2' }) })
        )
    })
})
