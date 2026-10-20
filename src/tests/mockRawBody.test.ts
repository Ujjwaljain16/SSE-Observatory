// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleMockSession } from '../../lib/mock/handlers.js'
import { loadConfig } from '../../lib/proxy/guard.js'

// A function host that does not parse NDJSON bodies (req.body is undefined): the handler must read the stream itself.
let server: http.Server
let base = ''
const config = loadConfig({ NODE_ENV: 'production', ENABLE_MOCK_API: '1' })

beforeAll(async () => {
    server = http.createServer((req, res) => { void handleMockSession(req, res, { config }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.closeAllConnections(); server.close() })

const post = (type: string, body: string) => fetch(`${base}/api/mock/session`, { method: 'POST', headers: { 'Content-Type': type, 'Sec-Fetch-Site': 'same-origin' }, body })
const capture = ['{"format":"sse-capture","version":"2.0","kind":"local-full"}', '{"seq":0,"t":0,"conn":0,"kind":"chunk","bytes":3,"text":"data: a\\n\\n"}'].join('\n')

describe('mock session upload without a body parser in front', () => {
    it('reads an NDJSON capture from the request itself', async () => {
        const r = await post('application/x-ndjson', capture)
        expect(r.status).toBe(200)
        expect(await r.json()).toMatchObject({ kind: 'capture', fidelity: 'chunks' })
    })

    it('refuses one over the size limit with a JSON error, without buffering it all', async () => {
        const r = await post('application/x-ndjson', capture + '\n' + 'x'.repeat(21 * 1024 * 1024))
        expect(r.status).toBe(413)
        expect((await r.json()).error).toMatch(/too large/)
    })

    it('still reports a bad capture with the line', async () => {
        const r = await post('application/x-ndjson', '{"format":"sse-capture","version":"2.0"}\n{oops\n{"kind":"chunk"}\n')
        expect(r.status).toBe(400)
        expect((await r.json()).error).toMatch(/Line 2/)
    })
})
