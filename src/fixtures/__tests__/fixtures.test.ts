import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SSEClient, type SSEClientOptions } from '../../core/sse/sseClient'
import { Recorder } from '../../core/observe/recorder'
import type { Observation } from '../../core/observe/observation'
import { analyze, createEngine } from '../../core/diagnostics/engine'
import type { Finding } from '../../core/diagnostics/finding'
import type { Rule } from '../../core/diagnostics/rule'
import { defaultRules } from '../../core/diagnostics/rules'
import { deliveryBursty } from '../../core/diagnostics/rules/r06DeliveryBursty'
import { reconnectLoop } from '../../core/diagnostics/rules/r07ReconnectLoop'
import { consumerSlow } from '../../core/diagnostics/rules/r11ConsumerSlow'
import { proxyMasking } from '../../core/diagnostics/rules/r13ProxyMasking'
import { PayloadProbe } from '../../core/observe/payloadProbe'
import type { StreamProfile, Thresholds } from '../../core/diagnostics/thresholds'
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

// Phase 7: the network family (F03, F05, F10) and the proxy tags (F04 behind the proxy). The rules are passed in
// explicitly, because they are not part of the default set yet.
const phase7Rules: Rule[] = [...defaultRules, deliveryBursty, reconnectLoop, consumerSlow, proxyMasking]

interface Phase7Options {
    rules?: Rule[]
    thresholds?: Partial<Thresholds>
    profile?: StreamProfile
    client?: Partial<SSEClientOptions>
    /** A page-side consumer that takes `serviceMs` per event, one at a time; its records are fed to the engine as `consumer` records. */
    consumer?: { serviceMs: number }
    maxMs?: number
}

/** Like `watch`, with the Phase 7 rules, an optional stream profile, and an optional simulated page consumer. */
async function watchPhase7(url: string, until: (o: Observation[], processed: () => number) => boolean, opts: Phase7Options = {}): Promise<Watch> {
    const observations: Observation[] = []
    const rules = opts.rules ?? phase7Rules
    const options = { thresholds: { ...thresholds, ...opts.thresholds }, rules, ...(opts.profile ? { profile: opts.profile } : {}) }
    const engine = createEngine(options)
    const onRecord = (o: Observation) => { observations.push(o); engine.feed(o) }
    const recorder = new Recorder({ onRecord })
    const page = new Recorder({ domain: 'page', onRecord: (o) => onRecord({ ...o, seq: 1_000_000 + o.seq }) })

    // the consumer: events queue up on arrival and are processed one at a time, each taking serviceMs
    const queue: number[] = []
    let busy = false
    let processed = 0
    const pump = (): void => {
        if (busy || !opts.consumer || queue.length === 0) return
        busy = true
        const receivedT = queue.shift()!
        setTimeout(() => {
            const processedT = recorder.elapsed()
            page.record({ kind: 'consumer', n: 1, queueDepth: queue.length, receivedT, processedT, lagMs: processedT - receivedT })
            busy = false
            processed++
            pump()
        }, opts.consumer.serviceMs)
    }

    const probe = opts.profile?.timestampField ? new PayloadProbe({ timestampField: opts.profile.timestampField }) : undefined
    const client = new SSEClient({
        request: () => ({ url }),
        onMessage: () => { if (opts.consumer) { queue.push(recorder.elapsed()); pump() } },
        onObservation: (d) => recorder.record(d),
        initialDelayMs: 5, maxDelayMs: 20, jitter: 0, maxRetries: 5,
        ...(probe ? { describeEvent: (m: { event: string; data: string; id: string }) => probe.probe(m) } : {}),
        ...opts.client,
    })
    const ticker = setInterval(() => engine.tick(recorder.elapsed()), 40)
    client.start()
    const started = Date.now()
    while (!until(observations, () => processed)) {
        if (Date.now() - started > (opts.maxMs ?? 5000)) { client.stop(); clearInterval(ticker); throw new Error(`timed out; saw ${observations.map((o) => o.kind).join(',')}`) }
        await wait(5)
    }
    client.stop()
    clearInterval(ticker)
    const endT = recorder.elapsed()
    engine.tick(endT)
    engine.end(endT)
    return { observations, findings: engine.findings(), batch: analyze(observations, { ...options, endT }).findings, coverage: engine.coverage() }
}

const connections = (o: Observation[]) => o.filter((x) => x.kind === 'connect').length
const keysOf = (w: Watch) => w.findings.map((f) => f.key)
const unevaluated = (w: Watch) => w.coverage.filter((c) => c.status !== 'evaluated').map((c) => c.ruleId)
// delays are scaled down, so the gap that counts as a quiet time and the nominal gap between events are scaled with them
const burstThresholds: Partial<Thresholds> = { stallNoCadenceMs: 5000, burstMinGapMs: 150, burstMinNominalGapMs: 10 }

describe('F03: events written in lumps (R06)', () => {
    it('f03-buffered: bursts after quiet times are reported as a hypothesis, medium confidence with even producer timestamps', async () => {
        const w = await watchPhase7(server.urlFor('f03-buffered', { scale: 0.15 }), hasPhase('ended'), { thresholds: burstThresholds, profile: { timestampField: '$.ts' } })
        expectMeta(route('f03-buffered'), w)
        const f = w.findings.find((x) => x.key === 'delivery.bursty')!
        expect(f.severity).toBe('warning')
        expect(f.deductions[0]!.statement).toMatch(/^Likely: response buffering/)
        expect(f.deductions[0]!.confidence).toBe('medium')
        expect(f.facts.some((x) => /evenly spaced/.test(x.text))).toBe(true)
    })

    it('f03-steady: the twin that flushes each event is silent, with every rule evaluated', async () => {
        const w = await watchPhase7(server.urlFor('f03-steady', { scale: 0.15 }), hasPhase('ended'), { thresholds: burstThresholds, rules: [...defaultRules, deliveryBursty] })
        expectMeta(route('f03-steady'), w)
        expect(unevaluated(w)).toEqual([])
    })
})

