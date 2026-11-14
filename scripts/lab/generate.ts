/**
 * Records every built-in fixture once and writes the captures the app's failure lab shows (public/lab). Run with `npm run lab:build`.
 *
 * A capture is only kept when the Doctor, with its DEFAULT thresholds (the ones the app runs with) and the route's own profile, reports
 * what the route says it must and nothing it says it must not. A fixture that cannot meet that on a plain run (it needs page-side
 * samples, proxy tags, or a request detail) is listed under "skipped" with the reason, never shown as if it worked.
 */
import { setMaxListeners } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { createObservedStream } from '../../src/core/sse/observedStream'
import { analyze } from '../../src/core/diagnostics/engine'
import { localCapture } from '../../src/core/capture/build'
import { serializeCapture } from '../../src/core/capture/format'
import { redactCapture } from '../../src/core/capture/redact'
import { probeConfigOf } from '../../src/core/diagnostics/profile'
import type { StreamProfile } from '../../src/core/diagnostics/thresholds'
import type { Observation } from '../../src/core/observe/observation'
import { startFixtureServer, FIXTURE_ROUTES } from '../../src/fixtures/server'
import { checkExpectations } from '../../src/doctor/labCheck'

// the fixture server's sleep helper adds an abort listener per wait; a long flood of events trips the default warning limit
setMaxListeners(0)

const outDir = process.argv[2] ?? 'public/lab'
/** A capture over this size is not shipped: the lab is a set of static files fetched on demand. */
const MAX_BYTES = 40 * 1024
/** Tried in this order: a fast run first, then real time for the detectors that judge gaps of a second or more. */
const SCALES = (process.env['LAB_SCALES'] ?? '0.25,1').split(',').map(Number)
const only = process.env['LAB_ONLY']?.split(',')

interface Entry { id: string; family: string; title: string; description: string; expected: string[]; forbidden: string[]; healthyTwin: string | null; file: string; events: number; seconds: number; scale: number }
interface Skipped { id: string; family: string; title: string; reason: string }

async function record(url: string, scale: number, profile: StreamProfile | undefined): Promise<{ records: Observation[]; events: number; answered: boolean; ended: boolean }> {
    const records: Observation[] = []
    let events = 0
    let answered = false
    let lastEventAt = Date.now()
    let finish!: (why: string) => void
    const done = new Promise<string>((resolve) => { finish = resolve })
    const stream = createObservedStream({
        request: () => ({ url }),
        sinks: { onMessage: () => { events++; lastEventAt = Date.now() }, onPhase: (p) => { if (p === 'ended' || p === 'failed') finish(p) } },
        recording: { ...(profile ? { profile: probeConfigOf(profile) } : {}), onObservations: (batch) => { for (const o of batch) { records.push(o); if (o.kind === 'response') answered = true } }, flushMs: 10 },
        clientOptions: { initialDelayMs: 20, maxDelayMs: 80, jitter: 0, maxRetries: 3 },
    })
    stream.start()
    // A stream that stays open (even one that keeps sending heartbeats) ends when no EVENT has come for long enough for a silence to be judged, or after a hard limit.
    const quietMs = Math.max(3000, 12_000 * scale)
    const quiet = setInterval(() => { if (Date.now() - lastEventAt > quietMs) finish('quiet') }, 100)
    const hard = setTimeout(() => finish('limit'), 30_000)
    const why = await done
    clearInterval(quiet); clearTimeout(hard)
    stream.flushObservations()
    stream.stop()
    return { records, events, answered, ended: why === 'ended' }
}

const server = await startFixtureServer({ port: 0 })
fs.mkdirSync(outDir, { recursive: true })
const entries: Entry[] = []
const skipped: Skipped[] = []

for (const route of FIXTURE_ROUTES) {
    if (only && !only.includes(route.id)) continue
    let reason = ''
    let kept = false
    for (const scale of SCALES) {
        const t0 = Date.now()
        try {
            const { records, events, answered } = await record(server.urlFor(route.id, { scale }), scale, route.profile)
            const endT = records.at(-1)?.t ?? 0
            // After a stream that stays open has gone quiet, the recording ends a little later than its last record: that silence is part of it.
            const silenceAfter = route.id.startsWith('f04') ? Math.max(6000, 12_000 * scale) : 0
            const analysis = analyze(records as never, { ...(route.profile ? { profile: route.profile } : {}), endT: endT + silenceAfter })
            const check = checkExpectations(analysis.findings.map((f) => f.key), route.expectedFindings, route.forbiddenFindings)
            if (!answered) reason = 'the server never answered a plain request (it needs a detail the lab does not send)'
            else if (!check.ok) reason = `under the default thresholds it did not meet its own expectations: ${check.problems.join('; ')}`
            else {
                const capture = localCapture(records, {
                    source: { kind: 'fixture', client: 'node-undici' },
                    request: { url: `https://lab.example/${route.id}`, method: 'GET' },
                    ...(route.profile ? { profile: route.profile } : {}),
                    endReason: 'stopped',
                })
                capture.footer = { ...(capture.footer ?? { endReason: 'stopped', counts: {} }), endT: endT + silenceAfter }
                const file = `${route.id}.sse-capture`
                const text = serializeCapture(redactCapture(capture).capture)
                if (text.length > MAX_BYTES) { reason = `the capture is ${(text.length / 1024).toFixed(0)} KB, over the ${MAX_BYTES / 1024} KB a static lab ships`; break }
                fs.writeFileSync(path.join(outDir, file), text)
                entries.push({ id: route.id, family: route.family, title: route.title, description: route.description, expected: route.expectedFindings, forbidden: route.forbiddenFindings, healthyTwin: route.healthyTwin, file, events, seconds: Math.round((endT + silenceAfter) / 100) / 10, scale })
                console.log(`ok      ${route.id.padEnd(22)} scale ${scale}: ${events} events, ${((endT + silenceAfter) / 1000).toFixed(1)} s recorded, ${((Date.now() - t0) / 1000).toFixed(1)} s to make`)
                kept = true
                break
            }
        } catch (error) {
            reason = `it could not be recorded: ${error instanceof Error ? error.message : String(error)}`
        }
    }
    if (!kept) {
        skipped.push({ id: route.id, family: route.family, title: route.title, reason })
        console.log(`skipped ${route.id.padEnd(22)} ${reason}`)
    }
}
await server.close()

const keepTwins = new Set(entries.map((e) => e.id))
for (const e of entries) if (e.healthyTwin && !keepTwins.has(e.healthyTwin)) e.healthyTwin = null // a twin that is not in the lab cannot be opened from it
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ schemaVersion: 1, entries, skipped }, null, 2) + '\n')
console.log(`\n${entries.length} in the lab, ${skipped.length} skipped -> ${outDir}`)
