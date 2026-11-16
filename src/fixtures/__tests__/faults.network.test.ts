// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startFixtureServer, type FixtureServer } from '../server'
import { startFaultProxy, type FaultPlan, type FaultProxy } from '../faultProxy'
import { compareFourWay, type Mismatch } from './fourWay'
import { gunzipLog } from './gunzipLog'
import { evidenceProblems, eventsOf, FAST, h01Offset, keysOf, observeWindow, type Window, type WindowOptions } from './faultHarness'
import type { Observation } from '../../core/observe/observation'
import type { LoggedConnection } from '../groundTruth'

// Network faults, for real: a TCP proxy (faultProxy.ts) between the real client and the fixture server, misbehaving the way networks do. Each fault is
// run through the real client (createObservedStream) with the live engine, and checked three ways: what the CLIENT did (events delivered, the
// cursor it resumed from, whether it hung), what the DOCTOR said (finding keys, and no false alarm on a benign fault), and what the SERVER's own log
// says happened (the ground truth: see groundTruth.ts and fourWay.ts). Every fault has a no-fault control on the same route.
//
// The proxy simulates the TCP level only. It does not cover TLS, HTTP/2, a real CDN or reverse proxy, or a mobile network.
// Timing: delays are scaled down (scale 0.05 is 50 ms per event) and every time assertion is a generous bound; nothing needs a fast machine.

let server: FixtureServer
const proxies: FaultProxy[] = []
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })
afterEach(async () => { await Promise.all(proxies.splice(0).map((p) => p.close())) })

const H01 = '/h01?scale=0.05&n=8'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Run { w: Window; p: FaultProxy; log: LoggedConnection[] }

/** The real client through a proxy with `plan`, for as long as `options` say; the proxy's log is complete (`settled`) and the server's log is the connections this run made. */
async function run(plan: FaultPlan | ((index: number, request: string) => FaultPlan), path: string, options: Partial<WindowOptions> = {}): Promise<Run> {
    const p = await startFaultProxy({ target: { port: server.port }, plan })
    proxies.push(p)
    const before = server.groundTruth.connections.length
    const w = await observeWindow(p.through(`${server.url}${path}`), { windowMs: 6000, captureBytes: true, ...options })
    // the proxy and the server note how each connection ended a moment after the client has gone
    for (let i = 0; i < 100 && p.responses.some((r) => !r.completed && !r.fired) && w.stoppedBy === 'ended'; i++) await sleep(10)
    await sleep(60)
    return { w, p, log: server.groundTruth.connections.slice(before) }
}

/** The same route read directly, no proxy: what the client is given when nothing is wrong. */
const directCache = new Map<string, Window>()
async function direct(path: string): Promise<Window> {
    const cached = directCache.get(path)
    if (cached) return cached
    const w = await observeWindow(`${server.url}${path}`, { windowMs: 6000, captureBytes: true })
    expect(w.stoppedBy, `the direct read of ${path} ends by itself`).toBe('ended')
    directCache.set(path, w)
    return w
}

const show = (m: Mismatch[]): string => m.map((x) => `[${x.boundary}] ${x.invariant}${x.connection !== undefined ? ` conn ${x.connection}` : ''}: ${x.detail}`).join('\n')

interface FourWayOptions {
    plain?: (l: LoggedConnection[]) => LoggedConnection[]
    /** The longest a record may lag the server's write: a latency or throttle fault makes this long on purpose. */
    maxLagMs?: number
    /** h03's last frame ends in CRLF CRLF; the client has the event (and stops) at the second CR, so the final LF is never read. */
    finalLfUnread?: boolean
}

/**
 * The four-way comparison (fourWay.ts) for a run through the proxy. A response the PROXY cut (reset, close, blackhole) is a connection the network
 * ended, whatever the server was doing: the server may have finished writing into the proxy long before, so its log says `server-end` while the
 * client rightly read less. Those connections are compared as ones the peer closed: the client may not have read MORE than was written, and may not have invented events.
 */
