// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createObservedStream, type ObservedStreamOptions } from '../observedStream'
import type { SSEClient, SSEClientOptions, SSEPhase } from '../sseClient'
import type { IncomingSSE } from '../incoming'
import type { Observation } from '../../observe/observation'

class FakeClient {
    static last: FakeClient | null = null
    constructor(public opts: SSEClientOptions) { FakeClient.last = this }
    isRunning = false
    lastId = ''
    start() { this.isRunning = true }
    stop() { this.isRunning = false }
}
const fakeFactory = (o: SSEClientOptions) => new FakeClient(o) as unknown as SSEClient

function build(over: Partial<ObservedStreamOptions> = {}) {
    const messages: IncomingSSE[] = []
    const batches: Observation[][] = []
    const stream = createObservedStream({
        request: () => ({ url: '/s' }),
        sinks: { onMessage: (m) => messages.push(m), onPhase: () => {} },
        clientFactory: fakeFactory,
        recording: { onObservations: (b) => batches.push(b), flushMs: 100, maxBatch: 50 },
        ...over,
    })
    return { stream, messages, batches, client: FakeClient.last! }
}

afterEach(() => { vi.useRealTimers() })

describe('recording off (the default)', () => {
    it('attaches no observer and does no extra work', () => {
        const { stream, client, messages } = build({ recording: undefined })
        expect(client.opts.onObservation).toBeUndefined()
        expect(client.opts.describeEvent).toBeUndefined()
        expect(stream.recorder).toBeUndefined()
        expect(stream.store).toBeUndefined()
        expect(stream.overhead()).toBeUndefined()
        expect(() => stream.flushObservations()).not.toThrow()
        client.opts.onMessage({ event: 'a', data: 'x', id: '1', raw: '' })
        expect(messages[0]).not.toHaveProperty('obsSeq')
    })
})

describe('recording on', () => {
    it('stamps what the client reports, keeps it in the store and delivers it in batches', () => {
        vi.useFakeTimers()
        const { stream, client, batches } = build()
        client.opts.onObservation!({ kind: 'connect', attempt: 0, url: '/s', method: 'GET', headerNames: [], sentLastEventId: '' })
        client.opts.onObservation!({ kind: 'chunk', bytes: 12 })
        expect(batches).toEqual([]) // not yet: batched
        vi.advanceTimersByTime(100)
        expect(batches).toHaveLength(1)
        expect(batches[0]!.map((o) => [o.seq, o.kind, o.conn, o.domain])).toEqual([[0, 'connect', 0, 'transport'], [1, 'chunk', 0, 'transport']])
        expect(stream.store!.snapshot()).toHaveLength(2)
        expect(stream.recorder!.count).toBe(2)
    })

    it('hands over pending records when the stream stops, and on demand', () => {
        vi.useFakeTimers()
        const { stream, client, batches } = build()
        client.opts.onObservation!({ kind: 'chunk', bytes: 1 })
        stream.flushObservations()
        expect(batches).toHaveLength(1)
        client.opts.onObservation!({ kind: 'chunk', bytes: 2 })
        stream.stop()
        expect(batches).toHaveLength(2)
    })

    it('links each delivered message to the record of its event (obsSeq), so evidence can point at the event', () => {
        const { client, messages } = build()
        client.opts.onObservation!({ kind: 'chunk', bytes: 40 })
        client.opts.onObservation!({ kind: 'event', event: 'a', sseId: '1', dataBytes: 1 }) // seq 1
        client.opts.onMessage({ event: 'a', data: 'x', id: '1', raw: '' })
        client.opts.onObservation!({ kind: 'event', event: 'b', sseId: '2', dataBytes: 1 }) // seq 2
        client.opts.onMessage({ event: 'b', data: 'y', id: '2', raw: '' })
        expect(messages.map((m) => m.obsSeq)).toEqual([1, 2])
    })

    it('runs the payload probe for each event: a salted hash and only the profile\'s fields', () => {
        const { client } = build({ recording: { profile: { sequence: { field: '$.seq' } } } })
        const described = client.opts.describeEvent!({ event: 'tick', data: '{"seq":7,"secret":"hunter2"}', id: '', raw: '' })
        expect(described.extracted).toEqual({ seq: 7 })
        expect(described.dataHash).toMatch(/^[0-9a-f]+$/)
        expect(JSON.stringify(described)).not.toContain('hunter2')
    })

    it('uses the clock, domain and memory cap it is given', () => {
        const { stream } = build({ recording: { domain: 'page', capBytes: 12345 } })
        expect(stream.store!.stats.capBytes).toBe(12345)
        const o = stream.recorder!.record({ kind: 'chunk', bytes: 1 })
        expect(o.domain).toBe('page')
    })

    it('reports what recording costs', () => {
        const { stream, client } = build()
        for (let i = 0; i < 200; i++) client.opts.onObservation!({ kind: 'chunk', bytes: 1 })
        expect(stream.overhead()).toMatchObject({ sampled: expect.any(Number) })
        expect(stream.overhead()!.sampled).toBeGreaterThan(0)
    })

    it('does not leak the stream\'s capture id, URL or token into any record', () => {
        const { stream, client } = build({ request: () => ({ url: '/s?token=SECRET' }) })
        client.opts.onObservation!({ kind: 'chunk', bytes: 1 })
        expect(JSON.stringify(stream.store!.snapshot())).not.toContain(stream.captureId)
        expect(JSON.stringify(stream.store!.snapshot())).not.toContain('SECRET')
    })
})

describe('recording with the real client', () => {
    const servers: http.Server[] = []
    afterEach(() => { servers.splice(0).forEach((s) => { s.closeAllConnections(); s.close() }) })

    it('records a whole session: request, response, chunks, comment, retry, events with extracted sequence, phases', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
            res.write(': hb\n\nretry: 2000\n\n')
            res.write('id: 1\nevent: order\ndata: {"seq":1,"password":"hunter2"}\n\n')
            res.end('id: 2\ndata: {"seq":2}\n\nevent: end\ndata: bye\n\n')
        })
        servers.push(server)
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

        const phases: SSEPhase[] = []
        const messages: IncomingSSE[] = []
        const stream = createObservedStream({
            request: () => ({ url }),
            sinks: { onMessage: (m) => messages.push(m), onPhase: (p) => phases.push(p) },
            recording: { profile: { sequence: { field: 'seq' } } },
        })
        stream.start()
        const t0 = Date.now()
        while (!phases.includes('ended')) { if (Date.now() - t0 > 3000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)) }

        const records = stream.store!.snapshot()
        const kinds = new Set(records.map((o) => o.kind))
        for (const k of ['connect', 'response', 'chunk', 'comment', 'retry', 'event', 'phase'] as const) expect(kinds).toContain(k)
        const events = records.filter((o): o is Extract<Observation, { kind: 'event' }> => o.kind === 'event')
        expect(events.map((e) => e.extracted?.seq)).toEqual([1, 2, undefined]) // "end" has no JSON sequence
        expect(JSON.stringify(records)).not.toContain('hunter2') // payload text never enters a record
        // every delivered message points at its own event record
        expect(messages.map((m) => m.obsSeq)).toEqual(events.map((e) => e.seq))
        expect(records.map((o) => o.seq)).toEqual([...records.map((o) => o.seq)].sort((a, b) => a - b))
    })
})
