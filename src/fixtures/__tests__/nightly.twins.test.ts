// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createObservedStream } from '../../core/sse/observedStream'
import { createEngine } from '../../core/diagnostics/engine'
import { FIXTURE_ROUTES, startFixtureServer, type FixtureServer } from '../server'

// Campaign J1 / plan T3: the healthy twins, in real time (scale 1), with the DEFAULT thresholds. Every other fixture test runs at a fraction of
// real time and lowers the stall thresholds to match, so none of them shows that a healthy stream raises nothing under the numbers users get. This
// does. It takes minutes (h02 alone is 100 s), so it runs only when NIGHTLY=1 (the nightly workflow, or by hand): `NIGHTLY=1 npx vitest run
// src/fixtures/__tests__/nightly.twins.test.ts`.

const NIGHTLY = process.env['NIGHTLY'] === '1'

/** Rules that cannot be judged from a socket alone, or need more history than a short twin gives, with the reason. A rule outside this list that
 *  is "not evaluated" on a twin is a failure: a twin that quietly skips a check proves nothing about it. */
const MAY_BE_UNJUDGED: Record<string, string> = {
    'seq.integrity': 'needs a declared sequence; most twins declare none',
    'consumer.slow': 'needs page-side samples; a Node client has none',
    'proxy.masking': 'needs a proxy in front of the stream',
    'schema.drift': 'needs a baseline of 20 events of one name; the short twins send fewer',
}

const TWINS: Array<{ id: string; query?: Record<string, string | number>; ceilingMs: number }> = [
    { id: 'h01', ceilingMs: 15_000 },
    { id: 'h03', ceilingMs: 15_000 },
    { id: 'h04', ceilingMs: 15_000 },
    { id: 'f09-healthy', ceilingMs: 20_000 },
    { id: 'f10-steady', ceilingMs: 15_000 },
    { id: 'f05-resumes', ceilingMs: 20_000 },
    { id: 'f06-resumes', ceilingMs: 20_000 },
    { id: 'f03-steady', ceilingMs: 40_000 },
    { id: 'f11-steady', ceilingMs: 20_000 },
    // h06-comments-only is the healthy twin of f04-late-heartbeat: the first run of the release-candidate workflow found it missing from this list.
    { id: 'h06-comments-only', ceilingMs: 30_000 },
    { id: 'h02', ceilingMs: 150_000 },
]

let server: FixtureServer
beforeAll(async () => { if (NIGHTLY) server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server?.close() })

async function readInRealTime(id: string, query: Record<string, string | number>) {
    const route = FIXTURE_ROUTES.find((r) => r.id === id)!
    const engine = createEngine({ ...(route.profile ? { profile: route.profile } : {}) }) // the DEFAULT thresholds
    let finished!: () => void
    const done = new Promise<void>((resolve) => { finished = resolve })
    const stream = createObservedStream({
        request: () => ({ url: server.urlFor(id, { scale: 1, ...query }) }),
        sinks: { onMessage: () => {}, onPhase: (p) => { if (p === 'ended' || p === 'failed') finished() } },
        recording: { ...(route.profile?.sequence ? { profile: { sequence: { useSseId: route.profile.sequence.useSseId, field: route.profile.sequence.field } } } : {}), onObservations: (batch) => { for (const o of batch) { engine.feed(o); engine.tick(o.t) } }, flushMs: 20 },
        clientOptions: { initialDelayMs: 100, maxDelayMs: 1000, jitter: 0, maxRetries: 3 },
    })
    const started = Date.now()
    stream.start()
    await done
    stream.flushObservations()
    stream.stop()
    const endT = Date.now() - started
    engine.tick(endT)
    engine.end(endT)
    return { findings: engine.findings(), coverage: engine.coverage(), ms: endT }
}

describe.skipIf(!NIGHTLY)('healthy twins in real time with the default thresholds', () => {
    for (const twin of TWINS) {
        it(`${twin.id}: no finding at all, and every rule that could be judged was`, async () => {
            const r = await readInRealTime(twin.id, twin.query ?? {})
            expect(r.findings.map((f) => `${f.key} (${f.severity})`), 'a healthy stream raised a finding').toEqual([])
            const unjudged = r.coverage.filter((c) => c.status === 'not-evaluated' && !(c.ruleId in MAY_BE_UNJUDGED)).map((c) => `${c.ruleId}: ${c.notes[0] ?? ''}`)
            expect(unjudged, 'a rule that should have been judged was not').toEqual([])
            expect(r.ms).toBeLessThan(twin.ceilingMs)
        }, twin.ceilingMs + 10_000)
    }

    it('every route named here is a real healthy twin of something', () => {
        const twinIds = new Set(FIXTURE_ROUTES.map((r) => r.healthyTwin).filter(Boolean))
        for (const t of TWINS) expect(FIXTURE_ROUTES.some((r) => r.id === t.id), t.id).toBe(true)
        expect([...twinIds].filter((id) => !TWINS.some((t) => t.id === id)), 'a twin missing from the nightly list').toEqual([])
    })
})

describe('the nightly list', () => {
    it('is not empty and names only routes that exist (checked in every run, so it cannot rot unseen)', () => {
        expect(TWINS.length).toBeGreaterThan(5)
        for (const t of TWINS) expect(FIXTURE_ROUTES.some((r) => r.id === t.id), t.id).toBe(true)
    })
})