const fourWay = (r: Run, options: FourWayOptions = {}) => {
    const cut = new Set(r.p.responses.filter((x) => x.fired).map((x) => x.index - (r.p.responses[0]?.index ?? 0)))
    const log = (options.plain ?? ((l) => l))(r.log).map((c, i) => (cut.has(i) ? { ...c, endedBy: 'client-closed' as const } : c))
    const mismatches = compareFourWay({ log, records: r.w.observations, messages: r.w.messages.map((m) => ({ id: m.id, event: m.event, dataBytes: Buffer.byteLength(m.data) })), findings: r.w.findings, ...(options.maxLagMs !== undefined ? { maxLagMs: options.maxLagMs } : {}) })
    return show(options.finalLfUnread ? mismatches.filter((m) => !(m.invariant === 'I1 bytes' && /wrote (\d+) bytes and ended the connection; the client read (\d+)$/.test(m.detail) && Number(/wrote (\d+)/.exec(m.detail)![1]) - Number(/read (\d+)$/.exec(m.detail)![1]) === 1)) : mismatches)
}
const violationsOf = (o: Observation[]) => o.filter((x) => x.kind === 'violation').map((x) => (x as Extract<Observation, { kind: 'violation' }>).code)
const connects = (o: Observation[]) => o.filter((x) => x.kind === 'connect').length
const lastEventIdsSeenByServer = (log: LoggedConnection[]) => log.map((c) => c.requestHeaders['last-event-id'] ?? '')
const finding = (w: Window, key: string) => w.findings.find((f) => f.key === key)

// ---------------------------------------------------------------------------------------------------------------------------------- (b) re-chunking

describe('(b) re-chunking: the parser and framer must give the same events however TCP cuts the bytes', () => {
    const ROUTES = [
        { id: 'h01', path: '/h01?scale=0.05&n=6', note: 'plain LF events' },
        { id: 'h03', path: '/h03?scale=0.05&n=3', note: 'CRLF line ends and UTF-8 characters split across the server\'s own writes' },
        { id: 'h04', path: '/h04?scale=0.05&n=5', note: 'uuid ids' },
        { id: 'f15-malformed', path: '/f15/malformed?scale=0.05', note: 'a BOM, unknown and wrong-case fields, a NUL id, a bad retry, CRLF in an LF stream: the framing violations must not depend on the cuts' },
    ]
    const PLANS: Array<{ name: string; plan: FaultPlan }> = [
        { name: 'every byte its own write', plan: { chunking: { bytes: 1 } } },
        { name: 'two bytes a write', plan: { chunking: { bytes: 2 } } },
        { name: 'random cuts of 1-3 bytes (seed 1)', plan: { chunking: { minBytes: 1, maxBytes: 3, seed: 1 } } },
        { name: 'random cuts of 2-9 bytes (seed 2)', plan: { chunking: { minBytes: 2, maxBytes: 9, seed: 2 } } },
        { name: 'random cuts of 1-40 bytes (seed 3)', plan: { chunking: { minBytes: 1, maxBytes: 40, seed: 3 } } },
    ]
    for (const route of ROUTES) {
        describe(`${route.id}: ${route.note}`, () => {
            for (const { name, plan } of PLANS) {
                it(`${name}: the same events, the same framing violations, the same findings as the direct read`, async () => {
                    const base = await direct(route.path)
                    const r = await run(plan, route.path)
                    expect(r.w.stoppedBy).toBe('ended')
                    expect(eventsOf(r.w)).toEqual(eventsOf(base))
                    expect(violationsOf(r.w.observations)).toEqual(violationsOf(base.observations))
                    expect(keysOf(r.w.findings)).toEqual(keysOf(base.findings))
                    // the fault really happened: the proxy wrote many small pieces, and the client read more chunks than it did directly
                    const writes = r.p.responses[0]!.writes
                    expect(Math.max(...writes)).toBeLessThanOrEqual('bytes' in (plan.chunking ?? {}) ? (plan.chunking as { bytes: number }).bytes : (plan.chunking as { maxBytes: number }).maxBytes)
                    expect(r.w.observations.filter((o) => o.kind === 'chunk').length).toBeGreaterThan(base.observations.filter((o) => o.kind === 'chunk').length)
                    // and the server's own log agrees with what the client read
                    expect(fourWay(r, { finalLfUnread: route.id === 'h03', maxLagMs: 5000 })).toBe('')
                }, 30_000)
            }
        })
    }

    it('the healthy twin stays healthy: no finding on h01 or h03 under per-byte writes', async () => {
        for (const path of ['/h01?scale=0.05&n=6', '/h03?scale=0.05&n=3']) {
            const r = await run({ chunking: { bytes: 1 } }, path)
            expect(keysOf(r.w.findings), path).toEqual([])
        }
    }, 30_000)

    it('control: a proxy with no plan changes nothing (events, findings, four-way)', async () => {
        const base = await direct(H01)
        const r = await run({}, H01)
        expect(eventsOf(r.w)).toEqual(eventsOf(base))
        expect(keysOf(r.w.findings)).toEqual([])
        expect(fourWay(r)).toBe('')
        expect(r.p.responses[0]!.completed).toBe(true)
    })
})

