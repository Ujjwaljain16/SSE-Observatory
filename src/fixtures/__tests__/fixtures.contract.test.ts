// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_ROUTES, startFixtureServer, type FixtureServer } from '../server'
import { frameLog, type LoggedConnection } from '../groundTruth'

// Plan A4: what each fixture route sends, written down once and checked against the server's OWN log (groundTruth.ts), not against any client.
//
// Every other test in this directory trusts a fixture to do what its description says. This one is what makes that trust earned: if a fixture is
// edited and stops sending the ids, the framing, the comments, the bytes or the ending it declares, this fails first and names the route, before a
// rule test fails for a reason nobody can read. The contract lives here and not in `FixtureRoute` so that kit.ts, families.ts and server.ts stay
// untouched; a route with no entry in the table fails the test below, so a new route cannot be added without declaring what it sends.
//
// Fetched with a plain `fetch` (no SSE client in the way), once per route, at scale 0.02.

const SCALE = 0.02

/** How the route's connection ends. `end-event`: the stream's own final `event: end`, then the server closes. `closes`: the server closes with no `end` event (a drop, or a failure body). `open`: it never ends; the test leaves. */
type Ending = 'end-event' | 'closes' | 'open'

interface Contract {
    status: number
    /** Start of the Content-Type header. */
    contentType: string
    /** The `id:` lines the frames carry, in order. An `end` event carries none. */
    ids: string[]
    /** Complete frames that dispatch an event (they have a data line), the final `end` event included. */
    events: number
    /** Complete frames made of comments only: an exact number, or `{ atLeast }` for a heartbeat that runs until the client leaves. */
    comments: number | { atLeast: number }
    /** Every comment line the server wrote matches this (the proxy-shaped heartbeats of f04-masked, for example). */
    commentPattern?: RegExp
    /** Whether the body ends with a frame that has no blank line after it. Undefined where the body is not an event stream at all (an error page). */
    unterminated?: boolean
    ending: Ending
    /** A resuming client is expected to ask again: the stream ended with no `end` event and the failure was not a fatal one (401, 404, wrong content type). */
    reconnect: boolean
    /** Exact bytes written, where nothing in the body varies from run to run. */
    bytes?: number
    /** The route's duration at scale 1 in the plan (section 5.2) and the number of timer wake-ups it takes: they set the ceiling at the scale used. */
    scale1Ms?: number
    wakeups?: number
    query?: Record<string, string>
}

const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => String(from + i))
const uuid = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
const SSE = 'text/event-stream'
const HEARTBEAT = /^(keep-alive|sse-proxy hb up_idle=\d+ n=\d+)$/

/** One route that answers 200 with a stream of ticks and an end event. */
const ticks = (n: number, extra: Partial<Contract> = {}): Contract => ({ status: 200, contentType: SSE, ids: range(1, n), events: n + 1, comments: 0, unterminated: false, ending: 'end-event', reconnect: false, ...extra })
/** A response that is one SSE-looking frame under the wrong content type. */
const wrongType = (contentType: string): Contract => ({ status: 200, contentType, ids: [], events: 1, comments: 0, unterminated: false, ending: 'closes', reconnect: false, bytes: 13 })

/**
 * The table, keyed by route id. Values come from the scripts (the ids and counts are what the script's loops and `defaultN` produce; the byte counts
 * were checked by hand for the small ones: an h01 tick is 33 bytes, 5 ticks and the 23-byte end event make 188) and are then measured against the server.
 */
