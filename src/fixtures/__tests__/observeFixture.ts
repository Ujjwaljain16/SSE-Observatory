import { createObservedStream } from '../../core/sse/observedStream'
import { createEngine } from '../../core/diagnostics/engine'
import type { Rule } from '../../core/diagnostics/rule'
import type { StreamProfile, Thresholds } from '../../core/diagnostics/thresholds'
import { localCapture } from '../../core/capture/build'
import type { Capture } from '../../core/capture/format'
import type { Observation } from '../../core/observe/observation'
import { FIXTURE_ROUTES, type FixtureServer } from '../server'

export interface ObserveOptions {
    /** Keep the wire bytes, so the capture can be replayed byte for byte. */
    captureBytes?: boolean
    /**
     * CONSECUTIVE failed attempts before the client gives up (a stream that closes without an end event is reconnected). Default 3. The count starts
     * again each time a connection opens, so a server that accepts every connection and then closes it is never given up on: that loop is bounded
     * with `stopAfterConnections`, not with this.
     */
    maxRetries?: number
    /** Stop the client as soon as this many connections have ended and it is about to reconnect: the run is bounded by a count, and every connection it saw was ended by the server. */
    stopAfterConnections?: number
    /** Give up waiting after this long (default 15 000 ms): the run rejects, and the client is stopped either way. */
    timeoutMs?: number
    /** Thresholds for the engine. Default: the two hand-picked limits the older fixture tests use (a 400 ms floor and a 500 ms no-cadence limit). A test run at a time scale passes `defaultsAt(scale)`. */
    thresholds?: Partial<Thresholds>
}

/**
 * The real client with the payload probe set from the stream profile, and the engine fed from the records, against
 * any URL. Resolves when the stream ends or fails.
 */
export async function observeUrl(url: string, rules: Rule[], profile: StreamProfile | undefined, options: ObserveOptions = {}) {
    const observations: Observation[] = []
    const engine = createEngine({ rules, ...(profile ? { profile } : {}), thresholds: options.thresholds ?? { stallMinSilenceMs: 400, stallNoCadenceMs: 500 } })
    let finished!: () => void
    const done = new Promise<void>((resolve) => { finished = resolve })
    let events = 0
    let reconnecting = 0
    const messages: Array<{ id: string; event: string; dataBytes: number }> = []
    const stream = createObservedStream({
        request: () => ({ url }),
        sinks: { onMessage: (m) => { events++; messages.push({ id: m.id, event: m.event, dataBytes: new TextEncoder().encode(m.data).length }) }, onPhase: (p) => {
            if (p === 'ended' || p === 'failed') finished()
            if (p === 'reconnecting' && options.stopAfterConnections !== undefined && ++reconnecting >= options.stopAfterConnections) { stream.stop(); finished() }
        } },
        recording: {
            profile: { ...(profile?.sequence ? { sequence: { useSseId: profile.sequence.useSseId, field: profile.sequence.field } } : {}) },
            ...(options.captureBytes ? { captureBytes: true } : {}),
            onObservations: (batch) => { for (const o of batch) { observations.push(o); engine.feed(o) } },
            flushMs: 10,
        },
        clientOptions: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0, maxRetries: options.maxRetries ?? 3 },
    })
    stream.start()
    const timeoutMs = options.timeoutMs ?? 15_000
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms; saw ${observations.length} records`)), timeoutMs) })])
    } finally {
        clearTimeout(timer)
        stream.stop() // a run that timed out must not leave the client reconnecting
    }
    stream.flushObservations()
    const endT = observations.at(-1)?.t ?? 0
    engine.tick(endT)
    engine.end(endT)
    const capture: Capture = localCapture(observations, { source: { kind: 'fixture', client: 'node-undici' }, ...(profile ? { profile } : {}) })
    return { findings: engine.findings(), observations, events, messages, coverage: engine.coverage(), capture }
}

/** `observeUrl` for a route of the fixture server, with delays scaled down (default 0.05) and the route's own profile. */
export function observeFixture(server: FixtureServer, rules: Rule[], id: string, query: Record<string, string | number> = {}, withContract = true, options: ObserveOptions = {}) {
    const route = FIXTURE_ROUTES.find((r) => r.id === id)!
    return observeUrl(server.urlFor(id, { scale: 0.05, ...query }), rules, withContract ? route.profile : {}, options)
}
