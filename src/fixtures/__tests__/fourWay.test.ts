// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultRules } from '../../core/diagnostics/rules'
import { startFixtureServer, type FixtureServer } from '../server'
import { observeFixture } from './observeFixture'
import { compareFourWay, type Mismatch } from './fourWay'
import type { LoggedConnection } from '../groundTruth'
import { gunzipLog } from './gunzipLog'

// Plan A5: the same stream at four places (the server's own log, the transport records, the parsed events, the findings), each checked against the
// one before. If the pipeline loses, adds or reorders anything, or a finding quotes a number the server did not produce, a mismatch names the
// boundary. The harness is itself tested by corrupting a good run in each way and requiring the right boundary to be named.

let server: FixtureServer
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })

async function run(id: string, query: Record<string, string | number> = {}) {
    const before = server.groundTruth.connections.length
    const observed = await observeFixture(server, defaultRules, id, query, true, { captureBytes: true })
    // let the server note a connection the client closed last
    await new Promise((r) => setTimeout(r, 30))
    // a compressed route is logged as the bytes on the wire; the client reads them decoded, so the comparison is made in plain bytes (a no-op for any other route)
    const log = server.groundTruth.connections.slice(before).filter((c) => c.route === id).map(gunzipLog)
    return { log, observed }
}

const compare = (r: Awaited<ReturnType<typeof run>>): Mismatch[] => compareFourWay({ log: r.log, records: r.observed.observations, messages: r.observed.messages, findings: r.observed.findings })
const show = (m: Mismatch[]): string => m.map((x) => `[${x.boundary}] ${x.invariant}${x.connection !== undefined ? ` conn ${x.connection}` : ''}: ${x.detail}`).join('\n')

const ROUTES: Array<{ id: string; query?: Record<string, string | number>; note: string }> = [
    { id: 'h01', note: 'steady, numeric ids' },
    { id: 'h03', note: 'CRLF, a UTF-8 character split across writes, comments' },
    { id: 'h04', note: 'uuid ids' },
    { id: 'f03-buffered', note: 'events written in lumps' },
    { id: 'f05-drops', note: 'four connections, resumed from Last-Event-ID' },
    { id: 'f05-resumes', note: 'one drop, correct resume' },
    { id: 'f06-skips', note: 'a resume that skips ids' },
    { id: 'f07-flood', note: '2000 frames as fast as it can' },
    { id: 'f09-buffered', note: 'writes of exactly 4096 bytes' },
    { id: 'f09-healthy', note: 'one write per event' },
    { id: 'f05-ignores', note: 'a drop, then a server that ignores the cursor and starts again from 1 (ids 1,2,3,1,2,3,4,5,6)' },
    { id: 'f15-malformed', note: 'a byte order mark, unknown and wrong-case fields, a NUL id, a bad retry, CRLF in an LF stream' },
    { id: 'f12-gzip-sync', note: 'gzip on the wire with a flush per event: the log is decoded to what the client reads' },
    { id: 'h06-comments-only', note: 'comments from byte 0 and no event until the end' },
]

describe('the pipeline loses nothing and adds nothing, on every route that ends', () => {
    for (const route of ROUTES) {
        it(`${route.id} (${route.note}): the four places agree`, async () => {
            const r = await run(route.id, route.query)
            expect(r.log.length, 'the server saw at least one request').toBeGreaterThan(0)
            expect(r.observed.observations.length).toBeGreaterThan(0)
            expect(show(compare(r))).toBe('')
        }, 40_000)
    }

    it('f05-drops: four requests, the cursors the server received are the ids the client saw, and the finding quotes four connections', async () => {
        const r = await run('f05-drops')
        expect(r.log.map((c) => c.requestHeaders['last-event-id'] ?? '')).toEqual(['', '3', '6', '9'])
        const loop = r.observed.findings.find((f) => f.key === 'reconnect.loop')
        expect(loop?.facts[0]?.text).toMatch(/4 connections were opened within/)
    }, 40_000)
})

