import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EventMessage } from '../../types'

// The sandbox is replaced: the test controls when a call "finishes" and what error it reports.
let finish: (value: { event: EventMessage | null; errors: Record<string, string> }) => void = () => undefined
vi.mock('../../utils/interceptorSandbox', () => ({
    compileInterceptor: () => ({ fn: true, error: null }),
    applyInterceptorChain: vi.fn(() => new Promise((resolve) => { finish = resolve as typeof finish })),
    disposeInterceptorPool: vi.fn(),
}))

import { useInterceptors } from '../useInterceptors'

const event: EventMessage = { id: '1', timestamp: 't', type: 'message', data: '{}', raw: '' }
const TIMEOUT = 'Interceptor exceeded 100ms — killed'

beforeEach(() => { localStorage.clear() })

describe('a runtime error belongs to the code that produced it', () => {
    it('is shown against the interceptor when the code is unchanged', async () => {
        const { result } = renderHook(() => useInterceptors())
        act(() => { result.current.addInterceptor() })
        const id = result.current.interceptors.at(-1)!.id
        let pending!: Promise<EventMessage | null>
        act(() => { pending = result.current.applyInterceptors(event) })
        await act(async () => { finish({ event, errors: { [id]: TIMEOUT } }); await pending })
        expect(result.current.interceptors.find((i) => i.id === id)!.lastError).toBe(TIMEOUT)
    })

    it('is dropped when the user fixed the code while the call was still running', async () => {
        const { result } = renderHook(() => useInterceptors())
        act(() => { result.current.addInterceptor() })
        const id = result.current.interceptors.at(-1)!.id
        act(() => { result.current.updateInterceptorCode(id, 'while (true) {}') })
        let pending!: Promise<EventMessage | null>
        act(() => { pending = result.current.applyInterceptors(event) }) // runs the old, looping code
        act(() => { result.current.updateInterceptorCode(id, 'return event') }) // the user fixes it
        await act(async () => { finish({ event, errors: { [id]: TIMEOUT } }); await pending }) // the old call reports its timeout late
        expect(result.current.interceptors.find((i) => i.id === id)!.lastError).toBeNull()
    })
})
