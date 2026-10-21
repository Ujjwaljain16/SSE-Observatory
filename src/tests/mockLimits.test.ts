// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleMockSession, handleMockStream } from '../../lib/mock/handlers.js'
import { checkBudget, checkRate, clientIp, loadLimits } from '../../lib/mock/limits.js'
import { createMockStore } from '../../lib/mock/session.js'
import { loadConfig } from '../../lib/proxy/guard.js'

const config = loadConfig({ NODE_ENV: 'production', ENABLE_MOCK_API: '1' })
const body = ['{"format":"sse-capture","version":"2.0","kind":"local-full"}', '{"seq":0,"t":0,"conn":0,"kind":"chunk","bytes":3,"text":"data: a\\n\\n"}'].join('\n')
const servers: http.Server[] = []
afterEach(() => { vi.useRealTimers(); for (const s of servers.splice(0)) { s.closeAllConnections(); s.close() } })

async function start(limits: ReturnType<typeof loadLimits>, ip: () => string = () => '203.0.113.7') {
    const s = http.createServer((req, res) => {
        const path = req.url?.startsWith('/api/mock/stream') ? handleMockStream : handleMockSession
        void path(req, res, { config, limits, ip: ip() })
    })
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}
const upload = (base: string) => fetch(`${base}/api/mock/session`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson', 'Sec-Fetch-Site': 'same-origin' }, body })

describe('mock API abuse limits', () => {
    it('defaults are finite and can be switched off per limit with 0', () => {
        expect(loadLimits({})).toEqual({ uploadsPerMinute: 20, streamsPerMinute: 60, sessionsPerHour: 500, bytesPerHour: 50 * 1024 * 1024 })
        expect(loadLimits({ MOCK_UPLOADS_PER_MINUTE: '0', MOCK_MB_PER_HOUR: 'junk' }).uploadsPerMinute).toBe(0)
        expect(loadLimits({ MOCK_MB_PER_HOUR: 'junk' }).bytesPerHour).toBe(50 * 1024 * 1024)
    })

    it('answers 429 with Retry-After once a client exceeds its uploads per minute', async () => {
        const base = await start({ ...loadLimits({}), uploadsPerMinute: 3 })
        const statuses = []
        for (let i = 0; i < 5; i++) statuses.push((await upload(base)).status)
        expect(statuses).toEqual([200, 200, 200, 429, 429])
        const r = await upload(base)
        expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0)
        expect((await r.json()).error).toMatch(/at most 3 per minute/)
    })

    it('counts each client separately', async () => {
        let who = 'a'
        const base = await start({ ...loadLimits({}), uploadsPerMinute: 1 }, () => who)
        expect((await upload(base)).status).toBe(200)
        expect((await upload(base)).status).toBe(429)
        who = 'b'
        expect((await upload(base)).status).toBe(200)
    })

    it('limits stream requests per client too', async () => {
        const base = await start({ ...loadLimits({}), streamsPerMinute: 2 })
        const id = ((await (await upload(base)).json()) as { sessionId: string }).sessionId
        const get = () => fetch(`${base}/api/mock/stream?session=${id}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })
        const first = await get(); await first.text()
        const second = await get(); await second.text()
        expect([first.status, second.status, (await get()).status]).toEqual([200, 200, 429])
    })

    it('refuses an upload once the global hourly budget is spent', async () => {
        // the hourly counters are shared by the whole process, so this test works in an hour of its own
        vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2031, 0, 1, 3, 30) })
        const base = await start({ ...loadLimits({}), uploadsPerMinute: 0, sessionsPerHour: 2 })
        expect([(await upload(base)).status, (await upload(base)).status, (await upload(base)).status]).toEqual([200, 200, 429])
    })

    it('budgets bytes as well as sessions', async () => {
        const store = createMockStore({ MOCK_STORE: 'memory' })
        const limits = { ...loadLimits({}), sessionsPerHour: 0, bytesPerHour: 1000 }
        expect((await checkBudget({ store, limits, bytes: 600, now: 1_000_000 })).ok).toBe(true)
        const over = await checkBudget({ store, limits, bytes: 600, now: 1_000_000 })
        expect(over).toMatchObject({ ok: false })
        // the next hour starts a fresh budget
        expect((await checkBudget({ store, limits, bytes: 600, now: 1_000_000 + 3_600_000 })).ok).toBe(true)
    })

    it('a limit of 0 means unlimited', async () => {
        const store = createMockStore({ MOCK_STORE: 'memory' })
        const limits = { ...loadLimits({}), uploadsPerMinute: 0 }
        for (let i = 0; i < 50; i++) expect((await checkRate({ store, limits, kind: 'upload', ip: 'x' })).ok).toBe(true)
    })

    it('fails open when the counter store is unreachable', async () => {
        const store = { counter: async () => { throw new Error('down') } }
        const quiet = console.error
        console.error = () => {}
        try {
            expect((await checkRate({ store, limits: loadLimits({}), kind: 'upload', ip: 'x' })).ok).toBe(true)
            expect((await checkBudget({ store, limits: loadLimits({}), bytes: 1 })).ok).toBe(true)
        } finally { console.error = quiet }
    })

    it('trusts forwarding headers only on Vercel', () => {
        const req = { headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }, socket: { remoteAddress: '10.9.9.9' } }
        expect(clientIp(req, {})).toBe('10.9.9.9')
        expect(clientIp(req, { VERCEL: '1' })).toBe('198.51.100.9')
        expect(clientIp({ headers: { 'x-real-ip': '192.0.2.1' }, socket: {} }, { VERCEL: '1' })).toBe('192.0.2.1')
        expect(clientIp({ headers: {}, socket: {} }, {})).toBe('unknown')
    })
})
