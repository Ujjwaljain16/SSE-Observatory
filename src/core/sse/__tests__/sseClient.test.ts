// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SSEClient, type SSEPhase, type SSEPhaseInfo } from '../sseClient'
import type { SSEMessage } from '../sseParser'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void
const servers: http.Server[] = []
async function serve(handler: Handler) {
    let n = 0
    const s = http.createServer((req, res) => handler(req, res, ++n))
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`
}
afterEach(() => { servers.splice(0).forEach((s) => { s.closeAllConnections(); s.close() }) })

const SSE = { 'Content-Type': 'text/event-stream' }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function run(url: string, extra: Partial<ConstructorParameters<typeof SSEClient>[0]> = {}, headers: Record<string, string> = {}) {
    const messages: SSEMessage[] = []
    const phases: Array<[SSEPhase, SSEPhaseInfo]> = []
    const seenRequests: string[] = []
    const client = new SSEClient({
        request: (lastId) => { seenRequests.push(lastId); return { url, headers } },
        onMessage: (m) => messages.push(m),
        onPhase: (p, i) => phases.push([p, i]),
        initialDelayMs: 5, maxDelayMs: 20, jitter: 0,
        ...extra,
    })
    const names = () => phases.map(([p]) => p)
    const until = async (pred: () => boolean, ms = 3000) => {
        const t0 = Date.now()
        while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout; phases=${names().join(',')} messages=${messages.length}`); await wait(5) }
    }
    return { client, messages, phases, names, seenRequests, until }
}

