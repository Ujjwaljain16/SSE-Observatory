import { createObservedStream } from '../../core/sse/observedStream'
import { createEngine } from '../../core/diagnostics/engine'
import type { Rule } from '../../core/diagnostics/rule'
import type { StreamProfile } from '../../core/diagnostics/thresholds'
import { localCapture } from '../../core/capture/build'
import type { Capture } from '../../core/capture/format'
import type { Observation } from '../../core/observe/observation'
import { FIXTURE_ROUTES, type FixtureServer } from '../server'

export interface ObserveOptions {
    /** Keep the wire bytes, so the capture can be replayed byte for byte. */
    captureBytes?: boolean
    /** Extra headers on every request, for example a Last-Event-ID the client would not send itself. */
    maxRetries?: number
}

/**
 * The real client with the payload probe set from the stream profile, and the engine fed from the records, against
 * any URL. Resolves when the stream ends or fails.
 */
export async function observeUrl(url: string, rules: Rule[], profile: StreamProfile | undefined, options: ObserveOptions = {}) {
    const observations: Observation[] = []
    const engine = createEngine({ rules, ...(profile ? { profile } : {}), thresholds: { stallMinSilenceMs: 400, stallNoCadenceMs: 500 } })
    let finished!: () => void
    const done = new Promise<void>((resolve) => { finished = resolve })
    let events = 0
    const stream = createObservedStream({
        request: () => ({ url }),
        sinks: { onMessage: () => { events++ }, onPhase: (p) => { if (p === 'ended' || p === 'failed') finished() } },
        recording: {
            profile: { ...(profile?.sequence ? { sequence: { useSseId: profile.sequence.useSseId, field: profile.sequence.field } } : {}) },
            ...(options.captureBytes ? { captureBytes: true } : {}),
            onObservations: (batch) => { for (const o of batch) { observations.push(o); engine.feed(o) } },
            flushMs: 10,
        },
        clientOptions: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0, maxRetries: options.maxRetries ?? 3 },
    })
    stream.start()
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out; saw ${observations.length} records`)), 15_000))])
    stream.flushObservations()
    stream.stop()
    const endT = observations.at(-1)?.t ?? 0
    engine.tick(endT)
    engine.end(endT)
    const capture: Capture = localCapture(observations, { source: { kind: 'fixture', client: 'node-undici' }, ...(profile ? { profile } : {}) })
    return { findings: engine.findings(), observations, events, coverage: engine.coverage(), capture }
}

/** `observeUrl` for a route of the fixture server, with delays scaled down (default 0.05) and the route's own profile. */
export function observeFixture(server: FixtureServer, rules: Rule[], id: string, query: Record<string, string | number> = {}, withContract = true, options: ObserveOptions = {}) {
    const route = FIXTURE_ROUTES.find((r) => r.id === id)!
    return observeUrl(server.urlFor(id, { scale: 0.05, ...query }), rules, withContract ? route.profile : {}, options)
}
