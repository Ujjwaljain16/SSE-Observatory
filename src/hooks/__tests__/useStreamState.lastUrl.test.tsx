import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStreamState } from '../useStreamState'
import { LAST_URL_KEY } from '../../utils/lastUrl'

// The stream itself is not under test: only what the connection form remembers and what it does on load.
const connectBase = vi.fn()
vi.mock('../useSharedStream', () => ({
    useSharedStream: () => ({
        connected: false, events: [], epoch: 0, error: '', isLoading: false, reconnecting: false, droppedCount: 0, receivedCount: 0,
        connect: connectBase, disconnect: vi.fn(), clearEvents: vi.fn(), replaceEvents: vi.fn(),
    }),
}))
vi.mock('../useFilterWorker', () => ({
    useFilterWorker: (events: unknown[]) => ({ filteredEvents: events, filterExecMs: 0, isWorkerReady: false, clearWorker: vi.fn() }),
}))

beforeEach(() => {
    localStorage.clear()
    connectBase.mockClear()
})

describe('the connection form remembers the last URL', () => {
    it('starts with the URL that was last connected to, and with an empty token', () => {
        localStorage.setItem(LAST_URL_KEY, 'https://api.example.com/sse')
        const { result } = renderHook(() => useStreamState())
        expect(result.current.streamValue.url).toBe('https://api.example.com/sse')
        expect(result.current.streamValue.bearerToken).toBe('')
    })

    it('starts empty when nothing was remembered', () => {
        const { result } = renderHook(() => useStreamState())
        expect(result.current.streamValue.url).toBe('')
    })

    it('does not connect by itself, with or without a remembered URL', () => {
        localStorage.setItem(LAST_URL_KEY, 'https://api.example.com/sse')
        renderHook(() => useStreamState())
        expect(connectBase).not.toHaveBeenCalled()
    })

    it('remembers a URL when connecting to it, and never the bearer token', () => {
        const { result } = renderHook(() => useStreamState())
        act(() => { result.current.streamValue.connect('https://api.example.com/sse', 'SECRET-BEARER-TOKEN') })
        expect(connectBase).toHaveBeenCalledTimes(1)
        expect(localStorage.getItem(LAST_URL_KEY)).toBe('https://api.example.com/sse')
        const everything = Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join('\n')
        expect(everything).not.toContain('SECRET-BEARER-TOKEN')
    })

    it('does not keep what is typed into the form until it is connected to (half-typed text could be half a secret)', () => {
        const { result } = renderHook(() => useStreamState())
        act(() => { result.current.streamValue.setUrl('https://api.exa') })
        expect(localStorage.getItem(LAST_URL_KEY)).toBeNull()
    })

    it.each([
        ['userinfo', 'https://user:hunter2@api.example.com/sse'],
        ['a token in the query', 'https://api.example.com/sse?token=abc123'],
    ])('still connects to a URL with %s, but does not store it, and forgets the earlier one', (_label, url) => {
        localStorage.setItem(LAST_URL_KEY, 'https://earlier.example.com/sse')
        const { result } = renderHook(() => useStreamState())
        act(() => { result.current.streamValue.connect(url, '') })
        expect(connectBase).toHaveBeenCalledWith(url, '', true, true)
        expect(localStorage.getItem(LAST_URL_KEY)).toBeNull()
        expect(JSON.stringify(Object.entries(localStorage))).not.toContain('hunter2')
        expect(JSON.stringify(Object.entries(localStorage))).not.toContain('abc123')
    })

    it('keeps saved profiles as they were: a token only with the explicit choice', () => {
        const { result } = renderHook(() => useStreamState())
        act(() => { result.current.streamValue.setUrl('https://api.example.com/sse'); result.current.streamValue.setBearerToken('PROFILE-TOKEN'); result.current.streamValue.setProfileName('prod') })
        act(() => { result.current.streamValue.saveProfile(false) })
        expect(JSON.parse(localStorage.getItem('sse-profiles')!)).toEqual([{ name: 'prod', url: 'https://api.example.com/sse', token: '' }])
    })
})
