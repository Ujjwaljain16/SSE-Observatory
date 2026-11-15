// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleSseProxy } from '../../../lib/proxy/streamProxy.js'
import { loadConfig } from '../../../lib/proxy/guard.js'
import { createObservedStream } from '../../core/sse/observedStream'
import { createEngine } from '../../core/diagnostics/engine'
import { defaultRules } from '../../core/diagnostics/rules'
import { parseProxyComment } from '../../core/proxyTags'
import type { Observation } from '../../core/observe/observation'
import type { Finding } from '../../core/diagnostics/finding'
import { startFixtureServer, type FixtureServer } from '../server'
import { compareFourWay } from './fourWay'
import type { LoggedConnection } from '../groundTruth'

// Plan A6: the real proxy (lib/proxy/streamProxy.js) between a fixture server and the real client, with the server's own log (groundTruth.ts) as the
// referee. Everything else that tests the proxy writes the upstream by hand and reads the proxy's answer with a bare http client; everything else that
// tests the Doctor's proxy rules feeds them tags that a test made up. Here the tags are the ones the proxy really writes, the stream is one a fixture
// really sent, and the reader is the observed client, so a change on either side of the contract (diagTags.js and proxyTags.ts) shows up as a failure.
//
// The proxy blocks private addresses unless it is configured for development, which is what `loadConfig` gives with NODE_ENV=development.

type Kind<K extends Observation['kind']> = Extract<Observation, { kind: K }>
const of = <K extends Observation['kind']>(records: Observation[], kind: K): Array<Kind<K>> => records.filter((r): r is Kind<K> => r.kind === kind)

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const HEARTBEAT_MS = 40
const devConfig = (over: Record<string, unknown> = {}) => ({ ...loadConfig({ NODE_ENV: 'development' }), heartbeatMs: HEARTBEAT_MS, ...over })

/** The proxy handler on a real port. `restart` brings it back on the same port after `stop`, which is what a proxy that crashed and came back looks like. */
class Proxy {
    port = 0
    private server: http.Server | undefined
    constructor(private readonly config: Record<string, unknown>) {}
    async start(port = 0): Promise<void> {
        this.server = http.createServer((req, res) => { void handleSseProxy(req, res, { config: this.config }) })
        await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, '127.0.0.1', () => resolve()) })
        this.port = (this.server.address() as AddressInfo).port
    }
    async stop(): Promise<void> {
        const server = this.server
        if (!server) return
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        this.server = undefined
    }
    /** The URL of an upstream, as the page would ask the proxy for it. */
    via(upstreamUrl: string): string { return `http://127.0.0.1:${this.port}/api/sse?url=${encodeURIComponent(upstreamUrl)}` }
}

let fixture: FixtureServer
const proxies: Proxy[] = []
const upstreams: http.Server[] = []
beforeAll(async () => { fixture = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await fixture.close() })
afterEach(async () => {
    await Promise.all(proxies.splice(0).map((p) => p.stop()))
    await Promise.all(upstreams.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()) })))
})

async function startProxy(over: Record<string, unknown> = {}): Promise<Proxy> {
    const proxy = new Proxy(devConfig(over))
    await proxy.start()
    proxies.push(proxy)
    return proxy
}

interface Seen {
    observations: Observation[]
    messages: Array<{ id: string; event: string; dataBytes: number }>
    findings: Finding[]
    coverage: ReturnType<ReturnType<typeof createEngine>['coverage']>
}

interface ObserveOptions {
    /** Ends the observation when it returns true (checked after every batch of records). Without it the stream is read until it ends or fails. */
    stopWhen?: (records: Observation[]) => boolean
    /** Called after every batch of records. */
    onBatch?: (records: Observation[]) => void
    /** Ends the observation once an event has arrived and then none has for this long (wall clock, so it also works when nothing at all arrives). */
    quietMs?: number
    maxRetries?: number
}