// ---------------------------------------------------------------------------------------------------------------------------------- (a) latency, (c) throttle

describe('(a) latency and (c) bandwidth: slow is not broken', () => {
    it('mild latency before the first byte and jittered latency between writes: the same events, no finding (healthy twin)', async () => {
        const base = await direct(H01)
        const r = await run({ responseDelayMs: 120, chunkDelayMs: { minMs: 5, maxMs: 25, seed: 11 } }, H01)
        expect(eventsOf(r.w)).toEqual(eventsOf(base))
        expect(keysOf(r.w.findings)).toEqual([])
        expect(keysOf(r.w.batchFindings)).toEqual([])
        expect(fourWay(r)).toBe('')
        const response = r.w.observations.find((o) => o.kind === 'response') as Extract<Observation, { kind: 'response' }>
        expect(response.ttfbMs, 'the client measured the delay').toBeGreaterThanOrEqual(100)
    })

    it('per-byte writes with a few milliseconds between bytes: the same events, no finding', async () => {
        const base = await direct('/h01?scale=0.05&n=4')
        const r = await run({ chunking: { bytes: 1 }, chunkDelayMs: { minMs: 0, maxMs: 3, seed: 5 }, headersIntact: true }, '/h01?scale=0.05&n=4')
        expect(eventsOf(r.w)).toEqual(eventsOf(base))
        expect(keysOf(r.w.findings)).toEqual([])
    }, 30_000)

    it('a throttled link (250 bytes a second for the body, slower than the producer): the same events, never ahead of the rate, no finding', async () => {
        const base = await direct(H01)
        const t0 = Date.now()
        const r = await run({ bytesPerSecond: 250, chunking: { bytes: 16 }, headersIntact: true }, H01)
        const body = r.p.responses[0]!.wireBytes - r.p.responses[0]!.writes[0]!
        expect(Date.now() - t0).toBeGreaterThanOrEqual((body / 250) * 1000 * 0.8)
        expect(eventsOf(r.w)).toEqual(eventsOf(base))
        expect(keysOf(r.w.findings)).toEqual([])
        expect(fourWay(r, { maxLagMs: 4000 })).toBe('')
    }, 30_000)

    it('latency beyond the stall limit is a stall the Doctor names, and a resolved one: the stream was slow, then recovered', async () => {
        // 900 ms before every write against a 500 ms limit (the fixtures' scaled floor): every gap is a silence
        const base = await direct('/h01?scale=0.05&n=3')
        const r = await run({ chunkDelayMs: 900 }, '/h01?scale=0.05&n=3', { windowMs: 12_000 })
        expect(r.w.stoppedBy).toBe('ended')
        expect(eventsOf(r.w)).toEqual(eventsOf(base))
        const stall = finding(r.w, 'stall.silent:bytes')
        expect(stall, keysOf(r.w.findings).join(',')).toBeDefined()
        expect(stall!.status).toBe('resolved')
        expect(evidenceProblems(stall!, r.w.observations)).toEqual([])
    }, 30_000)
})

// ---------------------------------------------------------------------------------------------------------------------------------- (d) RST and (e) FIN mid-event

