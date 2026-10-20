import { describe, it, expect } from 'vitest'
import { analyze, createEngine } from '../engine'
import type { Finding } from '../finding'
import { capture, healthyStart, type CaptureBuilder } from '../../testing/captureBuilder'
import { redactUrl } from '../../observe/redactUrl'

const run = (b: CaptureBuilder, opts: Parameters<typeof analyze>[1] = {}) => analyze(b.build(), { endT: b.now, ...opts })
const keys = (findings: Finding[]) => findings.map((f) => f.key)
const find = (findings: Finding[], key: string) => findings.find((f) => f.key === key)
const startsWith = (findings: Finding[], prefix: string) => findings.filter((f) => f.key.startsWith(prefix))
const coverageOf = (a: ReturnType<typeof analyze>, ruleId: string) => a.coverage.find((c) => c.ruleId === ruleId)!

/** A healthy open stream with `n` events one second apart. */
const steady = (n: number, everyMs = 1000) => healthyStart().repeat(n, everyMs, (b, i) => b.frame('tick', String(i + 1)))

describe('R01 content type and status', () => {
    it('fires an error for a wrong content type, and says what the proxy reported when it differs', () => {
        const a = run(capture().connect().response({ contentType: 'text/html', headers: { 'x-sse-upstream-content-type': 'application/json' } }))
        const f = find(a.findings, 'proto.content-type')!
        expect(f.severity).toBe('error')
        expect(f.facts[0]!.text).toContain('text/html')
        expect(f.facts[0]!.evidence.length).toBeGreaterThan(0)
        expect(f.facts.some((x) => x.text.includes('application/json'))).toBe(true)
        expect(f.deductions.every((d) => d.statement.startsWith('Likely:'))).toBe(true)
    })

    it.each([[401], [404], [502]])('fires an error for HTTP %i', (status) => {
        const f = find(run(capture().connect().response({ status, contentType: 'application/json' })).findings, 'http.status')!
        expect(f.severity).toBe('error')
        expect(f.summary).toContain(String(status))
        expect(f.facts[0]!.text).toContain(String(status))
    })

    it('keeps error for the spec-defined failures only: a charset or a redirect is never an error', () => {
        const a = run(capture().connect().response({ contentType: 'text/event-stream; charset=latin1', redirected: true }))
        expect(find(a.findings, 'proto.content-type:charset')!.severity).toBe('warning')
        expect(find(a.findings, 'http.redirect')!.severity).toBe('info')
        expect(a.findings.some((f) => f.severity === 'error')).toBe(false)
    })

    it('is silent for a correct response', () => {
        const a = run(steady(3))
        expect(startsWith(a.findings, 'proto.content-type')).toEqual([])
        expect(find(a.findings, 'http.status')).toBeUndefined()
        expect(coverageOf(a, 'proto.content-type').status).toBe('evaluated')
    })
})

describe('R02 framing', () => {
    it('makes one finding per code with the count and the first five examples, not one per occurrence', () => {
        const b = healthyStart()
        for (let i = 0; i < 40; i++) b.violation('UNKNOWN_FIELD', `field ${i}`, i)
        b.violation('WRONG_CASE_FIELD', 'Data:').violation('WRONG_CASE_FIELD', 'Event:').violation('UNTERMINATED_FRAME')
        const a = run(b)
        const framing = startsWith(a.findings, 'proto.framing')
        expect(keys(framing).sort()).toEqual(['proto.framing:UNKNOWN_FIELD', 'proto.framing:UNTERMINATED_FRAME', 'proto.framing:WRONG_CASE_FIELD'])
        const unknown = find(a.findings, 'proto.framing:UNKNOWN_FIELD')!
        expect(unknown.occurrences).toBe(40)
        expect(unknown.severity).toBe('info')
        expect(unknown.facts[0]!.evidence).toHaveLength(5)
        expect(find(a.findings, 'proto.framing:WRONG_CASE_FIELD')!.severity).toBe('warning')
        expect(find(a.findings, 'proto.framing:UNTERMINATED_FRAME')!.severity).toBe('warning')
    })

    it('leaves HTTP-level violations to R01', () => {
        expect(startsWith(run(capture().connect().response({ status: 500 })).findings, 'proto.framing')).toEqual([])
    })

    it('is silent when the parser noticed nothing', () => {
        const a = run(steady(5))
        expect(startsWith(a.findings, 'proto.framing')).toEqual([])
        expect(coverageOf(a, 'proto.framing').status).toBe('evaluated')
    })
})

