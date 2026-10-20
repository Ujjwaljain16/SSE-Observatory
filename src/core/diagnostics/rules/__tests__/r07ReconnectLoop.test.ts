import { describe, it, expect } from 'vitest'
import { analyze } from '../../engine'
import { capture, healthyStart, type CaptureBuilder } from '../../../testing/captureBuilder'
import { reconnectLoop } from '../r07ReconnectLoop'
import { find, keys, run, sameLiveAndBatch, withRule } from './helpers'

const LOOP = 'reconnect.loop'
const PATTERN = 'reconnect.duration-pattern'

/** One healthy connection that lasts `lifetimeMs`, sending an event every `everyMs`, then is dropped and reconnected. */
function connection(b: CaptureBuilder, o: { lifetimeMs: number; everyMs?: number; first?: boolean; tag?: string; silentAfter?: number; delayMs?: number }): CaptureBuilder {
    const every = o.everyMs ?? 1000
    if (o.first) b.connect().response()
    const start = b.now
    const stop = o.silentAfter !== undefined ? start + o.silentAfter : start + o.lifetimeMs
    for (let t = start + every; t <= stop - 10; t += every) b.at(t).frame('tick', String(t))
    if (o.tag) b.at(start + o.lifetimeMs - 10).beat('proxy', o.tag)
    return b.at(start + o.lifetimeMs).reconnect({ delayMs: o.delayMs ?? 500 }).silence(o.delayMs ?? 500).connect().response()
}

/** `count` connections with the given lifetimes. */
function lifetimes(values: number[], o: Omit<Parameters<typeof connection>[1], 'lifetimeMs' | 'first'> = {}): CaptureBuilder {
    const b = capture()
    values.forEach((lifetimeMs, i) => connection(b, { ...o, lifetimeMs, first: i === 0 }))
    return b
}

/** `count` connections that are refused (HTTP 502) one after another. */
function refused(count: number): CaptureBuilder {
    const b = capture().connect()
    for (let i = 0; i < count; i++) {
        b.response({ status: 502, contentType: 'text/plain' }).reconnect({ delayMs: 1000, status: 502, reason: 'HTTP 502' }).silence(1000).connect()
    }
    return b
}

describe('R07 reconnect.loop', () => {
    it('warns when the stream keeps dropping but makes progress between drops', () => {
        const b = lifetimes([8000, 9000, 7000]) // four connections inside a minute
        const f = find(run(b, reconnectLoop).findings, LOOP)!
        expect(f.severity).toBe('warning')
        expect(f.facts[0]!.text).toMatch(/4 connections were opened within/)
        expect(f.facts[0]!.evidence.length).toBeGreaterThan(0)
        expect(f.facts[1]!.text).toMatch(/events were delivered across them/)
        expect(f.deductions[0]!.statement).toMatch(/^Likely: something cuts the connection repeatedly/)
    })

    it('is an error when connections are refused and no event ever arrives', () => {
        const a = run(refused(4), reconnectLoop)
        const f = find(a.findings, LOOP)!
        expect(f.severity).toBe('error')
        expect(f.facts.some((x) => /No event was delivered on any of them/.test(x.text))).toBe(true)
        expect(f.facts.some((x) => /HTTP 502/.test(x.text))).toBe(true)
        expect(f.deductions[0]!.statement).toMatch(/^Likely: the server refuses or drops every attempt/)
    })

    it('counts reconnects in a row with no event even when they are spread out', () => {
        const b = capture().connect()
        for (let i = 0; i < 5; i++) b.response({ status: 503, contentType: 'text/plain' }).reconnect({ delayMs: 30_000, status: 503 }).silence(30_000).connect()
        const f = find(run(b, reconnectLoop).findings, LOOP)!
        expect(f.facts.some((x) => /5 reconnects happened in a row without a single event/.test(x.text))).toBe(true)
        expect(f.severity).toBe('error')
    })

    it('does not count connections that are far apart', () => {
        const b = lifetimes([40_000, 50_000]) // three connections, but not inside one minute
        expect(keys(run(b, reconnectLoop).findings)).not.toContain(LOOP)
    })

    it('honours the thresholds', () => {
        const b = lifetimes([8000, 9000, 7000])
        expect(keys(analyze(b.build(), withRule(reconnectLoop, { endT: b.now, thresholds: { loopMinConnections: 6 } })).findings)).not.toContain(LOOP)
    })
})