describe('(d) RST and (e) FIN: the connection is cut, the client resumes from the last whole event', () => {
    const cutAt = (kind: 'rst' | 'fin', payloadBytes: number) => (index: number): FaultPlan => (index === 0 ? { fault: { kind, at: { payloadBytes } } } : {})

    for (const kind of ['rst', 'fin'] as const) {
        it(`${kind} ten bytes into event 4: the partial event is never delivered, the client resumes with Last-Event-ID 3 and every event arrives once`, async () => {
            const base = await direct(H01)
            const r = await run(cutAt(kind, h01Offset(3, 10)), H01)
            expect(r.w.stoppedBy).toBe('ended')
            // 1. the client: all events, once, in order, none corrupted (the same list as an undisturbed read)
            expect(eventsOf(r.w)).toEqual(eventsOf(base))
            expect(r.w.phases.map((x) => x.phase)).toEqual(['connecting', 'open', 'reconnecting', 'open', 'ended'])
            const reconnect = r.w.observations.find((o) => o.kind === 'reconnect') as Extract<Observation, { kind: 'reconnect' }>
            expect(reconnect.lastEventIdSent).toBe('3')
            expect(reconnect.reason).toMatch(/^Network error/)
            // 3. the server's own log: two requests, the second carrying the cursor, and the first one cut by the client's side going away
            expect(lastEventIdsSeenByServer(r.log)).toEqual(['', '3'])
            expect(r.p.responses[0]!.fired).toMatchObject({ kind })
            expect(r.p.responses[0]!.completed, 'the response was cut: it never reached its terminal chunk').toBe(false)
            expect(fourWay(r)).toBe('')
            // 2. the Doctor: the cut event is reported, as exactly what it was (ten bytes), and a single resumed drop is NOT a loop, a stall or a resume failure
            expect(keysOf(r.w.findings)).toEqual(['proto.framing:UNTERMINATED_FRAME'])
            const f = finding(r.w, 'proto.framing:UNTERMINATED_FRAME')!
            expect(f.severity).toBe('warning')
            expect(f.facts.map((x) => x.text).join(' ')).toContain('10 bytes of an incomplete event were discarded')
            expect(f.deductions[0]!.statement, 'it does not blame the producer alone').toContain('the connection was cut mid-event')
            expect(evidenceProblems(f, r.w.observations)).toEqual([])
            expect(keysOf(r.w.batchFindings)).toEqual(keysOf(r.w.findings))
        }, 30_000)
    }

    it('control: the same route with no cut delivers the same events on one connection and reports nothing', async () => {
        const base = await direct(H01)
        const r = await run({}, H01)
        expect(eventsOf(r.w)).toEqual(eventsOf(base))
        expect(connects(r.w.observations)).toBe(1)
        expect(keysOf(r.w.findings)).toEqual([])
    })

    it('fin between two events: the client still sees an incomplete response, resumes, and the Doctor has nothing to say (nothing was lost)', async () => {
        const base = await direct(H01)
        const r = await run(cutAt('fin', h01Offset(3)), H01)
        expect(eventsOf(r.w)).toEqual(eventsOf(base))
        expect(lastEventIdsSeenByServer(r.log)).toEqual(['', '3'])
        expect(violationsOf(r.w.observations)).toEqual([])
        expect(keysOf(r.w.findings)).toEqual([])
        const reconnect = r.w.observations.find((o) => o.kind === 'reconnect') as Extract<Observation, { kind: 'reconnect' }>
        expect(reconnect.reason, 'a close with no terminal chunk is an error to the HTTP layer, not a clean end').toMatch(/^Network error/)
    }, 30_000)

    it('reset right after the headers: the client reconnects with no cursor (it has no id yet) and gets everything', async () => {
        const base = await direct(H01)
        const r = await run(cutAt('rst', 0), H01)
        expect(eventsOf(r.w)).toEqual(eventsOf(base))
        expect(lastEventIdsSeenByServer(r.log)).toEqual(['', ''])
        expect(keysOf(r.w.findings)).toEqual([])
    }, 30_000)

    it('a reset after every event: a flapping link. The client keeps resuming and delivers every event once; the Doctor calls it a loop that makes progress (a warning, not an error)', async () => {
        const base = await direct(H01)
        // 50 payload bytes is one whole event and a bit of the next, on every connection
        const r = await run(() => ({ fault: { kind: 'rst', at: { payloadBytes: 50 } } }), H01, { maxRetries: 3 })
        expect(r.w.stoppedBy).toBe('ended')
        expect(eventsOf(r.w)).toEqual(eventsOf(base))
        // each connection carried one new event, so the cursor climbed by one each time, and the server's log shows exactly the cursors the client says it sent
        expect(lastEventIdsSeenByServer(r.log)).toEqual(['', '1', '2', '3', '4', '5', '6', '7', '8'].slice(0, r.log.length))
        expect(r.log.length).toBeGreaterThanOrEqual(8)
        const loop = finding(r.w, 'reconnect.loop')
        expect(loop, keysOf(r.w.findings).join(',')).toBeDefined()
        expect(loop!.severity).toBe('warning')
        expect(loop!.facts[0]!.text).toMatch(new RegExp(`^${connects(r.w.observations)} connections were opened within`))
        expect(keysOf(r.w.findings)).not.toContain('stall.silent:bytes')
        // (not compared four-way: the last connection carries only the id-less end event, and the oracle's framer starts each connection with no id in effect while a client resumes with one)
    }, 30_000)
})

