// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createObservedStream } from '../../core/sse/observedStream'
import { analyze, createEngine } from '../../core/diagnostics/engine'
import type { Finding } from '../../core/diagnostics/finding'
import { defaultRules } from '../../core/diagnostics/rules'
import type { StreamProfile, Thresholds } from '../../core/diagnostics/thresholds'
import { localCapture } from '../../core/capture/build'
import { captureEndT, parseCapture, serializeCapture, type Capture, type CaptureRecord } from '../../core/capture/format'
import { redactCapture } from '../../core/capture/redact'
import type { Observation } from '../../core/observe/observation'
import { normaliseFindings, withoutChunkEvidence, type NormalisedFinding } from '../../core/testing/normalise'
import { handleMockSession, handleMockStream } from '../../../lib/mock/handlers.js'
import { loadConfig } from '../../../lib/proxy/guard.js'
import { FIXTURE_ROUTES, startFixtureServer, type FixtureServer } from '../server'

// Plan D1: a capture of a real stream, written to a file, read back and replayed, must still say the same thing.
//
// For each route: observe the fixture with the wire bytes kept; offline analysis of the capture equals what was concluded live; the file
// written and read back analyses to a deeply equal result (findings AND coverage, strictly); then the capture is replayed through the mock
// stream twice as it was recorded (chunk for chunk) and twice as a sanitized export, and the normalised findings of each replay are compared
// with the live run's by a policy per rule: class A (equal), class B (same key, rule, severity and status, occurrences within one), class C
// (left out, and the reason is printed). The two replays of one kind are compared with each other FIRST: when they differ the replay is not
// deterministic, which is a different problem from a replay that is not faithful.

let fixtures: FixtureServer
let mock: http.Server
let mockUrl = ''
const config = loadConfig({ NODE_ENV: 'development', ENABLE_MOCK_API: '1' })
// each route uploads four captures, which is more than the mock's per-minute allowance; the allowance is not what is being tested here
const GENEROUS = { MOCK_UPLOADS_PER_MINUTE: '100000', MOCK_STREAMS_PER_MINUTE: '100000', MOCK_SESSIONS_PER_HOUR: '100000', MOCK_MB_PER_HOUR: '10000' }