/** The real client, recorder and engine (the same wiring as observeUrl, with the thresholds the fixture tests use), against any URL. */
async function observe(url: string, options: ObserveOptions = {}): Promise<Seen> {
    const observations: Observation[] = []
    const messages: Seen['messages'] = []
    const engine = createEngine({ rules: defaultRules, thresholds: { stallMinSilenceMs: 400, stallNoCadenceMs: 500 } })
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const stream = createObservedStream({
        request: () => ({ url }),
        sinks: {
            onMessage: (m) => { messages.push({ id: m.id, event: m.event, dataBytes: new TextEncoder().encode(m.data).length }) },
            onPhase: (p) => { if (p === 'ended' || p === 'failed') finish() },
        },
        recording: {
            profile: {},
            captureBytes: true,
            onObservations: (batch) => {
                for (const o of batch) { observations.push(o); engine.feed(o) }
                options.onBatch?.(observations)
                if (options.stopWhen?.(observations)) finish()
            },
            flushMs: 10,
        },
        clientOptions: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0, maxRetries: options.maxRetries ?? 3 },
    })
    stream.start()
    let timer: NodeJS.Timeout | undefined
    let eventsSeen = 0
    let lastEventAt = Date.now()
    const quiet = options.quietMs === undefined ? undefined : setInterval(() => {
        const count = of(observations, 'event').length
        if (count !== eventsSeen) { eventsSeen = count; lastEventAt = Date.now() }
        if (eventsSeen > 0 && Date.now() - lastEventAt >= options.quietMs!) finish()
    }, 20)
    try {
        await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after 15 s; saw ${observations.length} records, the last "${observations.at(-1)?.kind}"`)), 15_000) })])
    } finally { clearTimeout(timer); clearInterval(quiet) }
    stream.flushObservations()
    stream.stop()
    const endT = observations.at(-1)?.t ?? 0
    engine.tick(endT)
    engine.end(endT)
    return { observations, messages, findings: engine.findings(), coverage: engine.coverage() }
}

/** The bytes the client read on one connection, as one string. */
function bodyOf(records: Observation[], conn: number): string {
    const parts = of(records, 'chunk').filter((c) => c.conn === conn).map((c) => Buffer.from(c.b64 ?? '', 'base64'))
    return Buffer.concat(parts).toString('utf8')
}

/** A body with the proxy's own frames taken out. Frames are cut at blank lines, so a tag written INSIDE an event would stay in it and show as a difference. */
function withoutTags(body: string, legacy = false): string {
    return body.split('\n\n').filter((frame) => !frame.startsWith(': sse-proxy') && !(legacy && frame === ': keep-alive')).join('\n\n')
}

const proxyComments = (records: Observation[]): Array<Kind<'comment'>> => of(records, 'comment').filter((c) => c.text.startsWith('sse-proxy'))
const keys = (s: Seen): string[] => s.findings.map((f) => f.key).sort()
const upIdleOf = (records: Observation[]): number => Math.max(0, ...of(records, 'comment').map((c) => { const t = parseProxyComment(c.text); return t?.kind === 'hb' ? t.upIdleMs : 0 }))
const lastUpstreamLog = (route: string, before: number): LoggedConnection[] => fixture.groundTruth.connections.slice(before).filter((c) => c.route === route)

describe('a healthy upstream through the proxy (h01)', () => {
    let seen: Seen
    let log: LoggedConnection[]
    let proxy: Proxy
    beforeAll(async () => {
        proxy = await startProxy()
        const before = fixture.groundTruth.connections.length
        seen = await observe(proxy.via(fixture.urlFor('h01', { scale: 0.05 })))
        log = lastUpstreamLog('h01', before)
    }, 20_000)
    afterAll(async () => { await proxy.stop() })

    it('the response record carries the X-SSE-* headers, and they say what the upstream log says', () => {
        const response = of(seen.observations, 'response')[0]!
        expect(response.status).toBe(200)
        expect(response.headers['x-sse-proxy']).toBe('observatory/1')
        expect(response.headers['x-sse-proxy-heartbeat-ms']).toBe(String(HEARTBEAT_MS))
        expect(response.headers['x-sse-proxy-max-duration']).toBe('0')
        expect(response.headers['x-sse-upstream-status']).toBe(String(log[0]!.status))
        expect(response.headers['x-sse-upstream-content-type']).toMatch(/^text\/event-stream/)
        expect(response.headers['x-sse-upstream-encoding']).toBe('')
        expect(Number(response.headers['x-sse-upstream-ttfb-ms'])).toBeGreaterThanOrEqual(0)
        // the proxy, not the fixture, is what the client talked to
        expect(response.headers['x-accel-buffering']).toBe('no')
        expect(log).toHaveLength(1)
    })

    it('the proxy\'s comments are labelled proxy: a ping, one meta line that is valid JSON, and heartbeats; nothing else is', () => {
        const comments = of(seen.observations, 'comment')
        expect(comments.length).toBeGreaterThan(2)
        expect(comments.every((c) => c.source === 'proxy')).toBe(true) // h01 sends no comments of its own
        expect(comments[0]!.text).toBe('sse-proxy-ping')
        const parsed = comments.map((c) => parseProxyComment(c.text))
        expect(parsed.every((p) => p !== null), 'every proxy comment is one the Doctor can read').toBe(true)
        const meta = parsed.filter((p) => p?.kind === 'meta')
        expect(meta).toHaveLength(1)
        expect(meta[0]).toMatchObject({ kind: 'meta', meta: { status: 200, heartbeatMs: HEARTBEAT_MS, maxDurationMs: 0 } })
        expect(parsed.filter((p) => p?.kind === 'hb').length).toBeGreaterThan(0)
    })

    it('what reaches the client is what the upstream wrote, byte for byte, plus whole proxy frames and nothing else', () => {
        const upstream = fixture.groundTruth.body(log[0]!)
        const client = bodyOf(seen.observations, 0)
        expect(withoutTags(client)).toBe(upstream)
        // the comparison is not vacuous: tags really were in the body, and they account for every extra byte
        const tagBytes = proxyComments(seen.observations).reduce((n, c) => n + Buffer.byteLength(`: ${c.text}\n\n`), 0)
        expect(tagBytes).toBeGreaterThan(0)
        expect(Buffer.byteLength(client)).toBe(fixture.groundTruth.totals(log[0]!).bytes + tagBytes)
    })

    it('the events, their ids and the cursor agree with the upstream log at every boundary the proxy does not change', () => {
        // I1 (bytes) is the one invariant the proxy changes on purpose: it adds tags. It is checked just above, with the tags subtracted.
        const mismatches = compareFourWay({ log, records: seen.observations, messages: seen.messages, findings: seen.findings }).filter((m) => m.invariant !== 'I1 bytes')
        expect(mismatches.map((m) => `[${m.boundary}] ${m.invariant}: ${m.detail}`)).toEqual([])
        expect(seen.messages.map((m) => m.id)).toEqual(['1', '2', '3', '4', '5', '5'])
    })

    it('R05 and R13 stay silent, and R13 reports that it saw the tags and judged them', () => {
        expect(keys(seen)).toEqual([])
        const r13 = seen.coverage.find((c) => c.ruleId === 'proxy.masking')!
        expect(r13.status).toBe('evaluated')
    })
})

describe('the proxy must not write inside an event (f09-buffered: the upstream cuts its writes at 4096 bytes, in the middle of events)', () => {
    it('with the proxy heartbeating every 40 ms across the cuts, no tag lands inside a frame and the bytes are the upstream\'s', async () => {
        const proxy = await startProxy()
        const before = fixture.groundTruth.connections.length
        const seen = await observe(proxy.via(fixture.urlFor('f09-buffered', { scale: 0.2 })))
        const [log] = lastUpstreamLog('f09-buffered', before)
        // the cuts really are mid-event: a write of the upstream does not end on a blank line
        const cuts = log!.writes.slice(0, -1).filter((w) => !Buffer.from(w.raw).toString('utf8').endsWith('\n\n'))
        expect(cuts.length, 'the fixture cuts inside events').toBeGreaterThan(0)
        expect(proxyComments(seen.observations).filter((c) => parseProxyComment(c.text)?.kind === 'hb').length, 'heartbeats were written during the stream').toBeGreaterThan(3)
        expect(withoutTags(bodyOf(seen.observations, 0))).toBe(fixture.groundTruth.body(log!))
        expect(seen.messages.filter((m) => m.event === 'tick')).toHaveLength(12)
        expect(keys(seen)).not.toContain('proxy.masking')
    }, 20_000)
})

describe('a silent upstream through the proxy (f04-silent): the proxy keeps the connection alive, and the tags say who went quiet', () => {
    let seen: Seen
    beforeAll(async () => {
        const proxy = await startProxy()
        seen = await observe(proxy.via(fixture.urlFor('f04-silent', { scale: 0.02 })), { stopWhen: (r) => upIdleOf(r) >= 900 })
        await proxy.stop()
    }, 20_000)

    it('the proxy\'s heartbeats carry an up_idle that grows, and the upstream\'s own events stop', () => {
        const idle = of(seen.observations, 'comment').map((c) => parseProxyComment(c.text)).filter((t): t is { kind: 'hb'; upIdleMs: number; n: number } => t?.kind === 'hb')
        expect(idle.length).toBeGreaterThan(10)
        expect(idle.map((h) => h.n)).toEqual(idle.map((_, i) => i + 1))
        expect(idle.at(-1)!.upIdleMs).toBeGreaterThan(idle[0]!.upIdleMs)
        expect(seen.messages).toHaveLength(12)
    })

    it('R13 fires on the real tags (proxy.masking) and R05 names the origin, not the bytes', () => {
        expect(keys(seen)).toContain('proxy.masking')
        expect(keys(seen)).toContain('stall.silent:origin')
        // bytes never stopped (the proxy kept talking), so the "no bytes" reading would be wrong
        expect(keys(seen)).not.toContain('stall.silent:bytes')
        const masking = seen.findings.find((f) => f.key === 'proxy.masking')!
        expect(masking.severity === 'warning' || masking.severity === 'error').toBe(true)
        expect(masking.facts[0]!.text).toMatch(/proxy heartbeats kept arriving while the proxy-reported idle time of the upstream grew/)
    })

    it('the same upstream read directly is a plain "no bytes" stall and R13 says it has nothing to judge: the tags are what changed the diagnosis', async () => {
        const direct = await observe(fixture.urlFor('f04-silent', { scale: 0.02 }), { quietMs: 900 })
        expect(keys(direct)).toContain('stall.silent:bytes')
        expect(keys(direct)).not.toContain('proxy.masking')
        expect(keys(direct)).not.toContain('stall.silent:origin')
        expect(direct.coverage.find((c) => c.ruleId === 'proxy.masking')!.status).toBe('not-evaluated')
    }, 20_000)
})

describe('an upstream that is alive but sends only heartbeats (f04-heartbeats): proxy comments and upstream comments are told apart', () => {
    it('the upstream\'s keep-alives are labelled upstream, the proxy\'s tags proxy; up_idle stays small, so it is not "masking"', async () => {
        const proxy = await startProxy()
        const seen = await observe(proxy.via(fixture.urlFor('f04-heartbeats', { scale: 0.02 })), { quietMs: 900 })
        const comments = of(seen.observations, 'comment')
        const fromUpstream = comments.filter((c) => c.source === 'upstream')
        const fromProxy = comments.filter((c) => c.source === 'proxy')
        expect(fromUpstream.length).toBeGreaterThan(10)
        expect(fromUpstream.every((c) => c.text === 'keep-alive')).toBe(true)
        expect(fromProxy.length).toBeGreaterThan(10)
        expect(fromProxy.every((c) => parseProxyComment(c.text) !== null)).toBe(true)
        expect(keys(seen)).toContain('stall.silent:events') // heartbeats but no events: the upstream's own state, seen through the proxy
        expect(keys(seen)).not.toContain('proxy.masking')
        expect(keys(seen)).not.toContain('stall.silent:origin')
    }, 20_000)
})

describe('PROXY_DIAGNOSTICS=0: no tags, no X-SSE-* headers, no R13', () => {
    const off = () => startProxy({ diagnostics: loadConfig({ NODE_ENV: 'development', PROXY_DIAGNOSTICS: '0' }).diagnostics })

    it('config: the switch is read', () => { expect(loadConfig({ NODE_ENV: 'development', PROXY_DIAGNOSTICS: '0' }).diagnostics).toBe(false) })

    // Q17 (decided): the switch means no proxy-specific diagnostic text and no diagnostic headers at all. The proxy's keep-alives (they hold the connection open
    // through idle timeouts) stay, as plain `: keep-alive` comments outside the reserved namespace: the client cannot tell them from the upstream's, by design.
    it('a healthy upstream: the response record has no X-SSE-* header, there is no comment in the proxy\'s namespace at all, the bytes are the upstream\'s, no findings', async () => {
        const proxy = await off()
        const before = fixture.groundTruth.connections.length
        const seen = await observe(proxy.via(fixture.urlFor('h01', { scale: 0.05 })))
        const [log] = lastUpstreamLog('h01', before)
        const response = of(seen.observations, 'response')[0]!
        expect(Object.keys(response.headers).filter((h) => h.startsWith('x-sse-'))).toEqual([])
        expect(proxyComments(seen.observations)).toEqual([])
        expect(bodyOf(seen.observations, 0)).not.toMatch(/sse-proxy/i)
        expect(withoutTags(bodyOf(seen.observations, 0), true)).toBe(fixture.groundTruth.body(log!))
        expect(keys(seen)).toEqual([])
    }, 20_000)

    it('a silent upstream: the proxy\'s plain keep-alives are indistinguishable from the upstream\'s (labelled upstream), nothing is labelled proxy, R13 never fires and nothing claims the upstream went quiet at the origin', async () => {
        const proxy = await off()
        const seen = await observe(proxy.via(fixture.urlFor('f04-silent', { scale: 0.02 })), { quietMs: 1100 })
        const comments = of(seen.observations, 'comment')
        expect(comments.some((c) => c.text === 'keep-alive' && c.source === 'upstream')).toBe(true)
        expect(comments.filter((c) => c.source === 'proxy')).toEqual([])
        expect(bodyOf(seen.observations, 0)).not.toMatch(/sse-proxy/i)
        expect(keys(seen)).not.toContain('proxy.masking')
        expect(keys(seen)).not.toContain('stall.silent:origin')
        expect(of(seen.observations, 'response')[0]!.headers['x-sse-proxy']).toBeUndefined()
    }, 20_000)

    it('the duration cap with diagnostics off: the client is asked to retry (a plain `retry:` line) and no cap tag is written', async () => {
        const upstream = await startUpstream((_req, res) => { res.writeHead(200, SSE_HEAD); res.write('id: 1\ndata: a\n\n') })
        const proxy = await startProxy({ diagnostics: false, maxDurationMs: 150 })
        const seen = await observe(proxy.via(upstream.url), { stopWhen: (r) => of(r, 'retry').length > 0 })
        expect(of(seen.observations, 'retry').map((r) => r.ms)).toEqual([1000])
        expect(bodyOf(seen.observations, 0)).not.toMatch(/sse-proxy/i)
    }, 20_000)
})

describe('the upstream drops the connection (f05-drops through the proxy)', () => {
    let seen: Seen
    let log: LoggedConnection[]
    beforeAll(async () => {
        const proxy = await startProxy()
        const before = fixture.groundTruth.connections.length
        seen = await observe(proxy.via(fixture.urlFor('f05-drops', { scale: 0.05 })))
        log = lastUpstreamLog('f05-drops', before)
        await wait(30)
        await proxy.stop()
    }, 30_000)

    it('the client reconnects each time, and the proxy passes the cursor on: the upstream received exactly the ids the client had seen', () => {
        expect(log.map((c) => c.requestHeaders['last-event-id'] ?? '')).toEqual(['', '3', '6', '9'])
        const reconnects = of(seen.observations, 'reconnect')
        expect(reconnects.map((r) => r.lastEventIdSent)).toEqual(['3', '6', '9'])
        expect(of(seen.observations, 'connect').map((c) => c.sentLastEventId)).toEqual(['', '3', '6', '9'])
        expect(seen.messages.filter((m) => m.event === 'tick').map((m) => m.id)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)))
    })

    it('every connection is a fresh proxy response with its own tags and headers (the tags are not carried over from the dead one)', () => {
        const responses = of(seen.observations, 'response')
        expect(responses).toHaveLength(4)
        expect(responses.every((r) => r.headers['x-sse-proxy'] === 'observatory/1' && r.headers['x-sse-upstream-status'] === '200')).toBe(true)
        for (let conn = 0; conn < 4; conn++) {
            const pings = proxyComments(seen.observations).filter((c) => c.conn === conn && c.text === 'sse-proxy-ping')
            expect(pings, `connection ${conn} starts with its own ping`).toHaveLength(1)
        }
    })

    it('no phantom healthy state: the stream is never "open" between a connection ending and the next response arriving', () => {
        const phases = of(seen.observations, 'phase')
        // reading the records in order: each phase 'open' is immediately preceded (among non-chunk records) by a response of the same connection
        const ordered = seen.observations.filter((r) => r.kind === 'phase' || r.kind === 'response' || r.kind === 'connect' || r.kind === 'reconnect')
        ordered.forEach((r, i) => {
            if (r.kind === 'phase' && r.phase === 'open') {
                const previous = ordered[i - 1]
                expect(previous?.kind, `the "open" phase of connection ${r.conn}`).toBe('response')
                expect(previous?.conn).toBe(r.conn)
            }
        })
        expect(phases.filter((p) => p.phase === 'reconnecting')).toHaveLength(3)
        expect(phases.at(-1)!.phase).toBe('ended')
        // the stream is "ended" only by the stream's own end event, which only the last connection carried
        expect(of(seen.observations, 'event').filter((e) => e.event === 'end').map((e) => e.conn)).toEqual([3])
    })

    it('the four places agree (the proxy\'s tags are the only extra bytes), and the finding quotes the connections the upstream really accepted', () => {
        const mismatches = compareFourWay({ log, records: seen.observations, messages: seen.messages, findings: seen.findings }).filter((m) => m.invariant !== 'I1 bytes')
        expect(mismatches.map((m) => `[${m.boundary}] ${m.invariant}: ${m.detail}`)).toEqual([])
        log.forEach((c, i) => {
            expect(withoutTags(bodyOf(seen.observations, i)), `connection ${i}`).toBe(fixture.groundTruth.body(c))
        })
        expect(seen.findings.find((f) => f.key === 'reconnect.loop')?.facts[0]?.text).toMatch(/4 connections were opened within/)
    })
})

/** A hand-written upstream with its own request log, for the failures a fixture route does not make (a connection that is destroyed). */
async function startUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse, nth: number) => void): Promise<{ url: string; requests: http.IncomingHttpHeaders[] }> {
    const requests: http.IncomingHttpHeaders[] = []
    const server = http.createServer((req, res) => { requests.push(req.headers); handler(req, res, requests.length - 1) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    upstreams.push(server)
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/stream`, requests }
}
const SSE_HEAD = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }

describe('the upstream connection is destroyed (reset, not closed): what the client is told, and what it asks for next', () => {
    const resetBetweenEvents = (nth: number, res: http.ServerResponse) => {
        res.writeHead(200, SSE_HEAD)
        if (nth === 0) { res.write('id: 1\ndata: a\n\nid: 2\ndata: b\n\n'); setTimeout(() => res.destroy(), 40) } else res.end('id: 3\ndata: c\n\nevent: end\ndata: done\n\n')
    }

    // Q16 (decided): the proxy's notice that the upstream connection was lost is a comment in the proxy's namespace, never an event: a business
    // consumer must not receive a message the upstream did not send. The Doctor reads it from the `comment` record (source "proxy").
    it('between two events: the proxy says so with a comment, not an event; the application sees only the upstream\'s events; the client resumes from the last id', async () => {
        const upstream = await startUpstream((_req, res, nth) => resetBetweenEvents(nth, res))
        const proxy = await startProxy()
        const seen = await observe(proxy.via(upstream.url))
        expect(upstream.requests.map((h) => h['last-event-id'] ?? '')).toEqual(['', '2'])
        expect(of(seen.observations, 'reconnect').map((r) => r.lastEventIdSent)).toEqual(['2'])
        expect(seen.messages.map((m) => `${m.event}#${m.id}`)).toEqual(['message#1', 'message#2', 'message#3', 'end#3'])
        expect(seen.messages.filter((m) => m.event === 'error')).toEqual([])
        expect(of(seen.observations, 'event').filter((e) => e.event === 'error')).toEqual([])
        expect(bodyOf(seen.observations, 0)).not.toContain('event: error')
        // the reason is in the observation: one proxy comment on the connection that was lost, which the Doctor's tag parser reads
        const notices = of(seen.observations, 'comment').map((c) => ({ c, tag: parseProxyComment(c.text) })).filter((x) => x.tag?.kind === 'error')
        expect(notices).toHaveLength(1)
        expect(notices[0]!.c).toMatchObject({ source: 'proxy', conn: 0 })
        expect(notices[0]!.tag).toEqual({ kind: 'error', message: 'Upstream connection lost' })
        expect(bodyOf(seen.observations, 0)).toContain(': sse-proxy error {"error":"Upstream connection lost"}\n\n')
        // it comes after the last event the connection delivered and nothing follows it, so it reads as the reason the connection ended
        const conn0 = seen.observations.filter((r) => r.conn === 0)
        expect(conn0.filter((r) => r.seq > notices[0]!.c.seq && r.kind === 'event')).toEqual([])
        const phases = of(seen.observations, 'phase').map((p) => p.phase)
        expect(phases).toEqual(['connecting', 'open', 'reconnecting', 'open', 'ended'])
        // the notice does not read as a heartbeat to the rules: it is not liveness of the upstream, and not a proxy heartbeat either
        expect(keys(seen)).not.toContain('proxy.masking')
    }, 20_000)

    it('PROXY_DIAGNOSTICS=0: the stream just ends (no notice of any kind, no event), and the client resumes from the last id all the same', async () => {
        const upstream = await startUpstream((_req, res, nth) => resetBetweenEvents(nth, res))
        const proxy = await startProxy({ diagnostics: false })
        const seen = await observe(proxy.via(upstream.url))
        expect(upstream.requests.map((h) => h['last-event-id'] ?? '')).toEqual(['', '2'])
        expect(seen.messages.map((m) => `${m.event}#${m.id}`)).toEqual(['message#1', 'message#2', 'message#3', 'end#3'])
        const body = bodyOf(seen.observations, 0)
        expect(body).not.toMatch(/sse-proxy/i)
        expect(body).not.toMatch(/error/i)
        expect(proxyComments(seen.observations)).toEqual([])
        expect(of(seen.observations, 'phase').map((p) => p.phase)).toEqual(['connecting', 'open', 'reconnecting', 'open', 'ended'])
    }, 20_000)

    it('an `event: error` that the UPSTREAM sends is the application\'s event and reaches it untouched (only the proxy\'s own notice stopped being an event)', async () => {
        const upstream = await startUpstream((_req, res) => { res.writeHead(200, SSE_HEAD); res.end('id: 1\nevent: error\ndata: {"error":"mine"}\n\nevent: end\ndata: done\n\n') })
        const proxy = await startProxy()
        const seen = await observe(proxy.via(upstream.url))
        expect(seen.messages.map((m) => `${m.event}#${m.id}`)).toEqual(['error#1', 'end#1'])
        expect(seen.messages[0]!.dataBytes).toBe(Buffer.byteLength('{"error":"mine"}'))
    }, 20_000)

    it('in the middle of an event: nothing is written into the half event, the cut frame is reported, and the client resumes from the last COMPLETE event', async () => {
        const upstream = await startUpstream((_req, res, nth) => {
            res.writeHead(200, SSE_HEAD)
            if (nth === 0) { res.write('id: 1\ndata: a\n\nid: 2\ndata: par'); setTimeout(() => res.destroy(), 40) } else res.end('id: 2\ndata: b\n\nevent: end\ndata: done\n\n')
        })
        const proxy = await startProxy()
        const seen = await observe(proxy.via(upstream.url))
        expect(upstream.requests.map((h) => h['last-event-id'] ?? '')).toEqual(['', '1'])
        expect(of(seen.observations, 'violation').map((v) => v.code)).toContain('UNTERMINATED_FRAME')
        expect(seen.messages.map((m) => `${m.event}#${m.id}`)).toEqual(['message#1', 'message#2', 'end#2'])
        expect(seen.messages.filter((m) => m.event === 'error')).toEqual([]) // the proxy did not write an error frame into the middle of an event
        expect(bodyOf(seen.observations, 0)).not.toContain('event: error')
        expect(bodyOf(seen.observations, 0), 'no notice of any kind is written into a half event').not.toContain('sse-proxy error')
    }, 20_000)
})

