// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseScenarioText } from '../../core/scenario/validate'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'
import { frameLog, type LoggedConnection } from '../../fixtures/groundTruth'
import { runScenario, type ScenarioRun } from '../scenarioRunner'
import { SecretRegistry } from '../secretRegistry'
import type { CliIo } from '../index'

// Found by the journey (e2e/journey.spec.ts, step 7): a scenario made from a capture taken in the app fails on the HEALTHY twin of the stream it
// came from. The app waits about a second before it reconnects, so the scenario says `reconnect: { after_ms: 1100 }`. The runner's own client
// reconnected by itself as soon as the server dropped it, and the events of the new connection arrived while the step slept; the next
// `collect_events` then waited for events that had already been delivered and found only the closing one: "the stream ended after 1".
// The scenarios shipped with the tool use `after_ms: 0`, where the sleep is too short to show it.
//
// Q-I2 (decided by the owner): a scenario with an explicit `reconnect` step holds its client at the drop, and the step is the reconnect: it waits
// `after_ms`, then connects with or without Last-Event-ID as `resume_from_last_event_id` says. A scenario with NO `reconnect` step keeps the client's
// own automatic reconnection (that is the client's real behaviour under test). Every claim about time and headers is checked on the fixture
// server's ground-truth log, which no client component writes.

let fixtures: FixtureServer
beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await fixtures.close() })

const ioFor = (url: string): CliIo => ({ out: () => {}, err: () => {}, env: { STREAM_URL: url }, readText: async () => { throw new Error('none') }, writeText: async () => {} }) as CliIo

const build = (steps: unknown[], extra: Record<string, unknown> = {}, verify: unknown[] = [{ no_findings_at_or_above: 'error' }]) => {
    const text = JSON.stringify({
        version: 1, name: 'resume after a dropped connection',
        target: { url: '${ENV:STREAM_URL}', sequence: { use_sse_id: true, policy: 'consecutive' }, ...extra },
        steps, verify, fail_on_severity: 'error',
    })
    const parsed = parseScenarioText(text)
    expect(parsed.errors).toEqual([])
    return parsed.value!
}

const scenario = (reconnect: Record<string, unknown>, collectAfter: number) =>
    build([{ collect_events: 4, timeout_ms: 10_000 }, { disconnect: { mode: 'server' } }, { reconnect }, { collect_events: collectAfter, timeout_ms: 10_000 }])

const why = (run: ScenarioRun) => run.checks.filter((c) => c.status !== 'pass').map((c) => `${c.name}: ${c.message}`).join(' | ')

let runs = 0
/** Runs a scenario against a route and returns the run and the connections the SERVER saw for it (told apart from other runs by a query tag the fixtures ignore). */
async function runOn(route: string, s: ReturnType<typeof build>, query: Record<string, string | number> = { scale: 0.05 }) {
    const tag = `run${++runs}`
    const run = await runScenario(s, 'q-i2.json', ioFor(fixtures.urlFor(route, { ...query, tag })), new SecretRegistry())
    const seen = fixtures.groundTruth.connections.filter((c) => c.route === route && c.query['tag'] === tag)
    return { run, seen }
}

/** The id the server last sent on a connection (its own framer, not the client's). */
const lastIdSent = (c: LoggedConnection): string => frameLog(c).filter((f) => f.id !== null).at(-1)!.effectiveId
/** How long the server saw between the end of one connection and the acceptance of the next. */
const gapMs = (a: LoggedConnection, b: LoggedConnection): number => b.acceptedAtMs - a.endedAtMs!
const TOLERANCE_MS = 25

