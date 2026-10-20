// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createObservedStream } from '../observedStream'
import type { SSEClient, SSEClientOptions, SSEPhase, SSEPhaseInfo } from '../sseClient'
import type { IncomingSSE } from '../incoming'
import { newCaptureId } from '../../observe/captureId'

class FakeClient {
    static last: FakeClient | null = null
    running = false
    started = 0
    stopped = 0
    lastEventId = ''
    constructor(public opts: SSEClientOptions) { FakeClient.last = this }
    get isRunning() { return this.running }
    get lastId() { return this.lastEventId }
    start() { this.running = true; this.started++ }
    stop() { this.running = false; this.stopped++ }
    deliver(event: string, data: string, id = '') { this.opts.onMessage({ event, data, id, raw: `data: ${data}` }) }
}
const fakeFactory = (options: SSEClientOptions) => new FakeClient(options) as unknown as SSEClient

function build(extra: Parameters<typeof createObservedStream>[0] extends infer O ? Partial<O> : never = {}) {
    const messages: IncomingSSE[] = []
    const phases: Array<[SSEPhase, SSEPhaseInfo]> = []
    const stream = createObservedStream({
        request: (lastEventId) => ({ url: `http://x.test/stream?since=${lastEventId}` }),
        sinks: { onMessage: (m) => messages.push(m), onPhase: (p, i) => phases.push([p, i]) },
        clientFactory: fakeFactory,
        ...extra,
    })
    return { stream, messages, phases, client: FakeClient.last! }
}

describe('createObservedStream', () => {
    it('shapes each message for the UI and stamps the arrival time from the injected clock', () => {
        let clock = 1000
        const { client, messages } = build({ now: () => clock })
        client.deliver('order', '{"a":1}', '7')
        clock = 1500
        client.deliver('message', 'plain')
        expect(messages).toEqual([
            { event: 'order', data: '{"a":1}', id: '7', raw: 'data: {"a":1}', arrivalTime: 1000 },
            { event: 'message', data: 'plain', id: '', raw: 'data: plain', arrivalTime: 1500 },
        ])
        expect(messages.every((m) => !('seq' in m))).toBe(true) // no sequence unless the caller asks for one
    })

    it('numbers messages when the caller supplies a sequence (the SharedWorker numbers across its connections)', () => {
        let n = 100
        const { client, messages } = build({ nextSeq: () => ++n })
        client.deliver('a', '1')
        client.deliver('b', '2')
        expect(messages.map((m) => m.seq)).toEqual([101, 102])
    })

    it('passes phases through untouched', () => {
        const { client, phases } = build()
        client.opts.onPhase?.('open', { attempt: 0 })
        client.opts.onPhase?.('reconnecting', { attempt: 2, delayMs: 4000, reason: 'HTTP 503', status: 503 })
        expect(phases).toEqual([['open', { attempt: 0 }], ['reconnecting', { attempt: 2, delayMs: 4000, reason: 'HTTP 503', status: 503 }]])
    })

    it('builds the request through the caller\'s function, with the last event id', () => {
        const { client } = build()
        expect(client.opts.request('')).toEqual({ url: 'http://x.test/stream?since=' })
        expect(client.opts.request('42')).toEqual({ url: 'http://x.test/stream?since=42' })
    })

    it('starts, stops and reports state through to the client', () => {
        const { stream, client } = build()
        expect(stream.isRunning).toBe(false)
        stream.start()
        expect(stream.isRunning).toBe(true)
        expect(client.started).toBe(1)
        client.lastEventId = '9'
        expect(stream.lastId).toBe('9')
        stream.stop()
        expect(stream.isRunning).toBe(false)
        expect(client.stopped).toBe(1)
    })

    it('forwards extra client options (backoff tuning) to the client', () => {
        const { client } = build({ clientOptions: { maxRetries: 2, initialDelayMs: 7 } })
        expect(client.opts).toMatchObject({ maxRetries: 2, initialDelayMs: 7 })
    })

    it('callbacks set in clientOptions cannot replace the stream\'s own', () => {
        const stolen: string[] = []
        const { client, messages } = build({ clientOptions: { onMessage: (m) => stolen.push(m.data) } as never })
        client.deliver('x', 'hello')
        expect(stolen).toEqual([])
        expect(messages).toHaveLength(1)
    })
})

describe('captureId', () => {
    it('is opaque and unique per stream, and carries nothing from the URL or token', () => {
        const a = build({ request: () => ({ url: 'http://x.test/s?token=SUPERSECRET' }) }).stream
        const b = build({ request: () => ({ url: 'http://x.test/s?token=SUPERSECRET' }) }).stream
        expect(a.captureId).not.toBe(b.captureId)
        expect(a.captureId).not.toMatch(/SUPERSECRET|x\.test|token/i)
        expect(a.captureId.length).toBeGreaterThanOrEqual(32)
    })

    it('newCaptureId never repeats', () => {
        const ids = new Set(Array.from({ length: 500 }, () => newCaptureId()))
        expect(ids.size).toBe(500)
    })
})

describe('createObservedStream with the real client', () => {
    const servers: http.Server[] = []
    afterEach(() => { servers.splice(0).forEach((s) => { s.closeAllConnections(); s.close() }) })

    it('delivers messages and phases from a real server, resuming with the last event id', async () => {
        const seen: Array<string | undefined> = []
        let hits = 0
        const server = http.createServer((req, res) => {
            hits++
            seen.push(req.headers['last-event-id'] as string | undefined)
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            if (hits === 1) res.end('id: 1\ndata: one\n\n')
            else res.end('id: 2\ndata: two\n\nevent: end\ndata: done\n\n')
        })
        servers.push(server)
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

        const messages: IncomingSSE[] = []
        const phases: SSEPhase[] = []
        const stream = createObservedStream({
            request: () => ({ url }),
            sinks: { onMessage: (m) => messages.push(m), onPhase: (p) => phases.push(p) },
            clientOptions: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0 },
        })
        stream.start()
        const t0 = Date.now()
        while (!phases.includes('ended')) { if (Date.now() - t0 > 3000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)) }

        expect(messages.map((m) => [m.event, m.data, m.id])).toEqual([['message', 'one', '1'], ['message', 'two', '2'], ['end', 'done', '2']])
        expect(seen).toEqual([undefined, '1'])
        expect(phases).toEqual(['connecting', 'open', 'reconnecting', 'open', 'ended'])
        expect(stream.lastId).toBe('2')
        expect(messages.every((m) => typeof m.arrivalTime === 'number')).toBe(true)
    })
})
