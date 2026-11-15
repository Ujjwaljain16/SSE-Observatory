// @vitest-environment node
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { main, EXIT, type CliIo } from '../index'

// Owner decision Q6, for scenarios: `sse-doctor test` follows the target through the same rule as probe. A redirect to ANOTHER origin while the
// scenario carries a secret (a header or a query value that comes from `${ENV:NAME}`) is refused, naming what is attached and never a value, unless
// `--follow-redirects` opts in; then it is followed and the secret stays behind (a warning says which). A redirect inside one origin continues
// with the headers, and a scenario that carries no secret follows a redirect as always. The oracle is the second server's own request log.

const KEY = 'scenario-CANARY-key-3d91f0'
const TOKEN = 'scenario-CANARY-query-77ab12'

interface Seen { url: string; headers: Record<string, string | string[] | undefined>; raw: string }
const servers: http.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })

async function serve(log: Seen[], handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
    const s = http.createServer((req, res) => {
        log.push({ url: req.url ?? '', headers: { ...req.headers }, raw: `${req.method} ${req.url}\n${req.rawHeaders.join('\n')}` })
        handler(req, res)
    })
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}
const events = (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('id: 1\ndata: a\n\nid: 2\ndata: b\n\n')
}
const redirect = (res: http.ServerResponse, to: string) => { res.writeHead(302, { Location: to }); res.end() }

function host(files: Record<string, string>, env: Record<string, string>) {
    let out = ''
    let err = ''
    const io: CliIo = {
        out: (t) => { out += t }, err: (t) => { err += t },
        readText: async (p) => { if (p in files) return files[p]!; throw new Error('ENOENT') },
        writeText: async () => undefined,
        env,
    }
    return { io, get out() { return out }, get err() { return err } }
}

const scenario = (target: Record<string, unknown>) => JSON.stringify({ version: 1, name: 'redirect', target, steps: [{ collect_events: 2, timeout_ms: 8000 }], verify: [] })
const WITH_KEY = (): string => scenario({ url: '${ENV:STREAM_URL}', headers: { 'X-Api-Key': '${ENV:STREAM_KEY}' } })
const WITH_QUERY = (): string => scenario({ url: '${ENV:STREAM_URL}?token=${ENV:STREAM_TOKEN}' })
const NO_SECRET = (): string => scenario({ url: '${ENV:STREAM_URL}' })

describe('a scenario and a redirect to another origin (Q6)', () => {
    it('refuses it while a header from the environment is attached: B is never contacted, the message names the header and the flag, no value', async () => {
        const b: Seen[] = []
        const a: Seen[] = []
        const B = await serve(b, events)
        const A = await serve(a, (_req, res) => redirect(res, `${B}/stream`))
        const h = host({ 's.json': WITH_KEY() }, { STREAM_URL: `${A}/s`, STREAM_KEY: KEY })
        const code = await main(['test', 's.json'], h.io)
        expect(code, `${h.out}${h.err}`).toBe(EXIT.couldNotRun)
        expect(b, 'the other origin was never contacted').toHaveLength(0)
        expect(a.length, 'the first origin was asked').toBeGreaterThanOrEqual(1)
        const said = h.out + h.err
        expect(said).toContain('X-Api-Key')
        expect(said).toContain('--follow-redirects')
        expect(said).toContain(new URL(B).origin)
        expect(said, 'no secret value is printed').not.toContain(KEY)
    })

    it('refuses it for a query value from the environment too, naming the variable and not its value', async () => {
        const b: Seen[] = []
        const B = await serve(b, events)
        const A = await serve([], (_req, res) => redirect(res, `${B}/stream`))
        const h = host({ 's.json': WITH_QUERY() }, { STREAM_URL: `${A}/s`, STREAM_TOKEN: TOKEN })
        expect(await main(['test', 's.json'], h.io), `${h.out}${h.err}`).toBe(EXIT.couldNotRun)
        expect(b).toHaveLength(0)
        expect(h.out + h.err).toContain('STREAM_TOKEN')
        expect(h.out + h.err).not.toContain(TOKEN)
    })

    it('follows it with --follow-redirects, and the secret does not go along; the warning names what stayed behind', async () => {
        const b: Seen[] = []
        const B = await serve(b, events)
        const A = await serve([], (_req, res) => redirect(res, `${B}/stream`))
        const h = host({ 's.json': WITH_KEY() }, { STREAM_URL: `${A}/s`, STREAM_KEY: KEY })
        const code = await main(['test', 's.json', '--follow-redirects'], h.io)
        expect(code, `${h.out}${h.err}`).toBe(EXIT.ok)
        expect(b.length, 'B answered').toBeGreaterThanOrEqual(1)
        expect(JSON.stringify(b), 'B never saw the key').not.toContain(KEY)
        expect(b.every((r) => r.headers['x-api-key'] === undefined)).toBe(true)
        expect(h.err).toContain('NOT forwarded')
        expect(h.err).toContain('X-Api-Key')
        expect(h.out + h.err, 'no secret value is printed').not.toContain(KEY)
    })

    it('a redirect inside one origin continues with the headers, with or without the flag, and says nothing', async () => {
        const seen: Seen[] = []
        const A = await serve(seen, (req, res) => { if (req.url === '/s') redirect(res, '/final'); else events(req, res) })
        for (const extra of [[], ['--follow-redirects']]) {
            seen.length = 0
            const h = host({ 's.json': WITH_KEY() }, { STREAM_URL: `${A}/s`, STREAM_KEY: KEY })
            expect(await main(['test', 's.json', ...extra], h.io), `${h.out}${h.err}`).toBe(EXIT.ok)
            const final = seen.filter((r) => r.url === '/final')
            expect(final.length).toBeGreaterThanOrEqual(1)
            expect(final.every((r) => r.headers['x-api-key'] === KEY), 'the same origin keeps the header').toBe(true)
            expect(h.err).not.toContain('NOT forwarded')
        }
    })

    it('a scenario with no secret follows a redirect to another origin as before, silently (the address alone is not a credential)', async () => {
        const b: Seen[] = []
        const B = await serve(b, events)
        const A = await serve([], (_req, res) => redirect(res, `${B}/stream`))
        const h = host({ 's.json': NO_SECRET() }, { STREAM_URL: `${A}/s` })
        expect(await main(['test', 's.json'], h.io), `${h.out}${h.err}`).toBe(EXIT.ok)
        expect(b.length).toBeGreaterThanOrEqual(1)
        expect(h.err).toBe('')
    })
})
