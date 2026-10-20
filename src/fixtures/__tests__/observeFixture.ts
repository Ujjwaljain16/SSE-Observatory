import { createObservedStream } from '../../core/sse/observedStream'
import { createEngine } from '../../core/diagnostics/engine'
import type { Rule } from '../../core/diagnostics/rule'
import { newHeader, type Capture } from '../../core/capture/format'
import type { Observation } from '../../core/observe/observation'
import { FIXTURE_ROUTES, type FixtureServer } from '../server'

/**
 * The real client with the payload probe set from the route's declared profile, and the engine fed from the records,
 * against a fixture server. Delays are scaled down (default 0.05).
 */
export async function observeFixture(server: FixtureServer, rules: Rule[], id: string, query: Record<string, string | number> = {}, withContract = true) {
    const route = FIXTURE_ROUTES.find((r) => r.id === id)!
    const profile = withContract ? route.profile : {}
    const observations: Observation[] = []
    const engine = createEngine({ rules, ...(profile ? { profile } : {}), thresholds: { stallMinSilenceMs: 400, stallNoCadenceMs: 500 } })
    let finished!: () => void
    const done = new Promise<void>((resolve) => { finished = resolve })
    let events = 0
    const stream = createObservedStream({
        request: () => ({ url: server.urlFor(id, { scale: 0.05, ...query }) }),
        sinks: { onMessage: () => { events++ }, onPhase: (p) => { if (p === 'ended' || p === 'failed') finished() } },
        recording: {
            profile: { ...(profile?.sequence ? { sequence: { useSseId: profile.sequence.useSseId, field: profile.sequence.field } } : {}) },
            onObservations: (batch) => { for (const o of batch) { observations.push(o); engine.feed(o) } },
            flushMs: 10,
        },
        clientOptions: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0, maxRetries: 3 },
    })
    stream.start()
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out; saw ${observations.length} records`)), 15_000))])
    stream.flushObservations()
    stream.stop()
    const endT = observations.at(-1)?.t ?? 0
    engine.tick(endT)
    engine.end(endT)
    const capture: Capture = { header: newHeader({ kind: 'local-full', source: { kind: 'fixture', client: 'node-undici' } }), records: observations }
    return { findings: engine.findings(), observations, events, coverage: engine.coverage(), capture }
}
