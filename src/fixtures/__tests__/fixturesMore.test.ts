// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultRules } from '../../core/diagnostics/rules'
import type { StreamProfile } from '../../core/diagnostics/thresholds'
import type { Observation } from '../../core/observe/observation'
import { DEFAULT_THRESHOLDS } from '../../core/diagnostics/thresholds'
import { defaultsAt, scaleProfile, scaleThresholds } from '../../core/testing/scaleThresholds'
import { frameLog } from '../groundTruth'
import { FIXTURE_ROUTES, startFixtureServer, type FixtureServer } from '../server'
import { gunzipLog, isGzipped } from './gunzipLog'
import { observeUrl } from './observeFixture'

// Plan A3: the fixtures that close the gaps (familyMore.ts). Every one runs through the real client, recorder and engine, with the thresholds the
// defaults give at the time scale of the run (never numbers made up for the test), so a twin that says nothing says nothing under the defaults.
// Each failing fixture is shown next to what makes it a fault: its twin, or the same stream with the fault taken away, so a test cannot pass
// because the stream was never going to be flagged.

let server: FixtureServer
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })

const route = (id: string) => FIXTURE_ROUTES.find((r) => r.id === id)!

interface RunOptions {
    scale: number
    query?: Record<string, string | number>
    /** `'route'` (the default) is the route's own profile, with its times scaled; `'none'` declares nothing; a profile replaces it. */
    profile?: 'route' | 'none' | StreamProfile
    maxRetries?: number
    captureBytes?: boolean
}

async function run(id: string, { scale, query = {}, profile = 'route', maxRetries, captureBytes }: RunOptions) {
    const declared = profile === 'route' ? route(id).profile : profile === 'none' ? undefined : profile
    const before = server.groundTruth.connections.length
    const result = await observeUrl(server.urlFor(id, { scale, ...query }), defaultRules, declared ? scaleProfile(declared, scale) : undefined, {
        thresholds: defaultsAt(scale), ...(maxRetries !== undefined ? { maxRetries } : {}), ...(captureBytes ? { captureBytes } : {}),
    })
    await new Promise((resolve) => setTimeout(resolve, 20)) // the server notes a connection the client closed last
    return { ...result, log: server.groundTruth.connections.slice(before).filter((c) => c.route === id) }
}
type Run = Awaited<ReturnType<typeof run>>

const keys = (r: Run) => r.findings.map((f) => f.key).sort()
const withSeverity = (r: Run) => r.findings.map((f) => `${f.key}[${f.severity}]`).sort()
const find = (r: Run, key: string) => r.findings.find((f) => f.key === key)
const records = <K extends Observation['kind']>(r: Run, kind: K) => r.observations.filter((o): o is Extract<Observation, { kind: K }> => o.kind === kind)

/** What the route declares about its findings, as sentences; empty when the run meets it. */
function breaches(id: string, r: Run): string[] {
    const { expectedFindings, forbiddenFindings } = route(id)
    const out: string[] = []
    for (const prefix of expectedFindings) if (!r.findings.some((f) => f.key === prefix || f.key.startsWith(prefix))) out.push(`${id} should report ${prefix}; got ${keys(r).join(', ') || 'nothing'}`)
    for (const prefix of forbiddenFindings) {
        const hit = prefix === '*' ? keys(r) : keys(r).filter((k) => k === prefix || k.startsWith(prefix))
        if (hit.length > 0) out.push(`${id} must not report ${prefix === '*' ? 'anything' : prefix}; got ${hit.join(', ')}`)
    }
    return out
}

/** Rules that need more than a socket give "not evaluated" there, which is the right answer; any other rule that was not evaluated on a twin is a hole in what "healthy" means. */
const NEEDS_MORE_THAN_A_SOCKET = new Set(['seq.integrity', 'consumer.slow', 'proxy.masking', 'schema.drift'])
const unevaluated = (r: Run) => r.coverage.filter((c) => c.status !== 'evaluated' && !NEEDS_MORE_THAN_A_SOCKET.has(c.ruleId)).map((c) => c.ruleId)