describe('an upstream that writes comments shaped like the proxy\'s tags (Q15, decided: the proxy rewrites them, so they are never labelled proxy)', () => {
    // The client labels a comment as the proxy's when its text starts with "sse-proxy", and R13 and R05 read the proxy's heartbeats as the proxy's own
    // statement about the upstream. An upstream (or content it relays) that writes such a comment would make them accuse a healthy origin (the f04-masked
    // fixture has exactly this shape). The proxy escapes any upstream comment in the namespace (": upstream: sse-proxy ...") before its own tags are written.
    /** What the forging upstream writes, in order, as the test knows it (the proxy must forward all of it, with only the forged lines rewritten). */
    const forgedWrites = (): string[] => {
        const writes = ['id: 1\ndata: a\n\n', ': sse-proxy-ping\n\n', ': sse-proxy-meta {"status":200,"heartbeatMs":1,"maxDurationMs":0}\n\n']
        for (let n = 1; n <= 20; n++) {
            const idle = 600 + 100 * n
            // the spellings a forger has: the client labels the first two as the proxy's; the rest are in the reserved namespace as well
            writes.push([`: sse-proxy hb up_idle=${idle} n=${n}\n\n`, `:sse-proxy hb up_idle=${idle} n=${n}\n\n`, `:  SSE-Proxy hb up_idle=${idle} n=${n}\n\n`][n % 3]!)
        }
        writes.push(': sse-proxy cap duration=1000\n\n', ': sse-proxy error {"error":"fake"}\n\n', 'event: end\ndata: done\n\n')
        return writes
    }
    /** An independent statement of the rewrite (a regular expression), not a call of the proxy's own code. */
    const escaped = (sent: string): string => sent.replace(/^:(?=[ \t]*sse-proxy)/gim, ': upstream:')

    const startForger = async (splitOne: boolean) => {
        const sent: string[] = []
        const upstream = await startUpstream((_req, res) => {
            res.writeHead(200, SSE_HEAD)
            const writes = forgedWrites()
            const next = (i: number): void => {
                if (res.writableEnded) return
                if (i >= writes.length) { res.end(); return }
                const w = writes[i]!
                sent.push(w)
                // one forged comment arrives in two network chunks, cut inside the namespace
                if (splitOne && i === 10) { res.write(w.slice(0, 9)); setTimeout(() => { res.write(w.slice(9)); setTimeout(() => next(i + 1), 30) }, 25); return }
                res.write(w)
                setTimeout(() => next(i + 1), 30)
            }
            next(0)
        })
        return { upstream, sent }
    }

    for (const [name, diagnostics, heartbeatMs] of [['diagnostics on', true, 400], ['diagnostics off', false, 400]] as const) {
        it(`${name}: nothing the upstream wrote is labelled proxy, R13 and R05's origin reading stay silent, and the bytes are the upstream's with exactly the forged lines rewritten`, async () => {
            const { upstream, sent } = await startForger(true)
            const proxy = await startProxy({ diagnostics, heartbeatMs })
            const seen = await observe(proxy.via(upstream.url))
            const comments = of(seen.observations, 'comment')
            const fromProxy = comments.filter((c) => c.source === 'proxy')
            // every forged comment reached the client, rewritten and labelled as the upstream's (20 heartbeats, ping, meta, cap, error)
            const forgedSeen = comments.filter((c) => c.text.startsWith('upstream:'))
            expect(forgedSeen.filter((c) => /sse-proxy hb/i.test(c.text))).toHaveLength(20)
            expect(forgedSeen).toHaveLength(24)
            expect(forgedSeen.every((c) => c.source === 'upstream'), 'the forged ones are the upstream\'s').toBe(true)
            expect(comments.filter((c) => c.source === 'upstream' && /^\s*sse-proxy/i.test(c.text)), 'nothing in the namespace is left in the upstream\'s comments').toEqual([])

            if (diagnostics) {
                // the proxy's own tags are untouched: a ping first, its meta, and every heartbeat it wrote reads as the proxy's (and none is a forged one: a forged up_idle is 700 or more)
                expect(fromProxy[0]!.text).toBe('sse-proxy-ping')
                const own = fromProxy.map((c) => parseProxyComment(c.text))
                expect(own.every((t) => t !== null)).toBe(true)
                expect(own.filter((t) => t?.kind === 'meta')).toHaveLength(1)
                expect(own.filter((t) => t?.kind === 'meta')[0]).toMatchObject({ meta: { heartbeatMs } }) // the proxy's, not the forged `heartbeatMs: 1`
                for (const t of own) if (t?.kind === 'hb') expect(t.upIdleMs).toBeLessThan(600)
                expect(of(seen.observations, 'response')[0]!.headers['x-sse-proxy']).toBe('observatory/1')
            } else {
                expect(fromProxy, 'with diagnostics off the proxy writes nothing in its namespace, so there is nothing to forge').toEqual([])
                expect(of(seen.observations, 'response')[0]!.headers['x-sse-proxy']).toBeUndefined()
            }

            expect(keys(seen)).not.toContain('proxy.masking')
            expect(keys(seen)).not.toContain('stall.silent:origin')
            expect(seen.messages.map((m) => `${m.event}#${m.id}`)).toEqual(['message#1', 'end#1'])

            // the bytes: the upstream's, with the proxy's own frames out, are the upstream's log with only the forged lines rewritten
            expect(withoutTags(bodyOf(seen.observations, 0), !diagnostics)).toBe(escaped(sent.join('')))
            expect(escaped(sent.join('')), 'the rewrite really changed something').not.toBe(sent.join(''))
        }, 20_000)
    }

    it('the same forger read directly (no proxy) IS labelled proxy and fires proxy.masking: the proxy is what closes the hole', async () => {
        const { upstream } = await startForger(false)
        const seen = await observe(upstream.url)
        const forged = of(seen.observations, 'comment').filter((c) => /^sse-proxy hb/.test(c.text))
        expect(forged.length).toBeGreaterThan(5)
        expect(forged.every((c) => c.source === 'proxy')).toBe(true)
        expect(keys(seen)).toContain('proxy.masking')
    }, 20_000)

    it('the honest path is unchanged: a comment of the upstream that is not in the namespace passes byte for byte and is labelled upstream', async () => {
        const upstream = await startUpstream((_req, res) => { res.writeHead(200, SSE_HEAD); res.end(': keep-alive\n\n: note about sse-proxy later\n\nid: 1\ndata: a\n\nevent: end\ndata: done\n\n') })
        const proxy = await startProxy({ diagnostics: false })
        const seen = await observe(proxy.via(upstream.url))
        expect(bodyOf(seen.observations, 0)).toBe(': keep-alive\n\n: note about sse-proxy later\n\nid: 1\ndata: a\n\nevent: end\ndata: done\n\n')
        expect(of(seen.observations, 'comment').map((c) => `${c.source}:${c.text}`)).toEqual(['upstream:keep-alive', 'upstream:note about sse-proxy later'])
    }, 20_000)
})