describe('R03 header hints', () => {
    it('hints at gzip, Content-Length, missing no-cache and absent X-Accel-Buffering, always at low confidence', () => {
        const a = run(capture().connect().response({ headers: { 'content-encoding': 'gzip', 'content-length': '123', 'cache-control': 'max-age=60', 'x-accel-buffering': undefined } }).frame())
        const hints = startsWith(a.findings, 'proto.headers-hints')
        expect(keys(hints).sort()).toEqual(['proto.headers-hints:cache-control', 'proto.headers-hints:content-encoding', 'proto.headers-hints:content-length', 'proto.headers-hints:x-accel-buffering'])
        expect(find(hints, 'proto.headers-hints:content-encoding')!.severity).toBe('warning')
        expect(find(hints, 'proto.headers-hints:cache-control')!.severity).toBe('info')
        for (const h of hints) {
            expect(h.deductions[0]!.confidence).toBe('low')
            expect(h.deductions[0]!.statement).toMatch(/^Likely: this can contribute/)
        }
    })

    it('flags a missing X-Accel-Buffering on its own', () => {
        const a = run(capture().connect().response({ headers: { 'x-accel-buffering': undefined } }).frame())
        expect(keys(startsWith(a.findings, 'proto.headers-hints'))).toEqual(['proto.headers-hints:x-accel-buffering'])
    })

    it('is silent for a well configured response', () => {
        expect(startsWith(run(steady(3)).findings, 'proto.headers-hints')).toEqual([])
    })

    it('is not evaluated, and says so, when the response carries no headers', () => {
        const a = run(capture().connect().response({ headers: 'none' }).frame())
        expect(startsWith(a.findings, 'proto.headers-hints')).toEqual([])
        expect(coverageOf(a, 'proto.headers-hints')).toMatchObject({ status: 'not-evaluated' })
        expect(coverageOf(a, 'proto.headers-hints').notes.join(' ')).toMatch(/no headers/)
    })
})

describe('R04 time to first event', () => {
    it('measures slow headers', () => {
        const a = run(capture().connect().at(4200).response().frame())
        const f = find(a.findings, 'timing.first-event:headers')!
        expect(f.severity).toBe('warning')
        expect(f.status).toBe('resolved')
        expect(f.facts[0]!.text).toContain('4.2 s')
        expect(f.deductions[0]!.statement).toMatch(/^Likely:/)
    })

    it('measures a late first event after on-time headers and escalates to an error at 3x', () => {
        const warn = run(capture().connect().at(100).response().at(150).beat().at(7000).frame())
        expect(find(warn.findings, 'timing.first-event:first-event')!.severity).toBe('warning')
        const bad = run(capture().connect().at(100).response().at(150).beat().at(20_000).frame())
        expect(find(bad.findings, 'timing.first-event:first-event')!.severity).toBe('error')
    })

    it('reports a stage that is still waiting as open, and a provisional one before the end', () => {
        const b = capture().connect().at(100).response().silence(10_000)
        const engine = createEngine()
        for (const o of b.build()) engine.feed(o)
        engine.tick(b.now)
        expect(find(engine.findings(), 'timing.first-event:first-byte')).toMatchObject({ status: 'open' })
        engine.end(b.now)
        expect(find(engine.findings(), 'timing.first-event:first-byte')).toMatchObject({ status: 'open', occurrences: 1 })
    })

    it('honours a profile that expects a slow first event', () => {
        const b = capture().connect().at(100).response().at(150).beat().at(7000).frame()
        expect(find(run(b, { profile: { expected: { firstEventMs: 10_000 } } }).findings, 'timing.first-event:first-event')).toBeUndefined()
    })

    it('is silent for a prompt stream', () => {
        const a = run(capture().connect().at(200).response().at(260).frame())
        expect(startsWith(a.findings, 'timing.first-event')).toEqual([])
    })
})

