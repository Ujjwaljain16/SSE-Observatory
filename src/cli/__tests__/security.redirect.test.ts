// @vitest-environment node
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { main, EXIT, type CliIo } from '../index'

// Campaign E4 (plan 3.5, suspected defect 7.3 #4, security review S12), redirects and header forwarding, through the real `main()` probe.
//
// What the platform does: `fetch` follows a redirect itself and, on another origin, drops only Authorization, Cookie and Proxy-Authorization.
// A key sent as `X-Api-Key` would follow. What this CLI does today (safeFetch.ts, the S12 fix): it follows redirects BY HAND (at most 5 hops) and
// once the origin changes it keeps only an allow-list of headers that describe the request (Accept, Cache-Control, Last-Event-ID, User-Agent, ...),
// so no custom header, no Authorization, no Cookie reach the second origin. It still FOLLOWS the redirect (a CDN hop is normal).
// That last point is the owner's decision Q6 (follow with stripped headers, refuse when a secret is attached, or always refuse). Nothing here
// changes it: the tests pin today's behaviour, and the "Q6" block says exactly what it is, so a change of policy shows up as a failing test.
//
// Oracle: the request log of the second server (B), recorded as the server saw it (raw header names and values and the URL), searched for the
// secret VALUES, not only for header names, so a secret that moves to another header or into the URL is caught too.

const SECRETS = {
    key: 'xapikey-CANARY-7f3a91',
    auth: 'bearer-CANARY-2c8d40',
    cookie: 'session=CANARY-cookie-55e1',
    literal: 'literal-CANARY-9b07d2',
    query: 'query-CANARY-61ac3e',
}
const ALL_VALUES = Object.values(SECRETS).flatMap((v) => [v, v.split('=').pop()!])

interface Seen { url: string; method: string; headers: Record<string, string | string[] | undefined>; raw: string }

function host(env: Record<string, string> = {}) {
    const written: Record<string, string> = {}
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t },
        readText: async () => { throw new Error('ENOENT') }, writeText: async (p, t) => { written[p] = t },
        env,
    }
    return { io, written, get out() { return out }, get err() { return err } }
}

const servers: http.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })

/** A server whose every request is logged as the server saw it. `handler` answers. */
async function serve(log: Seen[], handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ origin: string; port: number }> {
    const s = http.createServer((req, res) => {
        log.push({ url: req.url ?? '', method: req.method ?? '', headers: { ...req.headers }, raw: `${req.method} ${req.url}\n${req.rawHeaders.join('\n')}` })
        handler(req, res)
    })
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const port = (s.address() as AddressInfo).port
    return { origin: `http://127.0.0.1:${port}`, port }
}

const event = (res: http.ServerResponse, id = '1') => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`id: ${id}\ndata: hello\n\n`)
}
/** Answers one event, then ends: the client reconnects, so B is hit more than once. */
const eventThenEnd = (res: http.ServerResponse) => { event(res); setTimeout(() => res.end(), 20) }
const redirect = (res: http.ServerResponse, status: number, location: string) => { res.writeHead(status, { Location: location }); res.end() }

const ENV = { KEY: SECRETS.key, TOKEN: SECRETS.auth, COOKIE: SECRETS.cookie, QUERY: SECRETS.query }
/** Every way the CLI can attach a secret to a request, at once. */
const SECRET_FLAGS = ['--header-env', 'X-Api-Key=KEY', '--auth-env', 'TOKEN', '--cookie-env', 'COOKIE', '--header', `X-Literal: ${SECRETS.literal}`, '--query-env', 'token=QUERY']
const PROBE = ['--max-events', '1', '--duration', '8']

const carriesNoSecret = (s: Seen) => ALL_VALUES.every((v) => !s.raw.includes(v))
const namesOf = (s: Seen) => Object.keys(s.headers)

