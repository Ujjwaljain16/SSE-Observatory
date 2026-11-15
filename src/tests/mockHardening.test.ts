// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { planReplay, sessionFromCapture } from '../../lib/mock/capturePlan.js'
import { handleMockSession } from '../../lib/mock/handlers.js'
import { loadLimits } from '../../lib/mock/limits.js'
import { loadConfig } from '../../lib/proxy/guard.js'

const header = '{"format":"sse-capture","version":"2.0","kind":"sanitized"}'
const chunk = (conn: number, i: number) => JSON.stringify({ seq: i, t: i, conn, kind: 'chunk', bytes: 20, text: `id: ${i}\ndata: x\n\n` })
const capture = (connections: number) => [header, ...Array.from({ length: connections }, (_, c) => chunk(c, c))].join('\n')

describe('S03: a replay over many connections', () => {
    it('refuses a capture with more connections than a replay can serve', () => {
        const r = sessionFromCapture(capture(5000)) as { error?: string }
        expect(r.error).toMatch(/5000 connections/)
    })

    it('plans a resumed replay over the most it accepts in a moment', () => {
        const r = sessionFromCapture(capture(1000)) as { session?: unknown; error?: string }
        expect(r.error).toBeUndefined()
        const t0 = performance.now()
        const plan = planReplay(r.session, { honorLastEventId: true, lastEventId: '10', connection: 3 })
        expect(performance.now() - t0).toBeLessThan(500)
        expect(plan.steps.length).toBeGreaterThan(0)
    })

    it('does not scan every chunk for every connection (it did, and 32,000 connections took 8 s)', () => {
        // built directly, as the cap would keep this out of a real upload: the planner itself must still be linear
        const chunks = Array.from({ length: 20_000 }, (_, i) => ({ conn: i, t: i, text: `id: ${i}\ndata: x\n\n` }))
        const t0 = performance.now()
        planReplay({ kind: 'capture', captureKind: 'sanitized', endReason: 'x', chunks, events: [] }, { honorLastEventId: true, lastEventId: '5' })
        expect(performance.now() - t0).toBeLessThan(1500)
    })
})

describe('S04: the hourly byte budget counts what is stored', () => {
    const servers: http.Server[] = []
    afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })

    it('is not fooled by a small Content-Length (a gzip body inflates past it)', async () => {
        const config = loadConfig({ NODE_ENV: 'production', ENABLE_MOCK_API: '1' })
        const limits = { ...loadLimits({}), uploadsPerMinute: 0, sessionsPerHour: 0, bytesPerHour: 2000 }
        const body = [header, ...Array.from({ length: 200 }, (_, i) => chunk(0, i))].join('\n') // about 20 KB once stored
        const s = http.createServer((req, res) => { void handleMockSession(req, res, { config, limits, ip: 'gzip-test', body }) })
        servers.push(s)
        await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
        const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/mock/session`
        // the handler is given the parsed body, as a body parser that inflated it would; the header says the wire size was tiny
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson', 'Sec-Fetch-Site': 'same-origin', 'Content-Length': '10' }, body: 'x'.repeat(10) })
        expect(res.status).toBe(429)
        expect(((await res.json()) as { error: string }).error).toMatch(/storage budget/)
    })
})

describe('S20: open mock streams are capped, and none stays open forever', () => {
    const servers: http.Server[] = []
    afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })

    async function start(limits: ReturnType<typeof loadLimits>) {
        const { handleMockStream } = await import('../../lib/mock/handlers.js')
        const config = loadConfig({ NODE_ENV: 'production', ENABLE_MOCK_API: '1' })
        const body = '{"version":"1.0","events":[{"id":"1","type":"t","data":"{}","deltaMs":10}]}'
        const s = http.createServer((req, res) => {
            if (req.url?.startsWith('/api/mock/session')) void handleMockSession(req, res, { config, limits: { ...limits, uploadsPerMinute: 0 }, ip: 'cap', body: JSON.parse(body) })
            else void handleMockStream(req, res, { config, limits: { ...limits, streamsPerMinute: 0 }, ip: 'cap' })
        })
        servers.push(s)
        await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
        const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
        const created = await fetch(`${base}/api/mock/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body })
        return { base, id: ((await created.json()) as { sessionId: string }).sessionId }
    }

    it('answers 429 once the cap is reached, and a slot comes back when a stream closes', async () => {
        const { base, id } = await start({ ...loadLimits({}), maxOpenStreams: 2, maxStreamSeconds: 0 })
        const open = async () => { const c = new AbortController(); const r = await fetch(`${base}/api/mock/stream?session=${id}&loop=true`, { signal: c.signal }); return { r, c } }
        const one = await open(); const two = await open()
        expect([one.r.status, two.r.status]).toEqual([200, 200])
        const three = await fetch(`${base}/api/mock/stream?session=${id}&loop=true`)
        expect(three.status).toBe(429)
        expect(three.headers.get('retry-after')).toBe('5')
        one.c.abort()
        await new Promise((r) => setTimeout(r, 200))
        const again = await open()
        expect(again.r.status).toBe(200)
        again.c.abort(); two.c.abort()
    })

    it('ends a stream that has been open past the time limit, even a looping one', async () => {
        const { base, id } = await start({ ...loadLimits({}), maxOpenStreams: 5, maxStreamSeconds: 1 })
        const t0 = Date.now()
        const r = await fetch(`${base}/api/mock/stream?session=${id}&loop=true`)
        await r.text() // resolves when the server ends the response
        expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
        expect(Date.now() - t0).toBeLessThan(5000)
    }, 15_000)
})
