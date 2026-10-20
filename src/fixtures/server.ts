/**
 * Fixture streams with known faults, and healthy twins, for testing the diagnostics against real sockets.
 *
 * `startFixtureServer({ port: 0 })` binds a plain node http server to 127.0.0.1 and serves every route below. Each
 * route declares which findings it must produce, which must never appear, and its healthy twin. The server honours
 * `Last-Event-ID` (events carry ids, a reconnect continues after the id it sends), answers CORS including the
 * preflight for `Last-Event-ID` and `Authorization`, and scales every delay by `?scale=` (default 1, so a 15 s
 * heartbeat is 15 s; tests pass a small scale). `?n=` sets how many events a route sends before it finishes.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FixtureRoute {
    id: string
    path: string
    title: string
    description: string
    /** Finding keys (or key prefixes) the diagnostics must report for this stream. */
    expectedFindings: string[]
    /** Finding keys or prefixes that must NOT appear. `'*'` means no finding at all (a healthy twin). */
    forbiddenFindings: string[]
    /** The route that behaves correctly, to compare against. */
    healthyTwin: string | null
    /** Which fixture family of the plan this belongs to (F01..F08, H01..H04). */
    family: string
}

const FINDINGS_NEVER_ON_HEALTHY = ['*']

export const FIXTURE_ROUTES: FixtureRoute[] = [
    { id: 'f01-text-plain', family: 'F01', path: '/f01/text-plain', title: 'Wrong content type: text/plain', description: 'A 200 response labelled text/plain.', expectedFindings: ['proto.content-type'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f01-text-html', family: 'F01', path: '/f01/text-html', title: 'Wrong content type: text/html', description: 'A 200 response labelled text/html, like an error or login page.', expectedFindings: ['proto.content-type'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f01-json', family: 'F01', path: '/f01/application-json', title: 'Wrong content type: application/json', description: 'A 200 JSON response.', expectedFindings: ['proto.content-type'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f01-401', family: 'F01', path: '/f01/401', title: 'HTTP 401', description: 'Credentials rejected.', expectedFindings: ['http.status'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f01-404', family: 'F01', path: '/f01/404', title: 'HTTP 404', description: 'No such stream.', expectedFindings: ['http.status'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f01-502', family: 'F01', path: '/f01/502', title: 'HTTP 502', description: 'A gateway error (retryable).', expectedFindings: ['http.status'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'f02-closed', family: 'F02', path: '/f02/closed', title: 'Event never terminated, connection closed', description: '"data: x" with no blank line, then the connection closes.', expectedFindings: ['proto.framing:UNTERMINATED_FRAME'], forbiddenFindings: ['proto.content-type'], healthyTwin: 'h01' },
    { id: 'f02-open', family: 'F02', path: '/f02/open', title: 'Event never terminated, connection open', description: '"data: x" with no blank line and the connection stays open. R05(iii) would name this; it is not evaluated yet, so the silence is reported.', expectedFindings: ['stall.silent:bytes'], forbiddenFindings: ['proto.content-type'], healthyTwin: 'h01' },
    { id: 'f04-silent', family: 'F04', path: '/f04/silent', title: 'Events, then silence', description: 'N events one second apart, then nothing at all.', expectedFindings: ['stall.silent:bytes'], forbiddenFindings: ['stall.silent:origin', 'stall.silent:events'], healthyTwin: 'h02' },
    { id: 'f04-heartbeats', family: 'F04', path: '/f04/heartbeats', title: 'Events, then heartbeats only', description: 'N events, then only origin comments.', expectedFindings: ['stall.silent:events'], forbiddenFindings: ['stall.silent:bytes', 'stall.silent:origin'], healthyTwin: 'h02' },
    { id: 'f04-masked', family: 'F04', path: '/f04/masked', title: 'Events, then only proxy heartbeats', description: 'N events, then only proxy-tagged comments: the proxy hides an upstream stall.', expectedFindings: ['stall.silent:origin'], forbiddenFindings: ['stall.silent:bytes'], healthyTwin: 'h02' },
    { id: 'f08-token', family: 'F08', path: '/f08', title: 'Token in the URL', description: 'Requires ?token=; the value is a canary that must never appear in any output.', expectedFindings: ['security.credentials-in-metadata:url'], forbiddenFindings: ['stall.silent'], healthyTwin: 'h01' },
    { id: 'h01', family: 'H01', path: '/h01', title: 'Healthy: steady 1 s events', description: 'One event per second.', expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null },
    { id: 'h02', family: 'H02', path: '/h02', title: 'Healthy: sparse events with 15 s heartbeats', description: 'An event every 20 s, a heartbeat comment every 15 s.', expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null },
    { id: 'h03', family: 'H03', path: '/h03', title: 'Healthy: CRLF, split multi-byte UTF-8, comments', description: 'CRLF line endings, characters split across writes, comments.', expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null },
    { id: 'h04', family: 'H04', path: '/h04', title: 'Healthy: uuid ids', description: 'Steady events with uuid ids and resume support.', expectedFindings: [], forbiddenFindings: FINDINGS_NEVER_ON_HEALTHY, healthyTwin: null },
]

export interface FixtureServerOptions { port?: number; host?: string }

export interface FixtureServer {
    /** `http://127.0.0.1:<port>` */
    url: string
    port: number
    routes: FixtureRoute[]
    /** Full URL of a route by id, with optional query parameters. */
    urlFor(id: string, query?: Record<string, string | number>): string
    close(): Promise<void>
}

interface Ctx {
    req: http.IncomingMessage
    res: http.ServerResponse
    query: URLSearchParams
    scale: number
    /** Events to send before finishing. */
    n: number
    /** Index of the first event to send (from Last-Event-ID). */
    from: number
    write(chunk: string | Uint8Array): void
    /** Waits `ms` x scale. Resolves false when the client has gone. */
    sleep(ms: number): Promise<boolean>
    closed(): boolean
}

type Script = (ctx: Ctx) => Promise<void>

const STREAM_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' }

const numericId = (i: number) => String(i + 1)
const uuidId = (i: number) => `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`

const frame = (id: string, name: string, data: string, eol = '\n') =>
    `id: ${id}${eol}${name === 'message' ? '' : `event: ${name}${eol}`}data: ${data}${eol}${eol}`

/** Events sent one after another at a fixed interval, each carrying an id. */
function steady(idOf: (i: number) => string, intervalMs: number): Script {
    return async (ctx) => {
        for (let i = ctx.from; i < ctx.n; i++) {
            if (!(await ctx.sleep(intervalMs))) return
            ctx.write(frame(idOf(i), 'tick', JSON.stringify({ n: i + 1 })))
        }
        ctx.write('event: end\ndata: done\n\n')
    }
}

const lead = (ctx: Ctx, n: number, intervalMs: number) => (async () => {
    for (let i = ctx.from; i < n; i++) {
        if (!(await ctx.sleep(intervalMs))) return false
        ctx.write(frame(numericId(i), 'tick', JSON.stringify({ n: i + 1 })))
    }
    return true
})()

const SCRIPTS: Record<string, Script> = {
    '/h01': steady(numericId, 1000),
    '/h04': steady(uuidId, 1000),

    '/h02': async (ctx) => {
        // events at 0, 20, 40 ... s and heartbeats at 15, 30, 45 ... s
        const events = Math.min(ctx.n, 6)
        const timeline: Array<{ at: number; text: string }> = []
        for (let i = ctx.from; i < events; i++) timeline.push({ at: (i - ctx.from) * 20_000, text: frame(numericId(i), 'tick', JSON.stringify({ n: i + 1 })) })
        const horizon = Math.max(0, (events - 1 - ctx.from) * 20_000)
        for (let t = 15_000; t < horizon; t += 15_000) timeline.push({ at: t, text: ': keep-alive\n\n' })
        timeline.sort((a, b) => a.at - b.at)
        let now = 0
        for (const item of timeline) {
            if (!(await ctx.sleep(item.at - now))) return
            now = item.at
            ctx.write(item.text)
        }
        ctx.write('event: end\ndata: done\n\n')
    },

    '/h03': async (ctx) => {
        // CRLF throughout, a comment, and characters whose UTF-8 bytes are split across two writes.
        ctx.write(': connected\r\n\r\n')
        const texts = ['café €5', '日本語 ✓', 'emoji 😀 ok']
        for (let i = ctx.from; i < Math.min(ctx.n, texts.length); i++) {
            if (!(await ctx.sleep(1000))) return
            const bytes = Buffer.from(frame(numericId(i), 'tick', JSON.stringify({ text: texts[i] }), '\r\n'))
            const cut = bytes.indexOf(0xc3) >= 0 ? bytes.indexOf(0xc3) + 1 : bytes.indexOf(0xe2) >= 0 ? bytes.indexOf(0xe2) + 1 : bytes.indexOf(0xf0) >= 0 ? bytes.indexOf(0xf0) + 2 : bytes.length >> 1
            ctx.write(bytes.subarray(0, cut))
            if (!(await ctx.sleep(30))) return
            ctx.write(bytes.subarray(cut))
            ctx.write(': tick\r\n\r\n')
        }
        ctx.write('event: end\r\ndata: done\r\n\r\n')
    },

    '/f02/closed': async (ctx) => {
        ctx.write('data: x')
        await ctx.sleep(50)
        ctx.res.end()
    },
    '/f02/open': async (ctx) => {
        ctx.write('data: x')
        while (await ctx.sleep(1000)) { /* hold the connection open */ }
    },

    '/f04/silent': async (ctx) => {
        if (!(await lead(ctx, ctx.n, 1000))) return
        while (await ctx.sleep(1000)) { /* nothing more, ever */ }
    },
    '/f04/heartbeats': async (ctx) => {
        if (!(await lead(ctx, ctx.n, 1000))) return
        while (await ctx.sleep(1000)) ctx.write(': keep-alive\n\n')
    },
    '/f04/masked': async (ctx) => {
        if (!(await lead(ctx, ctx.n, 1000))) return
        let k = 0
        let idle = 0
        while (await ctx.sleep(1000)) { idle += 1000; ctx.write(`: sse-proxy hb up_idle=${Math.round(idle * ctx.scale)} n=${++k}\n\n`) }
    },
}

function failure(status: number, contentType: string, body: string): http.RequestListener {
    return (_req, res) => { res.writeHead(status, { 'Content-Type': contentType }); res.end(body) }
}

const WRONG_TYPE = (contentType: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' })
    res.end('data: hello\n\n')
}

/** Parses Last-Event-ID for either id scheme: the index to continue from. */
function resumeIndex(header: string | undefined): number {
    if (!header) return 0
    const uuid = /^00000000-0000-4000-8000-([0-9a-f]{12})$/.exec(header)
    if (uuid) return parseInt(uuid[1]!, 16)
    const n = Number(header)
    return Number.isInteger(n) && n > 0 ? n : 0
}

export async function startFixtureServer(options: FixtureServerOptions = {}): Promise<FixtureServer> {
    const host = options.host ?? '127.0.0.1'
    const live = new Set<http.ServerResponse>()

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://fixture.local')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Headers', 'Last-Event-ID, Authorization, Content-Type, Cache-Control, Accept')
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
        res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Cache-Control, Content-Encoding, Content-Length, X-Accel-Buffering')
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

        const path = url.pathname
        if (path === '/') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(FIXTURE_ROUTES)); return }

        const fixed: Record<string, http.RequestListener> = {
            '/f01/text-plain': WRONG_TYPE('text/plain'),
            '/f01/text-html': WRONG_TYPE('text/html'),
            '/f01/application-json': WRONG_TYPE('application/json'),
            '/f01/401': failure(401, 'application/json', '{"error":"unauthorized"}'),
            '/f01/404': failure(404, 'application/json', '{"error":"not found"}'),
            '/f01/502': failure(502, 'text/plain', 'bad gateway'),
        }
        const fixedHandler = fixed[path]
        if (fixedHandler) { fixedHandler(req, res); return }

        // F08 needs a token, and says so the usual way when it is missing.
        if (path === '/f08' && !url.searchParams.get('token')) { failure(401, 'application/json', '{"error":"token required"}')(req, res); return }

        const script = path === '/f08' ? SCRIPTS['/h01'] : SCRIPTS[path]
        if (!script) { failure(404, 'text/plain', 'no such fixture')(req, res); return }

        const scale = Number(url.searchParams.get('scale') ?? '1')
        const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
        const defaultN = path.startsWith('/f04') ? 12 : path === '/f08' ? 3 : 5
        const n = Number(url.searchParams.get('n') ?? defaultN)
        const lastEventId = req.headers['last-event-id']
        let closed = false
        const timers = new Set<NodeJS.Timeout>()
        const wake = new Set<() => void>()
        res.on('close', () => { closed = true; live.delete(res); timers.forEach(clearTimeout); wake.forEach((w) => w()) })

        const ctx: Ctx = {
            req, res, query: url.searchParams, scale: factor, n: Number.isFinite(n) ? n : defaultN,
            from: resumeIndex(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId),
            write: (chunk) => { if (!closed) res.write(chunk) },
            closed: () => closed,
            sleep: (ms) => new Promise<boolean>((resolve) => {
                if (closed) return resolve(false)
                const done = () => { wake.delete(done); resolve(!closed) }
                wake.add(done)
                timers.add(setTimeout(() => { done() }, Math.max(0, ms * factor)))
            }),
        }

        live.add(res)
        res.writeHead(200, STREAM_HEADERS)
        res.flushHeaders()
        void script(ctx).then(() => { if (!closed) res.end() }, () => { if (!closed) res.destroy() })
    })

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port ?? 0, host, () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    const base = `http://${host}:${port}`

    return {
        url: base,
        port,
        routes: FIXTURE_ROUTES,
        urlFor(id, query = {}) {
            const route = FIXTURE_ROUTES.find((r) => r.id === id)
            if (!route) throw new Error(`unknown fixture "${id}"`)
            const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()
            return `${base}${route.path}${qs ? `?${qs}` : ''}`
        },
        async close() {
            live.forEach((r) => r.destroy())
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}