describe('E4: a redirect to another origin', () => {
    it('set-up: the secrets do reach the origin they were meant for, in every form (a log that records nothing proves nothing)', async () => {
        const seen: Seen[] = []
        const a = await serve(seen, (_, res) => eventThenEnd(res))
        await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, ...PROBE], host(ENV).io)
        const first = seen[0]!
        expect(first.headers['x-api-key']).toBe(SECRETS.key)
        expect(first.headers['authorization']).toBe(`Bearer ${SECRETS.auth}`)
        expect(first.headers['cookie']).toBe(SECRETS.cookie)
        expect(first.headers['x-literal']).toBe(SECRETS.literal)
        expect(first.url).toContain(`token=${SECRETS.query}`)
    })

    it.each([301, 302, 303, 307, 308])('%i: B receives none of the secrets (headers, cookie, authorization, query) and the probe still gets its stream', async (status) => {
        const atA: Seen[] = []
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve(atA, (_, res) => redirect(res, status, `${b.origin}/landed`))
        const h = host(ENV)
        const code = await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, ...PROBE], h.io)
        expect(atA.length).toBeGreaterThan(0)
        expect(atA[0]!.headers['x-api-key']).toBe(SECRETS.key) // the key did leave the machine for A, as the user asked
        expect(atB.length, 'B was reached (so the absence below is not because nothing was followed)').toBeGreaterThan(0)
        for (const s of atB) {
            expect(carriesNoSecret(s), `B saw a secret:\n${s.raw}`).toBe(true)
            const names = namesOf(s)
            expect(names).not.toContain('x-api-key')
            expect(names).not.toContain('authorization')
            expect(names).not.toContain('cookie')
            expect(names).not.toContain('x-literal')
            expect(s.url).toBe('/landed')
            expect(s.headers['accept']).toBe('text/event-stream')
        }
        expect(code).toBe(EXIT.ok)
        expect(h.out + h.err + Object.values(h.written).join('')).not.toMatch(new RegExp(ALL_VALUES.join('|')))
    }, 30_000)

    it('the same host on another PORT is another origin; so is another HOST name on the same port (127.0.0.1 vs localhost)', async () => {
        const atB: Seen[] = []
        const same = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve([], (_, res) => redirect(res, 302, `http://localhost:${same.port}/by-name`))
        // `same` listens on 127.0.0.1 only; whether `localhost` reaches it depends on how the OS orders ::1 and 127.0.0.1. Either way, nothing secret goes.
        await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, '--max-events', '1', '--duration', '4', '--timeout', '3'], host(ENV).io)
        for (const s of atB) expect(carriesNoSecret(s), s.raw).toBe(true)
        // and the port case, deterministically
        const atB2: Seen[] = []
        const b = await serve(atB2, (_, res) => eventThenEnd(res))
        const a2 = await serve([], (_, res) => redirect(res, 302, `http://127.0.0.1:${b.port}/by-port`))
        await main(['probe', `${a2.origin}/s`, ...SECRET_FLAGS, ...PROBE], host(ENV).io)
        expect(atB2.length).toBeGreaterThan(0)
        for (const s of atB2) expect(carriesNoSecret(s), s.raw).toBe(true)
    }, 40_000)

    it('a relative redirect that stays on A keeps the secrets; a hop out and back to A does NOT get them back', async () => {
        const atA: Seen[] = []
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => redirect(res, 302, `${a.origin}/back`))
        const a = await serve(atA, (req, res) => {
            if (req.url!.startsWith('/start')) redirect(res, 302, '/same-origin')
            else if (req.url === '/same-origin') redirect(res, 302, `${b.origin}/out`)
            else eventThenEnd(res) // /back
        })
        await main(['probe', `${a.origin}/start`, ...SECRET_FLAGS, ...PROBE], host(ENV).io)
        const sameOrigin = atA.find((s) => s.url === '/same-origin')!
        expect(sameOrigin.headers['x-api-key'], 'inside the origin the key stays').toBe(SECRETS.key)
        expect(sameOrigin.headers['authorization']).toBe(`Bearer ${SECRETS.auth}`)
        const out = atB.find((s) => s.url === '/out')!
        expect(carriesNoSecret(out)).toBe(true)
        const back = atA.find((s) => s.url === '/back')!
        expect(back, 'the chain reached /back').toBeDefined()
        expect(carriesNoSecret(back), 'once a request has left the origin the secrets are not restored when it returns').toBe(true)
    }, 30_000)

    it('every reconnect keeps the rule: B is hit repeatedly, each time without secrets, and keeps Last-Event-ID (it says where to resume)', async () => {
        const atB: Seen[] = []
        let n = 0
        const b = await serve(atB, (_, res) => { n++; event(res, String(n)); setTimeout(() => res.end(), 20) })
        const a = await serve([], (_, res) => redirect(res, 302, `${b.origin}/landed`))
        await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, '--duration', '4'], host(ENV).io)
        expect(atB.length, 'the client reconnected at least once').toBeGreaterThan(1)
        for (const s of atB) expect(carriesNoSecret(s), s.raw).toBe(true)
        expect(atB.slice(1).some((s) => s.headers['last-event-id'] !== undefined)).toBe(true)
    }, 30_000)

    it('a Location that echoes a secret back (a server that copies the key into the redirect) does not reach stdout, stderr or the capture file', async () => {
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve([], (req, res) => redirect(res, 302, `${b.origin}/landed?echo=${encodeURIComponent(String(req.headers['x-api-key']))}`))
        const h = host(ENV)
        await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, ...PROBE, '--out', 'cap.sse-capture'], h.io)
        expect(atB.length).toBeGreaterThan(0)
        const everything = h.out + h.err + Object.values(h.written).join('')
        expect(Object.keys(h.written)).toEqual(['cap.sse-capture'])
        for (const v of ALL_VALUES) expect(everything, v).not.toContain(v)
    }, 30_000)

    it('a redirect to a scheme that is not http(s) is refused, and no secret is printed; a redirect loop stops (5 hops) with a bounded outcome', async () => {
        const odd = await serve([], (_, res) => redirect(res, 302, 'file:///etc/passwd'))
        const ho = host(ENV)
        const t0 = Date.now()
        const codeOdd = await main(['probe', `${odd.origin}/s`, ...SECRET_FLAGS, '--duration', '3', '--timeout', '2'], ho.io)
        expect(codeOdd).toBe(EXIT.couldNotRun)
        expect(Date.now() - t0).toBeLessThan(3000 + 5000)
        const loop = await serve([], (req, res) => redirect(res, 302, `${req.url}x`))
        const hl = host(ENV)
        const t1 = Date.now()
        const codeLoop = await main(['probe', `${loop.origin}/s`, ...SECRET_FLAGS, '--duration', '3', '--timeout', '2'], hl.io)
        expect(codeLoop).toBe(EXIT.couldNotRun)
        expect(Date.now() - t1).toBeLessThan(3000 + 5000)
        for (const x of [ho, hl]) expect(x.out + x.err).not.toMatch(new RegExp(ALL_VALUES.join('|')))
    }, 40_000)
})

