// @vitest-environment node
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { main, EXIT, type CliIo } from '../index'

// Campaign E5 (plan 3.5, suspected defect 7.3 #7, security review S14), the URL given on the command line, through the real `main()`.
// A URL typed in argv may carry a secret (user:password@, ?token=) and may be hostile or odd (an unsupported scheme, a control character, 100 KB, an
// IPv6 literal, `localhost`). Each case must (1) return within --duration + 5 s, (2) exit with the code the CLI documents (2 for what it cannot
// accept, 3 for a connection that could not be made, 0 for a stream that answered), and (3) never print the CANARY, on stdout, on stderr or in a
// file it wrote. A canary check is only worth something if the canary is known to reach the code that could leak it: each case that needs it has
// a positive control (the server saw the value) or a refused request (the value was in the URL that the error message names).

const CANARY = 'CANARY-argv-5e9b21c7'
const CANARY2 = 'CANARY-query-a04d77f3'
/** Every spelling of a canary that an output could contain. */
const spellings = (c: string) => [c, encodeURIComponent(c), Buffer.from(c).toString('base64'), Buffer.from(c).toString('base64').replace(/=+$/, '')]
/** Any raw C0 control (but tab, LF, CR), DEL or C1: what drives a terminal. */
const RAW_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
const LEAKS = [...spellings(CANARY), ...spellings(CANARY2)]

function host(env: Record<string, string> = {}) {
    const written: Record<string, string> = {}
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t },
        readText: async () => { throw new Error('ENOENT') }, writeText: async (p, t) => { written[p] = t },
        env,
    }
    return { io, written, get out() { return out }, get err() { return err }, get everything() { return out + err + Object.values(written).join('\n') } }
}

const servers: http.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })
interface Seen { url: string; headers: http.IncomingHttpHeaders }
async function serve(log: Seen[] = [], bind = '127.0.0.1', handler?: http.RequestListener): Promise<{ port: number }> {
    const s = http.createServer(handler ?? ((req, res) => {
        log.push({ url: req.url ?? '', headers: { ...req.headers } })
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('id: 1\ndata: hello\n\n')
        setTimeout(() => res.end(), 20)
    }))
    servers.push(s)
    await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(0, bind, () => resolve()) })
    return { port: (s.address() as AddressInfo).port }
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
    const s = net.createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    const port = (s.address() as AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    return port
}

const DURATION = 2
interface Run { code: number; ms: number; h: ReturnType<typeof host> }
async function probe(url: string, extra: string[] = [], env: Record<string, string> = {}): Promise<Run> {
    const h = host(env)
    const t0 = Date.now()
    const code = await main(['probe', url, '--duration', String(DURATION), '--max-events', '1', ...extra], h.io)
    return { code, ms: Date.now() - t0, h }
}
const bounded = (r: Run, what: string) => expect(r.ms, `${what} took ${r.ms} ms`).toBeLessThan(DURATION * 1000 + 5000)
const noCanary = (r: Run, what: string) => { for (const leak of LEAKS) expect(r.h.everything, `${what}: ${leak} appeared in the output`).not.toContain(leak) }

