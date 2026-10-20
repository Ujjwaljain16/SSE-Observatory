import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createObservedStream } from '../../core/sse/observedStream'
import { createEngine } from '../../core/diagnostics/engine'
import { defaultRules } from '../../core/diagnostics/rules'
import { sequenceIntegrity } from '../../core/diagnostics/rules/r09SequenceIntegrity'
import { resumeLastEventId } from '../../core/diagnostics/rules/r08ResumeLastEventId'
import type { Finding } from '../../core/diagnostics/finding'
import type { Observation } from '../../core/observe/observation'
import { FIXTURE_ROUTES, startFixtureServer, type FixtureServer } from '../server'

let server: FixtureServer
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })

const RULES = [...defaultRules, sequenceIntegrity, resumeLastEventId]

/** The real client, with the payload probe configured from the route's declared profile, and the engine fed from the records. */
async function observe(id: string, query: Record<string, string | number> = {}, withContract = true) {
    const route = FIXTURE_ROUTES.find((r) => r.id === id)!
    const profile = withContract ? route.profile : {}
    const observations: Observation[] = []
    const engine = createEngine({ rules: RULES, ...(profile ? { profile } : {}), thresholds: { stallMinSilenceMs: 400, stallNoCadenceMs: 500 } })
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
    return { findings: engine.findings(), observations, events, coverage: engine.coverage() }
}

const keys = (findings: Finding[]) => findings.map((f) => f.key)

describe('F06: a resume that skips ids', () => {
    it('reports the skipped events once, as the resume rule, when the sequence is declared', async () => {
        const { findings, observations } = await observe('f06-skips')
        expect(observations.some((o) => o.kind === 'reconnect')).toBe(true)
        const skipped = findings.find((f) => f.key === 'resume.last-event-id:skipped')!
        expect(skipped.severity).toBe('error')
        expect(skipped.summary).toMatch(/5-7|5, 6, 7|4-6|numbers between/)
        expect(keys(findings)).not.toContain('seq.integrity:gap')
    })

    it('says nothing about loss when the sequence is not declared (opaque ids prove nothing)', async () => {
        const { findings, coverage } = await observe('f06-skips', {}, false)
        expect(keys(findings).filter((k) => k.startsWith('seq.') || k.includes(':skipped'))).toEqual([])
        expect(coverage.find((c) => c.ruleId === 'seq.integrity')!.notes.join(' ')).toMatch(/not verified/)
    })

    it('stays silent for the twin that resumes correctly', async () => {
        const { findings, observations } = await observe('f06-resumes')
        expect(observations.some((o) => o.kind === 'reconnect')).toBe(true)
        expect(findings.map((f) => `${f.key}: ${f.summary}`)).toEqual([])
    })
})

describe('F07: a flood of tiny events', () => {
    it('raises no network or sequence finding while thousands of events arrive', async () => {
        const { findings, events } = await observe('f07-flood')
        expect(events).toBeGreaterThanOrEqual(2000)
        expect(findings.map((f) => `${f.key}: ${f.summary}`)).toEqual([])
    })
})
