import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import type { SSEClientOptions } from '../../utils/sseClient'

// The worker does multi-tab bookkeeping only; SSEClient (tested separately) is replaced by a controllable fake.
class FakeClient {
    static instances: FakeClient[] = []
    running = false
    started = 0
    stopped = 0
    constructor(public opts: SSEClientOptions) { FakeClient.instances.push(this) }
    get isRunning() { return this.running }
    start() { this.running = true; this.started++ }
    stop() { this.running = false; this.stopped++ }
    // helpers the tests use to play the server
    emit(event: string, data: string, id = '') { this.opts.onMessage({ event, data, id, raw: `data: ${data}` }) }
    phase(p: Parameters<NonNullable<SSEClientOptions['onPhase']>>[0], info: Parameters<NonNullable<SSEClientOptions['onPhase']>>[1] = { attempt: 0 }) {
        if (p === 'ended' || p === 'failed') this.running = false
        this.opts.onPhase?.(p, info)
    }
}

type Mod = typeof import('../sharedSSEWorker')

describe('sharedSSEWorker.ts - multi-tab bookkeeping', () => {
    let mod: Mod
    let onconnect: (e: MessageEvent) => void

    beforeAll(async () => {
        mod = await import('../sharedSSEWorker')
        onconnect = (globalThis as unknown as { onconnect: (e: MessageEvent) => void }).onconnect
        if (!onconnect) throw new Error('sharedSSEWorker did not register onconnect')
    })

    beforeEach(() => {
        vi.useFakeTimers()
        mod._clearConnectionsForTesting()
        FakeClient.instances = []
        mod._setClientFactoryForTesting((opts) => new FakeClient(opts) as never)
    })
    afterEach(() => { vi.useRealTimers() })

    const newPort = () => {
        const port = { start: vi.fn(), postMessage: vi.fn(), onmessage: null as ((e: MessageEvent) => void) | null }
        onconnect({ ports: [port] } as unknown as MessageEvent)
        const send = (data: unknown) => port.onmessage?.({ data } as MessageEvent)
        const received = () => port.postMessage.mock.calls.map((c) => c[0])
        return { port, send, received }
    }
    const connect = (p: ReturnType<typeof newPort>, url = '/events', token?: string) => p.send({ type: 'connect', url, token, useProxy: true })
    // events are posted in one batch once the current synchronous step is over
    const flush = () => Promise.resolve()
    const sentEvents = (p: ReturnType<typeof newPort>) => p.received().filter((m) => m.type === 'events').flatMap((m) => m.payloads)

    it('opens one client for the first tab and replays its status', () => {
        const a = newPort()
        connect(a)
        expect(FakeClient.instances).toHaveLength(1)
        expect(FakeClient.instances[0].started).toBe(1)
        expect(a.received()[0]).toMatchObject({ type: 'status', phase: 'connecting' })
    })

    it('a different profile, recording or proxy setting is a different connection (S18), the same one shares', () => {
        const probe = { sequence: { field: '$.seq' } }
        const a = newPort(); const b = newPort(); const c = newPort(); const d = newPort(); const e = newPort()
        a.send({ type: 'connect', url: '/events', useProxy: true })
        b.send({ type: 'connect', url: '/events', useProxy: true, profile: probe })
        expect(FakeClient.instances).toHaveLength(2) // the profile changes what is read from each payload
        c.send({ type: 'connect', url: '/events', useProxy: true, profile: { sequence: { field: '$.seq' } } })
        expect(FakeClient.instances).toHaveLength(2) // the same profile shares the second connection
        d.send({ type: 'connect', url: '/events', useProxy: true, recording: false })
        expect(FakeClient.instances).toHaveLength(3)
        e.send({ type: 'connect', url: '/events', useProxy: false })
        expect(FakeClient.instances).toHaveLength(4)
    })

    it('shares ONE connection between tabs with the same url+token, and a different token gets its own', () => {
        const a = newPort(); const b = newPort(); const c = newPort()
        connect(a, '/events', 't1')
        connect(b, '/events', 't1')
        expect(FakeClient.instances).toHaveLength(1)
        connect(c, '/events', 't2')
        expect(FakeClient.instances).toHaveLength(2)
    })

    it('two tabs connecting in the same tick still create a single client (no duplicate streams)', () => {
        const a = newPort(); const b = newPort()
        connect(a); connect(b)
        expect(FakeClient.instances).toHaveLength(1)
    })

    it('multiplexes events to every tab with increasing sequence numbers', async () => {
        const a = newPort(); const b = newPort()
        connect(a); connect(b)
        const client = FakeClient.instances[0]
        client.emit('order', '{"x":1}', '7')
        client.emit('message', 'two')
        await flush()
        for (const p of [a, b]) {
            const events = sentEvents(p)
            expect(events.map((e) => [e.event, e.data, e.id])).toEqual([['order', '{"x":1}', '7'], ['message', 'two', '']])
            expect(events[1].seq).toBeGreaterThan(events[0].seq)
        }
    })

    it('sends everything parsed in one step as a single message, and statuses never overtake events', async () => {
        const a = newPort()
        connect(a)
        const client = FakeClient.instances[0]
        for (let i = 0; i < 1000; i++) client.emit('message', `e${i}`)
        client.phase('reconnecting', { attempt: 1, delayMs: 1000, reason: 'closed' })
        await flush()
        const msgs = a.received().slice(1) // after the initial status
        expect(msgs.map((m) => m.type)).toEqual(['events', 'status'])
        expect(msgs[0].payloads).toHaveLength(1000)
        expect(msgs[0].payloads[0].data).toBe('e0')
        expect(msgs[0].payloads[999].data).toBe('e999')
    })

    it('records what its client observes and broadcasts it to every tab in batches, tagged with an opaque capture id', () => {
        const a = newPort(); const b = newPort()
        connect(a, '/events', 'secret-token'); connect(b, '/events', 'secret-token')
        const client = FakeClient.instances[0]
        client.opts.onObservation!({ kind: 'chunk', bytes: 10 })
        client.opts.onObservation!({ kind: 'comment', text: 'hb', source: 'upstream' })
        for (const p of [a, b]) expect(p.received().filter((m) => m.type === 'observations')).toHaveLength(0) // batched, not yet
        vi.advanceTimersByTime(100)
        for (const p of [a, b]) {
            const msgs = p.received().filter((m) => m.type === 'observations')
            expect(msgs).toHaveLength(1)
            expect(msgs[0].batch.map((o: { kind: string; seq: number }) => [o.seq, o.kind])).toEqual([[0, 'chunk'], [1, 'comment']])
            expect(msgs[0].replace).toBeUndefined()
            expect(msgs[0].key).toBe('/events::secret-token') // the existing routing key, as the other messages carry
            // the capture id is random: it must not reveal the URL or token the connection is keyed by
            expect(msgs[0].captureId).not.toMatch(/events|secret|token/)
        }
        expect(a.received().find((m) => m.type === 'observations').captureId).toBe(b.received().find((m) => m.type === 'observations').captureId)
    })

    it('sends a tab that joins late the retained history, marked replace', () => {
        const a = newPort()
        connect(a)
        const client = FakeClient.instances[0]
        client.opts.onObservation!({ kind: 'chunk', bytes: 10 })
        client.opts.onObservation!({ kind: 'chunk', bytes: 20 })
        vi.advanceTimersByTime(100)
        const b = newPort()
        connect(b)
        const history = b.received().find((m) => m.type === 'observations')
        expect(history.replace).toBe(true)
        expect(history.batch.map((o: { kind: string; bytes: number }) => o.bytes)).toEqual([10, 20])
        // a tab that joined first only got the live batch, not a replacement
        expect(a.received().filter((m) => m.type === 'observations' && m.replace)).toHaveLength(0)
    })

    it('records nothing when the tab that opens the connection turned recording off', () => {
        const a = newPort()
        a.send({ type: 'connect', url: '/events', useProxy: true, recording: false })
        const client = FakeClient.instances[0]
        expect(client.opts.onObservation).toBeUndefined()
        const b = newPort()
        connect(b, '/events') // a late joiner gets no history because there is none
        vi.advanceTimersByTime(200)
        for (const p of [a, b]) expect(p.received().filter((m) => m.type === 'observations')).toHaveLength(0)
    })

    it('answers a ping with a pong so a tab can tell the worker is alive', () => {
        const a = newPort()
        connect(a)
        a.send({ type: 'ping' })
        expect(a.received().at(-1)).toEqual({ type: 'pong' })
    })

    it('broadcasts phase changes (reconnecting, failed...) to all tabs', () => {
        const a = newPort(); const b = newPort()
        connect(a); connect(b)
        FakeClient.instances[0].phase('reconnecting', { attempt: 2, delayMs: 4000, reason: 'HTTP 503' })
        for (const p of [a, b]) {
            expect(p.received().at(-1)).toMatchObject({ type: 'status', phase: 'reconnecting', attempt: 2, delayMs: 4000, reason: 'HTTP 503' })
        }
    })

    it('sends a catch-up buffer (max 50) to late joiners, in chronological order', () => {
        const a = newPort()
        connect(a)
        for (let i = 1; i <= 60; i++) FakeClient.instances[0].emit('message', `e${i}`)
        const b = newPort()
        connect(b)
        const catchup = b.received().find((m) => m.type === 'catchup')
        expect(catchup.events).toHaveLength(50)
        expect(catchup.events[0].data).toBe('e11')
        expect(catchup.events[49].data).toBe('e60')
    })

    it('a tab that switches to another stream leaves the old one', async () => {
        const a = newPort()
        connect(a, '/one')
        connect(a, '/two')
        const [one, two] = FakeClient.instances
        expect(one).toBeDefined(); expect(two).toBeDefined()
        vi.advanceTimersByTime(6000) // idle grace
        expect(one.stopped).toBe(1)  // nobody is listening to /one any more
        expect(two.stopped).toBe(0)
        one.emit('message', 'late')
        await flush()
        expect(sentEvents(a)).toHaveLength(0)
    })

    it('closes a connection shortly after its last tab disconnects, but keeps it for quick reconnects', () => {
        const a = newPort()
        connect(a)
        const client = FakeClient.instances[0]
        a.send({ type: 'disconnect' })
        vi.advanceTimersByTime(2000)
        expect(client.stopped).toBe(0)
        const b = newPort()
        connect(b) // reload within the grace period reuses the same connection
        vi.advanceTimersByTime(10_000)
        expect(client.stopped).toBe(0)
        expect(FakeClient.instances).toHaveLength(1)
        b.send({ type: 'disconnect' })
        vi.advanceTimersByTime(6000)
        expect(client.stopped).toBe(1)
    })

    it('drops tabs that went silent (crashed/closed without telling us)', async () => {
        const a = newPort(); const b = newPort()
        connect(a); connect(b)
        const t0 = Date.now()
        vi.setSystemTime(t0 + 30_000); b.send({ type: 'ping' })
        mod._sweepForTesting(t0 + 80_000) // a: silent 80 s → gone; b: 50 s → alive
        FakeClient.instances[0].emit('message', 'x')
        await flush()
        expect(sentEvents(a)).toHaveLength(0)
        expect(sentEvents(b)).toHaveLength(1)
        mod._sweepForTesting(t0 + 200_000)
        vi.advanceTimersByTime(6000)
        expect(FakeClient.instances[0].stopped).toBe(1)
    })

    it('connect after the stream ended/failed restarts it with a clean buffer', () => {
        const a = newPort()
        connect(a)
        const client = FakeClient.instances[0]
        client.emit('message', 'old')
        client.phase('failed', { attempt: 3, reason: 'HTTP 401' })
        connect(a)
        expect(client.started).toBe(2)
        expect(a.received().at(-1)).toMatchObject({ type: 'status', phase: 'connecting' })
        expect(a.received().filter((m) => m.type === 'catchup')).toHaveLength(0)
    })

    it('ignores malformed messages', () => {
        const a = newPort()
        a.send(null); a.send({}); a.send({ type: 'connect' }); a.send({ type: 'nope' })
        expect(FakeClient.instances).toHaveLength(0)
    })
})
