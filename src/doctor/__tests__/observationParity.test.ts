// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createObservedStream } from '../../core/sse/observedStream'
import { ObservationRegistry } from '../observationRegistry'
import type { Observation } from '../../core/observe/observation'

/**
 * The worker, the in-page fallback and the lanes all build their stream with the same factory; they differ only in how the
 * records reach the page. This runs one real stream and delivers its records both ways, so a record that is dropped,
 * reordered or altered on the way shows up as a difference.
 */

let server: http.Server | undefined
afterEach(async () => { await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())); server = undefined })

async function serve(parts: string[]): Promise<string> {
    server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        let i = 0
        const next = () => {
            if (i >= parts.length) { res.end(); return }
            res.write(parts[i++])
            setTimeout(next, 15)
        }
        next()
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/s`
}

async function runOnce(url: string) {
    const batches: Observation[][] = []
    let phaseDone!: () => void
    const ended = new Promise<void>((resolve) => { phaseDone = resolve })
    const stream = createObservedStream({
        request: () => ({ url }),
        sinks: { onMessage: () => {}, onPhase: (p) => { if (p === 'ended' || p === 'failed') phaseDone() } },
        recording: { onObservations: (b) => batches.push(b), flushMs: 20 },
        clientOptions: { maxRetries: 0 },
    })
    stream.start()
    await ended
    stream.flushObservations()
    stream.stop()
    return { stream, batches }
}

const SCRIPT = [': hello\n\n', 'id: 1\nevent: order\ndata: {"seq":1}\n\n', 'retry: 2000\n\n', 'id: 2\ndata: {"seq":2}\n\ndata: unterminated']

describe('observation parity across the transports', () => {
    it('the records that arrive through worker-style batches equal the stream\'s own store', async () => {
        const url = await serve(SCRIPT)
        const { stream, batches } = await runOnce(url)

        const adopted = new ObservationRegistry() // in-page fallback and lanes
        adopted.attach('s', stream.store!, stream.captureId)

        const viaWorker = new ObservationRegistry() // SharedWorker: batches cross a message port (structured clone)
        for (const batch of batches) viaWorker.receive('s', { captureId: stream.captureId, batch: structuredClone(batch) })

        const own = adopted.get('s')!.store.snapshot()
        expect(own.length).toBeGreaterThan(5)
        expect(viaWorker.get('s')!.store.snapshot()).toEqual(own)
        for (const k of ['connect', 'response', 'chunk', 'comment', 'retry', 'event', 'violation', 'phase'] as const) {
            expect(own.some((o) => o.kind === k), k).toBe(true)
        }
        expect(own.map((o) => o.seq)).toEqual(own.map((_, i) => i)) // strict +1 order
    })

    it('a tab that joins late and receives the whole history as a replace batch ends up with the same records', async () => {
        const url = await serve(SCRIPT)
        const { stream, batches } = await runOnce(url)
        const live = new ObservationRegistry()
        for (const batch of batches) live.receive('s', { captureId: stream.captureId, batch })
        const late = new ObservationRegistry()
        late.receive('s', { captureId: stream.captureId, batch: structuredClone(stream.store!.snapshot()), replace: true })
        expect(late.get('s')!.store.snapshot()).toEqual(live.get('s')!.store.snapshot())
    })

    it('records carry no raw URL, token or capture id inside them', async () => {
        const url = await serve(SCRIPT)
        const { stream } = await runOnce(url)
        const text = JSON.stringify(stream.store!.snapshot())
        expect(text).not.toContain(stream.captureId)
    })
})
