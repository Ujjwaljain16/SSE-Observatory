import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyze } from '../../core/diagnostics/engine'
import { defaultRules } from '../../core/diagnostics/rules'
import { startFixtureServer, FIXTURE_ROUTES, type FixtureServer } from '../server'
import { observeFixture } from './observeFixture'

let server: FixtureServer
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })

const observe = (id: string) => observeFixture(server, defaultRules, id)

describe('F11: a producer changes its payload format part way through (R16)', () => {
    it('f11-drift: the change of format is the only finding, and says what went and what came', async () => {
        const w = await observe('f11-drift')
        expect(w.findings.map((f) => f.key)).toEqual(['schema.drift:order'])
        const f = w.findings[0]!
        expect(f.severity).toBe('warning') // a field is gone
        expect(f.summary).toContain('1 field gone (price)')
        expect(f.summary).toContain('1 field new (currency)')
        expect(f.deductions[0]!.statement).toMatch(/^Likely:/)
        expect(w.coverage.find((c) => c.ruleId === 'schema.drift')!.status).toBe('evaluated')
    })

    it('f11-steady: the twin with one shape throughout has no findings, and the check was evaluated', async () => {
        const w = await observe('f11-steady')
        expect(w.findings).toEqual([])
        expect(w.coverage.find((c) => c.ruleId === 'schema.drift')!.status).toBe('evaluated')
    })

    it('what a host showed live is what offline analysis of the capture finds', async () => {
        const w = await observe('f11-drift')
        const batch = analyze(w.observations, { endT: w.observations.at(-1)!.t, thresholds: { stallMinSilenceMs: 400, stallNoCadenceMs: 500 } })
        expect(batch.findings).toEqual(w.findings)
    })

    it('is declared, with a healthy twin that expects nothing', () => {
        const route = FIXTURE_ROUTES.find((r) => r.id === 'f11-drift')!
        expect(route.healthyTwin).toBe('f11-steady')
        expect(FIXTURE_ROUTES.find((r) => r.id === route.healthyTwin)!.expectedFindings).toEqual([])
    })
})