describe('R07 reconnect.duration-pattern', () => {
    it('reads connections cut while data flows, all the same length, as a maximum-duration cap', () => {
        const b = lifetimes([30_000, 30_000, 30_000, 30_000], { everyMs: 2000 })
        const a = run(b, reconnectLoop)
        const f = find(a.findings, PATTERN)!
        expect(f.severity).toBe('warning')
        expect(f.facts[0]!.text).toMatch(/4 dropped connections lasted 30 s each/)
        expect(f.deductions[0]!.statement).toMatch(/^Likely: a maximum-duration cap of about 30 s/)
        expect(f.deductions[0]!.confidence).toBe('medium')
    })

    it('reads silence before each drop as an idle timeout', () => {
        const b = lifetimes([40_000, 40_000, 40_000, 40_000], { everyMs: 1000, silentAfter: 5000 })
        const f = find(run(b, reconnectLoop).findings, PATTERN)!
        expect(f.deductions[0]!.statement).toMatch(/^Likely: an idle timeout of about 36 s/)
        expect(f.facts.some((x) => /silent for about 36 s/.test(x.text))).toBe(true)
    })

    it('attributes the cap to the proxy, as a fact, when it tagged the close', () => {
        const b = lifetimes([30_000, 30_000, 30_000], { everyMs: 2000, tag: 'sse-proxy cap duration=30000' })
        const f = find(run(b, reconnectLoop).findings, PATTERN)!
        expect(f.severity).toBe('info')
        expect(f.title).toMatch(/proxy closes connections at its duration cap/)
        expect(f.facts.some((x) => /proxy announced its own duration cap \(duration=30000 ms\)/.test(x.text))).toBe(true)
        expect(f.deductions).toEqual([])
    })

    it('is silent for varied lifetimes, the healthy twin (a drop is resumed, lengths differ)', () => {
        const b = lifetimes([20_000, 45_000, 33_000, 70_000])
        const a = run(b, reconnectLoop)
        expect(a.findings).toEqual([])
        expect(a.coverage.find((c) => c.ruleId === LOOP)!.status).toBe('evaluated')
    })

    it('needs enough lifetimes and a tight spread', () => {
        expect(keys(run(lifetimes([30_000, 30_000]), reconnectLoop).findings)).not.toContain(PATTERN)
        expect(keys(run(lifetimes([30_000, 32_000, 28_000, 31_000]), reconnectLoop).findings)).not.toContain(PATTERN)
        const loose = analyze(lifetimes([30_000, 32_000, 28_000, 31_000]).build(), withRule(reconnectLoop, { endT: 130_000, thresholds: { durationMaxCv: 0.1 } }))
        expect(keys(loose.findings)).toContain(PATTERN)
    })

    it('finds a regular tail even when the first connection was different', () => {
        const b = lifetimes([12_000, 30_000, 30_000, 30_000])
        expect(keys(run(b, reconnectLoop).findings)).toContain(PATTERN)
    })
})

describe('R07 coverage and determinism', () => {
    it('is not evaluated, and says so, without phase and reconnect records', () => {
        const a = analyze([], withRule(reconnectLoop))
        expect(a.coverage.find((c) => c.ruleId === LOOP)).toMatchObject({ status: 'not-evaluated', missingCapabilities: ['phases', 'reconnects'] })
        const eventsOnly = analyze(capture().event('tick', '1').silence(1000).event('tick', '2').build(), withRule(reconnectLoop))
        expect(eventsOnly.coverage.find((c) => c.ruleId === LOOP)!.status).toBe('not-evaluated')
        expect(eventsOnly.findings).toEqual([])
    })

    it('a single healthy connection is evaluated and silent', () => {
        const a = run(healthyStart().repeat(5, 1000, (b, i) => b.frame('tick', String(i))), reconnectLoop)
        expect(a.findings).toEqual([])
        expect(a.coverage.find((c) => c.ruleId === LOOP)!.status).toBe('evaluated')
    })

    it('live analysis equals batch analysis', () => {
        for (const b of [lifetimes([8000, 9000, 7000]), refused(5), lifetimes([30_000, 30_000, 30_000, 30_000], { everyMs: 2000 }), lifetimes([30_000, 30_000, 30_000], { everyMs: 2000, tag: 'sse-proxy cap duration=30000' }), lifetimes([20_000, 45_000, 33_000, 70_000])]) {
            const { live, batch } = sameLiveAndBatch(b, reconnectLoop)
            expect(live).toEqual(batch)
        }
    })
})
