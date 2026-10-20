import { describe, it, expect } from 'vitest'
import { analyze } from '../../engine'
import { capture, type CaptureBuilder } from '../../../testing/captureBuilder'
import { proxyMasking } from '../r13ProxyMasking'
import { find, keys, run, sameLiveAndBatch, withRule } from './helpers'

const MASK = 'proxy.masking'
const MISMATCH = 'proxy.upstream-mismatch'

const proxied = (headers: Record<string, string | undefined> = {}) => capture().connect().response({ headers: { 'x-sse-proxy': 'observatory/1', 'x-sse-upstream-status': '200', 'x-sse-upstream-content-type': 'text/event-stream', ...headers } })
const hb = (b: CaptureBuilder, upIdle: number, n: number) => b.beat('proxy', `sse-proxy hb up_idle=${upIdle} n=${n}`)

/** `count` events one second apart, each followed by a proxy heartbeat that reports little idle time. */
function lively(b: CaptureBuilder, count: number): CaptureBuilder {
    for (let i = 0; i < count; i++) { b.silence(1000).frame('tick', String(i + 1)); hb(b, 200, i + 1) }
    return b
}

/** Then the origin goes quiet: proxy heartbeats go on every second and the reported idle time grows. */
function masked(b: CaptureBuilder, beats: number, from = 1200): CaptureBuilder {
    for (let k = 0; k < beats; k++) { b.silence(1000); hb(b, from + k * 1000, 100 + k) }
    return b
}

describe('R13 proxy.masking', () => {
    it('warns once up_idle passes the stream\'s own stall threshold and errors beyond five times its rhythm', () => {
        // twelve events one second apart: p95 gap 1 s, so a warning above 3 s and an error above 5 s
        const warning = find(run(masked(lively(proxied(), 12), 4), proxyMasking).findings, MASK)!
        expect(warning.severity).toBe('warning')
        expect(warning.facts[0]!.text).toMatch(/proxy heartbeats kept arriving while the proxy-reported idle time of the upstream grew from/)
        expect(warning.facts.some((x) => /stall threshold was 3 s, set from the stream's own rhythm \(an error above 5 s\)/.test(x.text))).toBe(true)
        expect(warning.deductions[0]!.statement).toMatch(/^Likely: the upstream/)

        const error = find(run(masked(lively(proxied(), 12), 8), proxyMasking).findings, MASK)!
        expect(error.severity).toBe('error')
        expect(error.summary).toMatch(/upstream has been silent for 8\.2 s/)
    })

    it('without a measured rhythm one threshold applies (the default 30 s) and passing it is an error', () => {
        const below = run(masked(proxied(), 20, 1000), proxyMasking)
        expect(keys(below.findings)).not.toContain(MASK)
        const above = find(run(masked(proxied(), 35, 1000), proxyMasking).findings, MASK)!
        expect(above.severity).toBe('error')
        expect(above.facts.some((x) => /the default, as the stream has no measured rhythm/.test(x.text))).toBe(true)
    })

    it('follows the stream profile\'s longest silence when it has one', () => {
        const f = find(run(masked(proxied(), 8, 1000), proxyMasking, { profile: { expected: { maxSilenceMs: 5000 } } }).findings, MASK)!
        expect(f.severity).toBe('error')
        expect(f.facts.some((x) => /longest silence the stream profile allows/.test(x.text))).toBe(true)
    })

    it('resolves when the upstream speaks again, and counts each episode', () => {
        const b = masked(lively(proxied(), 12), 6)
        b.silence(1000).frame('tick', 'resumed')
        hb(b, 100, 200)
        const f = find(run(b, proxyMasking).findings, MASK)!
        expect(f.status).toBe('resolved')
        expect(f.occurrences).toBe(1)
    })

    it('is silent for a healthy stream behind the proxy, the twin of the masked one', () => {
        const a = run(lively(proxied(), 20), proxyMasking)
        expect(a.findings).toEqual([])
        expect(a.coverage.find((c) => c.ruleId === MASK)!.status).toBe('evaluated')
    })

    it('is silent for a sparse stream whose idle time stays under the threshold', () => {
        const b = proxied()
        for (let round = 0; round < 3; round++) {
            for (let k = 1; k <= 4; k++) { b.silence(5000); hb(b, k * 5000, round * 4 + k) }
            b.silence(5000).frame('tick', String(round))
        }
        // (the slow start is R04's business; this rule has nothing to say)
        expect(run(b, proxyMasking).findings.filter((f) => f.key.startsWith('proxy.'))).toEqual([])
    })
})

describe('R13 proxy.upstream-mismatch', () => {
    it('exposes a broken origin that the proxy delivers as an event stream', () => {
        const b = proxied({ 'x-sse-upstream-status': '502', 'x-sse-upstream-content-type': 'text/html' })
        const f = find(run(b, proxyMasking).findings, MISMATCH)!
        expect(f.severity).toBe('error')
        expect(f.facts).toHaveLength(2)
        expect(f.facts[0]!.text).toBe('The proxy reported that the upstream answered HTTP 502, but the client received HTTP 200.')
        expect(f.facts[1]!.text).toMatch(/upstream sent Content-Type text\/html, but the client received text\/event-stream/)
        expect(f.facts[0]!.evidence.length).toBeGreaterThan(0)
        expect(f.deductions[0]!.statement).toMatch(/^Likely: the origin is not serving a valid event stream/)
    })

    it('flags a content-type difference alone', () => {
        const f = find(run(proxied({ 'x-sse-upstream-content-type': 'application/json' }), proxyMasking).findings, MISMATCH)!
        expect(f.facts).toHaveLength(1)
        expect(f.severity).toBe('error')
    })

    it('is silent when the origin and the client saw the same thing, parameters aside', () => {
        const a = run(lively(proxied({ 'x-sse-upstream-content-type': 'text/event-stream; charset=utf-8' }), 5), proxyMasking)
        expect(keys(a.findings)).not.toContain(MISMATCH)
    })

    it('reads the headers whatever their case', () => {
        const b = capture().connect().response({ headers: { 'X-SSE-Upstream-Status': '404', 'x-sse-proxy': 'observatory/1' } })
        expect(keys(run(b, proxyMasking).findings)).toContain(MISMATCH)
    })
})

describe('R13 coverage and determinism', () => {
    it('is not evaluated when the capture has no response or comment records', () => {
        const a = analyze([], withRule(proxyMasking))
        expect(a.coverage.find((c) => c.ruleId === MASK)).toMatchObject({ status: 'not-evaluated', missingCapabilities: ['comments', 'response'] })
    })

    it('is not evaluated, and says why, when the capture carries no proxy tags at all', () => {
        const direct = capture().connect().response().repeat(5, 1000, (b, i) => b.frame('tick', String(i)))
        const a = run(direct, proxyMasking)
        const c = a.coverage.find((x) => x.ruleId === MASK)!
        expect(c.status).toBe('not-evaluated')
        expect(c.notes.join(' ')).toMatch(/no proxy tags/)
        expect(a.findings).toEqual([])
    })

    it('live analysis equals batch analysis', () => {
        for (const b of [masked(lively(proxied(), 12), 8), masked(lively(proxied(), 12), 4), lively(proxied(), 20), proxied({ 'x-sse-upstream-status': '502' }), masked(lively(proxied(), 12), 6).silence(1000).frame('tick', 'x')]) {
            const { live, batch } = sameLiveAndBatch(b, proxyMasking)
            expect(live).toEqual(batch)
        }
    })
})