describe('R05 stall.silent', () => {
    it('with no known cadence only speaks after 30 s, and says it cannot tell a stall from idle', () => {
        expect(startsWith(run(steady(3).silence(25_000)).findings, 'stall.silent')).toEqual([])
        const f = find(run(steady(3).silence(35_000)).findings, 'stall.silent:bytes')!
        expect(f.severity).toBe('warning')
        expect(f.status).toBe('open')
        expect(f.limits.join(' ')).toContain('cannot tell stall from legitimate idle')
        expect(f.deductions[0]!.statement).toMatch(/^Likely:/)
    })

    it('uses the stream\'s own rhythm after ten gaps: warning beyond 3x the p95 gap, error beyond 5x', () => {
        expect(startsWith(run(steady(12).silence(2500)).findings, 'stall.silent')).toEqual([])
        const warn = find(run(steady(12).silence(4000)).findings, 'stall.silent:bytes')!
        expect(warn.severity).toBe('warning')
        expect(warn.limits.join(' ')).not.toContain('cannot tell')
        expect(find(run(steady(12).silence(6000)).findings, 'stall.silent:bytes')!.severity).toBe('error')
    })

    it('resolves when data resumes, and counts each episode', () => {
        const b = steady(12).silence(6000).frame('tick', '13').repeat(40, 1000, (x) => x.frame()).silence(6000).frame()
        const f = find(run(b).findings, 'stall.silent:bytes')!
        expect(f.status).toBe('resolved')
        expect(f.occurrences).toBe(2)
        expect(f.severity).toBe('error')
    })

    it('(i) open with zero bytes', () => {
        const f = find(run(healthyStart().silence(40_000)).findings, 'stall.silent:no-bytes')!
        expect(f.severity).toBe('warning')
        expect(f.facts[0]!.text).toContain('no body byte arrived')
    })

    it('(ii) heartbeats alive but no events', () => {
        const b = steady(12).repeat(10, 1000, (x) => x.beat())
        const a = run(b)
        const f = find(a.findings, 'stall.silent:events')!
        expect(f).toBeDefined()
        expect(f.facts[0]!.text).toContain('chunks arrived, but no complete event')
        expect(find(a.findings, 'stall.silent:bytes')).toBeUndefined()
    })

    it('(iv) only proxy heartbeats arrive: a masked upstream stall', () => {
        const b = steady(12).repeat(10, 1000, (x) => x.beat('proxy'))
        const a = run(b)
        const f = find(a.findings, 'stall.silent:origin')!
        expect(f).toBeDefined()
        expect(f.title).toMatch(/proxy keeps the connection alive/)
        expect(f.facts[0]!.text).toContain('proxy comment')
        expect(find(a.findings, 'stall.silent:bytes')).toBeUndefined()
    })

    it('does not count proxy comments as origin liveness, but does count origin comments', () => {
        const proxy = analyze(steady(3).silence(500).beat('proxy').build())
        const origin = analyze(steady(3).silence(500).beat('upstream').build())
        expect(proxy.model.lastOriginByteT).toBe(3000)
        expect(proxy.model.lastByteT).toBe(3500)
        expect(origin.model.lastOriginByteT).toBe(3500)
    })

    it('is silent when the connection is not open, or never got going', () => {
        expect(startsWith(run(steady(3).reconnect().silence(60_000)).findings, 'stall.silent')).toEqual([])
        expect(startsWith(run(capture().connect().silence(60_000)).findings, 'stall.silent')).toEqual([])
    })

    it('does not read time across a clock jump as a stall', () => {
        const slept = run(steady(3).silence(35_000).discontinuity(35_000, 'resume').silence(5000).frame())
        expect(startsWith(slept.findings, 'stall.silent')).toEqual([])
        expect(find(slept.findings, 'clock.discontinuity')!.severity).toBe('info')
        // without the jump the same silence is a stall
        expect(find(run(steady(3).silence(40_000).frame()).findings, 'stall.silent:bytes')).toBeDefined()
    })

    it('is silent for a sparse stream whose heartbeats keep arriving', () => {
        const b = healthyStart().frame('tick', '0')
        for (let i = 0; i < 12; i++) b.repeat(1, 15_000, (x) => x.beat()).repeat(1, 5000, (x) => x.frame('tick', String(i + 1)))
        expect(startsWith(run(b).findings, 'stall.silent')).toEqual([])
    })

    it('says which part is not evaluated', () => {
        const a = run(steady(3))
        const c = coverageOf(a, 'stall.silent')
        expect(c.status).toBe('evaluated')
        expect(c.notes.join(' ')).toMatch(/pendingBytes/)
    })
})

