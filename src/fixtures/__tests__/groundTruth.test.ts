// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixtureServer, type FixtureServer } from '../server'
import { frameLog, type LoggedConnection } from '../groundTruth'
import { observeFixture } from './observeFixture'
import { defaultRules } from '../../core/diagnostics/rules'

// Plan A1 self-test: the log must be true before anything is compared with it. It is checked against things a test can know independently: the
// body a plain `fetch` received, the number of requests made, the header a request carried.

let server: FixtureServer
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })

const settle = async (c: LoggedConnection, ms = 2000) => { const until = Date.now() + ms; while (c.endedBy === 'open' && Date.now() < until) await new Promise((r) => setTimeout(r, 10)) }
const last = () => server.groundTruth.connections.at(-1)!

async function fetchAll(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
    const res = await fetch(url, { headers })
    return Buffer.from(await res.arrayBuffer())
}

describe('the ground-truth log of the fixture server', () => {
    it('h01 with three events: three frames with ids 1, 2, 3, then the end of the stream, all terminated', async () => {
        const body = await fetchAll(server.urlFor('h01', { n: 3, scale: 0.02 }))
        const c = last()
        await settle(c)
        expect(c.route).toBe('h01')
        expect(c.endedBy).toBe('server-end')
        const frames = frameLog(c).filter((f) => !f.isComment)
        expect(frames.slice(0, 3).map((f) => f.id)).toEqual(['1', '2', '3'])
        expect(frames.every((f) => f.terminated)).toBe(true)
        // the log and the client saw the same bytes
        expect(c.writes.reduce((n, w) => n + w.bytes, 0)).toBe(body.length)
        expect(server.groundTruth.body(c)).toBe(body.toString('utf8'))
    })

    it('h03 (CRLF line endings, a UTF-8 character split across writes, comments): three ticks and the end event', async () => {
        const body = await fetchAll(server.urlFor('h03', { scale: 0.02 }))
        const c = last()
        await settle(c)
        // three ticks and the closing `end` event, each with comments between them that are not events
        const frames = frameLog(c)
        expect(frames.filter((f) => !f.isComment && f.terminated).map((f) => f.event)).toEqual(['tick', 'tick', 'tick', 'end'])
        expect(frames.filter((f) => f.isComment).length).toBeGreaterThanOrEqual(4)
        expect(c.writes.reduce((n, w) => n + w.bytes, 0)).toBe(body.length)
        expect(c.writes.some((w) => w.text.includes('\r\n'))).toBe(true)
    })

    it('f09-buffered: the bytes the server wrote add up to the bytes the client read, in writes of exactly 4096 bytes', async () => {
        const body = await fetchAll(server.urlFor('f09-buffered', { scale: 0.02 }))
        const c = last()
        await settle(c)
        expect(c.writes.reduce((n, w) => n + w.bytes, 0)).toBe(body.length)
        expect(c.writes.filter((w) => w.bytes === 4096).length).toBeGreaterThan(0)
    })

    it('f02-closed: one unterminated trailing frame, and no complete event', async () => {
        await fetchAll(server.urlFor('f02-closed', { scale: 0.02 }))
        const c = last()
        await settle(c)
        const frames = frameLog(c).filter((f) => !f.isComment)
        expect(frames.filter((f) => f.terminated)).toEqual([])
        expect(frames.filter((f) => !f.terminated)).toHaveLength(1)
        expect(frames[0]!.dataText).toBe('x')
    })

    it('f05-drops, read by the real client: four connections, each carrying the id the client last saw', async () => {
        const before = server.groundTruth.connections.length
        await observeFixture(server, defaultRules, 'f05-drops', {}, true)
        const mine = server.groundTruth.connections.slice(before).filter((c) => c.route === 'f05-drops')
        expect(mine.map((c) => c.requestHeaders['last-event-id'] ?? '')).toEqual(['', '3', '6', '9'])
        // each connection's first event continues after the cursor it was sent
        const firstIds = mine.map((c) => frameLog(c).find((f) => !f.isComment)?.id)
        expect(firstIds).toEqual(['1', '4', '7', '10'])
    }, 30_000)

    it('a client that goes away is recorded as client-closed, and not as the server ending', async () => {
        const controller = new AbortController()
        const res = await fetch(server.urlFor('f04-silent', { scale: 0.05 }), { signal: controller.signal })
        const reader = res.body!.getReader()
        await reader.read()
        controller.abort()
        const c = last()
        await settle(c, 3000)
        expect(c.endedBy).toBe('client-closed')
    })

    it('a secret request header is recorded as present and how long it is, never as its value', async () => {
        await fetchAll(server.urlFor('h01', { n: 1, scale: 0.02 }), { Authorization: 'Bearer SECRET-VALUE-12345', Cookie: 'sid=SECRET-COOKIE-9', 'X-Trace': 'visible' })
        const c = last()
        expect(JSON.stringify(c.requestHeaders)).not.toMatch(/SECRET/)
        expect(c.requestHeaders['authorization']).toMatch(/present, 25 characters/)
        expect(c.requestHeaders['x-trace']).toBe('visible')
    })

    it('records the writes in order, with times that never go back, and the status of an error response', async () => {
        await fetchAll(server.urlFor('f01-404'))
        const c = last()
        expect(c.status).toBe(404)
        await fetchAll(server.urlFor('f03-steady', { n: 4, scale: 0.02 }))
        const s = last()
        for (let i = 1; i < s.writes.length; i++) expect(s.writes[i]!.atMs).toBeGreaterThanOrEqual(s.writes[i - 1]!.atMs)
        expect(s.acceptedAtMs).toBeLessThanOrEqual(s.writes[0]!.atMs)
    })

    it('a server started with log: false records nothing', async () => {
        const quiet = await startFixtureServer({ port: 0, log: false })
        await fetchAll(quiet.urlFor('h01', { n: 1, scale: 0.02 }))
        expect(quiet.groundTruth.connections).toEqual([])
        await quiet.close()
    })
})

describe('the oracle\'s own framer', () => {
    const connection = (...writes: string[]): LoggedConnection => ({
        index: 0, route: 'x', path: '/x', query: {}, requestHeaders: {}, acceptedAtMs: 0, acceptedEpochMs: 0, status: 200, endedBy: 'server-end', endedAtMs: 1,
        writes: writes.map((text, i) => ({ atMs: i, epochMs: i, bytes: Buffer.byteLength(text), raw: Uint8Array.from(Buffer.from(text)), text })),
    })

    it('reads ids, event names and multi-line data, with every line ending', () => {
        const frames = frameLog(connection('id: 1\r\nevent: tick\r\ndata: a\r\ndata: b\r\n\r\n', 'data: c\n\n', 'id: 3\rdata: d\r\r'))
        expect(frames.map((f) => [f.id, f.event, f.dataText, f.terminated])).toEqual([['1', 'tick', 'a\nb', true], [null, 'message', 'c', true], ['3', 'message', 'd', true]])
        expect(frames.map((f) => f.effectiveId)).toEqual(['1', '1', '3']) // an id persists until another one
    })

    it('a frame split across writes says which writes carried it; comments are not events; an unfinished last frame is unterminated', () => {
        const frames = frameLog(connection('data: par', 'tial\n\n: heartbeat\n\n', 'data: cut'))
        expect(frames[0]).toMatchObject({ dataText: 'partial', terminated: true, firstWrite: 0, lastWrite: 1 })
        expect(frames[1]).toMatchObject({ isComment: true })
        expect(frames[2]).toMatchObject({ dataText: 'cut', terminated: false, isComment: false })
    })
})