describe('E4 / Q6 (open decision): what the CLI does today with a cross-origin redirect when secrets are attached', () => {
    // The plan's recommended default for Q6 was: refuse a cross-origin redirect when a secret is attached (exit 3, a clear message), follow
    // same-origin ones, offer `--follow-redirects` to opt in. TODAY the CLI follows, minus the secrets. These tests pin that, so choosing another
    // policy is a deliberate change: update them together with safeFetch.ts and docs/guide/cli.md.
    it('pin: the redirect is followed (B is reached) and the probe succeeds with exit 0, saying nothing on stdout/stderr about the secrets being withheld', async () => {
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve([], (_, res) => redirect(res, 302, `${b.origin}/landed`))
        const h = host(ENV)
        const code = await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, ...PROBE], h.io)
        expect(atB.length).toBeGreaterThan(0)
        expect(code).toBe(EXIT.ok)
        expect(h.out).toContain('Observed 1 event')
        // the user is not told that the key was withheld from the second origin (open: a note would help; B will probably answer 401 in real life)
        expect(h.out + h.err).not.toMatch(/withheld|not sent|another origin|cross-origin/i)
    }, 30_000)

    it('pin: without secrets the redirect is followed too and nothing is different (the policy only matters when a secret is attached)', async () => {
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve([], (_, res) => redirect(res, 302, `${b.origin}/landed`))
        const h = host()
        expect(await main(['probe', `${a.origin}/s`, ...PROBE], h.io)).toBe(EXIT.ok)
        expect(atB.length).toBeGreaterThan(0)
    }, 30_000)
})