describe('f05-ignores: the server restarts from 1 after a drop', () => {
    it('is flagged as ignoring Last-Event-ID, and the server\'s own log shows what happened (the cursor 3 arrived; the answer began at 1)', async () => {
        const r = await run('f05-ignores', { scale: 0.05, profile: 'none' })
        expect(withSeverity(r)).toEqual(['resume.last-event-id:ignored[warning]'])
        expect(r.log.map((c) => c.requestHeaders['last-event-id'] ?? '')).toEqual(['', '3'])
        expect(frameLog(r.log[0]!).filter((f) => f.id !== null).map((f) => f.id)).toEqual(['1', '2', '3'])
        expect(frameLog(r.log[1]!).filter((f) => f.id !== null).map((f) => f.id)).toEqual(['1', '2', '3', '4', '5', '6'])
        expect(r.log.map((c) => c.endedBy)).toEqual(['server-end', 'server-end'])
        // the client saw the same: 1,2,3 and then 1..6 and the end event, in two connections and no more
        expect(r.messages.map((m) => m.id)).toEqual(['1', '2', '3', '1', '2', '3', '4', '5', '6', '6'])
        expect(records(r, 'connect').map((c) => c.sentLastEventId)).toEqual(['', '3'])
    })

    it('under the route\'s own profile (exactly once) the restart is also a replay of ids already seen: a warning from the sequence check', async () => {
        const r = await run('f05-ignores', { scale: 0.05 })
        expect(withSeverity(r)).toEqual(['resume.last-event-id:ignored[warning]', 'seq.integrity:replay[warning]'])
        expect(breaches('f05-ignores', r)).toEqual([])
    })

    it('under at_least_once the replay is expected, and is only information; with no declared contract there is no sequence finding at all', async () => {
        const base = route('f05-ignores').profile!
        const atLeastOnce = await run('f05-ignores', { scale: 0.05, profile: { ...base, delivery: 'at_least_once' } })
        expect(withSeverity(atLeastOnce)).toEqual(['resume.last-event-id:ignored[warning]', 'seq.integrity:replay[info]'])
        const none = await run('f05-ignores', { scale: 0.05, profile: 'none' })
        expect(keys(none).filter((k) => k.startsWith('seq.integrity'))).toEqual([])
    })

    it('f05-resumes, its twin, drops at the same place and says nothing: the cursor is honoured', async () => {
        const r = await run('f05-resumes', { scale: 0.05 })
        expect(r.findings).toEqual([])
        expect(unevaluated(r)).toEqual([])
        expect(r.log.map((c) => c.requestHeaders['last-event-id'] ?? '')).toEqual(['', '3'])
        expect(r.messages.map((m) => m.id)).toEqual(['1', '2', '3', '4', '5', '6', '6'])
    })
})

describe('h05-declared-idle: a stream that says it is idle for a minute is not stalled', () => {
    it('with its declaration there is nothing to say; without it the same stream is a stall and has no heartbeats (the controls)', async () => {
        const [declared, undeclared] = await Promise.all([
            run('h05-declared-idle', { scale: 0.025 }),
            run('h05-declared-idle', { scale: 0.025, profile: 'none' }),
        ])
        expect(declared.findings, 'a declared idle must be silent').toEqual([])
        expect(unevaluated(declared)).toEqual([])
        // the same bytes with no declaration: 40 s of nothing against the 30 s default (1 s against 0.75 s at this scale)
        expect(withSeverity(undeclared)).toEqual(['heartbeat.absent[info]', 'stall.silent:bytes[warning]'])
        // and the two streams are the same stream: the same events at the same gaps (within a timer tick or two)
        expect(declared.messages.map((m) => m.id)).toEqual(undeclared.messages.map((m) => m.id))
        const gaps = (r: Run) => records(r, 'event').slice(0, 3).map((e, i, all) => (i === 0 ? 0 : e.t - all[i - 1]!.t))
        expect(gaps(declared)[2]!).toBeGreaterThan(900)
        expect(gaps(declared)[2]!).toBeLessThan(1400)
        expect(breaches('h05-declared-idle', declared)).toEqual([])
    }, 30_000)

    it('a silence longer than the declared one is still a stall: the declaration is a limit, not a switch', async () => {
        const r = await run('h05-declared-idle', { scale: 0.025, profile: { expected: { maxSilenceMs: 30_000 } } })
        expect(keys(r)).toContain('stall.silent:bytes')
    }, 30_000)
})