// ---------------------------------------------------------------------------------------------------------------------------------- (f) blackhole

describe('(f) blackhole: the connection stays open and nothing arrives', () => {
    const atBoundary = h01Offset(3)
    const midEvent = h01Offset(3, 7)

    for (const [name, at] of [['between events (after event 3)', atBoundary], ['seven bytes into event 4', midEvent]] as const) {
        it(`${name}: the client never gives up on its own (no idle timeout exists), and the Doctor says stall.silent with evidence that is the real last byte`, async () => {
            const r = await run({ fault: { kind: 'blackhole', at: { payloadBytes: at } } }, H01, { windowMs: 2400 })
            // 1. the client: still waiting when the window closes. It did not reconnect, fail or end: there is no read-idle timeout in SSEClient.
            expect(r.w.stoppedBy).toBe('window')
            expect(r.w.phases.map((x) => x.phase).slice(0, -1)).toEqual(['connecting', 'open'])
            expect(connects(r.w.observations)).toBe(1)
            expect(r.w.messages.map((m) => m.id)).toEqual(['1', '2', '3'])
            // 2. the Doctor
            expect(keysOf(r.w.findings)).toEqual(['stall.silent:bytes'])
            expect(keysOf(r.w.batchFindings)).toEqual(['stall.silent:bytes'])
            const stall = finding(r.w, 'stall.silent:bytes')!
            expect(stall.status).toBe('open')
            expect(evidenceProblems(stall, r.w.observations)).toEqual([])
            const chunks = r.w.observations.filter((o) => o.kind === 'chunk')
            const lastChunk = chunks.at(-1)!
            const last = stall.facts[0]!.evidence[0]!
            expect(last.seq, 'the first piece of evidence is the last byte the client read').toBe(lastChunk.seq)
            expect(last.t).toBe(lastChunk.t)
            expect(stall.facts[0]!.text).toMatch(/^No bytes arrived for \d/)
            expect(stall.firstSeenT, 'not named before the 500 ms limit').toBeGreaterThanOrEqual(lastChunk.t + 450)
            // a stop of OUR OWN is not an unterminated frame of the server's
            expect(violationsOf(r.w.observations)).toEqual([])
            // 3. the server's own log: it wrote far more than the client read (the rest went into the hole), and was not the one that went quiet
            const wrote = r.log[0]!.writes.reduce((n, x) => n + x.bytes, 0)
            const read = r.w.observations.filter((o): o is Extract<Observation, { kind: 'chunk' }> => o.kind === 'chunk').reduce((n, x) => n + x.bytes, 0)
            expect(read).toBe(at)
            expect(wrote).toBeGreaterThan(read)
            expect(fourWay(r)).toBe('')
        }, 30_000)
    }

    it('control: the same stream with no blackhole ends by itself and has no stall', async () => {
        const r = await run({}, H01, { windowMs: 2400 })
        expect(r.w.stoppedBy).toBe('ended')
        expect(keysOf(r.w.findings)).toEqual([])
    })

    it('slow loris: the headers, then nothing. The client sits "open" with no byte; the Doctor names the missing first byte and the silence', async () => {
        const r = await run({ fault: { kind: 'blackhole', at: { payloadBytes: 0 } } }, H01, { windowMs: 2200, thresholds: { ...FAST, headersToFirstByteMs: 300 } })
        expect(r.w.stoppedBy).toBe('window')
        expect(r.w.phases.map((x) => x.phase).slice(0, -1)).toEqual(['connecting', 'open'])
        expect(r.w.observations.filter((o) => o.kind === 'chunk')).toHaveLength(0)
        expect(keysOf(r.w.findings).sort()).toEqual(['stall.silent:no-bytes', 'timing.first-event:first-byte'])
        const firstByte = finding(r.w, 'timing.first-event:first-byte')!
        expect(firstByte.status).toBe('open')
        expect(evidenceProblems(firstByte, r.w.observations)).toEqual([])
        const response = r.w.observations.find((o) => o.kind === 'response')!
        expect(firstByte.facts[0]!.evidence[0]!.seq, 'the wait is measured from the response headers').toBe(response.seq)
        expect(evidenceProblems(finding(r.w, 'stall.silent:no-bytes')!, r.w.observations)).toEqual([])
    }, 30_000)

    it('nothing at all, not even headers: the client waits in fetch for ever (no connect timeout); the Doctor names the missing headers', async () => {
        const r = await run({ fault: { kind: 'blackhole', at: { wireBytes: 0 } } }, H01, { windowMs: 2000, thresholds: { ...FAST, connectToHeadersMs: 300 } })
        expect(r.w.stoppedBy).toBe('window')
        expect(r.w.phases.map((x) => x.phase).slice(0, -1)).toEqual(['connecting'])
        expect(r.w.observations.some((o) => o.kind === 'response')).toBe(false)
        expect(keysOf(r.w.findings)).toEqual(['timing.first-event:headers'])
        const f = finding(r.w, 'timing.first-event:headers')!
        expect(f.status).toBe('open')
        expect(f.facts[0]!.text).toMatch(/^No response headers/)
        expect(evidenceProblems(f, r.w.observations)).toEqual([])
        // the server did answer at once; it is the proxy that held the answer back
        expect(r.log[0]!.status).toBe(200)
    }, 30_000)
})

