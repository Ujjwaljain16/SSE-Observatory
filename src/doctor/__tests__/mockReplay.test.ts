import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMockStreamUrl, startMockReplay } from '../mockReplay'

const reply = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })))
afterEach(() => vi.unstubAllGlobals())

describe('replaying a capture through the mock server', () => {
    it('posts the capture as NDJSON and returns the stream to connect to', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, sessionId: 'abc 123', fidelity: 'chunks' }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const r = await startMockReplay('{"format":"sse-capture"}\n', 'http://app.test')
        expect(fetchMock).toHaveBeenCalledWith('/api/mock/session', expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: '{"format":"sse-capture"}\n' }))
        expect(r).toEqual({ ok: true, url: 'http://app.test/api/mock/stream?session=abc%20123&honorLastEventId=1', sessionId: 'abc 123', fidelity: 'chunks' })
        expect(isMockStreamUrl(r.ok ? r.url : '')).toBe(true)
        expect(isMockStreamUrl('https://api.example.com/stream')).toBe(false)
    })

    it('says plainly when the mock server is off', async () => {
        reply(404, { error: 'Mock API is disabled on this deployment' })
        const r = await startMockReplay('x')
        expect(!r.ok && r.error).toMatch(/not enabled here/)
    })

    it('passes on the server\'s own reason when it refuses a capture', async () => {
        reply(400, { error: 'Line 2 is not valid JSON' })
        expect((await startMockReplay('x') as { error: string }).error).toBe('Line 2 is not valid JSON')
        reply(413, { error: 'Request body too large (NDJSON up to 20 MB)' })
        expect((await startMockReplay('x') as { error: string }).error).toMatch(/too large/)
    })

    it('says to wait when it is rate limited', async () => {
        reply(429, { error: 'Too many uploads: at most 20 per minute per client' })
        expect((await startMockReplay('x') as { error: string }).error).toMatch(/at most 20 per minute.*Try again/)
    })

    it('copes with a host that answers with a page, and with no server at all', async () => {
        reply(502, '<html>bad gateway</html>')
        expect((await startMockReplay('x') as { error: string }).error).toMatch(/status 502/)
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network') }))
        expect((await startMockReplay('x') as { error: string }).error).toMatch(/could not be reached/)
        reply(200, { success: true })
        expect((await startMockReplay('x') as { error: string }).error).toMatch(/without a session/)
    })
})