describe('h06-comments-only: a stream of nothing but comments', () => {
    it('shows every comment, makes no event of any of them, and has nothing wrong (the end event is the only event)', async () => {
        const r = await run('h06-comments-only', { scale: 0.1, query: { n: 3 } })
        expect(r.findings).toEqual([])
        expect(unevaluated(r)).toEqual([])
        expect(records(r, 'comment').map((c) => `${c.source}:${c.text}`)).toEqual(['upstream:keep-alive', 'upstream:keep-alive', 'upstream:keep-alive'])
        expect(records(r, 'event').map((e) => e.event)).toEqual(['end'])
        expect(r.messages.map((m) => m.event)).toEqual(['end'])
        expect(records(r, 'violation')).toEqual([])
        // from the first byte: the first chunk is the first comment, at once
        const firstChunk = records(r, 'chunk')[0]!
        const response = records(r, 'response')[0]!
        expect(firstChunk.t - response.t).toBeLessThan(60)
        expect(breaches('h06-comments-only', r)).toEqual([])
    }, 30_000)

    it('?bare=1 closes without the end event: no event at all, the comments all seen, and the client treats it as a drop', async () => {
        const r = await run('h06-comments-only', { scale: 0.1, query: { n: 3, bare: 1 }, maxRetries: 0 })
        expect(records(r, 'event')).toEqual([])
        expect(r.messages).toEqual([])
        expect(records(r, 'comment')).toHaveLength(3)
        expect(records(r, 'phase').some((p) => p.phase === 'failed')).toBe(true)
        expect(r.log[0]!.endedBy).toBe('server-end')
        expect(frameLog(r.log[0]!).filter((f) => f.hasData)).toEqual([])
    }, 30_000)
})

describe('f04-late-heartbeat: one heartbeat arrives four intervals late (R10)', () => {
    it('is reported as a late origin heartbeat, naming the usual interval, and nothing else', async () => {
        const r = await run('f04-late-heartbeat', { scale: 0.1 })
        expect(withSeverity(r)).toEqual(['heartbeat.late:origin[warning]'])
        expect(breaches('f04-late-heartbeat', r)).toEqual([])
        const fact = find(r, 'heartbeat.late:origin')!.facts[0]!.text
        expect(fact).toMatch(/^A origin heartbeat arrived \d+ ms after the previous one; the usual interval is \d+ ms/)
        expect(find(r, 'heartbeat.late:origin')!.status).toBe('resolved') // the rhythm came back
    }, 30_000)

    it('h06-comments-only, its twin, keeps the rhythm and says nothing', async () => {
        const r = await run('h06-comments-only', { scale: 0.1, query: { n: 3 } })
        expect(r.findings).toEqual([])
    }, 30_000)
})

