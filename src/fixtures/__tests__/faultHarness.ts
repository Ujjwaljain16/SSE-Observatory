import { createObservedStream } from '../../core/sse/observedStream'
import { createEngine } from '../../core/diagnostics/engine'
import { defaultRules } from '../../core/diagnostics/rules'
import { analyze } from '../../core/diagnostics/engine'
import type { Finding } from '../../core/diagnostics/finding'
import type { StreamProfile, Thresholds } from '../../core/diagnostics/thresholds'
import type { Observation } from '../../core/observe/observation'
import type { SSEPhase, SSEPhaseInfo } from '../../core/sse/sseClient'
import type { FaultPlan } from '../faultProxy'
import { startFaultProxy, type FaultProxy } from '../faultProxy'
import { frame, numericId } from '../kit'
import type { FixtureServer } from '../server'

/** The two limits the fixture tests use: delays are scaled down 20x, so a 1 s floor on a stall becomes 400 ms. */
export const FAST: Partial<Thresholds> = { stallMinSilenceMs: 400, stallNoCadenceMs: 500 }

export interface Window {
    observations: Observation[]
    findings: Finding[]
    /** The same records analysed in one go afterwards (what a replay of the capture would say). */
    batchFindings: Finding[]
    messages: Array<{ id: string; event: string; data: string }>
    phases: Array<{ phase: SSEPhase; info: SSEPhaseInfo; at: number }>
    /** `ended` / `failed`: the client stopped by itself. `window`: the time was up and the client was still running. `until`: the predicate was met. */
    stoppedBy: 'ended' | 'failed' | 'window' | 'until'
    /** Milliseconds, as the recorder's clock saw them. */
    endT: number
    stats: { lastPhase: SSEPhase | undefined }
}

export interface WindowOptions {
    windowMs: number
    thresholds?: Partial<Thresholds>
    profile?: StreamProfile
    maxRetries?: number
    captureBytes?: boolean
    until?: (w: { observations: Observation[]; messages: number; phases: SSEPhase[] }) => boolean
}

/**
 * The real client and recorder, with the engine fed live and ticked every 40 ms (so a silence is judged while it lasts, as the app does), for at
 * most `windowMs`. Unlike `observeUrl`, running out of time is a result, not an error: a stream that never ends (a blackhole) is the point.
 */
export async function observeWindow(url: string, options: WindowOptions): Promise<Window> {
    const observations: Observation[] = []
    const messages: Window['messages'] = []
    const phases: Window['phases'] = []
    const thresholds = options.thresholds ?? FAST
    const engine = createEngine({ rules: defaultRules, thresholds, ...(options.profile ? { profile: options.profile } : {}) })
    let stoppedBy: Window['stoppedBy'] = 'window'
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const check = () => { if (options.until?.({ observations, messages: messages.length, phases: phases.map((p) => p.phase) })) { stoppedBy = 'until'; finish() } }
    const stream = createObservedStream({
        request: () => ({ url }),
        sinks: {
            onMessage: (m) => { messages.push({ id: m.id, event: m.event, data: m.data }); check() },
            onPhase: (phase, info) => { phases.push({ phase, info, at: Date.now() }); if (phase === 'ended' || phase === 'failed') { stoppedBy = phase; finish() } else check() },
        },
        recording: {
            ...(options.profile?.sequence ? { profile: { sequence: { useSseId: options.profile.sequence.useSseId, field: options.profile.sequence.field } } } : {}),
            ...(options.captureBytes ? { captureBytes: true } : {}),
            onObservations: (batch) => { for (const o of batch) { observations.push(o); engine.feed(o) } check() },
            flushMs: 10,
        },
        clientOptions: { initialDelayMs: 5, maxDelayMs: 20, jitter: 0, maxRetries: options.maxRetries ?? 3 },
    })
    stream.start()
    const ticker = setInterval(() => { stream.flushObservations(); engine.tick(stream.recorder!.elapsed()) }, 40)
    const timer = setTimeout(finish, options.windowMs)
    await done
    clearTimeout(timer)
    clearInterval(ticker)
    stream.flushObservations()
    const endT = stream.recorder!.elapsed()
    stream.stop()
    stream.flushObservations()
    engine.tick(endT)
    engine.end(endT)
    return { observations, findings: engine.findings(), batchFindings: analyze(observations, { rules: defaultRules, thresholds, endT, ...(options.profile ? { profile: options.profile } : {}) }).findings, messages, phases, stoppedBy, endT, stats: { lastPhase: phases.at(-1)?.phase } }
}

/** The events the client was given, as a comparable list. */
export const eventsOf = (w: Pick<Window, 'messages'>) => w.messages.map((m) => `${m.event}#${m.id}:${m.data}`)

export const keysOf = (findings: Finding[]) => findings.map((f) => f.key)

/** A proxy to `server` with one plan for every response, that the caller closes. */
export function proxyTo(server: FixtureServer, plan: FaultPlan | ((index: number, request: string) => FaultPlan)): Promise<FaultProxy> {
    return startFaultProxy({ target: { port: server.port }, plan })
}

/**
 * The payload offset right after the first `events` complete events of h01 (`id`, `event: tick`, `data`, blank line), plus `extra` bytes into the next
 * one. h01 is deterministic, so a fault can be placed "in the middle of event 4" by arithmetic, not by guessing.
 */
export function h01Offset(events: number, extra = 0): number {
    let bytes = 0
    for (let i = 0; i < events; i++) bytes += Buffer.byteLength(frame(numericId(i), 'tick', JSON.stringify({ n: i + 1 })))
    return bytes + extra
}

/** Do all the pieces of evidence of a finding point at records that exist, at the time the finding says? */
export function evidenceProblems(finding: Finding, observations: Observation[]): string[] {
    const problems: string[] = []
    const bySeq = new Map(observations.map((o) => [o.seq, o]))
    for (const fact of finding.facts) {
        for (const e of fact.evidence) {
            const record = bySeq.get(e.seq)
            if (!record) problems.push(`${finding.key}: evidence seq ${e.seq} is not a record`)
            else if (Math.abs(record.t - e.t) > 0.001) problems.push(`${finding.key}: evidence seq ${e.seq} says t=${e.t}, the record's t=${record.t}`)
        }
    }
    return problems
}
