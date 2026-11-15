// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultRules } from '../../core/diagnostics/rules'
import { redactCapture } from '../../core/capture/redact'
import { analyze } from '../../core/diagnostics/engine'
import { captureEndT, parseCapture } from '../../core/capture/format'
import type { EngineInput } from '../../core/diagnostics/streamModel'
import { toScenario, serializeScenario } from '../../core/scenario/toScenario'
import { parseScenarioText } from '../../core/scenario/validate'
import { FIXTURE_ROUTES, startFixtureServer, type FixtureServer } from '../../fixtures/server'
import { observeFixture } from '../../fixtures/__tests__/observeFixture'
import { frameLog } from '../../fixtures/groundTruth'
import { runScenario } from '../scenarioRunner'
import { SecretRegistry } from '../secretRegistry'
import type { CliIo } from '../index'

// Campaign D3: capture a failing fixture, turn the capture into a scenario, and run the scenario against the faulty stream and against its
// healthy twin. The scenario exists to fail on the fault and pass on the fix; this is the test that says whether it does, for each fault. It is
// the journey's step 7 in isolation.

let fixtures: FixtureServer
beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await fixtures.close() })

const ioFor = (url: string): CliIo => ({ out: () => {}, err: () => {}, env: { STREAM_URL: url }, readText: async () => { throw new Error('none') }, writeText: async () => {} }) as CliIo

async function scenarioFrom(id: string, query: Record<string, string | number>) {
    const observed = await observeFixture(fixtures, defaultRules, id, query, true, { captureBytes: true })
    const redacted = redactCapture(observed.capture).capture
    const analysis = analyze(redacted.records as EngineInput[], { ...(redacted.header.profile ? { profile: redacted.header.profile } : {}), endT: captureEndT(redacted) })
    const { scenario } = toScenario(redacted, analysis, { name: `from ${id}` })
    // the file a user would keep: serialised, parsed back, valid against the schema
    const parsed = parseScenarioText(serializeScenario(scenario))
    expect(parsed.errors, `${id}: the generated scenario is valid`).toEqual([])
    return { scenario: parsed.value!, foundKeys: analysis.findings.map((f) => f.key) }
}

const run = async (scenario: Awaited<ReturnType<typeof scenarioFrom>>['scenario'], id: string, query: Record<string, string | number>) =>
    runScenario(scenario, `${id}.json`, ioFor(fixtures.urlFor(id, { scale: 0.05, ...query })), new SecretRegistry())

/** [faulty fixture, the key it must raise, its healthy twin, query for the capture and for the runs] */
const CASES: Array<{ fault: string; key: string; twin: string; query?: Record<string, string | number> }> = [
    { fault: 'f06-skips', key: 'resume.last-event-id:skipped', twin: 'f06-resumes' },
]
// Not in the table: `f02-closed` (a 200 whose connection closes at once is reconnected without end, so the capture cannot be finished by this
// helper; it needs the ground-truth harness of plan slice A) and `f05-ignores` (the fixture does not exist yet, plan A3).