describe('f11-slow-start: the first byte and the first event come late (R04)', () => {
    it('reports both stages, each against its own limit', async () => {
        const r = await run('f11-slow-start', { scale: 0.1 })
        expect(withSeverity(r)).toEqual(['timing.first-event:first-byte[warning]', 'timing.first-event:first-event[warning]'])
        expect(breaches('f11-slow-start', r)).toEqual([])
        expect(find(r, 'timing.first-event:first-byte')!.facts[0]!.text).toMatch(/^The first body byte arrived \d+ ms after the response headers/)
        expect(find(r, 'timing.first-event:first-event')!.facts[0]!.text).toMatch(/^The first event arrived \d+ ms after the first body byte/)
        expect(r.coverage.find((c) => c.ruleId === 'timing.first-event')!.status).toBe('evaluated')
    }, 30_000)

    it('each stage is judged alone: a prompt first byte leaves only the slow event, a prompt event leaves only the slow byte; far past the limit the event is an error', async () => {
        const [eventOnly, byteOnly, error] = await Promise.all([
            run('f11-slow-start', { scale: 0.1, query: { byteMs: 500 } }),
            run('f11-slow-start', { scale: 0.1, query: { eventMs: 1000 } }),
            run('f11-slow-start', { scale: 0.1, query: { byteMs: 500, eventMs: 20_000 } }),
        ])
        expect(withSeverity(eventOnly)).toEqual(['timing.first-event:first-event[warning]'])
        expect(withSeverity(byteOnly)).toEqual(['timing.first-event:first-byte[warning]'])
        expect(withSeverity(error)).toEqual(['timing.first-event:first-event[error]']) // 20 s is beyond 3 x the 5 s limit
    }, 30_000)

    it('h01, its twin, starts at once and says nothing, under the same thresholds', async () => {
        const r = await run('h01', { scale: 0.1 })
        expect(r.findings).toEqual([])
        expect(r.coverage.find((c) => c.ruleId === 'timing.first-event')!.status).toBe('evaluated')
        expect(unevaluated(r)).toEqual([])
    }, 30_000)

    it('the thresholds it is judged by are the defaults at the scale, and nothing else (no hand-made number)', () => {
        const t = defaultsAt(0.1)
        expect(t.headersToFirstByteMs).toBeCloseTo(DEFAULT_THRESHOLDS.headersToFirstByteMs * 0.1, 9)
        expect(t).toEqual(scaleThresholds(DEFAULT_THRESHOLDS, 0.1))
    })
})

describe('f12-gzip-sync: a compressed event stream', () => {
    it('the events arrive one by one, with their ids, although the body is gzip; the response headers are flagged as a hint', async () => {
        const r = await run('f12-gzip-sync', { scale: 0.1, captureBytes: true })
        expect(r.messages.map((m) => m.id)).toEqual(['1', '2', '3', '4', '5', '5'])
        expect(withSeverity(r)).toEqual(['proto.headers-hints:content-encoding[warning]'])
        expect(breaches('f12-gzip-sync', r)).toEqual([])
        expect(find(r, 'proto.headers-hints:content-encoding')!.facts[0]!.text).toContain('gzip')
        expect(records(r, 'response')[0]!.headers['content-encoding']).toBe('gzip')
        expect(records(r, 'violation')).toEqual([])
    }, 30_000)

    it('each event is delivered when it is flushed, not when the stream ends (a sync flush per event; without it everything would arrive at the end)', async () => {
        const r = await run('f12-gzip-sync', { scale: 0.1 })
        const events = records(r, 'event')
        // five ticks 100 ms apart: the first and the last are four intervals apart; a body that was held until the end would put them within a few ms
        expect(events[4]!.t - events[0]!.t).toBeGreaterThan(250)
        for (let i = 1; i < 5; i++) expect(events[i]!.t - events[i - 1]!.t, `event ${i + 1} came with the one before it`).toBeGreaterThan(30)
    }, 30_000)

    it('the wire really is gzip (not plain bytes under a label), flushed once per event, and decodes to exactly the stream h01 sends', async () => {
        const r = await run('f12-gzip-sync', { scale: 0.05 })
        const wire = r.log[0]!
        expect(isGzipped(wire)).toBe(true)
        const plain = gunzipLog(wire)
        // one write per event, plus the end event and the gzip trailer
        expect(wire.writes.length).toBeGreaterThanOrEqual(6)
        expect(frameLog(plain).filter((f) => f.id !== null).map((f) => f.id)).toEqual(['1', '2', '3', '4', '5'])
        const h01 = await run('h01', { scale: 0.05 })
        expect(server.groundTruth.body(plain)).toBe(server.groundTruth.body(h01.log[0]!))
        expect(server.groundTruth.totals(wire).bytes).not.toBe(server.groundTruth.totals(plain).bytes)
    }, 30_000)

    it('h01, its twin, is uncompressed and says nothing', async () => {
        const r = await run('h01', { scale: 0.05 })
        expect(r.findings).toEqual([])
        expect(records(r, 'response')[0]!.headers['content-encoding']).toBeUndefined()
    }, 30_000)
})