export const CONTRACTS: Record<string, Contract> = {
    'f01-text-plain': wrongType('text/plain'),
    'f01-text-html': wrongType('text/html'),
    'f01-json': wrongType('application/json'),
    'f01-401': { status: 401, contentType: 'application/json', ids: [], events: 0, comments: 0, ending: 'closes', reconnect: false, bytes: 24 },
    'f01-404': { status: 404, contentType: 'application/json', ids: [], events: 0, comments: 0, ending: 'closes', reconnect: false, bytes: 21 },
    'f01-502': { status: 502, contentType: 'text/plain', ids: [], events: 0, comments: 0, ending: 'closes', reconnect: true, bytes: 11 },

    'f02-closed': { status: 200, contentType: SSE, ids: [], events: 0, comments: 0, unterminated: true, ending: 'closes', reconnect: true, bytes: 7 },
    'f02-open': { status: 200, contentType: SSE, ids: [], events: 0, comments: 0, unterminated: true, ending: 'open', reconnect: false, bytes: 7 },

    // 12 events, then nothing at all (silent), only keep-alive comments (heartbeats), only proxy-tagged comments (masked)
    'f04-silent': { status: 200, contentType: SSE, ids: range(1, 12), events: 12, comments: 0, unterminated: false, ending: 'open', reconnect: false, bytes: 402 },
    'f04-heartbeats': { status: 200, contentType: SSE, ids: range(1, 12), events: 12, comments: { atLeast: 3 }, commentPattern: HEARTBEAT, unterminated: false, ending: 'open', reconnect: false },
    'f04-masked': { status: 200, contentType: SSE, ids: range(1, 12), events: 12, comments: { atLeast: 3 }, commentPattern: /^sse-proxy hb up_idle=\d+ n=\d+$/, unterminated: false, ending: 'open', reconnect: false },

    // ?token= is required; with one it is h01 (3 events)
    'f08-token': ticks(3, { query: { token: 'contract-test' }, bytes: 122, scale1Ms: 3000, wakeups: 4 }),

    'h01': ticks(5, { bytes: 188, scale1Ms: 5000, wakeups: 6 }),
    // 5 events 20 s apart; a heartbeat comment every 15 s until the last event (15, 30, 45, 60, 75 s)
    'h02': { ...ticks(5, { scale1Ms: 80_000, wakeups: 12 }), comments: 5, commentPattern: HEARTBEAT, bytes: 5 * 33 + 5 * 14 + 23 },
    // CRLF throughout, characters split across writes, a comment at the start and after every event
    'h03': { ...ticks(3, { scale1Ms: 3100, wakeups: 8 }), comments: 4, bytes: 230 },
    'h04': { ...ticks(5, { scale1Ms: 5000, wakeups: 6 }), ids: range(1, 5).map((n) => uuid(Number(n))), bytes: 363 },

    'f03-buffered': ticks(60, { bytes: 3245, scale1Ms: 15_000, wakeups: 6 }),
    'f03-steady': ticks(60, { scale1Ms: 15_000, wakeups: 60 }),

    // one connection of the loop: 3 events then the server closes (a resuming client comes back with Last-Event-ID 3)
    'f05-drops': { status: 200, contentType: SSE, ids: range(1, 3), events: 3, comments: 0, unterminated: false, ending: 'closes', reconnect: true, bytes: 99, scale1Ms: 1800, wakeups: 3 },
    // events and heartbeats for 3.5 s (an event each second, a heartbeat between), then the server cuts the connection
    'f05-cap': { status: 200, contentType: SSE, ids: range(1, 3), events: 3, comments: 3, commentPattern: HEARTBEAT, unterminated: false, ending: 'closes', reconnect: true, bytes: 141, scale1Ms: 3500, wakeups: 8 },
    'f05-resumes': { status: 200, contentType: SSE, ids: range(1, 3), events: 3, comments: 0, unterminated: false, ending: 'closes', reconnect: true, bytes: 99, scale1Ms: 1800, wakeups: 3 },

    'f06-skips': { status: 200, contentType: SSE, ids: range(1, 4), events: 4, comments: 0, unterminated: false, ending: 'closes', reconnect: true, bytes: 132, scale1Ms: 1200, wakeups: 4 },
    'f06-resumes': { status: 200, contentType: SSE, ids: range(1, 4), events: 4, comments: 0, unterminated: false, ending: 'closes', reconnect: true, bytes: 132, scale1Ms: 1200, wakeups: 4 },

    'f07-flood': ticks(2000, { bytes: 75_809, scale1Ms: 1000, wakeups: 20 }),
    'f09-buffered': ticks(12, { bytes: 12_533, scale1Ms: 3600, wakeups: 12 }),
    'f09-healthy': ticks(12, { bytes: 12_533, scale1Ms: 3600, wakeups: 12 }),
    'f10-steady': ticks(100, { scale1Ms: 1000, wakeups: 100 }),

    'f11-drift': ticks(34, { bytes: 2013, scale1Ms: 1700, wakeups: 34 }),
    'f11-steady': ticks(34, { bytes: 1943, scale1Ms: 1700, wakeups: 34 }),
}

/** Routes that need no contract beyond a status: f08-echo answers with whatever credentials it was sent, so there is nothing stable to pin. */
const STATUS_ONLY: Record<string, number> = { 'f08-echo': 200 }