describe('F05: dropped connections (R07)', () => {
    it('f05-drops: a reconnect loop that resumes correctly after Last-Event-ID, with differing lifetimes', async () => {
        const w = await watchPhase7(server.urlFor('f05-drops', { scale: 0.05 }), hasPhase('ended'))
        expectMeta(route('f05-drops'), w)
        const sent = w.observations.flatMap((o) => (o.kind === 'connect' ? [o.sentLastEventId] : []))
        expect(sent).toEqual(['', '3', '6', '9'])
        const f = w.findings.find((x) => x.key === 'reconnect.loop')!
        expect(f.severity).toBe('warning')
        expect(f.facts[0]!.text).toMatch(/4 connections were opened/)
        expect(f.facts[1]!.text).toMatch(/13 events were delivered across them/) // 12 ticks and the end event
    })

    it('f05-drops?ignore=1: the server restarts from 1 every time, and the loop is still reported', async () => {
        const w = await watchPhase7(server.urlFor('f05-drops', { scale: 0.05, ignore: 1 }), (o) => connections(o) >= 4)
        expect(keysOf(w)).toContain('reconnect.loop')
        expect(w.findings).toEqual(w.batch)
        const ids = w.observations.flatMap((o) => (o.kind === 'event' ? [o.sseId] : []))
        expect(ids.slice(0, 6)).toEqual(['1', '2', '3', '1', '2', '3'])
    })

    it('f05-cap: connections cut after the same duration while data flows read as a maximum-duration cap', async () => {
        const w = await watchPhase7(server.urlFor('f05-cap', { scale: 0.1 }), (o) => connections(o) >= 5, { thresholds: { durationMaxCv: 0.15 } })
        expectMeta(route('f05-cap'), w)
        const f = w.findings.find((x) => x.key === 'reconnect.duration-pattern')!
        expect(f.deductions[0]!.statement).toMatch(/^Likely: a maximum-duration cap/)
        expect(f.facts[0]!.text).toMatch(/dropped connections lasted/)
    })

    it('f05-resumes: the twin (one drop, a correct resume) has no findings, with every rule evaluated', async () => {
        const w = await watchPhase7(server.urlFor('f05-resumes', { scale: 0.05 }), hasPhase('ended'), { rules: [...defaultRules, reconnectLoop] })
        expectMeta(route('f05-resumes'), w)
        expect(unevaluated(w)).toEqual([])
        expect(connections(w.observations)).toBe(2)
    })
})

describe('F10: a slow page consumer (R11)', () => {
    const settled = (o: Observation[], processed: () => number) => hasPhase('ended')(o) && processed() >= 80

    it('f10-steady with a slow consumer: receipt is healthy and processing is late', async () => {
        const w = await watchPhase7(server.urlFor('f10-steady', { n: 80 }), settled, { consumer: { serviceMs: 25 }, maxMs: 8000 })
        expectMeta(route('f10-steady'), w)
        const f = w.findings.find((x) => x.key === 'consumer.slow')!
        expect(f.summary).toMatch(/^Receipt healthy, processing late/)
        expect(f.limits.join(' ')).toMatch(/worker-to-page hop is approximate/)
        expect(w.coverage.find((c) => c.ruleId === 'consumer.slow')!.status).toBe('evaluated')
    })

    it('f10-steady with a prompt consumer: silent', async () => {
        const w = await watchPhase7(server.urlFor('f10-steady', { n: 80 }), settled, { consumer: { serviceMs: 0 }, maxMs: 8000 })
        expect(w.findings).toEqual([])
        expect(w.findings).toEqual(w.batch)
        expect(w.coverage.find((c) => c.ruleId === 'consumer.slow')!.status).toBe('evaluated')
    })

    it('f10-steady with no consumer records: the rule is not evaluated, which is not the same as healthy', async () => {
        const w = await watchPhase7(server.urlFor('f10-steady', { n: 20 }), hasPhase('ended'))
        expect(w.coverage.find((c) => c.ruleId === 'consumer.slow')).toMatchObject({ status: 'not-evaluated', missingCapabilities: ['consumer'] })
        expect(keysOf(w)).not.toContain('consumer.slow')
    })
})

describe('F04 behind the proxy (R13)', () => {
    it('f04-masked: tagged proxy heartbeats with a growing up_idle name the silent upstream', async () => {
        const w = await watchPhase7(server.urlFor('f04-masked', { scale: 0.02 }), forMs(1500))
        expectMeta(route('f04-masked'), w)
        const f = w.findings.find((x) => x.key === 'proxy.masking')!
        expect(f.severity).toBe('error')
        expect(f.deductions[0]!.statement).toMatch(/^Likely: the upstream/)
        expect(w.coverage.find((c) => c.ruleId === 'proxy.masking')!.status).toBe('evaluated')
    })

    it('a direct stream carries no proxy tags: the rule is not evaluated rather than reported healthy', async () => {
        const w = await watchPhase7(server.urlFor('h01', { scale: 0.02, n: 4 }), hasPhase('ended'))
        const c = w.coverage.find((x) => x.ruleId === 'proxy.masking')!
        expect(c.status).toBe('not-evaluated')
        expect(c.notes.join(' ')).toMatch(/no proxy tags/)
    })
})
