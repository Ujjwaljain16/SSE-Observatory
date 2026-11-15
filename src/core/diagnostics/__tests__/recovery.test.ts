// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { analyze, createEngine } from '../engine'
import type { Finding } from '../finding'
import { capture, type CaptureBuilder } from '../../testing/captureBuilder'

// Results Q12 (decided): a finding about a silence that ended because its connection closed is resolved when a LATER connection delivers.
// R05 is covered in lifecycle.test.ts. The other findings that are about one connection's silence and have a resolved state are checked
// here: R13 (the proxy is alive, the upstream is silent) and R04 (a stage of the first event that never completed). Each is tested on the
// recovered path (resolved, everything it was kept, and one fact added) and on the path that must keep failing (nothing delivered yet; the
// capture ends in the silence; a recovery followed by a new silence).

const find = (findings: Finding[], key: string) => findings.find((f) => f.key === key)
const run = (b: CaptureBuilder, endT = b.now) => analyze(b.build(), { endT }).findings

/** What a finding was, apart from its status and the fact that says what ended it. */
const sameApartFromEnd = (resolved: Finding, open: Finding) => {
    for (const field of ['title', 'summary', 'severity', 'occurrences', 'firstSeenT', 'lastSeenT', 'deductions', 'limits'] as const) expect(resolved[field], field).toEqual(open[field])
    expect(resolved.facts.slice(0, open.facts.length)).toEqual(open.facts)
    expect(resolved.facts).toHaveLength(open.facts.length + 1)
}

describe('R13 proxy.masking after a reconnect', () => {
    const PROXY = { 'x-sse-proxy': 'observatory/1', 'x-sse-upstream-status': '200', 'x-sse-upstream-content-type': 'text/event-stream' }
    const hb = (b: CaptureBuilder, upIdle: number, n: number) => b.beat('proxy', `sse-proxy hb up_idle=${upIdle} n=${n}`)
    /** A lively stream behind the proxy, then the origin goes quiet while the proxy's heartbeats go on, and the connection is closed. */
    const maskedThenClosed = (): CaptureBuilder => {
        const b = capture().connect().response({ headers: PROXY })
        for (let i = 0; i < 12; i++) { b.silence(1000).frame('tick', String(i + 1)); hb(b, 200, i + 1) }
        for (let k = 0; k < 6; k++) { b.silence(1000); hb(b, 1200 + k * 1000, 100 + k) }
        return b.reconnect({ delayMs: 500 }).silence(500).connect({ sentLastEventId: '12' }).response({ headers: PROXY })
    }

    it('stays open while the new connection has delivered no event, and is resolved by its first one, keeping what it was', () => {
        const waiting = find(run(maskedThenClosed().silence(100)), 'proxy.masking')!
        expect(waiting).toMatchObject({ status: 'open', occurrences: 1 })

        const resolved = find(run(maskedThenClosed().silence(100).frame('tick', '13')), 'proxy.masking')!
        expect(resolved.status).toBe('resolved')
        sameApartFromEnd(resolved, waiting)
        expect(resolved.facts[0]!.text).toMatch(/grew from 200 ms to 6\.2 s/)
    })

    it('a capture that ends in the masking on the new connection still has it open, with its count raised', () => {
        const b = maskedThenClosed().silence(100).frame('tick', '13')
        for (let k = 0; k < 6; k++) { b.silence(1000); hb(b, 1200 + k * 1000, 300 + k) }
        expect(find(run(b), 'proxy.masking')).toMatchObject({ status: 'open', occurrences: 2 })
    })

    it('a live engine and a batch analysis agree', () => {
        const b = maskedThenClosed().silence(100).frame('tick', '13')
        const records = b.build()
        const engine = createEngine()
        for (const o of records) { engine.feed(o); engine.tick(o.t) }
        engine.end(b.now)
        expect(engine.findings()).toEqual(analyze(records, { endT: b.now }).findings)
    })
})

describe('R04 a stage of the first event that never completed because the connection ended', () => {
    /** Headers and a heartbeat arrive, then no event for 10 s (over the 5 s limit), and the connection is closed. */
    const stuckThenClosed = (): CaptureBuilder =>
        capture().connect().at(100).response().at(150).beat().silence(10_000).reconnect({ delayMs: 500 }).silence(500).connect().silence(100).response().silence(50).beat().silence(200)

    it('stays open while the new connection has no event, and is resolved by a prompt first event on it, keeping what it was', () => {
        const waiting = find(run(stuckThenClosed()), 'timing.first-event:first-event')!
        expect(waiting).toMatchObject({ status: 'open', occurrences: 1 })

        const resolved = find(run(stuckThenClosed().frame()), 'timing.first-event:first-event')!
        expect(resolved.status).toBe('resolved')
        sameApartFromEnd(resolved, waiting)
        expect(resolved.facts[0]!.text).toContain('before the connection ended')
    })

    it('a slow first event on the new connection is its own occurrence, reported as before (resolved, count 2)', () => {
        const f = find(run(stuckThenClosed().silence(8000).frame()), 'timing.first-event:first-event')!
        expect(f).toMatchObject({ status: 'resolved', occurrences: 2 })
    })

    it('a capture that ends while the new connection is still waiting keeps it open', () => {
        const b = stuckThenClosed()
        expect(find(run(b, b.now + 20_000), 'timing.first-event:first-event')).toMatchObject({ status: 'open', occurrences: 2 })
    })

    it('slow headers and a late first byte are resolved the same way', () => {
        // Headers never came on the first connection (it was closed after 6 s), the second answered at once.
        const noHeaders = capture().connect().silence(6000).reconnect({ delayMs: 500 }).silence(500).connect().silence(100).response().silence(50).frame()
        expect(find(run(noHeaders), 'timing.first-event:headers')).toMatchObject({ status: 'resolved', occurrences: 1 })
        const noHeadersEver = capture().connect().silence(6000).reconnect({ delayMs: 500 }).silence(500).connect().silence(100)
        expect(find(run(noHeadersEver), 'timing.first-event:headers')).toMatchObject({ status: 'open' })
        // Headers came, then no byte for 6 s and the connection was closed; the next one was prompt.
        const noBytes = capture().connect().at(100).response().silence(6000).reconnect({ delayMs: 500 }).silence(500).connect().silence(100).response().silence(50).frame()
        expect(find(run(noBytes), 'timing.first-event:first-byte')).toMatchObject({ status: 'resolved', occurrences: 1 })
    })
})