/** The ceiling for a finite route at the scale used: its stream time scaled, a Windows timer wake-up (up to ~20 ms) per sleep, and half a second. */
const ceilingMs = (c: Contract): number => (c.scale1Ms ?? 0) * SCALE + (c.wakeups ?? 0) * 20 + 500

/** Routes of the server that have no declared contract: the test that keeps new routes honest. */
export function routesWithoutContract(routeIds: string[], table: Record<string, Contract>): string[] {
    return routeIds.filter((id) => !(id in table) && !(id in STATUS_ONLY))
}

interface Result {
    status: number
    contentType: string
    log: LoggedConnection
    durationMs: number
    /** True when the test cut the connection itself. */
    cut: boolean
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Fetches a route once, and reads it until it ends. A route that never ends is read until its declared events have come, then watched in silence for a while, then abandoned. */
async function fetchRoute(server: FixtureServer, id: string, expectedEvents: number, ending: Ending, query: Record<string, string> = {}): Promise<Result> {
    const controller = new AbortController()
    const ceiling = setTimeout(() => controller.abort(), 10_000)
    const started = performance.now()
    const res = await fetch(server.urlFor(id, { scale: SCALE, ...query }), { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let cut = false
    let leaveAt: number | undefined
    try {
        for (;;) {
            const next = reader.read()
            // once an open route has delivered what it should, give it a quarter of a second to say something more, then go
            const outcome = leaveAt === undefined ? await next : await Promise.race([next, wait(Math.max(0, leaveAt - performance.now())).then(() => 'leave' as const)])
            if (outcome === 'leave') { cut = true; controller.abort(); break }
            if (outcome.done) break
            text += decoder.decode(outcome.value, { stream: true })
            if (ending === 'open' && leaveAt === undefined && text.split('\n\n').length - 1 >= expectedEvents) leaveAt = performance.now() + 250
            if (ending === 'open' && leaveAt === undefined && expectedEvents === 0 && text.length > 0) leaveAt = performance.now() + 250
        }
    } catch (error) {
        if (!controller.signal.aborted) throw error
        cut = true
    } finally { clearTimeout(ceiling) }
    const durationMs = performance.now() - started
    const entry = server.groundTruth.of(id).at(-1)!
    // let the server notice that the client left
    for (let i = 0; i < 50 && entry.endedBy === 'open'; i++) await wait(10)
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', log: entry, durationMs, cut }
}

/** What the server's log says about the connection, against what the contract says it must be. Empty when they agree. */
export function violations(id: string, c: Contract, r: Result, server: FixtureServer): string[] {
    const bad: string[] = []
    const log = r.log
    const frames = frameLog(log)
    const events = frames.filter((f) => f.terminated && f.hasData)
    const commentFrames = frames.filter((f) => f.terminated && f.isComment)
    const bytes = server.groundTruth.totals(log).bytes
    const comment = (message: string): void => { bad.push(`${id}: ${message}`) }

    if (r.status !== c.status) comment(`status ${r.status}, the contract says ${c.status}`)
    if (log.status !== c.status) comment(`the server's log records status ${log.status}, the contract says ${c.status}`)
    if (!r.contentType.startsWith(c.contentType)) comment(`Content-Type "${r.contentType}", the contract says it starts with "${c.contentType}"`)

    const ids = frames.filter((f) => f.id !== null).map((f) => f.id)
    if (JSON.stringify(ids) !== JSON.stringify(c.ids)) comment(`ids on the wire ${JSON.stringify(ids.length > 6 ? [...ids.slice(0, 3), '...', ...ids.slice(-3)] : ids)}, the contract says ${JSON.stringify(c.ids.length > 6 ? [...c.ids.slice(0, 3), '...', ...c.ids.slice(-3)] : c.ids)}`)
    if (events.length !== c.events) comment(`${events.length} complete events, the contract says ${c.events}`)
    if (typeof c.comments === 'number') { if (commentFrames.length !== c.comments) comment(`${commentFrames.length} comment frames, the contract says ${c.comments}`) } else if (commentFrames.length < c.comments.atLeast) comment(`${commentFrames.length} comment frames, the contract says at least ${c.comments.atLeast}`)
    if (c.commentPattern) {
        const lines = server.groundTruth.body(log).split(/\r\n|\n|\r/).filter((l) => l.startsWith(':')).map((l) => l.replace(/^: ?/, ''))
        const off = lines.filter((l) => !c.commentPattern!.test(l))
        if (off.length > 0) comment(`comment "${off[0]}" does not match ${c.commentPattern}`)
    }
    if (c.unterminated !== undefined) {
        const unterminated = frames.some((f) => !f.terminated)
        if (unterminated !== c.unterminated) comment(c.unterminated ? 'the body ends with a complete frame, the contract says it ends mid-frame' : 'the body ends mid-frame, the contract says every frame is complete')
    }

    // how it ends
    const last = events.at(-1)
    const endsWithEndEvent = last?.event === 'end'
    if (c.ending === 'end-event') {
        if (!endsWithEndEvent) comment(`the last event is "${last?.event}", the contract says the stream finishes with an "end" event`)
        if (log.endedBy !== 'server-end') comment(`the connection ended by "${log.endedBy}", the contract says the server ends it after the end event`)
    } else if (c.ending === 'closes') {
        if (endsWithEndEvent) comment('an "end" event was sent, the contract says the server just closes the connection')
        if (log.endedBy !== 'server-end') comment(`the connection ended by "${log.endedBy}", the contract says the server closes it`)
    } else {
        if (log.endedBy === 'server-end' || log.endedBy === 'server-destroy') comment(`the server ended the connection (${log.endedBy}), the contract says it stays open`)
        if (!r.cut) comment('the read finished by itself, the contract says the connection stays open')
    }
    // a resuming client comes back exactly when the stream ended without its own end event and the failure was not fatal
    if (c.reconnect && (c.ending !== 'closes' || endsWithEndEvent)) comment('the contract expects a reconnect but the stream does not end by closing without an end event')
    if (!c.reconnect && c.ending === 'end-event' && !endsWithEndEvent) comment('the contract expects no reconnect but the stream did not finish')

    if (c.bytes !== undefined && bytes !== c.bytes) comment(`${bytes} bytes written, the contract says ${c.bytes}`)
    if (c.ending !== 'open' && c.scale1Ms !== undefined) {
        const ceiling = ceilingMs(c)
        if (r.durationMs > ceiling) comment(`took ${Math.round(r.durationMs)} ms at scale ${SCALE}, the ceiling is ${Math.round(ceiling)} ms (stream time x scale + timer wake-ups + 500 ms)`)
    }
    return bad
}

let server: FixtureServer
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })

describe('every fixture route sends what its contract says (read from the server\'s own log)', () => {
    it('no route is missing a contract, and no contract is left for a route that is gone', () => {
        const ids = FIXTURE_ROUTES.map((r) => r.id)
        expect(routesWithoutContract(ids, CONTRACTS), 'add an entry to CONTRACTS for a new route').toEqual([])
        expect(Object.keys(CONTRACTS).filter((id) => !ids.includes(id)), 'a contract for a route that no longer exists').toEqual([])
    })

    it('every route, fetched once at scale 0.02: status, content type, ids, frame count, comments, ending, bytes and duration match', async () => {
        const problems: string[] = []
        await Promise.all(FIXTURE_ROUTES.map(async (route) => {
            const c = CONTRACTS[route.id]
            if (!c) {
                const status = STATUS_ONLY[route.id]
                if (status === undefined) { problems.push(`${route.id}: no contract`); return }
                // answers 200 only when given a token; nothing else about it is stable
                const res = await fetch(server.urlFor(route.id, { scale: SCALE, token: 'contract-test' }))
                await res.arrayBuffer()
                if (res.status !== status) problems.push(`${route.id}: status ${res.status}, expected ${status}`)
                return
            }
            const r = await fetchRoute(server, route.id, c.events, c.ending, c.query)
            problems.push(...violations(route.id, c, r, server))
        }))
        expect(problems.sort().join('\n')).toBe('')
    }, 40_000)

    it('f08-token is a 401 without a token, and a stream with one', async () => {
        const without = await fetch(server.urlFor('f08-token', { scale: SCALE }))
        await without.arrayBuffer()
        expect(without.status).toBe(401)
        expect(server.groundTruth.of('f08-token').at(-1)!.query).toEqual({ scale: '0.02' })
    })

    it('the log records a secret header as its presence and length only (so a contract can never leak what a route echoes)', async () => {
        const res = await fetch(server.urlFor('f01-401', { scale: SCALE }), { headers: { Authorization: 'Bearer contract-test-value', Cookie: 'k=contract-test-value' } })
        await res.arrayBuffer()
        const entry = server.groundTruth.of('f01-401').at(-1)!
        expect(entry.requestHeaders['authorization']).toBe('<present, 26 characters>')
        expect(JSON.stringify(entry.requestHeaders)).not.toContain('contract-test-value')
    })
})

describe('resuming: a route that honours Last-Event-ID continues after it, one that is built not to does what it is built to do', () => {
    // [route, Last-Event-ID sent, the ids of the frames the new connection carries]
    const RESUME: Array<[string, string, string[], string]> = [
        ['h01', '2', ['3', '4', '5'], 'continues after the cursor'],
        ['h04', uuid(2), [uuid(3), uuid(4), uuid(5)], 'a uuid cursor is read as an index'],
        ['f05-drops', '3', ['4', '5', '6'], 'the next three of the loop'],
        ['f05-resumes', '3', ['4', '5', '6'], 'the rest, and then the end'],
        ['f06-resumes', '4', ['5', '6', '7', '8'], 'continues right after the cursor'],
        ['f06-skips', '4', ['8'], 'jumps three ids past the cursor: the fault of this fixture'],
    ]
    it.each(RESUME)('%s with Last-Event-ID %s sends ids %j (%s)', async (id, cursor, expected) => {
        const res = await fetch(server.urlFor(id, { scale: SCALE }), { headers: { 'Last-Event-ID': cursor } })
        await res.arrayBuffer()
        const entry = server.groundTruth.of(id).at(-1)!
        expect(entry.requestHeaders['last-event-id']).toBe(cursor)
        expect(frameLog(entry).filter((f) => f.id !== null).map((f) => f.id)).toEqual(expected)
    }, 15_000)

    it('f05-drops?ignore=1 ignores the cursor and starts again from 1 (the fixture of an unresumable server)', async () => {
        const res = await fetch(server.urlFor('f05-drops', { scale: SCALE, ignore: 1 }), { headers: { 'Last-Event-ID': '3' } })
        await res.arrayBuffer()
        expect(frameLog(server.groundTruth.of('f05-drops').at(-1)!).filter((f) => f.id !== null).map((f) => f.id)).toEqual(['1', '2', '3'])
    })
})

describe('the contract check can fail (a check that cannot fail proves nothing)', () => {
    let result: Result
    beforeAll(async () => { result = await fetchRoute(server, 'h01', 5, 'end-event') })

    const base = CONTRACTS['h01']!
    const flaws = (c: Contract): string => violations('h01', c, result, server).join(' | ')

    it('the true contract passes', () => { expect(flaws(base)).toBe('') })
    it('a wrong status is reported', () => { expect(flaws({ ...base, status: 201 })).toContain('status 200, the contract says 201') })
    it('a wrong content type is reported', () => { expect(flaws({ ...base, contentType: 'application/json' })).toContain('Content-Type') })
    it('a missing id is reported', () => { expect(flaws({ ...base, ids: ['1', '2', '3', '5'] })).toContain('ids on the wire') })
    it('a wrong event count is reported', () => { expect(flaws({ ...base, events: 5 })).toContain('6 complete events, the contract says 5') })
    it('comments that were not declared are reported', () => { expect(flaws({ ...base, comments: 2 })).toContain('0 comment frames, the contract says 2') })
    it('a byte count that is one off is reported', () => { expect(flaws({ ...base, bytes: 189 })).toContain('188 bytes written, the contract says 189') })
    it('an ending that is not the real one is reported', () => {
        expect(flaws({ ...base, ending: 'closes' })).toContain('an "end" event was sent')
        expect(flaws({ ...base, ending: 'open' })).toContain('the contract says it stays open')
    })
    it('a reconnect declared for a stream that finishes is reported', () => { expect(flaws({ ...base, reconnect: true })).toContain('expects a reconnect') })
    it('an unterminated frame that is not there is reported', () => { expect(flaws({ ...base, unterminated: true })).toContain('the body ends with a complete frame') })
    it('a route that is too slow for its ceiling is reported', () => {
        const slow = { ...result, durationMs: 5000 }
        expect(violations('h01', { ...base, scale1Ms: 5000, wakeups: 6 }, slow, server).join(' | ')).toContain('took 5000 ms')
    })
    it('a route with no contract is reported by the check that keeps routes honest', () => {
        expect(routesWithoutContract(['h01', 'f99-new'], CONTRACTS)).toEqual(['f99-new'])
        expect(routesWithoutContract(['f08-echo'], CONTRACTS)).toEqual([])
    })
})