describe('SSEClient', () => {
    it('delivers named events with ids and sends the auth header', async () => {
        let auth = ''
        const url = await serve((req, res) => {
            auth = String(req.headers.authorization)
            res.writeHead(200, SSE)
            res.write('event: order\nid: 1\ndata: {"a":1}\n\n')
            res.end('event: end\ndata: bye\n\n')
        })
        const t = run(url, {}, { Authorization: 'Bearer abc' })
        t.client.start()
        await t.until(() => t.names().includes('ended'))
        expect(auth).toBe('Bearer abc')
        expect(t.messages.map((m) => [m.event, m.data, m.id])).toEqual([['order', '{"a":1}', '1'], ['end', 'bye', '1']])
        expect(t.names()).toEqual(['connecting', 'open', 'ended'])
        expect(t.client.isRunning).toBe(false)
    })

    it('reconnects after the server closes the stream and resumes with Last-Event-ID', async () => {
        const seen: Array<string | undefined> = []
        const url = await serve((req, res, n) => {
            seen.push(req.headers['last-event-id'] as string | undefined)
            res.writeHead(200, SSE)
            res.end(`id: ${n}\ndata: batch${n}\n\n`)
        })
        const t = run(url)
        t.client.start()
        await t.until(() => t.messages.length >= 3)
        t.client.stop()
        expect(t.messages.slice(0, 3).map((m) => m.data)).toEqual(['batch1', 'batch2', 'batch3'])
        expect(seen.slice(0, 3)).toEqual([undefined, '1', '2'])
        expect(t.seenRequests.slice(0, 3)).toEqual(['', '1', '2'])
        expect(t.names()).toContain('reconnecting')
    })

    it('treats 401/403/404 and wrong content types as fatal (no retry storm)', async () => {
        for (const status of [401, 403, 404]) {
            let hits = 0
            const url = await serve((_req, res) => { hits++; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'nope' })) })
            const t = run(url)
            t.client.start()
            await t.until(() => t.names().includes('failed'))
            await wait(40)
            expect(hits).toBe(1)
            const info = t.phases.find(([p]) => p === 'failed')![1]
            expect(info.status).toBe(status)
            expect(info.reason).toContain(`HTTP ${status}`)
            expect(info.reason).toContain('nope')
        }
        let hits = 0
        const html = await serve((_req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>') })
        const t = run(html)
        t.client.start()
        await t.until(() => t.names().includes('failed'))
        expect(hits).toBe(1)
        expect(t.phases.find(([p]) => p === 'failed')![1].reason).toMatch(/did not return an event stream/)
    })

    it('retries 5xx with backoff, then gives up after maxRetries', async () => {
        let hits = 0
        const url = await serve((_req, res) => { hits++; res.writeHead(503); res.end('busy') })
        const t = run(url, { maxRetries: 3 })
        t.client.start()
        await t.until(() => t.names().includes('failed'))
        expect(hits).toBe(4) // first attempt + 3 retries
        const delays = t.phases.filter(([p]) => p === 'reconnecting').map(([, i]) => i.delayMs)
        expect(delays).toEqual([5, 10, 20]) // 5ms · 2^(n-1), capped at 20
        expect(t.phases.find(([p]) => p === 'failed')![1].reason).toMatch(/Gave up after 3 attempts/)
    })

    it('recovers when the server comes back and resets the attempt counter', async () => {
        const url = await serve((_req, res, n) => {
            if (n <= 2) { res.writeHead(503); res.end(); return }
            res.writeHead(200, SSE)
            res.write('data: alive\n\n')
        })
        const t = run(url, { maxRetries: 5 })
        t.client.start()
        await t.until(() => t.messages.length === 1)
        expect(t.names()).toContain('open')
        expect(t.phases.find(([p]) => p === 'open')![1].attempt).toBe(0)
        t.client.stop()
    })

    it("honours the server's retry hint and applies jitter within bounds", async () => {
        const url = await serve((_req, res) => { res.writeHead(200, SSE); res.end('retry: 80\ndata: x\n\n') })
        const t = run(url)
        t.client.start()
        await t.until(() => t.names().includes('reconnecting'))
        t.client.stop()
        expect(t.phases.find(([p]) => p === 'reconnecting')![1].delayMs).toBeGreaterThanOrEqual(80)

        const delays: number[] = []
        const probe = new SSEClient({ request: () => ({ url: 'http://127.0.0.1:1/' }), onMessage: () => {}, initialDelayMs: 1000, jitter: 0.5, random: () => 0, maxRetries: 1, onPhase: (p, i) => { if (p === 'reconnecting' && i.delayMs) delays.push(i.delayMs) } })
        probe.start()
        await wait(200)
        probe.stop()
        expect(delays[0]).toBe(500) // random()=0 → base · (1 − jitter)
    })

    it('stop() aborts an open stream immediately and never reconnects', async () => {
        let closed = false
        const url = await serve((req, res) => { res.writeHead(200, SSE); res.write('data: 1\n\n'); req.on('close', () => { closed = true }) })
        const t = run(url)
        t.client.start()
        await t.until(() => t.messages.length === 1)
        t.client.stop()
        await wait(60)
        expect(closed).toBe(true)
        expect(t.names().slice(-1)[0]).toBe('stopped')
        expect(t.names().filter((p) => p === 'open')).toHaveLength(1)
    })

    it('treats 204 as "do not reconnect"', async () => {
        let hits = 0
        const url = await serve((_req, res) => { hits++; res.writeHead(204); res.end() })
        const t = run(url)
        t.client.start()
        await t.until(() => t.names().includes('ended'))
        await wait(30)
        expect(hits).toBe(1)
    })

    it('handles an event split across many tiny chunks', async () => {
        const url = await serve(async (_req, res) => {
            res.writeHead(200, SSE)
            for (const piece of ['ev', 'ent: spl', 'it\nda', 'ta: he', 'llo\n', '\n', 'event: end\ndata: x\n\n']) { res.write(piece); await wait(2) }
            res.end()
        })
        const t = run(url)
        t.client.start()
        await t.until(() => t.names().includes('ended'))
        expect(t.messages[0]).toMatchObject({ event: 'split', data: 'hello' })
    })

    it('parses one huge chunk in slices: every event arrives intact and the event loop keeps getting turns', async () => {
        const N = 60_000
        let body = ''
        for (let i = 0; i < N; i++) body += `id: ${i}\ndata: {"i":${i},"s":"héllo 😀 ${i}"}\n\n`
        body += 'event: end\ndata: done\n\n'
        const url = await serve((_req, res) => { res.writeHead(200, SSE); res.end(body) }) // a single write: multi-megabyte chunks
        const t = run(url)
        let ticks = 0
        const timer = setInterval(() => ticks++, 1)
        t.client.start()
        await t.until(() => t.names().includes('ended'), 15000)
        clearInterval(timer)
        expect(t.messages).toHaveLength(N + 1)
        // multi-byte characters straddling the slice boundaries must not be corrupted
        for (const i of [0, 1, 12345, N - 1]) expect(t.messages[i]?.data).toBe(`{"i":${i},"s":"héllo 😀 ${i}"}`)
        expect(t.messages.slice(0, N).every((m, i) => m.id === String(i))).toBe(true)
        expect(ticks).toBeGreaterThan(3)
    })

    it('can POST a JSON body (used for the proxy)', async () => {
        let got = ''
        let method = ''
        const url = await serve((req, res) => {
            method = req.method ?? ''
            req.on('data', (c) => (got += c))
            req.on('end', () => { res.writeHead(200, SSE); res.end('event: end\ndata: ok\n\n') })
        })
        const t = run(url, { request: () => ({ url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"url":"x"}' }) })
        t.client.start()
        await t.until(() => t.names().includes('ended'))
        expect([method, got]).toEqual(['POST', '{"url":"x"}'])
    })
})
