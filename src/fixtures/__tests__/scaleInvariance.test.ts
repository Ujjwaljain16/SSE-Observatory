// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultRules } from '../../core/diagnostics/rules'
import { defaultsAt } from '../../core/testing/scaleThresholds'
import { FIXTURE_ROUTES, startFixtureServer, type FixtureServer } from '../server'
import { observeFixture } from './observeFixture'

// Campaign C5: the fixture suite runs the streams at a fraction of real time so that it is quick, with the thresholds scaled to match. That is only
// honest if the findings do not depend on the scale: the same stream at scale 0.1 with defaults x 0.1 must say what it says at scale 1 with the
// defaults. A difference is a threshold that is not purely a time (a fixed floor in milliseconds, a count), and it is a finding about the test
// method, not about the product. Real time, so it runs only when NIGHTLY=1: `NIGHTLY=1 npx vitest run src/fixtures/__tests__/scaleInvariance.test.ts`.

const NIGHTLY = process.env['NIGHTLY'] === '1'

/** Streams that end by themselves, faulty and healthy, so that each can be read at scale 1 (the longest, f05-drops, takes about 11 s). */
const ROUTES = ['f01-text-html', 'f05-drops', 'f06-skips', 'f11-drift', 'f15-malformed', 'f12-gzip-sync', 'h01', 'h03', 'f05-resumes']
const SCALES = [0.1, 0.25]

let server: FixtureServer
beforeAll(async () => { if (NIGHTLY) server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server?.close() })

/** What a person would compare: each finding's key and severity, sorted. */
async function findingsAt(id: string, scale: number): Promise<string[]> {
    const r = await observeFixture(server, defaultRules, id, { scale }, true, { thresholds: defaultsAt(scale) })
    return r.findings.map((f) => `${f.key} (${f.severity})`).sort()
}

describe.skipIf(!NIGHTLY)('the findings do not depend on the time scale', () => {
    for (const id of ROUTES) {
        it(`${id}: the same findings at scale ${SCALES.join(' and ')} as at scale 1`, async () => {
            const real = await findingsAt(id, 1)
            for (const scale of SCALES) expect(await findingsAt(id, scale), `${id} at scale ${scale} against scale 1`).toEqual(real)
        }, 90_000)
    }
})

describe('the scale invariance list', () => {
    it('names only routes that exist (checked in every run, so it cannot rot unseen)', () => {
        for (const id of ROUTES) expect(FIXTURE_ROUTES.some((r) => r.id === id), id).toBe(true)
        expect(SCALES.every((s) => s >= 0.02), 'not below the timer granularity of the machine').toBe(true)
    })
})
