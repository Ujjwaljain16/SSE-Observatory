// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

// server.js as it runs in production: body-parser failures on /api must come back as JSON, not Express's HTML error page.
let server: ChildProcess
let base = ''

const freePort = () => new Promise<number>((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)) })
})

beforeAll(async () => {
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, ['server.js'], { env: { ...process.env, NODE_ENV: 'production', PORT: String(port), ENABLE_MOCK_API: '1' }, stdio: 'ignore' })
    for (let i = 0; i < 200; i++) {
        try { await fetch(`${base}/healthz`); return } catch { await new Promise((r) => setTimeout(r, 250)) }
    }
    throw new Error('server.js did not start')
}, 60_000)
afterAll(() => { server.kill() })

const post = (type: string, body: string) => fetch(`${base}/api/mock/session`, { method: 'POST', headers: { 'Content-Type': type, 'Sec-Fetch-Site': 'same-origin' }, body })

describe('API errors are JSON', () => {
    it('a body over the limit is a 413 with a message', async () => {
        const r = await post('application/x-ndjson', 'x'.repeat(21 * 1024 * 1024))
        expect(r.status).toBe(413)
        expect(r.headers.get('content-type')).toContain('application/json')
        expect((await r.json()).error).toMatch(/too large/)
    })

    it('malformed JSON is a 400 with a message', async () => {
        const r = await post('application/json', '{oops')
        expect(r.status).toBe(400)
        expect(r.headers.get('content-type')).toContain('application/json')
        expect((await r.json()).error).toMatch(/not valid JSON/)
    })

    it('a capture is accepted as raw NDJSON and a bad one is refused with the line', async () => {
        const good = ['{"format":"sse-capture","version":"2.0","kind":"local-full"}', '{"seq":0,"t":0,"conn":0,"kind":"chunk","bytes":3,"text":"data: a\\n\\n"}'].join('\n')
        expect((await post('application/x-ndjson', good)).status).toBe(200)
        const bad = await post('application/x-ndjson', '{"format":"sse-capture","version":"2.0"}\n{oops\n{"kind":"chunk"}\n')
        expect(bad.status).toBe(400)
        expect((await bad.json()).error).toMatch(/Line 2/)
    })
})
