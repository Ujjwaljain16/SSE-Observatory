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
import { baseFamily } from './base'
import { FAMILIES } from './families'
import { STREAM_HEADERS, type Ctx, type FixtureRoute, type Script } from './kit'

export type { FixtureRoute } from './kit'

export const FIXTURE_ROUTES: FixtureRoute[] = [baseFamily, ...FAMILIES].flatMap((f) => f.routes)
const SCRIPTS = Object.assign({}, baseFamily.scripts, ...FAMILIES.map((f) => f.scripts)) as Record<string, Script>
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
        const defaultN = FIXTURE_ROUTES.find((r) => r.path === path)?.defaultN ?? (path.startsWith('/f04') ? 12 : path === '/f08' ? 3 : 5)
        const n = Number(url.searchParams.get('n') ?? defaultN)
        const lastEventId = req.headers['last-event-id']
        let closed = false
        const timers = new Set<NodeJS.Timeout>()
        const wake = new Set<() => void>()
        res.on('close', () => { closed = true; live.delete(res); timers.forEach(clearTimeout); wake.forEach((w) => w()) })

        const ctx: Ctx = {
            req, res, query: url.searchParams, scale: factor, lastEventId: String(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId ?? ''), n: Number.isFinite(n) ? n : defaultN,
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
