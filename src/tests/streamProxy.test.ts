// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleSseProxy } from '../../lib/proxy/streamProxy.js'
import { loadConfig } from '../../lib/proxy/guard.js'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
const listen = (handler: Handler) =>
    new Promise<http.Server>((resolve) => {
        const s = http.createServer(handler)
        s.listen(0, '127.0.0.1', () => resolve(s))
    })
const portOf = (s: http.Server) => (s.address() as AddressInfo).port

interface Result { status: number; headers: http.IncomingHttpHeaders; body: string }
function get(port: number, path: string, headers: Record<string, string> = {}, abortAfterMs?: number): Promise<Result> {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (c) => (body += c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
            res.on('close', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
            if (abortAfterMs) setTimeout(() => req.destroy(), abortAfterMs)
        })
        req.on('error', (e) => (abortAfterMs ? resolve({ status: 0, headers: {}, body: '' }) : reject(e)))
    })
}

function post(port: number, path: string, body: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }): Promise<Result> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
            let out = ''
            res.setEncoding('utf8')
            res.on('data', (c) => (out += c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out }))
        })
        req.on('error', reject)
        req.end(body)
    })
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const devConfig = (over: object = {}) => ({ ...loadConfig({}), heartbeatMs: 30, ...over })

let upstream: http.Server
let upstreamHandler: Handler = (_req, res) => res.end()
let proxy: http.Server
let proxyConfig = devConfig()
const closers: Array<() => void> = []

beforeAll(async () => {
    upstream = await listen((req, res) => upstreamHandler(req, res))
    proxy = await listen((req, res) => { handleSseProxy(req, res, { config: proxyConfig }) })
})
afterAll(() => { upstream.closeAllConnections(); proxy.closeAllConnections(); upstream.close(); proxy.close() })
afterEach(() => { closers.splice(0).forEach((f) => f()); proxyConfig = devConfig() })

const sseHead = { 'Content-Type': 'text/event-stream' }
const target = (p = '/stream') => `/api/sse?url=${encodeURIComponent(`http://127.0.0.1:${portOf(upstream)}${p}`)}`

