import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SSEClient, type SSEClientOptions } from '../../core/sse/sseClient'
import { Recorder } from '../../core/observe/recorder'
import type { Observation } from '../../core/observe/observation'
import { analyze, createEngine } from '../../core/diagnostics/engine'
import type { Finding } from '../../core/diagnostics/finding'
import type { Thresholds } from '../../core/diagnostics/thresholds'
import { FIXTURE_ROUTES, startFixtureServer, type FixtureRoute, type FixtureServer } from '../server'

let server: FixtureServer
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })

// The same thresholds for failing fixtures and healthy twins, so "no findings" on a twin means something. Delays are
// scaled down 20-50x, so the 1 s floor on what counts as a stall is lowered to match.
const thresholds: Partial<Thresholds> = { stallMinSilenceMs: 400, stallNoCadenceMs: 500 }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Watch {
    observations: Observation[]
    findings: Finding[]
    batch: Finding[]
    coverage: ReturnType<ReturnType<typeof createEngine>['coverage']>
}

/** The real client and recorder against a fixture, with the engine fed live (ticking as time passes). */
async function watch(url: string, until: (o: Observation[]) => boolean, extra: Partial<SSEClientOptions> = {}, maxMs = 5000): Promise<Watch> {
    const observations: Observation[] = []
    const engine = createEngine({ thresholds })
    const recorder = new Recorder({ onRecord: (o) => { observations.push(o); engine.feed(o) } })
    const client = new SSEClient({
        request: () => ({ url }), onMessage: () => undefined,
        onObservation: (d) => recorder.record(d),
        initialDelayMs: 5, maxDelayMs: 20, jitter: 0, maxRetries: 2, ...extra,
    })
    const ticker = setInterval(() => engine.tick(recorder.elapsed()), 40)
    client.start()
    const started = Date.now()
    while (!until(observations)) {
        if (Date.now() - started > maxMs) { client.stop(); clearInterval(ticker); throw new Error(`timed out; saw ${observations.map((o) => o.kind).join(',')}`) }
        await wait(5)
    }
    client.stop()
    clearInterval(ticker)
    const endT = recorder.elapsed()
    engine.tick(endT)
    engine.end(endT)
    return { observations, findings: engine.findings(), batch: analyze(observations, { thresholds, endT }).findings, coverage: engine.coverage() }
}

const hasPhase = (phase: string) => (o: Observation[]) => o.some((x) => x.kind === 'phase' && x.phase === phase)
const forMs = (ms: number) => { const t0 = Date.now(); return () => Date.now() - t0 >= ms }
const keyMatches = (f: Finding, prefix: string) => f.key === prefix || f.key.startsWith(prefix + ':') || f.key.startsWith(prefix)

/** The route's own declaration of what must and must not be found. */
function expectMeta(route: FixtureRoute, w: Watch) {
    for (const prefix of route.expectedFindings) expect(w.findings.some((f) => keyMatches(f, prefix)), `${route.id} should report ${prefix}; got ${w.findings.map((f) => f.key).join(', ') || 'nothing'}`).toBe(true)
    for (const prefix of route.forbiddenFindings) {
        if (prefix === '*') expect(w.findings.map((f) => f.key), `${route.id} is healthy`).toEqual([])
        else expect(w.findings.filter((f) => keyMatches(f, prefix)).map((f) => f.key), `${route.id} must not report ${prefix}`).toEqual([])
    }
    // what a host would have shown live is what offline analysis finds
    expect(w.findings).toEqual(w.batch)
}

const route = (id: string) => FIXTURE_ROUTES.find((r) => r.id === id)!

describe('the fixture server', () => {
    it('declares, for every failing fixture, a healthy twin that exists and expects nothing', () => {
        for (const r of FIXTURE_ROUTES) {
            if (r.healthyTwin === null) { expect(r.expectedFindings).toEqual([]); continue }
            const twin = route(r.healthyTwin)
            expect(twin.forbiddenFindings).toEqual(['*'])
            expect(r.expectedFindings.length).toBeGreaterThan(0)
        }
    })

    it('answers the CORS preflight for Last-Event-ID and Authorization', async () => {
        const res = await fetch(server.urlFor('h01'), { method: 'OPTIONS' })
        expect(res.status).toBe(204)
        expect(res.headers.get('access-control-allow-origin')).toBe('*')
        const allowed = res.headers.get('access-control-allow-headers')!.toLowerCase()
        expect(allowed).toContain('last-event-id')
        expect(allowed).toContain('authorization')
    })

    it('resumes after the id in Last-Event-ID, for numeric and uuid ids', async () => {
        const numeric = await fetch(server.urlFor('h01', { scale: 0.01, n: 5 }), { headers: { 'Last-Event-ID': '3' } })
        const text = await numeric.text()
        expect(text.split('\n').filter((l) => l.startsWith('id:'))).toEqual(['id: 4', 'id: 5'])
        const uuid = await (await fetch(server.urlFor('h04', { scale: 0.01, n: 3 }), { headers: { 'Last-Event-ID': '00000000-0000-4000-8000-000000000002' } })).text()
        expect(uuid.split('\n').filter((l) => l.startsWith('id:'))).toEqual(['id: 00000000-0000-4000-8000-000000000003'])
    })
})