describe('the harness can fail: a good run, damaged one way at a time, is caught at the right boundary', () => {
    let good: Awaited<ReturnType<typeof run>>
    beforeAll(async () => { good = await run('f05-drops') }, 40_000)

    const damaged = (change: (records: typeof good.observed.observations, messages: typeof good.observed.messages, log: LoggedConnection[]) => { records?: typeof good.observed.observations; messages?: typeof good.observed.messages; log?: LoggedConnection[] }): Mismatch[] => {
        const c = change(structuredClone(good.observed.observations), structuredClone(good.observed.messages), structuredClone(good.log))
        return compareFourWay({ log: c.log ?? good.log, records: c.records ?? good.observed.observations, messages: c.messages ?? good.observed.messages, findings: good.observed.findings })
    }

    it('the undamaged run has no mismatch (so a mismatch below is the damage)', () => {
        expect(show(compare(good))).toBe('')
    })

    it('a chunk record dropped: the bytes the client read no longer add up (server -> transport, I1)', () => {
        const m = damaged((records) => { const i = records.findIndex((r) => r.kind === 'chunk' && r.conn === 0); records.splice(i, 1); return { records } })
        expect(m.map((x) => `${x.boundary} ${x.invariant}`)).toContain('server->transport I1 bytes')
    })

    it('two event ids swapped: the parser disagrees with the server about which event is which (transport -> parser, I2)', () => {
        const m = damaged((records) => {
            const events = records.filter((r) => r.kind === 'event' && r.conn === 0) as Array<{ sseId: string }>
            ;[events[0]!.sseId, events[1]!.sseId] = [events[1]!.sseId, events[0]!.sseId]
            return { records }
        })
        expect(m.map((x) => `${x.boundary} ${x.invariant}`)).toContain('transport->parser I2 events')
    })

    it('an event record deleted: fewer events than the server sent, and the delivered messages no longer match (I2 and I3)', () => {
        const m = damaged((records) => { records.splice(records.findIndex((r) => r.kind === 'event'), 1); return { records } })
        const names = m.map((x) => `${x.boundary} ${x.invariant}`)
        expect(names).toContain('transport->parser I2 events')
        expect(names).toContain('parser->delivered I3 delivered')
    })

    it('a message delivered that was never recorded, or recorded under another name (parser -> delivered, I3)', () => {
        const m = damaged((_, messages) => { messages[0]!.event = 'something-else'; return { messages } })
        expect(m.map((x) => `${x.boundary} ${x.invariant}`)).toContain('parser->delivered I3 delivered')
    })

    it('a cursor shifted: the client says it sent an id the server did not receive (server -> transport, I4)', () => {
        const m = damaged((records) => { const c = records.find((r) => r.kind === 'connect' && r.conn === 1) as { sentLastEventId: string }; c.sentLastEventId = '999'; return { records } })
        expect(m.map((x) => `${x.boundary} ${x.invariant}`)).toContain('server->transport I4 cursor')
    })

    it('every record a second late: events recorded after the server wrote them by far more than a loopback needs (clock, I5)', () => {
        const m = damaged((records) => { for (const r of records) if (r.kind === 'event') r.t += 1000; return { records } })
        expect(m.map((x) => `${x.boundary} ${x.invariant}`)).toContain('clock I5 time')
    })

    it('a connection the server did not make: the log has fewer connections than the finding says (transport -> findings, I6)', () => {
        const m = damaged((_, __, log) => ({ log: log.slice(0, 2) }))
        expect(m.length).toBeGreaterThan(0)
    })
})

describe('a compressed route can only be compared in plain bytes', () => {
    it('against the raw wire log the bytes do not add up (I1), and decoded they do: the decoding is what makes the comparison true, not a way round it', async () => {
        const before = server.groundTruth.connections.length
        const observed = await observeFixture(server, defaultRules, 'f12-gzip-sync', {}, true, { captureBytes: true })
        await new Promise((r) => setTimeout(r, 30))
        const raw = server.groundTruth.connections.slice(before).filter((c) => c.route === 'f12-gzip-sync')
        const against = (log: LoggedConnection[]) => compareFourWay({ log, records: observed.observations, messages: observed.messages, findings: observed.findings })
        expect(against(raw).map((x) => `${x.boundary} ${x.invariant}`)).toContain('server->transport I1 bytes')
        expect(show(against(raw.map(gunzipLog)))).toBe('')
    }, 40_000)
})
