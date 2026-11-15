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
// so no custom header, no Authorization, no Cookie reach the second origin. It still FOLLOWS the redirect when told to (a CDN hop is normal).
// A redirect to ANOTHER origin while an option carries a secret is the owner's decision Q6: it is REFUSED (exit 3, naming the options and the origin)
// unless --follow-redirects opts in, and then the secrets are still never sent (a warning names which ones were not forwarded). The "Q6" block at the
// end pins that; the tests above it run with --follow-redirects, the path where a redirect is followed and the secrets must not follow it.
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
const FOLLOW = ['--follow-redirects']

const carriesNoSecret = (s: Seen) => ALL_VALUES.every((v) => !s.raw.includes(v))
const namesOf = (s: Seen) => Object.keys(s.headers)

describe('E4: a redirect to another origin', () => {
    it('set-up: the secrets do reach the origin they were meant for, in every form (a log that records nothing proves nothing)', async () => {
        const seen: Seen[] = []
        const a = await serve(seen, (_, res) => eventThenEnd(res))
        await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, ...PROBE, ...FOLLOW], host(ENV).io)
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
        const code = await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, ...PROBE, ...FOLLOW], h.io)
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
        await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, ...FOLLOW, '--max-events', '1', '--duration', '4', '--timeout', '3'], host(ENV).io)
        for (const s of atB) expect(carriesNoSecret(s), s.raw).toBe(true)
        // and the port case, deterministically
        const atB2: Seen[] = []
        const b = await serve(atB2, (_, res) => eventThenEnd(res))
        const a2 = await serve([], (_, res) => redirect(res, 302, `http://127.0.0.1:${b.port}/by-port`))
        await main(['probe', `${a2.origin}/s`, ...SECRET_FLAGS, ...PROBE, ...FOLLOW], host(ENV).io)
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
        await main(['probe', `${a.origin}/start`, ...SECRET_FLAGS, ...PROBE, ...FOLLOW], host(ENV).io)
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
        await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, ...FOLLOW, '--duration', '4'], host(ENV).io)
        expect(atB.length, 'the client reconnected at least once').toBeGreaterThan(1)
        for (const s of atB) expect(carriesNoSecret(s), s.raw).toBe(true)
        expect(atB.slice(1).some((s) => s.headers['last-event-id'] !== undefined)).toBe(true)
    }, 30_000)

    it('a Location that echoes a secret back (a server that copies the key into the redirect) does not reach stdout, stderr or the capture file', async () => {
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve([], (req, res) => redirect(res, 302, `${b.origin}/landed?echo=${encodeURIComponent(String(req.headers['x-api-key']))}`))
        const h = host(ENV)
        await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, ...PROBE, ...FOLLOW, '--out', 'cap.sse-capture'], h.io)
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

