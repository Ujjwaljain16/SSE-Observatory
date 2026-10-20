import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useEventIngest } from '../useEventIngest'
import { observationRegistry } from '../../doctor/observationRegistry'
import { CaptureStore } from '../../core/observe/captureStore'

const msg = (i: number) => ({ event: 'message', data: `e${i}`, id: String(i), raw: '', arrivalTime: i, seq: i })

beforeEach(() => { observationRegistry.reset('ingest-test') })

describe('useEventIngest consumer samples', () => {
    it('reports how long the oldest message of a flushed slice waited, in the page domain', async () => {
        observationRegistry.attach('ingest-test', new CaptureStore(), 'cap')
        const { result } = renderHook(() => useEventIngest({ maxEvents: 100, streamId: 'ingest-test' }))
        act(() => { result.current.push([msg(1), msg(2), msg(3)]) })
        await waitFor(() => expect(result.current.events).toHaveLength(3))
        const samples = observationRegistry.get('ingest-test')!.consumer
        expect(samples.length).toBeGreaterThan(0)
        const total = samples.reduce((n, s) => n + (s.kind === 'consumer' ? s.n : 0), 0)
        expect(total).toBe(3)
        const first = samples[0]!
        expect(first).toMatchObject({ kind: 'consumer', domain: 'page' })
        if (first.kind === 'consumer') {
            expect(first.lagMs).toBeGreaterThanOrEqual(0)
            expect(first.processedT).toBeGreaterThanOrEqual(first.receivedT)
        }
    })

    it('does nothing when no observation entry exists for the stream', async () => {
        const { result } = renderHook(() => useEventIngest({ maxEvents: 100, streamId: 'ingest-test' }))
        act(() => { result.current.push(msg(1)) })
        await waitFor(() => expect(result.current.events).toHaveLength(1))
        expect(observationRegistry.get('ingest-test')).toBeUndefined()
    })

    it('keeps the timing queue in step when the message queue overflows or is cleared', async () => {
        observationRegistry.attach('ingest-test', new CaptureStore(), 'cap')
        const { result } = renderHook(() => useEventIngest({ maxEvents: 50, streamId: 'ingest-test' }))
        act(() => { result.current.push(Array.from({ length: 20_500 }, (_, i) => msg(i))) })
        expect(result.current.droppedCount).toBe(500)
        act(() => { result.current.clear() })
        act(() => { result.current.push(msg(1)) })
        await waitFor(() => expect(result.current.events).toHaveLength(1))
        const samples = observationRegistry.get('ingest-test')!.consumer
        expect(samples.at(-1)).toMatchObject({ kind: 'consumer', n: 1 })
    })
})
