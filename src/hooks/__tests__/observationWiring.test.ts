import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useMultiStream } from '../useMultiStream'
import { observationRegistry, MAIN_STREAM } from '../../doctor/observationRegistry'

// Lanes run a real client over a stubbed fetch, so this checks the whole path from the wire to the registry.
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

beforeEach(() => { observationRegistry.reset(MAIN_STREAM) })
afterEach(() => { vi.unstubAllGlobals() })

describe('lanes record into the registry', () => {
    it('each lane gets its own records, and its events point at their event records', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => sse(': hb\n\n', 'id: 1\ndata: {"a":1}\n\n', 'id: 2\ndata: {"a":2}\n\n', 'event: end\ndata: x\n\n')))
        const { result } = renderHook(() => useMultiStream())
        let laneId = ''
        act(() => { laneId = result.current.addStream('Orders', 'http://api.test/s') })
        act(() => { result.current.connectStream(laneId) })
        await waitFor(() => expect(result.current.streams[0]!.events).toHaveLength(3))

        const entry = observationRegistry.get(laneId)!
        const records = entry.store.snapshot()
        const kinds = new Set(records.map((o) => o.kind))
        for (const k of ['connect', 'response', 'chunk', 'comment', 'event', 'phase'] as const) expect(kinds).toContain(k)
        // evidence can find the event: each lane event's obsSeq is the seq of its own event record
        const eventSeqs = records.filter((o) => o.kind === 'event').map((o) => o.seq)
        expect(result.current.streams[0]!.events.map((e) => e.obsSeq).reverse()).toEqual(eventSeqs)
        expect(entry.captureId).toBeTruthy()
        expect(JSON.stringify(records)).not.toContain(entry.captureId as string) // the capture id is not inside records

        act(() => { result.current.removeStream(laneId) })
        expect(observationRegistry.get(laneId)).toBeUndefined()
    })

    it('two lanes do not mix their records', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => sse('data: x\n\n', 'event: end\ndata: y\n\n')))
        const { result } = renderHook(() => useMultiStream())
        let a = ''; let b = ''
        act(() => { a = result.current.addStream('A', 'http://a.test/s'); b = result.current.addStream('B', 'http://b.test/s') })
        act(() => { result.current.connectStream(a) })
        await waitFor(() => expect(result.current.streams[0]!.events).toHaveLength(2))
        expect(observationRegistry.get(a)!.store.snapshot().length).toBeGreaterThan(0)
        expect(observationRegistry.get(b)).toBeUndefined() // B never connected
        act(() => { result.current.connectStream(b) })
        await waitFor(() => expect(result.current.streams[1]!.events).toHaveLength(2))
        expect(observationRegistry.get(a)!.captureId).not.toBe(observationRegistry.get(b)!.captureId)
    })
})