describe('a reconnect step that waits', () => {
    it('does not make a healthy stream fail: the events that arrive during the wait count for the step after it', async () => {
        const run = await runScenario(scenario({ after_ms: 500, resume_from_last_event_id: true }, 2), 'wait.json', ioFor(fixtures.urlFor('f06-resumes', { scale: 0.05 })), new SecretRegistry())
        expect(run.status, why(run)).toBe('pass')
    }, 60_000)

    it('still fails on the stream that skips ids after the resume', async () => {
        const run = await runScenario(scenario({ after_ms: 500, resume_from_last_event_id: true }, 1), 'wait.json', ioFor(fixtures.urlFor('f06-skips', { scale: 0.05 })), new SecretRegistry())
        expect(run.status).toBe('fail')
        expect(run.checks.filter((c) => c.status === 'fail').map((c) => c.message).join(' ')).toMatch(/resume\.last-event-id/)
    }, 60_000)
})

describe('Q-I2: an explicit reconnect step is the reconnect (server ground truth)', () => {
    it('after_ms delays the second connection: it starts no earlier than the drop plus after_ms, and there is no connection in between', async () => {
        const { run, seen } = await runOn('f06-resumes', scenario({ after_ms: 400, resume_from_last_event_id: true }, 3))
        expect(run.status, why(run)).toBe('pass')
        expect(seen, 'the runner opened a connection of its own during the wait').toHaveLength(2)
        expect(seen[0]!.endedBy).toBe('server-end')
        expect(gapMs(seen[0]!, seen[1]!), 'the second connection came before the 400 ms the step asked for').toBeGreaterThanOrEqual(400 - TOLERANCE_MS)
        expect(gapMs(seen[0]!, seen[1]!), 'and it was not left waiting long after them').toBeLessThan(400 + 400)
    }, 60_000)

    it('the client does not reconnect on its own between the drop and the step, whatever lies between them (a wait step here)', async () => {
        const s = build([{ collect_events: 4, timeout_ms: 10_000 }, { disconnect: { mode: 'server' } }, { wait: { ms: 500 } }, { reconnect: { after_ms: 0, resume_from_last_event_id: true } }, { collect_events: 3, timeout_ms: 10_000 }])
        const { run, seen } = await runOn('f06-resumes', s)
        expect(run.status, why(run)).toBe('pass')
        expect(seen, 'a connection the scenario did not ask for').toHaveLength(2)
        expect(gapMs(seen[0]!, seen[1]!), 'the second connection came before the wait was over').toBeGreaterThanOrEqual(500 - TOLERANCE_MS)
    }, 60_000)

    it('resume_from_last_event_id: true sends the last id the server sent, and the healthy twin passes', async () => {
        const { run, seen } = await runOn('f06-resumes', scenario({ after_ms: 100, resume_from_last_event_id: true }, 3))
        expect(run.status, why(run)).toBe('pass')
        expect(seen[0]!.requestHeaders['last-event-id'], 'the first connection has no cursor').toBeUndefined()
        expect(seen[1]!.requestHeaders['last-event-id']).toBe(lastIdSent(seen[0]!))
        expect(run.checks.find((c) => c.name.endsWith('reconnect'))?.message).toMatch(/with Last-Event-ID/)
    }, 60_000)

    it('resume_from_last_event_id: false withholds the cursor: the second connection has no Last-Event-ID header, and the analysis says so', async () => {
        const { run, seen } = await runOn('f06-resumes', scenario({ after_ms: 300, resume_from_last_event_id: false }, 1))
        expect(seen.length).toBeGreaterThanOrEqual(2)
        expect(Object.keys(seen[1]!.requestHeaders), 'the cursor was sent although the step said to forget it').not.toContain('last-event-id')
        expect(gapMs(seen[0]!, seen[1]!)).toBeGreaterThanOrEqual(300 - TOLERANCE_MS)
        expect(run.findings.map((f) => f.key), 'a client that forgot its cursor is something the analysis reports').toContain('resume.last-event-id:not-sent')
        expect(run.checks.find((c) => c.name.endsWith('reconnect'))?.message).toMatch(/without Last-Event-ID/)
    }, 60_000)

    it('a stream that skips ids after a correct resume fails, with the timing and header of the step', async () => {
        const { run, seen } = await runOn('f06-skips', scenario({ after_ms: 300, resume_from_last_event_id: true }, 1))
        expect(run.status).toBe('fail')
        expect(run.checks.filter((c) => c.status === 'fail').map((c) => c.message).join(' ')).toMatch(/resume\.last-event-id/)
        expect(seen[1]!.requestHeaders['last-event-id']).toBe(lastIdSent(seen[0]!))
        expect(gapMs(seen[0]!, seen[1]!)).toBeGreaterThanOrEqual(300 - TOLERANCE_MS)
    }, 60_000)

    it('a stream that ignores the cursor (f05-ignores) fails: the cursor was sent and the stream began again', async () => {
        const s = build([{ collect_events: 3, timeout_ms: 10_000 }, { disconnect: { mode: 'server' } }, { reconnect: { after_ms: 200, resume_from_last_event_id: true } }, { collect_events: 3, timeout_ms: 10_000 }], { delivery: 'exactly_once' }, ['no_unexpected_duplicates'])
        const { run, seen } = await runOn('f05-ignores', s)
        expect(run.status).toBe('fail')
        expect(run.findings.map((f) => f.key)).toContain('resume.last-event-id:ignored')
        expect(seen[1]!.requestHeaders['last-event-id']).toBe(lastIdSent(seen[0]!))
        expect(gapMs(seen[0]!, seen[1]!)).toBeGreaterThanOrEqual(200 - TOLERANCE_MS)
    }, 60_000)

    it('a reconnect step with no drop before it closes the connection, waits after_ms and connects again', async () => {
        const s = build([{ collect_events: 2, timeout_ms: 10_000 }, { reconnect: { after_ms: 250, resume_from_last_event_id: true } }, { collect_events: 2, timeout_ms: 10_000 }])
        const { run, seen } = await runOn('f06-resumes', s)
        expect(run.status, why(run)).toBe('pass')
        expect(seen[0]!.endedBy).toBe('client-closed')
        expect(gapMs(seen[0]!, seen[1]!)).toBeGreaterThanOrEqual(250 - TOLERANCE_MS)
        expect(seen[1]!.requestHeaders['last-event-id']).toBeDefined()
    }, 60_000)

    it('a drop the scenario did not plan for (the step before the reconnect asks for more events than the connection sent) fails at once, not at the timeout', async () => {
        const s = build([{ collect_events: 6, timeout_ms: 20_000 }, { disconnect: { mode: 'server' } }, { reconnect: { after_ms: 0, resume_from_last_event_id: true } }])
        const started = Date.now()
        const { run } = await runOn('f06-resumes', s) // the first connection sends 4 and drops
        expect(run.status).toBe('fail')
        expect(run.checks.find((c) => c.name.includes('collect'))?.message).toMatch(/dropped.*after 4/)
        expect(Date.now() - started, 'it waited for the timeout').toBeLessThan(5000)
    }, 60_000)
})

describe('a scenario with NO reconnect step keeps the client\'s own reconnection (it tests the real behaviour)', () => {
    const noStep = (collectAfter: number) => build([{ collect_events: 4, timeout_ms: 10_000 }, { disconnect: { mode: 'server' } }, { collect_events: collectAfter, timeout_ms: 10_000 }])

    it('the client reconnects by itself within a moment, with the cursor, and the healthy twin passes', async () => {
        const { run, seen } = await runOn('f06-resumes', noStep(3))
        expect(run.status, why(run)).toBe('pass')
        expect(seen).toHaveLength(2)
        expect(gapMs(seen[0]!, seen[1]!), 'the automatic reconnect is the client\'s backoff (20 ms), not a held connection').toBeLessThan(300)
        expect(seen[1]!.requestHeaders['last-event-id']).toBe(lastIdSent(seen[0]!))
    }, 60_000)

    it('and it still catches the stream that skips ids', async () => {
        const { run } = await runOn('f06-skips', noStep(1))
        expect(run.status).toBe('fail')
        expect(run.checks.filter((c) => c.status === 'fail').map((c) => c.message).join(' ')).toMatch(/resume\.last-event-id/)
    }, 60_000)
})