describe('R10 heartbeat recognition', () => {
    it('flags a heartbeat that arrives more than 2.5x late', () => {
        const b = healthyStart().repeat(6, 1000, (x) => x.beat()).silence(4000).beat().beat()
        const f = find(run(b).findings, 'heartbeat.late:origin')!
        expect(f.severity).toBe('warning')
        expect(f.facts[0]!.text).toContain('4 s')
        expect(f.facts[0]!.text).toContain('1 s')
    })

    it('judges proxy and origin heartbeats separately', () => {
        const b = healthyStart().repeat(6, 1000, (x) => x.beat('proxy')).silence(4000).beat('proxy')
        const a = run(b)
        expect(find(a.findings, 'heartbeat.late:proxy')).toBeDefined()
        expect(find(a.findings, 'heartbeat.late:origin')).toBeUndefined()
    })

    it('is silent for a steady heartbeat, even a slightly jittery one', () => {
        const b = healthyStart()
        for (const gap of [1000, 1100, 900, 1200, 950, 1050, 1000, 1150]) b.silence(gap).beat()
        expect(startsWith(run(b).findings, 'heartbeat.late')).toEqual([])
    })

    it('notes the absence of heartbeats as info, and only when long quiet periods exist', () => {
        const quiet = run(healthyStart().frame().silence(35_000).frame())
        expect(find(quiet.findings, 'heartbeat.absent')!.severity).toBe('info')
        expect(find(run(steady(10)).findings, 'heartbeat.absent')).toBeUndefined()
    })

    it('feeds R05: the heartbeat interval raises the event-silence threshold', () => {
        // events every second, heartbeats every two: the event clock alone would warn at 3 s, the heartbeat interval makes it 4 s
        const b = healthyStart()
        for (let i = 1; i <= 12; i++) { b.silence(1000).frame('tick', String(i)); if (i % 2 === 0) b.beat() }
        b.silence(2000).beat().silence(1500)
        expect(startsWith(run(b).findings, 'stall.silent')).toEqual([])
        expect(find(run(b, { thresholds: { stallHeartbeatFactor: 0 } }).findings, 'stall.silent:events')).toBeDefined()
    })
})

describe('R12 credentials in metadata', () => {
    it('flags credential-like parameter names and never prints a value', () => {
        const url = redactUrl('http://api.test/stream?access_token=CANARY-eyJhbGciOi&room=7&Api-Key=CANARY2&token=CANARY3')
        const a = run(capture().connect({ url }).response().frame())
        const f = find(a.findings, 'security.credentials-in-metadata:url')!
        expect(f.severity).toBe('warning')
        expect(f.summary).toContain('access_token')
        expect(f.summary).toContain('Api-Key')
        expect(JSON.stringify(a.findings)).not.toContain('CANARY')
        expect(f.limits.join(' ')).toMatch(/header values .* not recorded/)
    })

    it('is silent for a URL without credential-like names', () => {
        const a = run(capture().connect({ url: redactUrl('http://api.test/stream?room=7&keyboard=us') }).response().frame())
        expect(startsWith(a.findings, 'security.')).toEqual([])
        expect(coverageOf(a, 'security.credentials-in-metadata').notes.join(' ')).toMatch(/not evaluated/)
    })
})

describe('R15 clock discontinuity', () => {
    it('records the jump as an info marker', () => {
        const a = run(steady(2).discontinuity(10_000))
        const f = find(a.findings, 'clock.discontinuity')!
        expect(f).toMatchObject({ severity: 'info', occurrences: 1 })
    })
    it('is silent without one', () => {
        expect(find(run(steady(2)).findings, 'clock.discontinuity')).toBeUndefined()
    })
})

describe('coverage: not evaluated is never healthy', () => {
    it('reports every rule that needs records the capture lacks as not evaluated, with the missing kinds', () => {
        const a = analyze([])
        const by = (id: string) => coverageOf(a, id)
        for (const id of ['proto.content-type', 'proto.framing', 'proto.headers-hints', 'timing.first-event', 'stall.silent', 'heartbeat.recognition', 'security.credentials-in-metadata']) {
            expect(by(id).status).toBe('not-evaluated')
            expect(by(id).missingKinds.length).toBeGreaterThan(0)
        }
        expect(by('clock.discontinuity').status).toBe('evaluated')
    })

    it('a v1-style capture with only event records cannot show the wire rules as healthy', () => {
        const events = capture().event('tick', '1').silence(1000).event('tick', '2').build()
        const a = analyze(events)
        expect(a.findings).toEqual([])
        expect(coverageOf(a, 'stall.silent')).toMatchObject({ status: 'not-evaluated', missingCapabilities: ['phases', 'chunks'] })
        expect(coverageOf(a, 'proto.content-type')).toMatchObject({ status: 'not-evaluated', missingKinds: ['response'] })
        expect(coverageOf(a, 'security.credentials-in-metadata')).toMatchObject({ status: 'not-evaluated', missingKinds: ['connect'] })
    })

    it('a recording that stopped before any bytes does not claim the timing rule is fine', () => {
        const a = run(capture().connect().response({ status: 502 }))
        expect(coverageOf(a, 'timing.first-event').status).toBe('not-evaluated')
        expect(coverageOf(a, 'proto.content-type').status).toBe('evaluated')
    })
})
