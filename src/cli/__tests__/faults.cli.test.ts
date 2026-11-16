// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { main, EXIT, type CliIo } from '../index'
import { startFixtureServer, type FixtureServer } from '../../fixtures/server'
import { startFaultProxy, type FaultPlan, type FaultProxy } from '../../fixtures/faultProxy'
import { h01Offset } from '../../fixtures/__tests__/faultHarness'

// `sse-doctor probe` through the TCP fault proxy (src/fixtures/faultProxy.ts): the command line's own options and exit codes under real network
// faults, with its default thresholds (no scaled-down limits). Every fault has a no-fault control. What these pin about hangs: the client has no read
// timeout of its own, so a probe is bounded ONLY by --duration (default 30 s), --idle-timeout (default off) and --timeout (default off, covers only
// "no response at all").

let server: FixtureServer
const proxies: FaultProxy[] = []
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })
afterEach(async () => { await Promise.all(proxies.splice(0).map((p) => p.close())) })

async function through(plan: FaultPlan | ((index: number, request: string) => FaultPlan), path: string): Promise<{ url: string; proxy: FaultProxy }> {
    const proxy = await startFaultProxy({ target: { port: server.port }, plan })
    proxies.push(proxy)
    return { url: proxy.through(`${server.url}${path}`), proxy }
}

interface Probe { code: number; keys: string[]; findings: Array<{ key: string; severity: string; status: string }>; notes: string[]; out: string; err: string; ms: number }

async function probe(url: string, flags: string[]): Promise<Probe> {
    let out = ''
    let err = ''
    const io: CliIo = { out: (t) => { out += t }, err: (t) => { err += t }, env: {}, readText: async () => { throw new Error('ENOENT') }, writeText: async () => {} }
    const t0 = Date.now()
    const code = await main(['probe', url, '--format', 'json', ...flags], io)
    const ms = Date.now() - t0
    const json = JSON.parse(out) as { findings: Probe['findings']; notes: string[] }
    return { code, keys: json.findings.map((f) => f.key), findings: json.findings, notes: json.notes, out, err, ms }
}

// 14 events 20 ms apart: enough of a rhythm (10 gaps) for the Doctor to judge a silence by the stream's own cadence, under the DEFAULT thresholds.
const FAST_STREAM = '/h01?scale=0.02&n=14'
const direct = () => probe(`${server.url}${FAST_STREAM}`, ['--duration', '10'])

describe('probe through a fault proxy: benign faults', () => {
    it('control and re-chunked into single bytes: the same events, no finding, exit 0', async () => {
        const base = await direct()
        expect(base.code).toBe(EXIT.ok)
        expect(base.keys).toEqual([])
        const { url, proxy } = await through({ chunking: { bytes: 1 }, headersIntact: true }, FAST_STREAM)
        const r = await probe(url, ['--duration', '10'])
        expect(r.code).toBe(EXIT.ok)
        expect(r.keys).toEqual([])
        expect(r.notes[0]).toBe(base.notes[0]!.replace(/ for [\d.]+ s/, ` for ${/ for ([\d.]+ s)/.exec(r.notes[0]!)![1]}`))
        expect(proxy.responses[0]!.writes.slice(1).every((n) => n === 1)).toBe(true)
    }, 40_000)

    it('a reset in the middle of an event: the probe resumes, delivers every event, and says the event was cut (a warning does not fail the gate)', async () => {
        const base = await direct()
        const { url } = await through((i) => (i === 0 ? { fault: { kind: 'rst', at: { payloadBytes: h01Offset(5, 12) } } } : {}), FAST_STREAM)
        const r = await probe(url, ['--duration', '10'])
        expect(/Observed (\d+) events/.exec(r.notes[0]!)![1]).toBe(/Observed (\d+) events/.exec(base.notes[0]!)![1])
        expect(r.keys).toEqual(['proto.framing:UNTERMINATED_FRAME'])
        expect(r.code).toBe(EXIT.ok)
    }, 40_000)
})