describe('E5: a secret typed into the URL never comes back out', () => {
    it('user:CANARY@ on a refused connection: exit 3, bounded, the capture file is written and holds no canary', async () => {
        const port = await closedPort()
        const r = await probe(`http://user:${CANARY}@127.0.0.1:${port}/s`, ['--out', 'p.sse-capture'])
        expect(r.code).toBe(EXIT.couldNotRun)
        bounded(r, 'userinfo, refused')
        expect(Object.keys(r.h.written), 'a file was written, so the check covers it').toEqual(['p.sse-capture'])
        expect(r.h.written['p.sse-capture']!.length).toBeGreaterThan(100)
        expect(r.h.out).toContain('127.0.0.1') // the host is still shown, so the output is not just empty
        noCanary(r, 'userinfo, refused')
    }, 30_000)

    it('user:CANARY@ against a live server (the platform refuses credentials in a URL, and its message names the URL): nothing leaks, nothing is sent', async () => {
        const seen: Seen[] = []
        const { port } = await serve(seen)
        const r = await probe(`http://user:${CANARY}@127.0.0.1:${port}/s`, ['--out', 'p.sse-capture'])
        bounded(r, 'userinfo, live')
        // pinned: credentials in the URL are not turned into a Basic header; the request is not made at all
        expect(seen.filter((s) => s.headers['authorization'] !== undefined)).toEqual([])
        expect(r.code).toBe(EXIT.couldNotRun)
        expect(Object.keys(r.h.written)).toEqual(['p.sse-capture'])
        noCanary(r, 'userinfo, live')
    }, 30_000)

    // The checks above pass for two reasons: the registry knows the values typed in the URL, AND the shape redaction of the capture removes a URL's
    // userinfo and query by itself. With --no-redact the capture is written as recorded, so only the registry stands between the URL's secrets and
    // the file: this is the case that fails if `requestFor` stops registering what the URL carries (shown by removing those lines, see the report).
    it('--no-redact (the capture is written as recorded): the registry alone still keeps the URL\'s user name, password and query values out of every sink', async () => {
        const seen: Seen[] = []
        const { port } = await serve(seen)
        const closed = await closedPort()
        for (const base of [`127.0.0.1:${closed}`, `127.0.0.1:${port}`]) {
            const url = `http://${CANARY}:${CANARY2}@${base}/s?token=${CANARY2}`
            const r = await probe(url, ['--no-redact', '--out', 'raw.sse-capture'])
            const file = r.h.written['raw.sse-capture']!
            expect(file, 'the capture was written as recorded: the URL and the platform\'s error message are in it').toMatch(/"url":"http:\/\/.*@?127\.0\.0\.1/)
            // a mask is where the values were: the registry's "[REDACTED]", or the client's own "[redacted]" (a URL quoted in a browser or fetch error
            // message is now masked where it is stored, a second layer in front of the registry)
            expect(file).toMatch(/\[REDACTED\]|\[redacted\]/)
            noCanary(r, `--no-redact ${base}`)
        }
    }, 40_000)

    it('CANARY as the user name alone, percent-encoded in the password, and in the query: all stay out', async () => {
        const port = await closedPort()
        const urls = [
            `http://${CANARY}@127.0.0.1:${port}/s`,
            `http://u:${encodeURIComponent(CANARY)}@127.0.0.1:${port}/s`,
            `http://u:${CANARY}@127.0.0.1:${port}/s?token=${CANARY2}&x=1`,
            `http://127.0.0.1:${port}/s?${CANARY2}=1`,
            `http://127.0.0.1:${port}/v1/${CANARY.replace(/-/g, '')}${CANARY2.replace(/-/g, '')}/stream`,
        ]
        for (const url of urls) {
            const r = await probe(url, ['--out', 'p.sse-capture'])
            expect(r.code, url).toBe(EXIT.couldNotRun)
            bounded(r, url)
            for (const leak of [...spellings(CANARY), ...spellings(CANARY2), CANARY.replace(/-/g, ''), CANARY2.replace(/-/g, '')]) expect(r.h.everything, `${url}: ${leak}`).not.toContain(leak)
        }
    }, 60_000)

    it('the other commands that take a URL do not print it either: curl <url>', async () => {
        const h = host()
        const code = await main(['curl', `http://user:${CANARY}@127.0.0.1:1/s?token=${CANARY2}`], h.io)
        expect(code).toBe(EXIT.ok)
        expect(h.out).toContain('curl')
        for (const leak of LEAKS) expect(h.out + h.err, leak).not.toContain(leak)
    })

    it('a URL the platform cannot parse is refused (2) and not quoted with its userinfo or query', async () => {
        for (const url of [`http://user:${CANARY}@[bad/x?token=${CANARY2}`, `http://user:${CANARY}@127.0.0.1:99999/x?t=${CANARY2}`, `http://user:${CANARY}@/x`]) {
            const r = await probe(url, ['--out', 'p.sse-capture'])
            expect(r.code, url).toBe(EXIT.usage)
            noCanary(r, url)
            expect(r.h.written).toEqual({})
        }
    })
})

describe('E5: schemes the probe does not accept', () => {
    const CASES = [
        `ftp://user:${CANARY}@127.0.0.1/x`, 'ftp://127.0.0.1/x', 'file:///etc/passwd', 'FILE:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/event-stream,data:x%0A%0A',
        'ws://127.0.0.1:1/x', 'wss://127.0.0.1:1/x', 'gopher://127.0.0.1/x', '//127.0.0.1/x', '127.0.0.1:1/x', 'http:/127.0.0.1/x', '', ' http://127.0.0.1:1/x', 'httpx://127.0.0.1/x',
    ]
    it.each(CASES)('%j: exit 2 with the usage line, at once, nothing opened, no canary', async (url) => {
        const r = await probe(url, ['--out', 'p.sse-capture'])
        expect(r.code).toBe(EXIT.usage)
        expect(r.ms, 'refused before any connection').toBeLessThan(1000)
        expect(r.h.err).toMatch(/Usage: sse-doctor probe <http\(s\) url>/)
        expect(r.h.written, 'no file for a request that was never made').toEqual({})
        noCanary(r, url)
    })

    it('the missing URL itself is a usage error', async () => {
        const h = host()
        expect(await main(['probe'], h.io)).toBe(EXIT.usage)
    })

    it('an upper-case scheme is accepted (the scheme is case-insensitive)', async () => {
        const { port } = await serve()
        const r = await probe(`HTTP://127.0.0.1:${port}/s`)
        expect(r.code).toBe(EXIT.ok)
    })
})

describe('E5: a hostile or odd URL cannot make the probe hang, crash or echo it', () => {
    it('a 100 KB URL (path, then userinfo and query with canaries): bounded, exit 3, canaries out', async () => {
        const port = await closedPort()
        const long = 'a'.repeat(100 * 1024)
        for (const url of [`http://127.0.0.1:${port}/${long}`, `http://u:${CANARY}@127.0.0.1:${port}/${long}?token=${CANARY2}`, `http://127.0.0.1:${port}/?q=${long}`]) {
            expect(url.length).toBeGreaterThan(100 * 1024)
            const r = await probe(url, ['--out', 'p.sse-capture'])
            expect(r.code).toBe(EXIT.couldNotRun)
            bounded(r, `100 KB URL (${url.slice(0, 40)}...)`)
            noCanary(r, '100 KB URL')
        }
    }, 60_000)

    it('a 100 KB URL against a live server: the request is bounded too (the server may refuse a long request line; either way no hang)', async () => {
        const seen: Seen[] = []
        const { port } = await serve(seen)
        const r = await probe(`http://127.0.0.1:${port}/${'b'.repeat(100 * 1024)}`)
        bounded(r, '100 KB live')
        // 0 if the server accepted it, 3 if the connection failed, and 1 if the server answered with a refusal (Node's HTTP server limits the request line
        // and says 431 on some platforms): the probe saw a failed stream and says so. All three are an answer in time; a hang or a crash is what is excluded.
        expect([EXIT.ok, EXIT.gateFailed, EXIT.couldNotRun]).toContain(r.code)
    }, 30_000)

    it('control characters in the path are percent-encoded on the wire: a CR LF cannot start a second header or request', async () => {
        const seen: Seen[] = []
        const { port } = await serve(seen)
        const r = await probe(`http://127.0.0.1:${port}/a\u0001b\u007fc\u0000d\r\nX-Injected: yes\r\n\r\nGET /second HTTP/1.1`)
        bounded(r, 'control characters')
        expect(r.code).toBe(EXIT.ok)
        expect(seen.length, 'exactly one request reached the server').toBe(1)
        expect(seen[0]!.headers['x-injected']).toBeUndefined()
        expect(seen[0]!.url).toMatch(/^\/a%01b%7Fc%00dX-Injected:%20yesGET%20\/second%20HTTP\/1\.1$/)
    }, 30_000)

    it('control characters in the host make an invalid URL: exit 2, and the message holds no raw control character or escape sequence', async () => {
        for (const url of ['http://127.0.0.1\u001b[2J:1/x', 'http://exa\u0000mple.test/x', 'http://127.0.0.1\u0007:1/x']) {
            const r = await probe(url)
            expect(r.code, JSON.stringify(url)).toBe(EXIT.usage)
            expect(r.h.err, 'the message did come out (so the check below is not vacuous)').toMatch(/is not a valid URL/)
            expect(r.h.out + r.h.err, JSON.stringify(url)).not.toMatch(RAW_CONTROL)
        }
    })

    it('other text from argv that an error message quotes is shown the same way: unknown command, unknown option, a file that cannot be read', async () => {
        const cases: Array<{ argv: string[]; code: number; message: RegExp }> = [
            { argv: ['bogus\u001b]0;pwned\u0007'], code: EXIT.usage, message: /Unknown command: bogus/ },
            { argv: ['probe', 'http://127.0.0.1:1/x', '--no\u001b[2Jpe'], code: EXIT.usage, message: /Unknown option --no/ },
            { argv: ['analyze', 'miss\u001b[2Jing.sse-capture'], code: EXIT.couldNotRun, message: /Cannot read "miss/ },
        ]
        for (const c of cases) {
            const h = host()
            expect(await main(c.argv, h.io), JSON.stringify(c.argv)).toBe(c.code)
            expect(h.err).toMatch(c.message)
            expect(h.out + h.err, JSON.stringify(c.argv)).not.toMatch(RAW_CONTROL)
        }
    })

    // `http:///x` is NOT an empty host: the WHATWG parser collapses the slashes of a special scheme, so the host is `x` (a DNS lookup, then 3).
    it('an invalid port, an empty host and a lone scheme are 2, quickly', async () => {
        for (const url of ['http://127.0.0.1:99999/x', 'http://', 'https://', 'http://exa mple.test/', 'http://127.0.0.1:-1/x']) {
            const r = await probe(url)
            expect(r.code, url).toBe(EXIT.usage)
            expect(r.ms).toBeLessThan(1000)
        }
    })

    it('port 0 and an unroutable address (192.0.2.1, TEST-NET) end within the duration and a margin, exit 3', async () => {
        for (const url of ['http://127.0.0.1:0/x', 'http://192.0.2.1:81/x']) {
            const r = await probe(url, ['--timeout', '1'])
            bounded(r, url)
            expect(r.code, url).toBe(EXIT.couldNotRun)
        }
    }, 40_000)
})

describe('E5: IPv6 literals and localhost', () => {
    it('http://[::1]:PORT on a refused port: exit 3 and bounded (the literal is parsed; nothing is looked up)', async () => {
        const r = await probe('http://[::1]:1/x')
        expect(r.code).toBe(EXIT.couldNotRun)
        bounded(r, 'ipv6 refused')
    }, 30_000)

    it('a malformed IPv6 literal is 2', async () => {
        for (const url of ['http://[::1/x', 'http://[::g]:1/x', 'http://[]:1/x', 'http://::1:1/x']) expect((await probe(url)).code, url).toBe(EXIT.usage)
    })

    it('http://[::1]:PORT against a server listening on ::1 reaches it, and the capture names the literal with its brackets', async () => {
        let port: number
        try { ({ port } = await serve([], '::1')) } catch { return } // this machine has no IPv6 loopback; the refused-port case above still ran
        const r = await probe(`http://[::1]:${port}/x`, ['--out', 'p.sse-capture'])
        expect(r.code).toBe(EXIT.ok)
        expect(r.h.written['p.sse-capture']).toContain(`[::1]:${port}`)
    }, 30_000)

    it('IPv6 literal with userinfo: the canary stays out', async () => {
        const r = await probe(`http://u:${CANARY}@[::1]:1/x?token=${CANARY2}`, ['--out', 'p.sse-capture'])
        expect(r.code).toBe(EXIT.couldNotRun)
        noCanary(r, 'ipv6 userinfo')
    }, 30_000)

    // `localhost` is resolved by the OS and may be ::1, 127.0.0.1 or both, in either order. Node 20+ tries both families (autoSelectFamily), so a server on
    // 127.0.0.1 only is still reached through `localhost`. Pinned for the Node versions the package supports (engines >= 20): the outcome is
    // bounded either way, and exit 0 means "reached".
    it('localhost reaches a server bound to 127.0.0.1 only (Node tries both address families); the outcome is bounded', async () => {
        const seen: Seen[] = []
        const { port } = await serve(seen, '127.0.0.1')
        const r = await probe(`http://localhost:${port}/x`)
        bounded(r, 'localhost -> 127.0.0.1')
        expect(r.code).toBe(EXIT.ok)
        expect(seen.length).toBeGreaterThan(0)
    }, 30_000)

    it('localhost against a server bound to ::1 only: bounded; reached (0) where localhost lists ::1, refused (3) where it does not', async () => {
        let port: number
        try { ({ port } = await serve([], '::1')) } catch { return }
        const r = await probe(`http://localhost:${port}/x`)
        bounded(r, 'localhost -> ::1')
        expect([EXIT.ok, EXIT.couldNotRun]).toContain(r.code)
    }, 30_000)
})

describe('E5: secrets in the flags that build the request do not reach the URL echo either', () => {
    it('--query-env value is registered and does not appear in the "Capture written" note, the subject line or the file', async () => {
        const port = await closedPort()
        const r = await probe(`http://127.0.0.1:${port}/s`, ['--query-env', 'token=Q', '--out', 'p.sse-capture'], { Q: CANARY })
        expect(r.code).toBe(EXIT.couldNotRun)
        expect(r.h.written['p.sse-capture']).toBeDefined()
        noCanary(r, '--query-env')
    }, 30_000)
})