describe('the proxy dies mid-stream while the upstream stays open (h01), and comes back', () => {
    it('the client sees a reconnect carrying the last id it had; the upstream stops writing to the dead connection; every event arrives once; there is no healthy state in between', async () => {
        const proxy = await startProxy()
        const port = proxy.port
        const before = fixture.groundTruth.connections.length
        let killed = false
        const run = observe(proxy.via(fixture.urlFor('h01', { scale: 0.1 })), {
            maxRetries: 30,
            onBatch: (records) => {
                if (killed || of(records, 'event').filter((e) => e.event === 'tick').length < 2) return
                killed = true
                void (async () => { await proxy.stop(); await wait(150); await proxy.start(port) })()
            },
        })
        const seen = await run
        expect(killed).toBe(true)
        const log = lastUpstreamLog('h01', before)
        expect(log.length).toBe(2)

        // the cursor: what the client had when it asked again, what the upstream received
        const reconnect = of(seen.observations, 'reconnect')[0]!
        expect(reconnect.lastEventIdSent).toMatch(/^[23]$/)
        expect(log[1]!.requestHeaders['last-event-id']).toBe(reconnect.lastEventIdSent)
        expect(log[0]!.requestHeaders['last-event-id'] ?? '').toBe('')

        // the upstream was cut off from the dead proxy's connection, not left writing into it
        expect(log[0]!.endedBy).toBe('client-closed')
        expect(log[0]!.writes.length).toBeLessThan(6)

        // nothing lost, nothing twice
        expect(seen.messages.map((m) => `${m.event}#${m.id}`)).toEqual(['tick#1', 'tick#2', 'tick#3', 'tick#4', 'tick#5', 'end#5'])

        // no phantom healthy state: the connection that died records nothing after the reconnect decision; the next "open" follows a real response
        const phases = of(seen.observations, 'phase')
        const firstReconnecting = phases.findIndex((p) => p.phase === 'reconnecting')
        expect(firstReconnecting).toBeGreaterThan(0)
        const reconnectingAt = phases[firstReconnecting]!
        const afterDeath = seen.observations.filter((r) => r.seq > reconnectingAt.seq)
        expect(afterDeath.filter((r) => r.conn === 0 && (r.kind === 'chunk' || r.kind === 'event'))).toEqual([])
        const nextOpen = afterDeath.find((r) => r.kind === 'phase' && r.phase === 'open')!
        const lastResponseBefore = [...seen.observations].filter((r) => r.seq < nextOpen.seq && r.kind === 'response').at(-1)!
        expect(lastResponseBefore.conn).toBe(nextOpen.conn)
        expect(lastResponseBefore.seq).toBeGreaterThan(reconnectingAt.seq)
        expect(phases.at(-1)!.phase).toBe('ended')
        expect(keys(seen)).not.toContain('proxy.masking')
    }, 30_000)
})