describe('failing fixtures produce the documented finding', () => {
    for (const [id, expectedStatusOrType] of [['f01-text-plain', 'text/plain'], ['f01-text-html', 'text/html'], ['f01-json', 'application/json']] as const) {
        it(`${id}: wrong content type (R01)`, async () => {
            const w = await watch(server.urlFor(id), hasPhase('failed'))
            expectMeta(route(id), w)
            const f = w.findings.find((x) => x.key === 'proto.content-type')!
            expect(f.severity).toBe('error')
            expect(f.facts[0]!.text).toContain(expectedStatusOrType)
        })
    }

    for (const [id, status] of [['f01-401', 401], ['f01-404', 404]] as const) {
        it(`${id}: HTTP ${status} (R01)`, async () => {
            const w = await watch(server.urlFor(id), hasPhase('failed'))
            expectMeta(route(id), w)
            expect(w.findings.find((x) => x.key === 'http.status')!.summary).toContain(String(status))
        })
    }

    it('f01-502: a retryable status is still an error finding (R01)', async () => {
        const w = await watch(server.urlFor('f01-502'), (o) => o.some((x) => x.kind === 'reconnect'))
        expectMeta(route('f01-502'), w)
    })

    it('f02-closed: an unterminated event is reported once, as a framing warning (R02)', async () => {
        const w = await watch(server.urlFor('f02-closed'), (o) => o.some((x) => x.kind === 'violation' && x.code === 'UNTERMINATED_FRAME'))
        expectMeta(route('f02-closed'), w)
        expect(w.findings.find((f) => f.key === 'proto.framing:UNTERMINATED_FRAME')!.severity).toBe('warning')
    })

    it('f02-open: the open variant is reported as silence, and says (iii) is not evaluated (R05)', async () => {
        const w = await watch(server.urlFor('f02-open'), forMs(1000))
        expectMeta(route('f02-open'), w)
        expect(w.coverage.find((c) => c.ruleId === 'stall.silent')!.notes.join(' ')).toMatch(/pendingBytes/)
    })

    it('f04-silent: events then nothing (R05)', async () => {
        const w = await watch(server.urlFor('f04-silent', { scale: 0.02 }), forMs(1500))
        expectMeta(route('f04-silent'), w)
        expect(w.findings.find((f) => f.key === 'stall.silent:bytes')!.status).toBe('open')
    })

    it('f04-heartbeats: events then only heartbeats (R05 ii)', async () => {
        const w = await watch(server.urlFor('f04-heartbeats', { scale: 0.02 }), forMs(1500))
        expectMeta(route('f04-heartbeats'), w)
    })

    it('f04-masked: events then only proxy heartbeats (R05 iv)', async () => {
        const w = await watch(server.urlFor('f04-masked', { scale: 0.02 }), forMs(1500))
        expectMeta(route('f04-masked'), w)
        expect(w.findings.find((f) => f.key === 'stall.silent:origin')!.deductions[0]!.statement).toMatch(/^Likely: the upstream stopped/)
    })

    it('f08-token: the credential parameter is flagged and the canary never appears anywhere (R12)', async () => {
        const canary = 'CANARY-7f3a9c1e5b'
        const w = await watch(server.urlFor('f08-token', { token: canary, scale: 0.02 }), hasPhase('ended'))
        expectMeta(route('f08-token'), w)
        const everything = JSON.stringify([w.observations, w.findings, w.coverage])
        expect(everything).not.toContain(canary)
        expect(everything).toContain('token')
    })

    it('f08-token: without the token the stream is refused', async () => {
        expect((await fetch(server.urlFor('f08-token'))).status).toBe(401)
    })
})

describe('healthy twins produce zero findings, with every rule evaluated', () => {
    for (const [id, query] of [['h01', { scale: 0.02, n: 6 }], ['h02', { scale: 0.03, n: 3 }], ['h03', { scale: 0.05 }], ['h04', { scale: 0.02, n: 6 }]] as const) {
        it(`${id}`, async () => {
            const w = await watch(server.urlFor(id, query), hasPhase('ended'))
            expectMeta(route(id), w)
            expect(w.coverage.filter((c) => c.status !== 'evaluated')).toEqual([])
        })
    }
})
