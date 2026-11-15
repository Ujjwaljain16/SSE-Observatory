// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createObservedStream } from '../../core/sse/observedStream'
import { startFixtureServer, type FixtureServer } from '../server'

// Plan B5: observing a stream must not change it. The same stream is read three ways (no observer at all, the observer, the observer keeping the
// wire bytes), and everything the application can see is compared with everything the SERVER saw: the messages delivered, the phases passed
// through, the last event id, and the requests that reached the server (how many, with which Last-Event-ID, with which header names). If the
// observer changed the client's behaviour (a retry, a header, an id) the server's log would show it.

let server: FixtureServer
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })

type Arm = 'no observer' | 'observer' | 'observer + wire bytes'

async function readThrough(id: string, arm: Arm, query: Record<string, string | number> = {}) {
    const before = server.groundTruth.connections.length
    const messages: Array<{ id: string; event: string; data: string }> = []
    const phases: string[] = []
    let finished!: () => void
    const done = new Promise<void>((resolve) => { finished = resolve })
    const url = server.urlFor(id, { scale: 0.05, ...query })
    const stream = createObservedStream({
        request: () => ({ url }),
        sinks: { onMessage: (m) => { messages.push({ id: m.id, event: m.event, data: m.data }) }, onPhase: (p) => { if (phases.at(-1) !== p) phases.push(p); if (p === 'ended' || p === 'failed') finished() } },
        ...(arm === 'no observer' ? {} : { recording: { ...(arm === 'observer + wire bytes' ? { captureBytes: true } : {}), onObservations: () => {}, flushMs: 10 } }),
        clientOptions: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0, maxRetries: 3 },
    })
    stream.start()
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error(`${id} (${arm}) did not finish`)), 20_000))])
    stream.flushObservations()
    const lastId = stream.lastId
    stream.stop()
    await new Promise((r) => setTimeout(r, 30))
    const requests = server.groundTruth.connections.slice(before).filter((c) => c.route === id)
    return {
        messages, phases, lastId,
        requests: requests.map((c) => ({ lastEventId: c.requestHeaders['last-event-id'] ?? '', headerNames: Object.keys(c.requestHeaders).filter((h) => h !== 'host' && h !== 'connection').sort(), accept: c.requestHeaders['accept'] })),
    }
}

/** Some routes put the time they were written in the payload; that differs between any two reads and is not what is being compared. */
const withoutTimestamps = (messages: Array<{ id: string; event: string; data: string }>) => messages.map((m) => ({ ...m, data: m.data.replace(/"ts":\s*[\d.]+/g, '"ts":0') }))

const ROUTES = ['h01', 'h03', 'h04', 'f03-buffered', 'f05-drops', 'f05-resumes', 'f06-skips', 'f09-buffered']

describe('observing a stream does not change what the application, or the server, sees', () => {
    for (const id of ROUTES) {
        it(`${id}: messages, phases, last id and the requests the server received are the same with and without the observer`, async () => {
            const base = await readThrough(id, 'no observer')
            expect(base.messages.length, 'the stream delivered something').toBeGreaterThan(0)
            for (const arm of ['observer', 'observer + wire bytes'] as const) {
                const other = await readThrough(id, arm)
                expect(withoutTimestamps(other.messages), `${arm}: messages`).toEqual(withoutTimestamps(base.messages))
                expect(other.phases, `${arm}: phases`).toEqual(base.phases)
                expect(other.lastId, `${arm}: last event id`).toBe(base.lastId)
                expect(other.requests, `${arm}: the requests the server received`).toEqual(base.requests)
            }
        }, 60_000)
    }

    it('an observer that throws does not break the stream (what is delivered and sent is unchanged)', async () => {
        const base = await readThrough('f05-resumes', 'no observer')
        const before = server.groundTruth.connections.length
        const messages: string[] = []
        let finished!: () => void
        const done = new Promise<void>((resolve) => { finished = resolve })
        const stream = createObservedStream({
            request: () => ({ url: server.urlFor('f05-resumes', { scale: 0.05 }) }),
            sinks: { onMessage: (m) => { messages.push(m.id) }, onPhase: (p) => { if (p === 'ended' || p === 'failed') finished() } },
            recording: { onObservations: () => { throw new Error('observer failure') }, flushMs: 10 },
            clientOptions: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0, maxRetries: 3 },
        })
        stream.start()
        await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('did not finish')), 20_000))])
        stream.stop()
        await new Promise((r) => setTimeout(r, 30))
        expect(messages).toEqual(base.messages.map((m) => m.id))
        const requests = server.groundTruth.connections.slice(before).filter((c) => c.route === 'f05-resumes').map((c) => c.requestHeaders['last-event-id'] ?? '')
        expect(requests).toEqual(base.requests.map((r) => r.lastEventId))
    }, 60_000)
})