describe('probe through a fault proxy: a stream that stops without closing', () => {
    it('a blackhole after event 12: with --duration the probe stops on time, reports stall.silent as an error, and fails the gate', async () => {
        const { url } = await through({ fault: { kind: 'blackhole', at: { payloadBytes: h01Offset(12) } } }, FAST_STREAM)
        const r = await probe(url, ['--duration', '3'])
        expect(r.notes[0]).toMatch(/Observed 12 events .*\(stopped: duration\)/)
        expect(r.keys).toEqual(['stall.silent:bytes'])
        expect(r.findings[0]!.severity).toBe('error')
        expect(r.code).toBe(EXIT.gateFailed)
        expect(r.ms, 'bounded by --duration, not by the stream').toBeLessThan(10_000)
    }, 40_000)

    it('--idle-timeout ends the probe early and says why; without it only --duration bounds it', async () => {
        const { url } = await through({ fault: { kind: 'blackhole', at: { payloadBytes: h01Offset(12) } } }, FAST_STREAM)
        const r = await probe(url, ['--duration', '20', '--idle-timeout', '1.5'])
        expect(r.notes[0]).toMatch(/\(stopped: idle\)/)
        expect(r.ms).toBeLessThan(10_000)
        expect(r.keys).toEqual(['stall.silent:bytes'])
        expect(r.code).toBe(EXIT.gateFailed)
    }, 40_000)

    it('control: the same stream, no blackhole, ends by itself with no finding', async () => {
        const { url } = await through({}, FAST_STREAM)
        const r = await probe(url, ['--duration', '10', '--idle-timeout', '1.5'])
        expect(r.notes[0]).toMatch(/\(stopped: ended\)/)
        expect(r.keys).toEqual([])
    }, 40_000)

    it('the headers never come: --timeout ends the probe, "the server never answered", exit 3 (could not run)', async () => {
        const { url } = await through({ fault: { kind: 'blackhole', at: { wireBytes: 0 } } }, FAST_STREAM)
        const r = await probe(url, ['--duration', '20', '--timeout', '1'])
        expect(r.notes.join(' ')).toContain('The server never answered')
        expect(r.notes[0]).toMatch(/\(stopped: timeout\)/)
        expect(r.code).toBe(EXIT.couldNotRun)
        expect(r.ms).toBeLessThan(10_000)
    }, 40_000)

    it('the headers never come and no --timeout is given: the probe waits out --duration and still ends (exit 3); nothing else bounds it', async () => {
        const { url } = await through({ fault: { kind: 'blackhole', at: { wireBytes: 0 } } }, FAST_STREAM)
        const r = await probe(url, ['--duration', '2'])
        expect(r.notes[0]).toMatch(/\(stopped: duration\)/)
        expect(r.code).toBe(EXIT.couldNotRun)
        expect(r.ms).toBeGreaterThanOrEqual(1800)
        expect(r.ms).toBeLessThan(10_000)
    }, 40_000)

    it('slow loris, the headers and then nothing: under the default limits, after 4 s the Doctor names the missing first byte', async () => {
        const { url } = await through({ fault: { kind: 'blackhole', at: { payloadBytes: 0 } } }, FAST_STREAM)
        const r = await probe(url, ['--duration', '4.5', '--timeout', '1'])
        expect(r.notes[0]).toMatch(/\(stopped: duration\)/)
        expect(r.keys).toContain('timing.first-event:first-byte')
        expect(r.keys).not.toContain('timing.first-event:headers')
    }, 40_000)
})

describe('probe through a fault proxy: refused after the first success', () => {
    it('the port refuses after the first connection ends: the probe gives up after its retries (stopped: failed) and reports reconnect.loop as a WARNING, and exits 0 (pinned, see the comment)', async () => {
        const { url, proxy } = await through((i) => (i === 0 ? { thenRefuse: true } : {}), '/f05/drops?scale=0.02&per=3&n=12')
        const r = await probe(url, ['--duration', '10'])
        expect(r.notes[0]).toMatch(/Observed 3 events .*\(stopped: failed\)/)
        expect(r.keys).toEqual(['reconnect.loop'])
        expect(r.findings[0]!.severity).toBe('warning')
        // PINNED, and questionable: the probe's client has given up on a refusing port, and the run still passes the gate, because the only finding is a warning (the 3 events
        // of the first connection count as progress for R07, and 3 reconnects in a row is under the 5 that make it an error). The rule that turns 'failed with no finding' into exit 3
        // does not apply (there is a finding). Whether a probe that ends 'failed' should ever exit 0 is a decision for the owner; this test fails the day it changes.
        expect(r.code).toBe(EXIT.ok)
        expect(proxy.connections, 'only the first attempt ever reached the proxy').toBe(1)
        const loop = (JSON.parse(r.out) as { findings: Array<{ facts: Array<{ text: string }> }> }).findings[0]!
        expect(loop.facts[0]!.text).toMatch(/connection attempts were made .* 1 was answered/)
    }, 40_000)

    it('control: a stream that ends itself after a drop and a correct resume, through a proxy that never refuses, exits 0 with no finding', async () => {
        const { url } = await through({}, '/f05/resumes?scale=0.02&n=6')
        const r = await probe(url, ['--duration', '10'])
        expect(r.keys).toEqual([])
        expect(r.code).toBe(EXIT.ok)
    }, 40_000)
})
