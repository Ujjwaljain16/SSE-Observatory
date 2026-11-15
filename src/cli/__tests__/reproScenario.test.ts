// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main, EXIT, type CliIo } from '../index'
import { parseCapture } from '../../core/capture/format'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'

// Issue #75: `repro <capture> --output min --scenario s.json` wrote the minimal capture AND built the scenario from it. A stall's minimal capture
// keeps no events, so the scenario collected one event and passed on the stalled stream it came from. The scenario is made from the ORIGINAL
// capture (its events, its response, its stall limit); only `--output` is the minimal capture. This is the CLI path, end to end, against the
// fixture server at the lab's scale.

const SCALE = 0.25
let fixtures: FixtureServer
beforeAll(async () => { fixtures = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await fixtures.close() })

/** An in-memory host: the files the CLI wrote are the files a later command reads. */
function host(env: Record<string, string> = {}) {
    const files: Record<string, string> = {}
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t }, env,
        readText: async (p) => { if (p in files) return files[p]!; throw new Error(`ENOENT ${p}`) },
        writeText: async (p, t) => { files[p] = t },
    }
    return { io, files, get out() { return out }, get err() { return err } }
}

/** Probe a fixture to a capture file, then `repro --scenario` it. The host keeps both files. */
async function probeAndRepro(id: string, query: Record<string, string | number>, duration: number) {
    const h = host()
    await main(['probe', fixtures.urlFor(id, { scale: SCALE, ...query }), '--duration', String(duration), '--out', 'c.sse-capture'], h.io)
    const code = await main(['repro', 'c.sse-capture', '--output', 'min.sse-capture', '--scenario', 's.json'], h.io)
    return { h, code, scenario: JSON.parse(h.files['s.json']!) }
}

/** `sse-doctor test s.json` against a fixture. */
async function testAgainst(h: ReturnType<typeof host>, id: string, query: Record<string, string | number> = {}) {
    const run = host({ STREAM_URL: fixtures.urlFor(id, { scale: SCALE, ...query }) })
    run.files['s.json'] = h.files['s.json']!
    const code = await main(['test', 's.json', '--format', 'json'], run.io)
    return { code, out: run.out, err: run.err }
}

describe('repro --scenario builds the scenario from the original capture', () => {
    it('f04-silent: the scenario fails on the stalled stream (the max silence check) and passes on the healthy twin h01', async () => {
        const { h, scenario } = await probeAndRepro('f04-silent', {}, 12)

        // the minimal capture is what --output writes: it has no events; the scenario is not made from it
        const minimal = parseCapture(h.files['min.sse-capture']!).capture
        expect(minimal.records.some((r) => r.kind === 'event')).toBe(false)
        // ... the scenario carries the original's 12 events, its response expectations and the stall limit
        expect(scenario.steps[0].collect_events).toBe(12)
        expect(scenario.expect.status).toBe(200)
        expect(scenario.expect.content_type).toBe('text/event-stream')
        expect(scenario.expect.max_silence_ms).toBe(1000)
        expect(scenario.meta.notes.join(' ')).not.toMatch(/no events/)

        const bad = await testAgainst(h, 'f04-silent')
        expect(bad.code, bad.out + bad.err).toBe(EXIT.gateFailed)
        const silence = JSON.parse(bad.out).scenarios[0].checks.find((c: { name: string }) => c.name === 'expect max silence')
        expect(silence?.status, bad.out).toBe('fail')

        const good = await testAgainst(h, 'h01', { n: 80 })
        expect(good.code, good.out + good.err).toBe(EXIT.ok)
    }, 90_000)

    it('a capture with no stall: the scenario carries no silence limit and still collects the original events', async () => {
        const { h, code, scenario } = await probeAndRepro('f11-drift', {}, 15)
        expect([EXIT.ok, EXIT.gateFailed]).toContain(code)
        expect(scenario.expect.max_silence_ms).toBeUndefined()
        const events = parseCapture(h.files['c.sse-capture']!).capture.records.filter((r) => r.kind === 'event').length
        const collected = scenario.steps.filter((s: { collect_events?: number }) => s.collect_events).reduce((n: number, s: { collect_events: number }) => n + s.collect_events, 0)
        expect(collected).toBe(events)
        // ... and not the minimal capture's (which has fewer): the scenario is not made from it
        expect(parseCapture(h.files['min.sse-capture']!).capture.records.filter((r) => r.kind === 'event').length).toBeLessThan(events)
    }, 90_000)

    it('a bad response: the scenario still expects the healthy one (200, text/event-stream), as the original capture said', async () => {
        const { h, scenario } = await probeAndRepro('f01-text-html', {}, 5)
        expect(scenario.expect.status).toBe(200)
        expect(scenario.expect.content_type).toBe('text/event-stream')
        expect(scenario.meta.notes.join(' ')).toMatch(/verify the fix, not to reproduce the broken response/)
        // and it does its job: it fails on the bad response, for that reason, and passes on the healthy twin
        const bad = await testAgainst(h, 'f01-text-html')
        expect(bad.code, bad.out + bad.err).toBe(EXIT.gateFailed)
        const names = JSON.parse(bad.out).scenarios[0].checks.filter((c: { status: string }) => c.status === 'fail').map((c: { name: string }) => c.name).join(' | ')
        expect(names).toMatch(/expect status|expect content type/)
        const good = await testAgainst(h, 'h01', { n: 80 })
        expect(good.code, good.out + good.err).toBe(EXIT.ok)
    }, 90_000)
})