beforeAll(async () => {
    fixtures = await startFixtureServer({ port: 0 })
    mock = http.createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString()
            if (req.url!.startsWith('/api/mock/session')) {
                const ndjson = String(req.headers['content-type']).includes('x-ndjson')
                handleMockSession(req, res, { config, env: GENEROUS, body: ndjson ? raw : raw ? JSON.parse(raw) : undefined })
            } else handleMockStream(req, res, { config, env: GENEROUS })
        })
    })
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()))
    mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`
})
afterAll(async () => { mock.closeAllConnections(); mock.close(); await fixtures.close() })

// ------------------------------------------------------------------------------------------------ observing

// The same thresholds as every other fixture test: delays are scaled down 20-50x, so the 1 s floor on a stall is lowered to match.
const THRESHOLDS = { stallMinSilenceMs: 400, stallNoCadenceMs: 500 }

interface Run {
    observations: Observation[]
    findings: Finding[]
    coverage: ReturnType<ReturnType<typeof createEngine>['coverage']>
    capture: Capture
    messages: Array<{ id: string; event: string }>
    endT: number
}

/**
 * The real client, recorder and engine against a URL, keeping the wire bytes. Stops when the stream ends or fails, or, for a stream that never
 * ends (a stall), after `holdMs`, with the engine ticked as time passes (as a host would) and the capture's end time set to when it stopped.
 */
async function observe(url: string, profile: StreamProfile | undefined, holdMs?: number, thresholds: Partial<Thresholds> = THRESHOLDS): Promise<Run> {
    const observations: Observation[] = []
    const engine = createEngine({ rules: defaultRules, ...(profile ? { profile } : {}), thresholds })
    const messages: Run['messages'] = []
    let finished!: () => void
    const done = new Promise<void>((resolve) => { finished = resolve })
    const stream = createObservedStream({
        request: () => ({ url }),
        sinks: { onMessage: (m) => { messages.push({ id: m.id, event: m.event }) }, onPhase: (p) => { if (p === 'ended' || p === 'failed') finished() } },
        recording: {
            profile: { ...(profile?.sequence ? { sequence: { useSseId: profile.sequence.useSseId, field: profile.sequence.field } } : {}) },
            captureBytes: true,
            // one record per batch: the engine is fed as each record is made, so a tick can never run ahead of a record
            onObservations: (batch) => { for (const o of batch) { observations.push(o); engine.feed(o) } },
            flushMs: 1, maxBatch: 1,
        },
        clientOptions: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0, maxRetries: 3 },
    })
    const ticker = holdMs === undefined ? undefined : setInterval(() => { if (stream.recorder) engine.tick(stream.recorder.elapsed()) }, 40)
    stream.start()
    const limit = holdMs ?? 15_000
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([done.then(() => 'finished'), new Promise<string>((resolve) => { timer = setTimeout(() => resolve('time'), limit) })])
    clearTimeout(timer)
    if (outcome === 'time' && holdMs === undefined) { stream.stop(); throw new Error(`${url} did not finish; saw ${observations.length} records`) }
    stream.flushObservations()
    const elapsed = stream.recorder?.elapsed() ?? 0
    stream.stop()
    if (ticker) clearInterval(ticker)
    const endT = Math.max(observations.at(-1)?.t ?? 0, holdMs === undefined ? 0 : elapsed)
    engine.tick(endT)
    engine.end(endT)
    const capture = localCapture(observations, { source: { kind: 'fixture', client: 'node-undici' }, ...(profile ? { profile } : {}) })
    capture.footer = { ...capture.footer!, endT }
    return { observations, findings: engine.findings(), coverage: engine.coverage(), capture, messages, endT }
}

/** Offline analysis of a capture file's content, the way the CLI does it. */
const analyseCapture = (c: Capture, thresholds: Partial<Thresholds>) => analyze(c.records as Observation[], { thresholds, ...(c.header.profile ? { profile: c.header.profile } : {}), endT: captureEndT(c) })

async function upload(capture: Capture): Promise<string> {
    const res = await fetch(`${mockUrl}/api/mock/session`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: serializeCapture(capture) })
    const body = await res.json() as { sessionId?: string; error?: string }
    if (!body.sessionId) throw new Error(body.error ?? 'upload failed')
    return body.sessionId
}

const routeOf = (id: string) => FIXTURE_ROUTES.find((r) => r.id === id)!

// ------------------------------------------------------------------------------------------------ the comparison policy

type Klass = 'A' | 'B' | 'C'
interface Policy { klass: Klass; reason?: string }

/**
 * What a replay can be expected to reproduce, rule by rule.
 *   A  decided by the content of the stream (what was sent, in which order, which ids): must be equal, evidence included.
 *   B  decided by timing or by how the bytes were cut up (a stall, a burst, a first-event delay): the same finding, severity and status,
 *      occurrences within one; chunk evidence is not compared (the replay is read in different pieces).
 *   C  cannot be reproduced by replaying the stream: left out, with the reason printed.
 */
const BY_RULE: Record<string, Policy> = {
    'proto.content-type': { klass: 'A' },
    'proto.framing': { klass: 'A' },
    'proto.headers-hints': { klass: 'C', reason: 'a replay is served by the mock server, whose response headers are not the original server\'s' },
    'timing.first-event': { klass: 'B' },
    'stall.silent': { klass: 'B' },
    'delivery.bursty': { klass: 'B' },
    'reconnect.loop': { klass: 'A' },
    'resume.last-event-id': { klass: 'A' },
    'seq.integrity': { klass: 'A' },
    'heartbeat.recognition': { klass: 'B' },
    'consumer.slow': { klass: 'C', reason: 'the consumer lag is measured in the page, which a replay does not have' },
    'security.credentials-in-metadata': { klass: 'C', reason: 'it reads the request URL, and a replay is requested from a different address' },
    'proxy.masking': { klass: 'B' },
    'clock.discontinuity': { klass: 'C', reason: 'it reflects the recording machine\'s clock, which a replay does not reproduce' },
    'schema.drift': { klass: 'A' },
}
/** A rule can have findings that are timing-decided although the rule is not: by key. */
const BY_KEY: Record<string, Policy> = {
    'reconnect.duration-pattern': { klass: 'B' },
}

function policyOf(n: NormalisedFinding): Policy {
    const key = BY_KEY[n.key] ?? BY_KEY[n.key.split(':')[0]!]
    if (key) return key
    const rule = BY_RULE[n.ruleId]
    if (!rule) throw new Error(`no replay policy for rule "${n.ruleId}" (finding ${n.key}): add it to BY_RULE, with a class`)
    return rule
}

/** Everything a policy says is different between two normalised runs, as sentences. Empty when they agree. Class C findings are skipped and listed in `excluded`. */
export function compareRuns(expected: NormalisedFinding[], actual: NormalisedFinding[]): { problems: string[]; excluded: string[] } {
    const problems: string[] = []
    const excluded: string[] = []
    const keep = (list: NormalisedFinding[]) => list.filter((n) => {
        const p = policyOf(n)
        if (p.klass === 'C') { excluded.push(`${n.key}: ${p.reason ?? 'no reason given'}`); return false }
        return true
    })
    const want = new Map(keep(expected).map((n) => [n.key, n]))
    const got = new Map(keep(actual).map((n) => [n.key, n]))
    for (const key of want.keys()) if (!got.has(key)) problems.push(`missing: ${key}`)
    for (const key of got.keys()) if (!want.has(key)) problems.push(`extra: ${key}`)
    for (const [key, a] of want) {
        const b = got.get(key)
        if (!b) continue
        if (policyOf(a).klass === 'A') {
            if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${key} differs (class A, must be equal):\n  expected ${JSON.stringify(a)}\n  actual   ${JSON.stringify(b)}`)
            continue
        }
        if (a.ruleId !== b.ruleId) problems.push(`${key}: rule ${a.ruleId} became ${b.ruleId}`)
        if (a.severity !== b.severity) problems.push(`${key}: severity ${a.severity} became ${b.severity}`)
        if (a.status !== b.status) problems.push(`${key}: status ${a.status} became ${b.status}`)
        if (Math.abs(a.occurrences - b.occurrences) > 1) problems.push(`${key}: occurrences ${a.occurrences} became ${b.occurrences} (class B allows one)`)
        const kinds = (n: NormalisedFinding) => [...new Set(withoutChunkEvidence(n).evidence.map((e) => e.kind))].sort().join(',')
        if (kinds(a) !== kinds(b)) problems.push(`${key}: evidence kinds ${kinds(a)} became ${kinds(b)}`)
    }
    return { problems, excluded: [...new Set(excluded)] }
}