// ---------------------------------------------------------------------------------------------------------------------------------- (h) header delay

describe('(h) response delay beyond the first-event thresholds (R04)', () => {
    const slow = { ...FAST, connectToHeadersMs: 300, headersToFirstByteMs: 300 }

    it('headers 700 ms late: timing.first-event:headers, resolved once they came, measured by the client and the same as the proxy\'s delay', async () => {
        const base = await direct(H01)
        const r = await run({ responseDelayMs: 700 }, H01, { thresholds: slow })
        expect(eventsOf(r.w)).toEqual(eventsOf(base))
        expect(keysOf(r.w.findings)).toEqual(['timing.first-event:headers'])
        const f = finding(r.w, 'timing.first-event:headers')!
        expect(f.status).toBe('resolved')
        expect(f.facts[0]!.text).toMatch(/^Response headers arrived/)
        expect(evidenceProblems(f, r.w.observations)).toEqual([])
        const response = r.w.observations.find((o) => o.kind === 'response') as Extract<Observation, { kind: 'response' }>
        expect(response.ttfbMs).toBeGreaterThanOrEqual(670)
        expect(f.lastSeenT - f.firstSeenT, 'the finding spans what the client measured').toBeGreaterThanOrEqual(0)
    })

    it('the same 700 ms under the default limits (3 s) is not a finding: a slow link is not reported as a fault', async () => {
        const r = await run({ responseDelayMs: 700 }, H01, { thresholds: {} })
        expect(keysOf(r.w.findings)).toEqual([])
    })

    it('headers on time, the first byte 700 ms late: timing.first-event:first-byte (and the silence before any byte)', async () => {
        const r = await run({ bodyDelayMs: 700 }, H01, { thresholds: slow })
        expect(keysOf(r.w.findings).sort()).toEqual(['stall.silent:no-bytes', 'timing.first-event:first-byte'])
        expect(finding(r.w, 'timing.first-event:first-byte')!.status).toBe('resolved')
        expect(keysOf(r.w.findings)).not.toContain('timing.first-event:headers')
    })

    it('control: no delay, same thresholds, no finding', async () => {
        const r = await run({}, H01, { thresholds: slow })
        expect(keysOf(r.w.findings)).toEqual([])
    })
})

// ---------------------------------------------------------------------------------------------------------------------------------- (i) gzip cut

describe('(i) a compressed body cut in the middle (f12-gzip-sync)', () => {
    const GZ = '/f12/gzip-sync?scale=0.05&n=5'
    const plain = (l: LoggedConnection[]) => l.map(gunzipLog)

    for (const kind of ['rst', 'fin'] as const) {
        it(`${kind} 60 bytes into the gzip body: the decoder fails, the client resumes, every event arrives once, and the cut adds no finding to the stream's own`, async () => {
            const base = await direct(GZ)
            const r = await run((index) => (index === 0 ? { fault: { kind, at: { payloadBytes: 60 } } } : {}), GZ)
            expect(r.w.stoppedBy).toBe('ended')
            expect(eventsOf(r.w)).toEqual(eventsOf(base))
            expect(r.w.phases.map((x) => x.phase)).toEqual(['connecting', 'open', 'reconnecting', 'open', 'ended'])
            const reconnect = r.w.observations.find((o) => o.kind === 'reconnect') as Extract<Observation, { kind: 'reconnect' }>
            expect(reconnect.reason).toMatch(/^Network error/)
            // the cursor the client sent is the cursor the server received, and is an id of an event the client really got
            expect(lastEventIdsSeenByServer(r.log)).toEqual(['', reconnect.lastEventIdSent])
            expect(r.w.messages.map((m) => m.id)).toContain(reconnect.lastEventIdSent)
            // the Doctor's findings are the compressed stream's own (R03), plus nothing for the cut
            expect(keysOf(r.w.findings)).toEqual(keysOf(base.findings))
            expect(keysOf(r.w.findings)).toEqual(['proto.headers-hints:content-encoding'])
            expect(fourWay(r, { plain })).toBe('')
        }, 30_000)
    }
})

