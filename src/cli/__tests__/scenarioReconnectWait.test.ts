// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseScenarioText } from '../../core/scenario/validate'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'
import { runScenario } from '../scenarioRunner'
import { SecretRegistry } from '../secretRegistry'
import type { CliIo } from '../index'

// Found by the journey (e2e/journey.spec.ts, step 7): a scenario made from a capture taken in the app fails on the HEALTHY twin of the stream it
// came from. The app waits about a second before it reconnects, so the scenario says `reconnect: { after_ms: 1100 }`. The runner's own client
// reconnects by itself as soon as the server drops it, and the events of the new connection arrive while the step sleeps; the next
// `collect_events` then waited for events that had already been delivered and found only the closing one: "the stream ended after 1".
// The scenarios shipped with the tool use `after_ms: 0`, where the sleep is too short to show it.

let fixtures: FixtureServer
beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await fixtures.close() })

const ioFor = (url: string): CliIo => ({ out: () => {}, err: () => {}, env: { STREAM_URL: url }, readText: async () => { throw new Error('none') }, writeText: async () => {} }) as CliIo

const scenario = (reconnect: Record<string, unknown>, collectAfter: number) => {
    const text = JSON.stringify({
        version: 1, name: 'resume after a dropped connection',
        target: { url: '${ENV:STREAM_URL}', sequence: { use_sse_id: true, policy: 'consecutive' } },
        steps: [{ collect_events: 4, timeout_ms: 10_000 }, { disconnect: { mode: 'server' } }, { reconnect }, { collect_events: collectAfter, timeout_ms: 10_000 }],
        verify: [{ no_findings_at_or_above: 'error' }], fail_on_severity: 'error',
    })
    const parsed = parseScenarioText(text)
    expect(parsed.errors).toEqual([])
    return parsed.value!
}

describe('a reconnect step that waits', () => {
    it('does not make a healthy stream fail: the events that arrive during the wait count for the step after it', async () => {
        const run = await runScenario(scenario({ after_ms: 500, resume_from_last_event_id: true }, 2), 'wait.json', ioFor(fixtures.urlFor('f06-resumes', { scale: 0.05 })), new SecretRegistry())
        expect(run.status, run.checks.filter((c) => c.status !== 'pass').map((c) => `${c.name}: ${c.message}`).join(' | ')).toBe('pass')
    }, 60_000)

    it('still fails on the stream that skips ids after the resume', async () => {
        const run = await runScenario(scenario({ after_ms: 500, resume_from_last_event_id: true }, 1), 'wait.json', ioFor(fixtures.urlFor('f06-skips', { scale: 0.05 })), new SecretRegistry())
        expect(run.status).toBe('fail')
        expect(run.checks.filter((c) => c.status === 'fail').map((c) => c.message).join(' ')).toMatch(/resume\.last-event-id/)
    }, 60_000)

    // OPEN QUESTION (campaign page, Q-I2), pinned as it is: in `disconnect: server` mode the runner's client has already reconnected, with the
    // cursor, by the time the reconnect step runs, so `after_ms` does not delay the connection and `resume_from_last_event_id: false` does not
    // withhold the cursor. docs/guide/cli-ci.md says "reconnect waits after_ms, then connects again; resume_from_last_event_id: false forgets
    // the cursor first". This flips when the runner holds its client at the drop.
    it('KNOWN GAP: the second connection already carried the cursor, whatever resume_from_last_event_id says', async () => {
        const before = fixtures.groundTruth.connections.length
        await runScenario(scenario({ after_ms: 300, resume_from_last_event_id: false }, 1), 'forget.json', ioFor(fixtures.urlFor('f06-resumes', { scale: 0.05 })), new SecretRegistry())
        const mine = fixtures.groundTruth.connections.slice(before).filter((c) => c.route === 'f06-resumes')
        expect(mine.length).toBeGreaterThanOrEqual(2)
        expect(mine[1]!.requestHeaders['last-event-id'], 'the cursor was sent although the step said to forget it').not.toBe('')
        expect(mine[1]!.acceptedAtMs - mine[0]!.endedAtMs!, 'the new connection came before the 300 ms the step asked for').toBeLessThan(300)
    }, 60_000)
})