const normalised = (run: Run) => normaliseFindings(run.findings, run.observations as CaptureRecord[])

// ------------------------------------------------------------------------------------------------ the matrix

interface RouteCase {
    id: string
    query?: Record<string, string | number>
    /** A stream that never ends: watched for this long (ms) instead of to its end, and replayed with the connection held open. */
    hold?: number
    /** Fixture delay scale (default 0.05) and the thresholds that go with it, as the fixture tests use them. */
    scale?: number
    thresholds?: Partial<Thresholds>
    /** Added to the route's own stream profile. */
    profile?: StreamProfile
    /** Finding keys the live run must show, so that a route that stopped producing its fault cannot pass by comparing nothing with nothing. */
    mustShow: string[]
}

const MATRIX: RouteCase[] = [
    { id: 'h01', mustShow: [] },
    { id: 'h03', mustShow: [] },
    { id: 'f05-resumes', mustShow: [] },
    { id: 'f05-drops', mustShow: ['reconnect.loop'] },
    { id: 'f06-skips', mustShow: ['resume.last-event-id:skipped'] },
    { id: 'f05-ignores', mustShow: ['resume.last-event-id:ignored', 'seq.integrity:replay'] },
    { id: 'f15-malformed', mustShow: ['proto.framing:NUL_IN_ID', 'proto.framing:WRONG_CASE_FIELD', 'proto.framing:BOM_STRIPPED'] },
    { id: 'f12-gzip-sync', mustShow: ['proto.headers-hints:content-encoding'] },
    { id: 'f03-buffered', scale: 0.15, thresholds: { stallNoCadenceMs: 5000, burstMinGapMs: 150, burstMinNominalGapMs: 10 }, profile: { timestampField: '$.ts' }, mustShow: ['delivery.bursty'] },
    { id: 'f09-buffered', mustShow: [] },
    { id: 'f04-silent', hold: 1500, mustShow: ['stall.silent:bytes'] },
    { id: 'f04-heartbeats', hold: 1500, mustShow: ['stall.silent:events'] },
    { id: 'f04-masked', hold: 1500, mustShow: ['stall.silent:origin'] },
]

