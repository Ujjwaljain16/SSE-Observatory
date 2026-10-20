// @vitest-environment node
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { validateSession, replay, clampSpeed, createMockStore } from '../../lib/mock/session.js'
import { handleMockSession, handleMockStream } from '../../lib/mock/handlers.js'
import { loadConfig } from '../../lib/proxy/guard.js'

describe('validateSession', () => {
    it('accepts a normal recording and strips unknown fields', () => {
        const { session, error } = validateSession({ version: '1.0', events: [{ id: 1, type: 'a', data: '{"x":1}', deltaMs: 5, evil: true }] })
        expect(error).toBeUndefined()
        expect(session!.events[0]).toEqual({ id: '1', type: 'a', data: '{"x":1}', deltaMs: 5 })
    })
    it.each([
        [null], [{}], [{ events: 'no' }],
        [{ events: [null] }], [{ events: [{ data: 123 }] }],
        [{ events: [{ data: 'x', deltaMs: -1 }] }], [{ events: [{ data: 'x', deltaMs: Infinity }] }],
        [{ events: [{ data: 'x', deltaMs: 1e12 }] }], [{ events: [{ data: 'x', deltaMs: '5' }] }],
    ])('rejects malformed input %j', (body) => expect(validateSession(body).error).toBeTruthy())
    it('enforces size limits and strips CR/LF from ids', () => {
        expect(validateSession({ events: [{ data: 'xxxxx' }, { data: 'xxxxx' }] }, { maxEvents: 1, maxBytes: 100, maxDeltaMs: 1 }).error).toMatch(/Too many/)
        expect(validateSession({ events: [{ data: 'x'.repeat(50) }, { data: 'x'.repeat(60) }] }, { maxEvents: 5, maxBytes: 100, maxDeltaMs: 1 }).error).toMatch(/large/)
        expect(validateSession({ events: [{ id: 'a\nevent: x', data: 'd' }] }).session!.events[0].id).toBe('aevent: x')
    })
})

describe('clampSpeed', () => {
    it('bounds and defaults', () => {
        expect(clampSpeed('abc')).toBe(1)
        expect(clampSpeed('-3')).toBe(1)
        expect(clampSpeed('0')).toBe(1)
        expect(clampSpeed('1e9')).toBe(1000)
        expect(clampSpeed('0.0001')).toBe(0.01)
        expect(clampSpeed('2')).toBe(2)
    })
})

describe('replay', () => {
    class FakeRes extends EventEmitter {
        frames: string[] = []
        ended = false
        write(s: string) { this.frames.push(s); return true }
        end() { this.ended = true }
    }

    it('a looping recording with zero delays cannot starve the event loop', async () => {
        const res = new FakeRes()
        let closed = false
        const session = { events: [{ data: 'a', deltaMs: 0 }, { data: 'b', deltaMs: 0 }] }
        const p = replay({ res: res as never, session, loop: true, isClosed: () => closed })
        let timerFired = false
        setTimeout(() => { timerFired = true }, 20)
        await new Promise((r) => setTimeout(r, 300))
        closed = true
        await p
        expect(timerFired).toBe(true)
        // minimum pass time (50 ms) bounds the frame rate: at most ~7 passes in 300 ms
        expect(res.frames.length).toBeLessThanOrEqual(2 * 8)
    })

    it('respects recorded timing, speed, ids, multi-line data and type injection', async () => {
        const res = new FakeRes()
        const session = { events: [{ id: '1', type: 'tick', data: '{"n":1}', deltaMs: 0 }, { data: 'l1\r\nl2', deltaMs: 100 }] }
        const t0 = Date.now()
        await replay({ res: res as never, session, speed: 2, isClosed: () => false })
        const took = Date.now() - t0
        expect(took).toBeGreaterThanOrEqual(40)
        expect(took).toBeLessThan(400)
        expect(res.frames[0]).toBe('id: 1\ndata: {"n":1,"type":"tick"}\n\n')
        expect(res.frames[1]).toBe('data: l1\ndata: l2\n\n')
        // a finished recording says so, otherwise clients treat the close as a drop and replay it again
        expect(res.frames[2]).toBe('event: end\ndata: {"done":true}\n\n')
        expect(res.ended).toBe(true)
    })
})

describe('createMockStore (memory)', () => {
    it('stores per-session data under unguessable ids and honours delete', async () => {
        const store = createMockStore({})
        const a = await store.create({ events: [] })
        const b = await store.create({ events: [{ data: 'x', deltaMs: 0 }] })
        expect(a).not.toBe(b)
        expect(await store.get(a)).toEqual({ events: [] })
        expect(await store.get('../../etc/passwd')).toBeNull()
        await store.delete(a)
        expect(await store.get(a)).toBeNull()
    })
})

describe('mock HTTP handlers', () => {
    let server: http.Server
    let port: number
    let config = loadConfig({ NODE_ENV: 'production', ENABLE_MOCK_API: '1' })
    const same = { 'Sec-Fetch-Site': 'same-origin' }

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (c) => chunks.push(c))
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString()
                let body: unknown
                try { body = raw ? JSON.parse(raw) : undefined } catch { body = undefined }
                if (req.url!.startsWith('/api/mock/session')) handleMockSession(req, res, { config, body })
                else handleMockStream(req, res, { config })
            })
        })
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
        port = (server.address() as AddressInfo).port
    })
    afterAll(() => { server.closeAllConnections(); server.close() })

    const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
                let b = ''
                res.on('data', (c) => (b += c))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
            })
            req.on('error', reject)
            if (body) req.write(body)
            req.end()
        })
    const json = { 'Content-Type': 'application/json', ...same }

    it('is disabled in production unless ENABLE_MOCK_API=1', async () => {
        const saved = config
        config = loadConfig({ NODE_ENV: 'production' })
        expect((await call('POST', '/api/mock/session', json, '{"events":[]}')).status).toBe(404)
        expect((await call('GET', '/api/mock/stream?session=x')).status).toBe(404)
        config = saved
    })

    it('rejects cross-origin writes, wrong content type and invalid bodies', async () => {
        expect((await call('POST', '/api/mock/session', { 'Content-Type': 'application/json' }, '{"events":[]}')).status).toBe(403)
        expect((await call('POST', '/api/mock/session', { ...same }, '{"events":[]}')).status).toBe(415)
        expect((await call('POST', '/api/mock/session', json, '{"events":[{"data":123}]}')).status).toBe(400)
    })

    it('round-trips a session, streams it, isolates sessions and deletes', async () => {
        const create = await call('POST', '/api/mock/session', json, JSON.stringify({ events: [{ data: 'hello', deltaMs: 0 }, { data: 'world', deltaMs: 10 }] }))
        expect(create.status).toBe(200)
        const { sessionId } = JSON.parse(create.body)
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)

        const stream = await call('GET', `/api/mock/stream?session=${sessionId}&speed=10`)
        expect(stream.status).toBe(200)
        expect(stream.body).toBe('data: hello\n\ndata: world\n\nevent: end\ndata: {"done":true}\n\n')

        expect((await call('GET', '/api/mock/stream')).status).toBe(404) // production: no implicit "latest" session
        expect((await call('GET', '/api/mock/stream?session=00000000-0000-0000-0000-000000000000')).status).toBe(404)

        expect((await call('DELETE', `/api/mock/session?id=${sessionId}`, same)).status).toBe(200)
        expect((await call('GET', `/api/mock/stream?session=${sessionId}`)).status).toBe(404)
    })
})
