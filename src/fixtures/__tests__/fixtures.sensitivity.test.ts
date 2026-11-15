// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultRules } from '../../core/diagnostics/rules'
import { checkExpectations } from '../../doctor/labCheck'
import { FIXTURE_ROUTES, startFixtureServer, type FixtureServer } from '../server'
import { observeFixture } from './observeFixture'

// Campaign J4: does the suite notice a broken detector? Each faulty fixture says which findings it must produce. This runs the fixture with the rule
// that raises its finding REMOVED, and requires the fixture's own expectation to fail and to name that finding. A fixture whose expectation still holds
// without its rule was never testing that rule. Runs only when NIGHTLY=1 (it reads about ten fixtures twice): `NIGHTLY=1 npx vitest run
// src/fixtures/__tests__/fixtures.sensitivity.test.ts`.

const NIGHTLY = process.env['NIGHTLY'] === '1'

/** Routes that end by themselves, so they can be read to the end here. (The ones that stay open are read by watching, in fixtures.test.ts.) */
// Not here: f03-buffered (its bursts are a pattern only with the burst thresholds that fixtures.test.ts lowers for it, which this reader does not), f09-buffered
// (judged by a comparison of two captures, not by a rule) and the streams that stay open.
const ROUTES = ['f01-text-html', 'f01-json', 'f05-drops', 'f06-skips', 'f11-drift']
const QUERY: Record<string, Record<string, number>> = {}

let server: FixtureServer
beforeAll(async () => { if (NIGHTLY) server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server?.close() })

describe.skipIf(!NIGHTLY)('each fixture depends on the rule it claims to test', () => {
    for (const id of ROUTES) {
        it(`${id}: with its rule removed, its own expectation fails and names the finding`, async () => {
            const route = FIXTURE_ROUTES.find((r) => r.id === id)!
            const whole = await observeFixture(server, defaultRules, id, QUERY[id] ?? {}, true)
            const found = whole.findings.filter((f) => route.expectedFindings.some((k) => f.key === k || f.key.startsWith(k)))
            expect(found.length, `${id} shows what it expects when every rule is on`).toBeGreaterThan(0)
            expect(checkExpectations(whole.findings.map((f) => f.key), route.expectedFindings, route.forbiddenFindings).ok).toBe(true)

            const owners = [...new Set(found.map((f) => f.ruleId))]
            for (const owner of owners) {
                const without = await observeFixture(server, defaultRules.filter((r) => r.id !== owner), id, QUERY[id] ?? {}, true)
                const check = checkExpectations(without.findings.map((f) => f.key), route.expectedFindings, route.forbiddenFindings)
                // the finding of THAT rule must be what is missing (another rule may raise a second finding the route also expects)
                const missing = route.expectedFindings.filter((k) => !without.findings.some((f) => f.key === k || f.key.startsWith(k)))
                const lostOwn = found.filter((f) => f.ruleId === owner).some((f) => !without.findings.some((g) => g.key === f.key))
                expect(lostOwn, `${id}: without ${owner} its finding is still there`).toBe(true)
                if (found.every((f) => f.ruleId === owner)) {
                    expect(check.ok, `${id}: its expectation still holds with ${owner} removed`).toBe(false)
                    expect(check.problems.join(' '), 'and the message names what was lost').toContain(missing[0] ?? route.expectedFindings[0]!)
                }
            }
        }, 60_000)
    }

    it('the list names real routes that have expectations', () => {
        for (const id of ROUTES) expect(FIXTURE_ROUTES.find((r) => r.id === id)?.expectedFindings.length, id).toBeGreaterThan(0)
    })
})

describe('the sensitivity list', () => {
    it('names only routes that exist (checked in every run, so it cannot rot unseen)', () => {
        for (const id of ROUTES) expect(FIXTURE_ROUTES.some((r) => r.id === id), id).toBe(true)
    })
})