// Routes of the plan's matrix that cannot be part of this round trip, and why. Printed, never silent.
const SKIPPED: Array<{ id: string; reason: string }> = [
    { id: 'f02-closed', reason: 'the server closes every connection after "data: x" and the client reconnects for ever (about 5000 records in 15 s), so there is no end to capture; a capture cut at an arbitrary moment would replay with a different number of connections each time' },
    { id: 'f01-text-html', reason: 'the client stops at the response, before any byte is read, so the capture holds no payload and the mock refuses it; a replay is in any case always served as 200 text/event-stream' },
]

async function replayRuns(capture: Capture, hold: number | undefined, profile: StreamProfile | undefined, thresholds: Partial<Thresholds>): Promise<Run[]> {
    const runs: Run[] = []
    for (let i = 0; i < 2; i++) {
        const id = await upload(capture)
        runs.push(await observe(`${mockUrl}/api/mock/stream?session=${id}${hold !== undefined ? '&end=hold' : ''}`, profile, hold, thresholds))
    }
    return runs
}

describe('capture -> file -> replay keeps the diagnosis', () => {
    for (const { id, query, hold, mustShow, scale = 0.05, thresholds = THRESHOLDS, profile: extra } of MATRIX) {
        it(`${id}: file round trip is lossless; both kinds of replay conclude the same thing`, async () => {
            const route = routeOf(id)
            const profile = extra || route.profile ? { ...route.profile, ...extra } : undefined
            const live = await observe(fixtures.urlFor(id, { scale, ...query }), profile, hold, thresholds)
            const keys = live.findings.map((f) => f.key)
            for (const k of mustShow) expect(keys, `${id} must show ${k} live; the comparison below would otherwise compare nothing`).toContain(k)
            for (const prefix of route.forbiddenFindings) {
                if (prefix === '*') expect(keys, `${id} is healthy`).toEqual([])
            }
            expect(live.observations.some((o) => o.kind === 'chunk' && typeof o.b64 === 'string')).toBe(true)

            // 1. offline analysis equals what was concluded while the stream ran
            const offline = analyseCapture(live.capture, thresholds)
            expect(offline.findings).toEqual(live.findings)
            expect(offline.coverage).toEqual(live.coverage)

            // 2. the file written and read back analyses to a deep-equal result, coverage included
            const parsed = parseCapture(serializeCapture(live.capture))
            expect(parsed.warnings, 'a file that was finished and not touched has nothing to warn about').toEqual([])
            expect(parsed.integrity).toBe('ok')
            expect(parsed.capture.records).toEqual(live.capture.records)
            const again = analyseCapture(parsed.capture, thresholds)
            expect(again.findings).toEqual(offline.findings)
            expect(again.coverage).toEqual(offline.coverage)

            // 3. replays: as recorded (chunk for chunk) and as a sanitized export; each twice
            const liveN = normalised(live)
            const variants: Array<[string, Capture]> = [['as recorded', live.capture], ['sanitized', redactCapture(live.capture).capture]]
            for (const [label, capture] of variants) {
                const [first, second] = await replayRuns(capture, hold, profile, thresholds)
                const drift = compareRuns(normalised(first!), normalised(second!))
                expect(drift.problems, `${id} (${label}): two replays of the same capture differ, so the replay is not deterministic`).toEqual([])
                const diff = compareRuns(liveN, normalised(first!))
                for (const line of diff.excluded) console.info(`[round trip] ${id} (${label}): class C, left out: ${line}`)
                expect(diff.problems, `${id} (${label}): the replay does not conclude what the live run concluded`).toEqual([])
                // what the replay was asked to be: the same events, in the same order
                expect(first!.messages, `${id} (${label}) delivered events`).toEqual(live.messages)
                expect(first!.coverage.map((c) => [c.ruleId, c.status])).toEqual(live.coverage.map((c) => [c.ruleId, c.status]))
            }
        }, 30_000)
    }

    it('says which routes of the matrix are not part of the round trip, and why', () => {
        for (const s of SKIPPED) {
            expect(s.reason.length).toBeGreaterThan(10)
            console.info(`[round trip] skipped ${s.id}: ${s.reason}`)
        }
        for (const s of SKIPPED) expect(MATRIX.some((m) => m.id === s.id)).toBe(false)
    })

    it('f01-text-html: the claim that its capture cannot be replayed is true (the mock refuses a capture with no payload)', async () => {
        const live = await observe(fixtures.urlFor('f01-text-html'), undefined)
        expect(live.findings.map((f) => f.key)).toContain('proto.content-type')
        const res = await fetch(`${mockUrl}/api/mock/session`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: serializeCapture(live.capture) })
        expect(res.status).toBe(400)
        expect((await res.json() as { error: string }).error).toMatch(/no payload to replay/)
    }, 30_000)

    it('f02-closed: the claim that it has no end is true (the client is still reconnecting after a second)', async () => {
        const live = await observe(fixtures.urlFor('f02-closed', { scale: 0.05 }), undefined, 1000)
        expect(live.observations.filter((o) => o.kind === 'connect').length).toBeGreaterThan(5)
        expect(live.observations.some((o) => o.kind === 'phase' && o.phase === 'ended')).toBe(false)
    }, 30_000)
})