describe('f15-malformed: every kind of framing slip, then good events', () => {
    it('reports each slip once with the severity the specification gives it, and the stream is still delivered', async () => {
        const r = await run('f15-malformed', { scale: 0.05 })
        expect(withSeverity(r)).toEqual([
            'proto.framing:BOM_STRIPPED[info]', 'proto.framing:INVALID_RETRY[info]', 'proto.framing:MIXED_LINE_ENDINGS[info]',
            'proto.framing:NUL_IN_ID[warning]', 'proto.framing:UNKNOWN_FIELD[info]', 'proto.framing:WRONG_CASE_FIELD[warning]',
        ])
        expect(breaches('f15-malformed', r)).toEqual([])
        // all six events and the end event reach the application, as a conforming EventSource would deliver them; the NUL id did not move the cursor
        expect(r.messages.map((m) => m.event)).toEqual(['tick', 'tick', 'tick', 'tick', 'tick', 'tick', 'end'])
        expect(r.messages.map((m) => m.id)).toEqual(['1', '2', '2', '4', '5', '6', '6'])
        // what the "Data:" line carried is lost, and the event keeps what was spelled right
        expect(find(r, 'proto.framing:WRONG_CASE_FIELD')!.facts[0]!.text).toContain('1 time')
        expect(find(r, 'proto.framing:NUL_IN_ID')!.deductions[0]!.statement).toMatch(/^Likely:/)
        // a retry that is not a number is not a retry hint
        expect(records(r, 'retry')).toEqual([])
    }, 30_000)

    it('h03, its twin (CRLF, split characters, comments), says nothing under the same thresholds', async () => {
        const r = await run('h03', { scale: 0.1 })
        expect(r.findings).toEqual([])
        expect(unevaluated(r)).toEqual([])
    }, 30_000)
})

describe('f16-rate: a constant rate', () => {
    it('sends ten events every 20 ms, each with a data field of 100 bytes, ids 1..N, and the Doctor has nothing to say at the default thresholds, in real time', async () => {
        const r = await run('f16-rate', { scale: 1, query: { n: 250 } })
        expect(r.findings).toEqual([])
        expect(unevaluated(r)).toEqual([])
        expect(r.messages.slice(0, 250).map((m) => m.id)).toEqual(Array.from({ length: 250 }, (_, i) => String(i + 1)))
        expect(r.messages.slice(0, 250).every((m) => m.dataBytes === 100)).toBe(true)
        expect(r.messages.at(-1)!.event).toBe('end')
        // ten to a write, 25 writes, then the end event
        const writes = r.log[0]!.writes.map((w) => frameLog({ ...r.log[0]!, writes: [w] }).filter((f) => f.terminated && f.hasData).length)
        expect(writes).toEqual([...Array(25).fill(10), 1])
        // the cadence: the mean gap between the tick writes is the tick (absolute scheduling, so timer granularity does not slow it down)
        const at = r.log[0]!.writes.slice(0, 25).map((w) => w.atMs)
        const mean = (at[24]! - at[0]!) / 24
        expect(mean).toBeGreaterThan(14)
        expect(mean).toBeLessThan(35)
    }, 30_000)

    it('?rate and ?bytes change the batch and the size: 100 a second is two a tick, ?bytes=300 makes each data field 300 bytes', async () => {
        const r = await run('f16-rate', { scale: 1, query: { n: 20, rate: 100, bytes: 300 } })
        expect(r.findings).toEqual([])
        expect(r.messages.slice(0, 20).every((m) => m.dataBytes === 300)).toBe(true)
        const perWrite = r.log[0]!.writes.map((w) => frameLog({ ...r.log[0]!, writes: [w] }).filter((f) => f.terminated && f.hasData).length)
        expect(perWrite).toEqual([...Array(10).fill(2), 1])
    }, 30_000)

    it('every other number asked for is ignored in favour of a sane one: a rate of 0 or a size of nothing still sends the stream', async () => {
        const r = await run('f16-rate', { scale: 1, query: { n: 12, rate: 0, bytes: 0 } })
        expect(r.messages).toHaveLength(13)
        expect(r.messages.slice(0, 12).every((m) => m.dataBytes > 0)).toBe(true)
    }, 30_000)
})
