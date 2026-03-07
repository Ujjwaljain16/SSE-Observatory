import { renderHook, act, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { useSharedStream } from '../useSharedStream'
import { workerRegistry } from '../../utils/workerRegistry'

// Mock the worker registry to return a fake MessagePort
const mockPort = {
    start: vi.fn(),
    postMessage: vi.fn(),
    onmessage: null as any,
    addEventListener: vi.fn(),
}

const mockWorker = {
    port: mockPort
}

vi.mock('../../utils/workerRegistry', () => ({
    workerRegistry: {
        create: vi.fn(() => mockWorker),
        release: vi.fn(),
    }
}))

describe('useSharedStream', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockPort.onmessage = null
    })

    it('should initialize and connect via worker', () => {
        const { result } = renderHook(() => useSharedStream())

        expect(workerRegistry.create).toHaveBeenCalled()
        expect(mockPort.start).toHaveBeenCalled()

        act(() => {
            result.current.connect('http://test.com', 'token123')
        })

        expect(mockPort.postMessage).toHaveBeenCalledWith({
            type: 'connect',
            url: 'http://test.com',
            token: 'token123'
        })
        expect(result.current.isLoading).toBe(true)
    })

    it('should handle connected message', () => {
        const { result } = renderHook(() => useSharedStream())

        act(() => {
            if (mockPort.onmessage) {
                mockPort.onmessage({ data: { type: 'connected' } } as unknown as MessageEvent)
            }
        })

        expect(result.current.connected).toBe(true)
        expect(result.current.isLoading).toBe(false)
        expect(result.current.error).toBe('')
    })

    it('should receive and append events', async () => {
        const { result } = renderHook(() => useSharedStream())

        act(() => {
            if (mockPort.onmessage) {
                mockPort.onmessage({
                    data: {
                        type: 'event',
                        payload: { raw: '{"message": "hello"}', arrivalTime: 12345 }
                    }
                } as unknown as MessageEvent)
            }
        })

        await waitFor(() => {
            expect(result.current.events).toHaveLength(1)
            expect(result.current.events[0].data).toBe('{"message": "hello"}')
        })
    })

    it('should disconnect from worker', () => {
        const { result } = renderHook(() => useSharedStream())

        act(() => {
            result.current.disconnect()
        })

        expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'disconnect' })
        expect(result.current.connected).toBe(false)
    })

    it('should handle catchup batches', async () => {
        const { result } = renderHook(() => useSharedStream(5))

        act(() => {
            if (mockPort.onmessage) {
                mockPort.onmessage({
                    data: {
                        type: 'catchup',
                        events: [
                            { raw: '{"id": 1}', arrivalTime: 100 },
                            { raw: '{"id": 2}', arrivalTime: 101 }
                        ]
                    }
                } as unknown as MessageEvent)
            }
        })

        await waitFor(() => {
            expect(result.current.events).toHaveLength(2)
        })
    })

    it('should respect maxEvents buffer limit', async () => {
        const MAX = 5
        const { result } = renderHook(() => useSharedStream(MAX))

        act(() => {
            for (let i = 0; i < 10; i++) {
                if (mockPort.onmessage) {
                    mockPort.onmessage({
                        data: {
                            type: 'event',
                            payload: { raw: `{"id": ${i}}`, arrivalTime: 100 + i }
                        }
                    } as unknown as MessageEvent)
                }
            }
        })

        await waitFor(() => {
            expect(result.current.events).toHaveLength(MAX)
            // It pre-pends to the top, so latest (9 down to 5) should be kept
            expect(result.current.events[0].data).toBe('{"id": 9}')
        })
    })

    it('should pass event through interceptors', async () => {
        const interceptor = vi.fn(async (e) => {
            return { ...e, data: 'intercepted' }
        })

        const { result } = renderHook(() => useSharedStream(10, interceptor))

        act(() => {
            if (mockPort.onmessage) {
                mockPort.onmessage({
                    data: {
                        type: 'event',
                        payload: { raw: '{"id": 1}', arrivalTime: 100 }
                    }
                } as unknown as MessageEvent)
            }
        })

        await waitFor(() => {
            expect(interceptor).toHaveBeenCalled()
            expect(result.current.events).toHaveLength(1)
            expect(result.current.events[0].data).toBe('intercepted')
        })
    })
})