describe('Q6 (decided and implemented): a redirect to another origin when a secret is attached', () => {
    // The owner's decision: refuse a cross-origin redirect when any option supplies a secret, name the options (never the values) and the origin the
    // server redirected to, exit 3; `--follow-redirects` is the explicit opt-in (a warning on stderr names what is NOT forwarded; the secrets still never
    // leave the origin they were given for); a redirect inside the same origin continues; with no secret option nothing changes.
    const ORIGIN_MESSAGE = (origin: string) => new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

    it('REFUSED: a cross-origin redirect with secret options stops with exit 3 before the second origin is reached, naming the options and the origin, never a value', async () => {
        const atA: Seen[] = []
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve(atA, (_, res) => redirect(res, 302, `${b.origin}/landed?echo=${SECRETS.key}`))
        const h = host(ENV)
        const code = await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, ...PROBE], h.io)
        expect(code).toBe(EXIT.couldNotRun)
        expect(atA.length, 'A was asked, with the credentials the user gave for it').toBeGreaterThan(0)
        expect(atA[0]!.headers['x-api-key']).toBe(SECRETS.key)
        expect(atB, 'the second origin was never contacted').toEqual([])
        expect(h.err).toMatch(ORIGIN_MESSAGE(b.origin))
        for (const name of ['--auth-env', '--cookie-env', '--header-env X-Api-Key', '--header X-Literal', '--query-env token']) expect(h.err, name).toContain(name)
        expect(h.err).toContain('--follow-redirects')
        expect(h.err).toMatch(/redirect/i)
        expect(h.out + h.err + Object.values(h.written).join('')).not.toMatch(new RegExp(ALL_VALUES.join('|')))
    }, 30_000)

    it.each([301, 302, 303, 307, 308])('REFUSED, %i: every redirect status is refused the same way', async (status) => {
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve([], (_, res) => redirect(res, status, `${b.origin}/landed`))
        const h = host(ENV)
        expect(await main(['probe', `${a.origin}/s`, '--auth-env', 'TOKEN', ...PROBE], h.io)).toBe(EXIT.couldNotRun)
        expect(atB).toEqual([])
        expect(h.err).toContain('--auth-env')
    }, 30_000)

    // one secret option at a time: each of them, alone, is enough to refuse (the list is every option the secret registry is fed from)
    it.each([
        ['--auth-env', ['--auth-env', 'TOKEN']],
        ['--cookie-env', ['--cookie-env', 'COOKIE']],
        ['--header-env X-Api-Key', ['--header-env', 'X-Api-Key=KEY']],
        ['--header X-Literal', ['--header', `X-Literal: ${SECRETS.literal}`]],
        ['--query-env token', ['--query-env', 'token=QUERY']],
    ])('REFUSED: %s alone is a secret-bearing option', async (shown, flags) => {
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve([], (_, res) => redirect(res, 302, `${b.origin}/landed`))
        const h = host(ENV)
        expect(await main(['probe', `${a.origin}/s`, ...flags, ...PROBE], h.io)).toBe(EXIT.couldNotRun)
        expect(atB).toEqual([])
        expect(h.err).toContain(shown)
        expect(h.err + h.out).not.toMatch(new RegExp(ALL_VALUES.join('|')))
    }, 30_000)

    it('REFUSED: a secret typed into the URL (a token in the query) is a secret option too; the message does not name the parameter or print the value', async () => {
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve([], (_, res) => redirect(res, 302, `${b.origin}/landed`))
        const h = host()
        expect(await main(['probe', `${a.origin}/s?token=${SECRETS.query}&${SECRETS.literal}=1`, ...PROBE], h.io)).toBe(EXIT.couldNotRun)
        expect(atB).toEqual([])
        expect(h.err).toMatch(/URL/)
        expect(h.err).toContain('--follow-redirects')
        expect(h.err + h.out).not.toContain(SECRETS.query)
        expect(h.err + h.out).not.toContain(SECRETS.literal)
    }, 30_000)

    it('REFUSED with --format json: the refusal is on stderr like every other refusal; stdout holds no half result', async () => {
        const b = await serve([], (_, res) => eventThenEnd(res))
        const a = await serve([], (_, res) => redirect(res, 302, `${b.origin}/landed`))
        const h = host(ENV)
        expect(await main(['probe', `${a.origin}/s`, '--auth-env', 'TOKEN', '--format', 'json', ...PROBE], h.io)).toBe(EXIT.couldNotRun)
        expect(h.out).toBe('')
        expect(h.err).toMatch(/--follow-redirects/)
    }, 30_000)

    it('REFUSED: another PORT on the same host is another origin, and so is the other scheme', async () => {
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve([], (_, res) => redirect(res, 302, `http://127.0.0.1:${b.port}/by-port`))
        const h = host(ENV)
        expect(await main(['probe', `${a.origin}/s`, '--auth-env', 'TOKEN', ...PROBE], h.io)).toBe(EXIT.couldNotRun)
        expect(atB).toEqual([])
        const secure = await serve([], (_, res) => redirect(res, 302, `https://127.0.0.1:${b.port}/by-scheme`))
        const h2 = host(ENV)
        expect(await main(['probe', `${secure.origin}/s`, '--auth-env', 'TOKEN', ...PROBE], h2.io)).toBe(EXIT.couldNotRun)
        expect(h2.err).toContain('https://127.0.0.1')
    }, 30_000)

    it('OPT-IN: --follow-redirects follows, exit 0, the second origin sees no secret, and stderr warns naming what was NOT forwarded (names only)', async () => {
        const atA: Seen[] = []
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve(atA, (_, res) => redirect(res, 302, `${b.origin}/landed`))
        const h = host(ENV)
        const code = await main(['probe', `${a.origin}/s`, ...SECRET_FLAGS, ...PROBE, '--follow-redirects'], h.io)
        expect(code).toBe(EXIT.ok)
        expect(atB.length).toBeGreaterThan(0)
        for (const s of atB) expect(carriesNoSecret(s), s.raw).toBe(true)
        expect(h.out).toContain('Observed 1 event')
        expect(h.err).toMatch(/^warning: .*redirect/im)
        expect(h.err).toMatch(ORIGIN_MESSAGE(b.origin))
        expect(h.err).toMatch(/not (be )?(sent|forwarded)/i)
        for (const name of ['--auth-env', '--cookie-env', '--header-env X-Api-Key', '--header X-Literal', '--query-env token']) expect(h.err, name).toContain(name)
        expect(h.out + h.err + Object.values(h.written).join('')).not.toMatch(new RegExp(ALL_VALUES.join('|')))
    }, 30_000)

    it('OPT-IN: the warning is given once per origin, not once per reconnect', async () => {
        const atB: Seen[] = []
        let n = 0
        const b = await serve(atB, (_, res) => { n++; event(res, String(n)); setTimeout(() => res.end(), 20) })
        const a = await serve([], (_, res) => redirect(res, 302, `${b.origin}/landed`))
        const h = host(ENV)
        await main(['probe', `${a.origin}/s`, '--auth-env', 'TOKEN', '--follow-redirects', '--duration', '4'], h.io)
        expect(atB.length, 'the client reconnected at least once').toBeGreaterThan(1)
        expect(h.err.match(/not (be )?(sent|forwarded)/gi)?.length).toBe(1)
    }, 30_000)

    it('SAME ORIGIN: a redirect that stays on the origin works without the flag, keeps the secrets, exit 0, no warning', async () => {
        const atA: Seen[] = []
        const a = await serve(atA, (req, res) => { if (req.url!.startsWith('/start')) redirect(res, 302, '/same-origin'); else eventThenEnd(res) })
        const h = host(ENV)
        const code = await main(['probe', `${a.origin}/start`, ...SECRET_FLAGS, ...PROBE], h.io)
        expect(code).toBe(EXIT.ok)
        const landed = atA.find((s) => s.url.startsWith('/same-origin'))!
        expect(landed.headers['x-api-key']).toBe(SECRETS.key)
        expect(landed.headers['authorization']).toBe(`Bearer ${SECRETS.auth}`)
        expect(h.err).not.toMatch(/follow-redirects|not (be )?(sent|forwarded)/i)
    }, 30_000)

    it('NO SECRETS: a cross-origin redirect is followed as before, with and without the flag, and nothing is said', async () => {
        for (const extra of [[], ['--follow-redirects']]) {
            const atB: Seen[] = []
            const b = await serve(atB, (_, res) => eventThenEnd(res))
            const a = await serve([], (_, res) => redirect(res, 302, `${b.origin}/landed`))
            const h = host()
            // a query value that is not a secret (a number, a flag word) does not count as one
            expect(await main(['probe', `${a.origin}/s?scale=0.05&debug=true`, ...PROBE, ...extra], h.io), extra.join(' ')).toBe(EXIT.ok)
            expect(atB.length).toBeGreaterThan(0)
            expect(h.out).toContain('Observed 1 event')
            expect(h.err).toBe('')
        }
    }, 30_000)

    it('env-diff: the side that carries a secret is refused (naming the side\'s own option), the side without one follows', async () => {
        const atB: Seen[] = []
        const b = await serve(atB, (_, res) => eventThenEnd(res))
        const a = await serve([], (_, res) => redirect(res, 302, `${b.origin}/landed`))
        const plain = await serve([], (_, res) => redirect(res, 302, `${b.origin}/plain`))
        const refused = host(ENV)
        expect(await main(['env-diff', `${a.origin}/s`, `${plain.origin}/s`, '--auth-env-a', 'TOKEN', ...PROBE], refused.io)).toBe(EXIT.couldNotRun)
        expect(refused.err).toContain('--auth-env-a')
        expect(refused.err).toContain('--follow-redirects')
        expect(refused.err).not.toContain(SECRETS.auth)
        expect(atB.some((s) => s.url === '/landed'), 'the secret-bearing side never reached B').toBe(false)
        const followed = host(ENV)
        expect(await main(['env-diff', `${a.origin}/s`, `${plain.origin}/s`, '--auth-env-a', 'TOKEN', '--follow-redirects', ...PROBE], followed.io)).toBe(EXIT.ok)
        for (const s of atB) expect(carriesNoSecret(s), s.raw).toBe(true)
        expect(followed.err).toContain('--auth-env-a')
    }, 40_000)

    it('the help text and the option parser know --follow-redirects', async () => {
        const h = host()
        expect(await main(['--help'], h.io)).toBe(EXIT.ok)
        expect(h.out).toContain('--follow-redirects')
    })
})