// ------------------------------------------------------------------------------------------------ a harness that cannot fail proves nothing

describe('the comparison can fail', () => {
    const finding = (over: Partial<NormalisedFinding> = {}): NormalisedFinding => ({
        key: 'delivery.bursty', ruleId: 'delivery.bursty', ruleVersion: 1, severity: 'warning', status: 'open', confidences: ['medium'],
        deductionStems: ['Likely: buffering'], factStems: ['#unit'], evidence: [{ kind: 'event', conn: 0, ordinal: 3, sseId: '4' }], occurrences: 2, data: {}, ...over,
    })
    const exact = (over: Partial<NormalisedFinding> = {}): NormalisedFinding => finding({ key: 'resume.last-event-id:skipped', ruleId: 'resume.last-event-id', ...over })

    it('passes identical runs, and a class B finding that moved by one occurrence', () => {
        expect(compareRuns([finding(), exact()], [finding(), exact()])).toEqual({ problems: [], excluded: [] })
        expect(compareRuns([finding()], [finding({ occurrences: 3 })]).problems).toEqual([])
    })

    it('reports a missing finding, an extra finding, a changed severity or status, and occurrences off by two', () => {
        expect(compareRuns([finding()], []).problems).toEqual(['missing: delivery.bursty'])
        expect(compareRuns([], [finding()]).problems).toEqual(['extra: delivery.bursty'])
        expect(compareRuns([finding()], [finding({ severity: 'error' })]).problems[0]).toMatch(/severity warning became error/)
        expect(compareRuns([finding()], [finding({ status: 'resolved' })]).problems[0]).toMatch(/status open became resolved/)
        expect(compareRuns([finding()], [finding({ occurrences: 4 })]).problems[0]).toMatch(/occurrences 2 became 4/)
        expect(compareRuns([finding()], [finding({ evidence: [{ kind: 'comment', conn: 0, ordinal: 0 }] })]).problems[0]).toMatch(/evidence kinds/)
    })

    it('holds a class A finding to equality in every field the normaliser keeps', () => {
        for (const change of [{ occurrences: 3 }, { confidences: ['high'] as NormalisedFinding['confidences'] }, { evidence: [{ kind: 'event', conn: 0, ordinal: 4, sseId: '4' }] }, { data: { ranges: [[5, 7]] } }, { factStems: ['changed'] }] as Array<Partial<NormalisedFinding>>) {
            expect(compareRuns([exact()], [exact(change)]).problems.length, JSON.stringify(change)).toBe(1)
        }
    })

    it('lists a class C finding as left out, with its reason, and refuses a rule that has no policy', () => {
        const consumer = finding({ key: 'consumer.slow', ruleId: 'consumer.slow' })
        const out = compareRuns([consumer], [])
        expect(out.problems).toEqual([])
        expect(out.excluded[0]).toMatch(/^consumer\.slow: the consumer lag is measured in the page/)
        expect(() => compareRuns([finding({ key: 'new.rule', ruleId: 'new.rule' })], [])).toThrow(/no replay policy for rule "new.rule"/)
    })

    it('every rule the engine ships has a class, so a new rule cannot be compared by accident', () => {
        const ids = defaultRules.map((r) => r.id)
        expect(ids.filter((i) => !(i in BY_RULE))).toEqual([])
    })

    it('flags a replay that is not the recording: a server that leaves out an event the original had', async () => {
        const route = routeOf('f06-skips')
        const live = await observe(fixtures.urlFor('f06-skips', { scale: 0.05 }), route.profile)
        expect(live.findings.map((f) => f.key)).toContain('resume.last-event-id:skipped')
        const id = await upload(live.capture)
        // the mock's own test aid: serve the stream with one frame removed (event-level), which is exactly the damage a bad replay does
        const skipped = live.observations.filter((o): o is Extract<Observation, { kind: 'event' }> => o.kind === 'event').map((e) => e.sseId).filter(Boolean)
        const broken = await observe(`${mockUrl}/api/mock/stream?session=${id}&skipIds=${skipped[1]}`, route.profile)
        const diff = compareRuns(normalised(live), normalised(broken))
        const sameMessages = JSON.stringify(broken.messages) === JSON.stringify(live.messages)
        expect(diff.problems.length > 0 || !sameMessages, 'a replay with a frame removed must not look the same as the recording').toBe(true)
        expect(sameMessages).toBe(false)
    }, 30_000)

    it('flags a file that was changed after it was written', () => {
        const text = serializeCapture(localCapture([{ seq: 0, t: 0, conn: 0, kind: 'event', event: 'a', sseId: '1', dataBytes: 1 } as CaptureRecord], { source: { kind: 'fixture' } }))
        const lines = text.split('\n')
        lines[1] = lines[1]!.replace('"sseId":"1"', '"sseId":"2"')
        expect(parseCapture(lines.join('\n')).integrity).toBe('mismatch')
    })
})