describe('streamProxy', () => {
    it('relays events and forwards Authorization and Last-Event-ID upstream', async () => {
        let seen: http.IncomingHttpHeaders = {}
        upstreamHandler = (req, res) => { seen = req.headers; res.writeHead(200, sseHead); res.end('id: 7\ndata: {"hello":1}\n\n') }
        const r = await get(portOf(proxy), `${target()}&auth=${encodeURIComponent('Bearer abc')}`, { 'Last-Event-ID': '6' })
        expect(r.status).toBe(200)
        expect(r.headers['content-type']).toContain('text/event-stream')
        expect(r.body).toContain('id: 7\ndata: {"hello":1}\n\n')
        expect(seen.authorization).toBe('Bearer abc')
        expect(seen['last-event-id']).toBe('6')
        expect(r.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('refuses upstreams that are not event streams (no generic download relay)', async () => {
        upstreamHandler = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end('x'.repeat(1000)) }
        const r = await get(portOf(proxy), target())
        expect(r.status).toBe(502)
        expect(r.body).not.toContain('xxxx')
    })

    it('reports upstream HTTP errors instead of masquerading them as streams', async () => {
        upstreamHandler = (_req, res) => { res.writeHead(404, sseHead); res.end('nope') }
        const r = await get(portOf(proxy), target())
        expect(r.status).toBe(502)
        expect(r.body).toContain('404')
    })

    it('never injects keep-alive comments into the middle of an event', async () => {
        upstreamHandler = (_req, res) => {
            res.writeHead(200, sseHead)
            res.write('data: {"a":')
            setTimeout(() => { res.write('1}\n\n') }, 150) // several heartbeat intervals later
            setTimeout(() => res.end('data: tail\n\n'), 250)
        }
        const r = await get(portOf(proxy), target())
        expect(r.body).toContain('data: {"a":1}\n\n')
        expect(r.body).not.toMatch(/data: \{"a":[^\n]*keep-alive/)
    })

    it('does send keep-alive comments while idle between events', async () => {
        upstreamHandler = (_req, res) => { res.writeHead(200, sseHead); res.write('data: x\n\n'); setTimeout(() => res.end(), 200) }
        const r = await get(portOf(proxy), target())
        expect(r.body).toContain(': keep-alive\n\n')
    })

    it('enforces the byte cap', async () => {
        proxyConfig = devConfig({ maxBytes: 200 })
        upstreamHandler = (_req, res) => {
            res.writeHead(200, sseHead)
            const iv = setInterval(() => res.write(`data: ${'y'.repeat(100)}\n\n`), 5)
            closers.push(() => clearInterval(iv))
            res.on('close', () => clearInterval(iv))
        }
        const r = await get(portOf(proxy), target())
        expect(r.body.length).toBeLessThan(600)
        expect(r.body).toContain('byte limit')
    })

    it('enforces the max duration and asks the client to retry', async () => {
        proxyConfig = devConfig({ maxDurationMs: 100 })
        upstreamHandler = (_req, res) => { res.writeHead(200, sseHead); res.write('data: x\n\n') }
        const t0 = Date.now()
        const r = await get(portOf(proxy), target())
        expect(Date.now() - t0).toBeLessThan(1500)
        expect(r.body).toContain('retry: 1000')
    })

    it('closes the upstream connection when the client leaves', async () => {
        let upstreamClosed = false
        upstreamHandler = (req, res) => { res.writeHead(200, sseHead); res.write('data: x\n\n'); req.on('close', () => { upstreamClosed = true }) }
        await get(portOf(proxy), target(), {}, 100)
        await wait(150)
        expect(upstreamClosed).toBe(true)
    })

    it('caps concurrent streams', async () => {
        proxyConfig = devConfig({ maxConcurrent: 1 })
        upstreamHandler = (_req, res) => { res.writeHead(200, sseHead); res.write('data: x\n\n') }
        const first = get(portOf(proxy), target(), {}, 400)
        await wait(100)
        const second = await get(portOf(proxy), target())
        expect(second.status).toBe(429)
        await first
        await wait(100)
        upstreamHandler = (_req, res) => { res.writeHead(200, sseHead); res.end('data: ok\n\n') }
        expect((await get(portOf(proxy), target())).status).toBe(200) // slot was released
    })

    it('POST {url, token}: the token travels in the body, not the URL', async () => {
        let seen: http.IncomingHttpHeaders = {}
        upstreamHandler = (req, res) => { seen = req.headers; res.writeHead(200, sseHead); res.end('event: order\ndata: 1\n\n') }
        const r = await post(portOf(proxy), '/api/sse', JSON.stringify({ url: `http://127.0.0.1:${portOf(upstream)}/s`, token: 'Bearer s3cret' }))
        expect(r.status).toBe(200)
        expect(r.body).toContain('event: order\ndata: 1')
        expect(seen.authorization).toBe('Bearer s3cret')
    })

    it('POST validates content type, size and JSON', async () => {
        expect((await post(portOf(proxy), '/api/sse', '{}', { 'Content-Type': 'text/plain' })).status).toBe(415)
        expect((await post(portOf(proxy), '/api/sse', '{not json')).status).toBe(400)
        expect((await post(portOf(proxy), '/api/sse', JSON.stringify({ url: 'x'.repeat(20000) }))).status).toBe(413)
        expect((await post(portOf(proxy), '/api/sse', JSON.stringify({}))).status).toBe(400)
        expect((await post(portOf(proxy), '/api/sse', JSON.stringify({ url: 'http://127.0.0.1:1/', token: 'a\r\nX: 1' }))).status).toBe(400)
    })

    it('rejects header injection through auth', async () => {
        const r = await get(portOf(proxy), `${target()}&auth=${encodeURIComponent('x\r\nX-Evil: 1')}`)
        expect(r.status).toBe(400)
    })

    it('only allows GET and POST', async () => {
        const r = await new Promise<number>((resolve) => {
            const req = http.request({ host: '127.0.0.1', port: portOf(proxy), path: target(), method: 'PUT' }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
            req.end()
        })
        expect(r).toBe(405)
    })
})

describe('streamProxy in production mode', () => {
    const prod = (env: object = {}) => loadConfig({ NODE_ENV: 'production', ...env })
    const same = { 'Sec-Fetch-Site': 'same-origin' }

    it('is closed by default: hosts must be on the allow-list', async () => {
        proxyConfig = prod() as typeof proxyConfig
        const r = await get(portOf(proxy), '/api/sse?url=https%3A%2F%2Fexample.com%2Fs', same)
        expect(r.status).toBe(403)
        expect(r.body).toContain('allow-list')
    })

    it('rejects requests that do not come from the app itself', async () => {
        proxyConfig = prod({ PROXY_OPEN: '1' }) as typeof proxyConfig
        expect((await get(portOf(proxy), '/api/sse?url=https%3A%2F%2Fexample.com%2Fs')).status).toBe(403)
        expect((await get(portOf(proxy), '/api/sse?url=https%3A%2F%2Fexample.com%2Fs', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    })

    it('blocks private and metadata targets even when open and allow-listed', async () => {
        proxyConfig = prod({ PROXY_OPEN: '1', ALLOWED_HOSTS: '169.254.169.254,127.0.0.1' }) as typeof proxyConfig
        for (const u of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:1/', 'http://[::ffff:169.254.169.254]/', 'http://[::1]/']) {
            const r = await get(portOf(proxy), `/api/sse?url=${encodeURIComponent(u)}`, same)
            expect(r.status, u).toBe(403)
        }
    })

    it('requires url and valid scheme', async () => {
        proxyConfig = prod({ PROXY_OPEN: '1' }) as typeof proxyConfig
        expect((await get(portOf(proxy), '/api/sse', same)).status).toBe(400)
        expect((await get(portOf(proxy), '/api/sse?url=file%3A%2F%2F%2Fetc%2Fpasswd', same)).status).toBe(400)
    })
})
