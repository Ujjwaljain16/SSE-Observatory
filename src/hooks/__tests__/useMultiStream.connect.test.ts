import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useMultiStream } from '../useMultiStream'

// Drives a real lane (hook -> client -> parser) through a stubbed fetch. This is the safety net for the lane's
// connection path, which the other tests in this folder do not exercise.
const sse = (...chunks: string[]) => new Response(
    new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder()
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
            controller.close()
        },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
)

afterEach(() => { vi.unstubAllGlobals() })

describe('useMultiStream lane connections', () => {
    it('connects a lane, tags its events with the lane and ends cleanly on an end event', async () => {
        const fetchMock = vi.fn(async () => sse('id: 1\nevent: order\ndata: {"a":1}\n\n', 'data: plain\n\n', 'event: end\ndata: bye\n\n'))
        vi.stubGlobal('fetch', fetchMock)

        const { result } = renderHook(() => useMultiStream())
        let laneId = ''
        act(() => { laneId = result.current.addStream('Orders', 'http://api.test/stream', 'tok') })
        act(() => { result.current.connectStream(laneId) })

        await waitFor(() => expect(result.current.streams[0]!.events).toHaveLength(3))
        const lane = result.current.streams[0]!
        expect(lane.events.map((e) => e.type)).toEqual(['end', 'message', 'order']) // newest first
        expect(lane.events.every((e) => e.streamId === laneId && e.streamColor === lane.color)).toBe(true)
        expect(lane.events.find((e) => e.type === 'order')).toMatchObject({ data: '{"a":1}', sseId: '1' })
        expect(lane.connected).toBe(false) // an `end` event closes the lane
        expect(lane.isLoading).toBe(false)

        // the request goes through the proxy with the token in the body, as before
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe('/api/sse')
        expect(init.method).toBe('POST')
        expect(JSON.parse(String(init.body))).toEqual({ url: 'http://api.test/stream', token: 'Bearer tok' })
    })

    it('shows a clear error on the lane for a fatal HTTP status, and does not keep retrying', async () => {
        const fetchMock = vi.fn(async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }))
        vi.stubGlobal('fetch', fetchMock)

        const { result } = renderHook(() => useMultiStream())
        let laneId = ''
        act(() => { laneId = result.current.addStream('Missing', 'http://api.test/gone') })
        act(() => { result.current.connectStream(laneId) })

        await waitFor(() => expect(result.current.streams[0]!.error).toMatch(/404/))
        expect(result.current.streams[0]).toMatchObject({ connected: false, isLoading: false, retrying: false }) // a failure, not a retry: announced as an alert
        await new Promise((r) => setTimeout(r, 50))
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    // #77: the proxy answers 415 for a target that is not an event stream. The lane must stop after one attempt and say why, as the single stream does.
    it('shows the same message on the lane when the proxy answers 415 for a page, and does not retry', async () => {
        const fetchMock = vi.fn(async () => new Response(
            JSON.stringify({ error: 'Target answers with text/html, not text/event-stream', upstreamContentType: 'text/html' }),
            { status: 415, headers: { 'content-type': 'application/json' } },
        ))
        vi.stubGlobal('fetch', fetchMock)

        const { result } = renderHook(() => useMultiStream())
        let laneId = ''
        act(() => { laneId = result.current.addStream('Page', 'https://example.com/') })
        act(() => { result.current.connectStream(laneId) })

        await waitFor(() => expect(result.current.streams[0]!.error).toBe('The address answers with text/html, not text/event-stream, so there is nothing to retry.'))
        expect(result.current.streams[0]).toMatchObject({ connected: false, isLoading: false })
        await new Promise((r) => setTimeout(r, 80))
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(result.current.streams[0]!.error).not.toMatch(/Retrying/)
    })

    it('a lane whose proxy answers 502 (the target is down) is still retried', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Failed to reach target' }), { status: 502, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)

        const { result } = renderHook(() => useMultiStream())
        let laneId = ''
        act(() => { laneId = result.current.addStream('Down', 'http://api.test/down') })
        act(() => { result.current.connectStream(laneId) })

        await waitFor(() => expect(result.current.streams[0]!.error).toMatch(/Retrying in/))
        expect(result.current.streams[0]!.error).toMatch(/HTTP 502/)
    })

    it('marks a lane that is waiting to reconnect as retrying, so its message is announced as a retry and not as a failure', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502, headers: { 'content-type': 'text/plain' } })))

        const { result } = renderHook(() => useMultiStream())
        let laneId = ''
        act(() => { laneId = result.current.addStream('Flaky', 'http://api.test/flaky') })
        act(() => { result.current.connectStream(laneId) })

        await waitFor(() => expect(result.current.streams[0]!.error).toMatch(/Retrying in \d+s \(attempt 1\)/))
        expect(result.current.streams[0]).toMatchObject({ connected: false, retrying: true })
        act(() => { result.current.disconnectStream(laneId) })
    })

    it('disconnecting a lane stops it and clears its state', async () => {
        const never = new Response(new ReadableStream<Uint8Array>({ start() { /* stays open */ } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        vi.stubGlobal('fetch', vi.fn(async () => never))

        const { result } = renderHook(() => useMultiStream())
        let laneId = ''
        act(() => { laneId = result.current.addStream('Live', 'http://api.test/live') })
        act(() => { result.current.connectStream(laneId) })
        await waitFor(() => expect(result.current.streams[0]!.connected).toBe(true))
        act(() => { result.current.disconnectStream(laneId) })
        expect(result.current.streams[0]).toMatchObject({ connected: false, isLoading: false, error: '' })
    })
})