describe('the checks can fail (a harness that cannot fail proves nothing)', () => {
    it('a tag written inside an event is not hidden by the tag filter', () => {
        const upstream = 'id: 1\ndata: a\n\nid: 2\ndata: b\n\n'
        const clean = ': sse-proxy-ping\n\nid: 1\ndata: a\n\n: sse-proxy hb up_idle=3 n=1\n\nid: 2\ndata: b\n\n'
        const inside = 'id: 1\n: sse-proxy hb up_idle=3 n=1\ndata: a\n\nid: 2\ndata: b\n\n'
        expect(withoutTags(clean)).toBe(upstream)
        expect(withoutTags(inside)).not.toBe(upstream)
    })
    it('a byte lost or added by the proxy is not hidden by it', () => {
        const upstream = 'id: 1\ndata: a\n\n'
        expect(withoutTags(': sse-proxy-ping\n\nid: 1\ndata: \n\n')).not.toBe(upstream)
        expect(withoutTags(': sse-proxy-ping\n\nid: 1\ndata: a\n\nid: 2\n\n')).not.toBe(upstream)
    })
    it('the up_idle reader reads the tags the proxy writes and nothing else', () => {
        const rec = (text: string, seq: number): Observation => ({ kind: 'comment', text, source: 'proxy', seq, t: seq, conn: 0 })
        expect(upIdleOf([rec('sse-proxy hb up_idle=700 n=3', 1), rec('keep-alive', 2), rec('sse-proxy-ping', 3)])).toBe(700)
        expect(upIdleOf([rec('keep-alive', 1)])).toBe(0)
    })
})