// ---------------------------------------------------------------------------------------------------------------------------------- (j) refused after success

describe('(j) connection refused after a first success: the reconnect storm (R07)', () => {
    const DROPS = '/f05/drops?scale=0.05&per=3&n=12'

    it('the server ends the stream after 3 events, then the port refuses: the client retries to its limit and fails (no hang), and the Doctor says reconnect.loop as an error', async () => {
        const r = await run((index) => (index === 0 ? { thenRefuse: true } : {}), DROPS, { maxRetries: 8, windowMs: 10_000 })
        // 1. the client
        expect(r.w.stoppedBy).toBe('failed')
        expect(r.w.messages.map((m) => m.id)).toEqual(['1', '2', '3'])
        expect(connects(r.w.observations)).toBe(9)
        expect(r.w.phases.at(-1)!.info.reason).toMatch(/^Gave up after 8 attempts/)
        const reconnects = r.w.observations.filter((o): o is Extract<Observation, { kind: 'reconnect' }> => o.kind === 'reconnect')
        expect(reconnects.map((x) => x.lastEventIdSent), 'every retry carries the cursor').toEqual(Array(reconnects.length).fill('3'))
        expect(reconnects[0]!.reason).toBe('Stream closed by server')
        expect(reconnects.slice(1).every((x) => /^Network error/.test(x.reason))).toBe(true)
        // 3. the server's log: it accepted ONE connection; the proxy accepted one TCP connection. Eight of the nine attempts never reached anything.
        expect(r.log).toHaveLength(1)
        expect(r.p.connections).toBe(1)
        // 2. the Doctor
        expect(keysOf(r.w.findings)).toEqual(['reconnect.loop'])
        const loop = finding(r.w, 'reconnect.loop')!
        expect(loop.severity).toBe('error')
        expect(evidenceProblems(loop, r.w.observations)).toEqual([])
        expect(loop.facts.map((x) => x.text).join(' ')).toMatch(/7 reconnects happened in a row without a single event/)
    }, 30_000)

    it('the finding does not claim more connections than the server accepted: refused attempts are attempts, not opened connections', async () => {
        const r = await run((index) => (index === 0 ? { thenRefuse: true } : {}), DROPS, { maxRetries: 8, windowMs: 10_000 })
        const first = finding(r.w, 'reconnect.loop')!.facts[0]!.text
        expect(first).toMatch(/^9 connection attempts were made within [\d.]+ (ms|s) \(connections 0 to 8; 1 was answered\); the limit is 3 within 60 s.$/)
        expect(first).not.toMatch(/were opened/)
    }, 30_000)

    it('refused right after a mid-event reset: the same loop, and the cut event is still reported as what it was', async () => {
        const r = await run((index) => (index === 0 ? { thenRefuse: true, fault: { kind: 'rst', at: { payloadBytes: h01Offset(3, 4) } } } : {}), H01, { maxRetries: 8, windowMs: 10_000 })
        expect(r.w.stoppedBy).toBe('failed')
        expect(keysOf(r.w.findings).sort()).toEqual(['proto.framing:UNTERMINATED_FRAME', 'reconnect.loop'])
    }, 30_000)

    it('control: the twin (one drop, a correct resume) on a proxy that never refuses has no finding at all', async () => {
        const r = await run({}, '/f05/resumes?scale=0.05&n=6')
        expect(r.w.stoppedBy).toBe('ended')
        expect(keysOf(r.w.findings)).toEqual([])
        expect(lastEventIdsSeenByServer(r.log)).toEqual(['', '3'])
    }, 30_000)
})