describe('a scenario made from a capture fails on the fault it came from and passes on the fix', () => {
    for (const c of CASES) {
        it(`${c.fault}: fails on the faulty stream (naming the finding), passes on ${c.twin}`, async () => {
            const { scenario, foundKeys } = await scenarioFrom(c.fault, c.query ?? {})
            expect(foundKeys.some((k) => k.startsWith(c.key)), `the capture shows ${c.key} (found: ${foundKeys.join(', ')})`).toBe(true)
            const bad = await run(scenario, c.fault, c.query ?? {})
            expect(bad.status, `${c.fault}: ${bad.checks.map((x) => `${x.name}: ${x.status} ${x.message}`).join(' | ')}`).toBe('fail')
            const good = await run(scenario, c.twin, c.query ?? {})
            expect(good.status, `${c.twin}: ${good.checks.filter((x) => x.status !== 'pass').map((x) => `${x.name}: ${x.message}`).join(' | ')}`).toBe('pass')
        }, 60_000)
    }

    // Q4b (owner's decision): a capture of a bad response (a wrong status or content type) makes a scenario that expects a HEALTHY one, 200 and
    // text/event-stream: it is written to verify the fix, not to reproduce the broken response, so it fails on the fault and passes on the fix.
    for (const fault of ['f01-text-html', 'f01-404']) {
        it(`${fault}: the set-up works (the capture shows the bad response; the scenario expects a healthy one and says why)`, async () => {
            const { scenario, foundKeys } = await scenarioFrom(fault, {})
            expect(foundKeys.some((k) => k.startsWith('proto.content-type') || k.startsWith('http.status')), `found: ${foundKeys.join(', ')}`).toBe(true)
            expect(scenario.expect?.status).toBe(200)
            expect(scenario.expect?.content_type).toBe('text/event-stream')
            const notes = (scenario.meta?.notes ?? []).join(' ')
            expect(notes).toMatch(/verify the fix/)
            expect(notes).toMatch(/not reproduce/)
        }, 60_000)

        it(`${fault}: the scenario made from a bad-response capture fails on the bad response and passes on the healthy twin h01`, async () => {
            const { scenario } = await scenarioFrom(fault, {})
            const bad = await run(scenario, fault, {})
            expect(bad.status, `on the faulty stream: ${bad.checks.map((x) => `${x.name}: ${x.status}`).join(' | ')}`).toBe('fail')
            // it fails for the reason it was made for: the response is not a healthy event stream
            expect(bad.checks.filter((x) => x.status === 'fail').map((x) => x.name).join(' | ')).toMatch(/expect status|expect content type/)
            const good = await run(scenario, 'h01', {})
            expect(good.status, `on the twin: ${good.checks.filter((x) => x.status !== 'pass').map((x) => `${x.name}: ${x.message}`).join(' | ')}`).toBe('pass')
        }, 60_000)
    }

    // Q4a (owner's decision): a silence needs time to show, so a scenario made from a stall capture carries `expect.max_silence_ms` (the stall
    // rule's own limit for that capture) and the runner keeps the connection open and observing for that long after the last step. A stall cannot
    // be captured live here (a stalled stream never ends), so these use the failure lab's shipped captures: the files a user would have been given.
    // The runs are against the same fixture at the lab's scale; the healthy twin is the steady fixture h01 at that scale (a 250 ms cadence, like
    // the capture's; the catalogue's twin h02 is a sparse stream of another cadence, so the capture's limit does not apply to it).
    const SCALE = 0.25
    for (const fault of ['f04-silent', 'f04-heartbeats']) {
        const scenarioFromLab = () => {
            const lab = parseCapture(fs.readFileSync(path.resolve(process.cwd(), `public/lab/${fault}.sse-capture`), 'utf8')).capture
            const redacted = redactCapture(lab).capture
            const analysis = analyze(redacted.records as EngineInput[], { ...(redacted.header.profile ? { profile: redacted.header.profile } : {}), endT: captureEndT(redacted) })
            const { scenario } = toScenario(redacted, analysis, { name: `from ${fault}` })
            const parsed = parseScenarioText(serializeScenario(scenario))
            expect(parsed.errors).toEqual([])
            return { keys: analysis.findings.map((f) => f.key), scenario: parsed.value! }
        }
        const runAt = (scenario: Awaited<ReturnType<typeof scenarioFrom>>['scenario'], id: string, query: Record<string, string | number> = {}) =>
            runScenario(scenario, `${id}.json`, ioFor(fixtures.urlFor(id, { scale: SCALE, ...query })), new SecretRegistry())
        /** What the server did on the connection(s) a run opened, from the server's own log. */
        const connectionsOf = async (route: string, go: () => Promise<unknown>) => {
            const before = fixtures.groundTruth.connections.length
            await go()
            return fixtures.groundTruth.connections.slice(before).filter((c) => c.route === route)
        }
        /** When the server last wrote a complete event, and the writes it made after that. */
        const afterLastEvent = (c: (typeof fixtures.groundTruth.connections)[number]) => {
            const events = frameLog(c).filter((f) => f.terminated && f.hasData)
            const lastWrite = events.at(-1)!.lastWrite
            return { events: events.length, lastEventAt: c.writes[lastWrite]!.atMs, writesAfter: c.writes.slice(lastWrite + 1), openForAfter: (c.endedAtMs ?? performance.now()) - c.writes[lastWrite]!.atMs }
        }

        it(`${fault}: the set-up works (the capture shows the stall; the scenario carries the stall rule's own limit and says so)`, async () => {
            const { keys, scenario } = scenarioFromLab()
            expect(keys.some((k) => k.startsWith('stall.silent')), `found: ${keys.join(', ')}`).toBe(true)
            // the lab captures' stall findings say "The threshold was 1 s" (their cadence is 250 ms)
            expect(scenario.expect?.max_silence_ms).toBe(1000)
            expect((scenario.meta?.notes ?? []).join(' ')).toMatch(/max_silence_ms/)
            const run = await runAt(scenario, fault)
            expect(['pass', 'fail', 'inconclusive']).toContain(run.status)
            expect(run.checks.length).toBeGreaterThan(0)
        }, 60_000)

        it(`${fault}: the scenario made from a stall capture fails on the stalled stream, which really stayed open and silent for the observation time`, async () => {
            const { scenario } = scenarioFromLab()
            let bad!: Awaited<ReturnType<typeof runAt>>
            const connections = await connectionsOf(fault, async () => { bad = await runAt(scenario, fault) })
            expect(bad.status, bad.checks.map((x) => `${x.name}: ${x.status}`).join(' | ')).toBe('fail')
            const silence = bad.checks.find((x) => x.name === 'expect max silence')
            expect(silence?.status, bad.checks.map((x) => `${x.name}: ${x.status} ${x.message}`).join(' | ')).toBe('fail')

            // the server's own log: one connection, which the client (not the server) closed, at least the limit after the last event
            expect(connections).toHaveLength(1)
            const c = connections[0]!
            expect(c.endedBy).toBe('client-closed')
            const after = afterLastEvent(c)
            expect(after.events).toBe(12)
            expect(after.openForAfter, 'the connection stayed open after the last event for at least the limit').toBeGreaterThanOrEqual(1000)
            if (fault === 'f04-silent') expect(after.writesAfter, 'the server wrote nothing after the last event').toHaveLength(0)
            else {
                // heartbeats kept the bytes flowing, so it is the event silence that the scenario had to catch
                expect(after.writesAfter.length).toBeGreaterThanOrEqual(3)
                expect(after.writesAfter.every((w) => w.text.startsWith(':'))).toBe(true)
                expect(silence?.message).toMatch(/stall\.silent:events/)
            }
        }, 60_000)

        it(`${fault}: the same scenario passes on its healthy twin (h01 at the same cadence), whose connection really kept delivering`, async () => {
            const { scenario } = scenarioFromLab()
            let good!: Awaited<ReturnType<typeof runAt>>
            const connections = await connectionsOf('h01', async () => { good = await runAt(scenario, 'h01', { n: 80 }) })
            expect(good.status, good.checks.filter((x) => x.status !== 'pass').map((x) => `${x.name}: ${x.message}`).join(' | ')).toBe('pass')
            expect(good.checks.find((x) => x.name === 'expect max silence')?.status).toBe('pass')
            // the server's own log: the client closed it, the server never ended it, and it never went a second without writing
            expect(connections).toHaveLength(1)
            const c = connections[0]!
            expect(c.endedBy).toBe('client-closed')
            const after = afterLastEvent(c)
            expect(after.openForAfter).toBeLessThan(1000) // it did not sit silent after its last event: the last event is the last thing it wrote before the close
            const gaps = c.writes.slice(1).map((w, i) => w.atMs - c.writes[i]!.atMs)
            expect(Math.max(...gaps)).toBeLessThan(1000)
            // and it was observed for longer than the limit after the 12 events the steps asked for
            expect(good.durationMs).toBeGreaterThan(12 * 250 + 1000 - 100)
        }, 60_000)

        it(`${fault}: without expect.max_silence_ms the same scenario behaves as before (no silence check; the stall is still not judged)`, async () => {
            const { scenario } = scenarioFromLab()
            const { max_silence_ms: _removed, ...rest } = scenario.expect!
            const old = { ...scenario, expect: rest }
            expect(JSON.stringify(old)).not.toContain('max_silence_ms')
            const run = await runAt(old, fault)
            expect(run.checks.map((x) => x.name)).not.toContain('expect max silence')
            expect(run.status, run.checks.map((x) => `${x.name}: ${x.status} ${x.message}`).join(' | ')).toBe('pass')
        }, 60_000)
    }

    it('every fault in the table is a real fixture with the twin it names', () => {
        const ids = new Set(FIXTURE_ROUTES.map((r) => r.id))
        for (const c of CASES) { expect(ids.has(c.fault), c.fault).toBe(true); expect(ids.has(c.twin), c.twin).toBe(true) }
    })
})
