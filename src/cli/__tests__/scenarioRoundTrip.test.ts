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

    // A silence needs time to show: the scenario collects the events the capture had and stops, so nothing ever judges the silence that
    // followed. Until a scenario can say "the stream must not go silent" (plan question Q4, a schema change that is the owner's to decide),
    // this is a known, executable gap: `it.fails` passes while the fault is missed, and starts failing, loudly, the day it is caught.
    // The same shape for a bad response: the scenario "expects the same" response the capture had (text/html), so it passes on the fault and
    // FAILS on the fixed stream, the wrong way round. toScenario says so in a note ("Change expect if that was the problem being investigated"),
    // but a regression scenario that has to be edited to mean what it says is not a regression scenario. Fix, with Q4, in the follow-up PR.
    it('f01-text-html: the set-up for the gap below works (the capture shows the wrong content type; both runs reach a verdict)', async () => {
        const { scenario, foundKeys } = await scenarioFrom('f01-text-html', {})
        expect(foundKeys.some((k) => k.startsWith('proto.content-type'))).toBe(true)
        expect(scenario.expect?.content_type).toBe('text/html') // what the scenario currently expects: the fault itself
        for (const id of ['f01-text-html', 'h01']) expect(['pass', 'fail', 'inconclusive']).toContain((await run(scenario, id, {})).status)
    }, 60_000)

    it.fails('f01-text-html (KNOWN GAP, D3-b): the scenario made from a bad-response capture fails on the bad response and passes on the healthy twin', async () => {
        const { scenario } = await scenarioFrom('f01-text-html', {})
        const bad = await run(scenario, 'f01-text-html', {})
        expect(bad.status, 'on the faulty stream').toBe('fail')
        const good = await run(scenario, 'h01', {})
        expect(good.status, `on the twin: ${good.checks.filter((x) => x.status !== 'pass').map((x) => x.message).join(' | ')}`).toBe('pass')
    }, 60_000)

    // A stall cannot be captured live here (a stalled stream never ends), so these use the failure lab's shipped captures of them: the files a user
    // would have been given. The run is against the same fixture at the lab's scale.
    for (const fault of ['f04-silent', 'f04-heartbeats']) {
        const stallRun = async () => {
            const lab = parseCapture(fs.readFileSync(path.resolve(process.cwd(), `public/lab/${fault}.sse-capture`), 'utf8')).capture
            const redacted = redactCapture(lab).capture
            const analysis = analyze(redacted.records as EngineInput[], { ...(redacted.header.profile ? { profile: redacted.header.profile } : {}), endT: captureEndT(redacted) })
            const { scenario } = toScenario(redacted, analysis, { name: `from ${fault}` })
            const parsed = parseScenarioText(serializeScenario(scenario))
            expect(parsed.errors).toEqual([])
            const bad = await runScenario(parsed.value!, `${fault}.json`, ioFor(fixtures.urlFor(fault, { scale: 0.25 })), new SecretRegistry())
            return { keys: analysis.findings.map((f) => f.key), bad }
        }

        it(`${fault}: the set-up for the gap below works (the capture shows the stall; the scenario runs to a verdict)`, async () => {
            const { keys, bad } = await stallRun()
            expect(keys.some((k) => k.startsWith('stall.silent')), `found: ${keys.join(', ')}`).toBe(true)
            expect(['pass', 'fail', 'inconclusive']).toContain(bad.status)
            expect(bad.checks.length).toBeGreaterThan(0)
        }, 60_000)

        it.fails(`${fault} (KNOWN GAP, Q4): the scenario made from a stall capture fails on the stalled stream`, async () => {
            const { bad } = await stallRun()
            expect(bad.status, bad.checks.map((x) => `${x.name}: ${x.status}`).join(' | ')).toBe('fail')
        }, 60_000)
    }

    it('every fault in the table is a real fixture with the twin it names', () => {
        const ids = new Set(FIXTURE_ROUTES.map((r) => r.id))
        for (const c of CASES) { expect(ids.has(c.fault), c.fault).toBe(true); expect(ids.has(c.twin), c.twin).toBe(true) }
    })
})
