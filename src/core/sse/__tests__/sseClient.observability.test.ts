// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SSEClient, type SSEPhase, type SSEPhaseInfo, type SSEClientOptions } from '../sseClient'
import type { SSEMessage } from '../sseParser'
import { Recorder } from '../../observe/recorder'
import type { Observation } from '../../observe/observation'

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

function run(url: string, extra: Partial<SSEClientOptions> = {}, observe = true) {
    const messages: SSEMessage[] = []
    const phases: Array<[SSEPhase, SSEPhaseInfo]> = []
    const observations: Observation[] = []
    const recorder = new Recorder({ onRecord: (o) => observations.push(o) })
    const client = new SSEClient({
        request: () => ({ url }),
        onMessage: (m) => messages.push(m),
        onPhase: (p, i) => phases.push([p, i]),
        initialDelayMs: 5, maxDelayMs: 20, jitter: 0,
        ...(observe ? { onObservation: (d) => recorder.record(d) } : {}),
        ...extra,
    })
    const names = () => phases.map(([p]) => p)
    const until = async (pred: () => boolean, ms = 3000) => {
        const t0 = Date.now()
        while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout; phases=${names().join(',')} messages=${messages.length}`); await wait(5) }
    }
    const kinds = () => observations.map((o) => o.kind)
    const ofKind = <K extends Observation['kind']>(kind: K) => observations.filter((o): o is Extract<Observation, { kind: K }> => o.kind === kind)
    return { client, messages, phases, observations, names, until, kinds, ofKind }
}

describe('SSEClient observations', () => {
    it('records the request, the response, the bytes, the comment, the retry hint and the event, in that order', async () => {
        const body = [': heartbeat\n\n', 'retry: 2000\n\n', 'id: 7\nevent: order\ndata: {"a":1}\n\n', 'event: end\ndata: bye\n\n']
        const url = await serve((_req, res) => {
            res.writeHead(200, { ...SSE, 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'Set-Cookie': 'sid=secret', 'X-Secret': 'nope' })
            for (const piece of body) res.write(piece)
            res.end()
        })
        const t = run(url)
        t.client.start()
        await t.until(() => t.names().includes('ended'))

        const connect = t.ofKind('connect')[0]!
        expect(connect).toMatchObject({ attempt: 0, method: 'GET', sentLastEventId: '' })
        expect(connect.headerNames).toEqual(expect.arrayContaining(['accept', 'cache-control']))

        const response = t.ofKind('response')[0]!
        expect(response).toMatchObject({ status: 200, contentType: 'text/event-stream', redirected: false })
        expect(response.ttfbMs).toBeGreaterThanOrEqual(0)
        expect(response.headers['cache-control']).toBe('no-cache')
        expect(response.headers['x-accel-buffering']).toBe('no')
        expect(response.headers).not.toHaveProperty('set-cookie') // only diagnostic headers are kept
        expect(response.headers).not.toHaveProperty('x-secret')

        expect(t.ofKind('chunk').reduce((sum, c) => sum + c.bytes, 0)).toBe(body.join('').length)
        expect(t.ofKind('comment')).toMatchObject([{ text: 'heartbeat', source: 'upstream' }])
        expect(t.ofKind('retry')).toMatchObject([{ ms: 2000 }])
        expect(t.ofKind('event')).toMatchObject([{ event: 'order', sseId: '7', dataBytes: 7 }, { event: 'end', sseId: '7', dataBytes: 3 }])

        // ordering
        const firstIndex = (kind: Observation['kind']) => t.kinds().indexOf(kind)
        expect(firstIndex('connect')).toBeLessThan(firstIndex('response'))
        expect(firstIndex('response')).toBeLessThan(firstIndex('chunk'))
        expect(firstIndex('chunk')).toBeLessThan(firstIndex('event'))
        // strict total order, monotonic time, every record on connection 0
        expect(t.observations.map((o) => o.seq)).toEqual(t.observations.map((_, i) => i))
        expect(t.observations.every((o, i, all) => i === 0 || o.t >= all[i - 1]!.t)).toBe(true)
        expect(new Set(t.observations.map((o) => o.conn))).toEqual(new Set([0]))
        // phases are observations too
        expect(t.ofKind('phase').map((p) => p.phase)).toEqual(t.names())
    })

    it('labels the proxy\'s own comments as proxy, so they cannot be mistaken for upstream liveness', async () => {
        const url = await serve((_req, res) => {
            res.writeHead(200, SSE)
            res.write(': sse-proxy-ping\n\n: sse-proxy hb up_idle=4000 n=2\n\n: origin heartbeat\n\n')
            res.end('event: end\ndata: x\n\n')
        })
        const t = run(url)
        t.client.start()
        await t.until(() => t.names().includes('ended'))
        expect(t.ofKind('comment').map((c) => [c.text, c.source])).toEqual([
            ['sse-proxy-ping', 'proxy'], ['sse-proxy hb up_idle=4000 n=2', 'proxy'], ['origin heartbeat', 'upstream'],
        ])
    })

    it('records the Last-Event-ID it sends, the connection each record belongs to, and the server\'s retry hint at reconnect', async () => {
        const seenHeader: Array<string | undefined> = []
        const url = await serve((req, res, n) => {
            seenHeader.push(req.headers['last-event-id'] as string | undefined)
            res.writeHead(200, SSE)
            if (n === 1) { res.end('retry: 5\nid: 41\ndata: first\n\nid: 42\ndata: second\n\n') } // closes: the client reconnects
            else res.end('id: 43\ndata: third\n\nevent: end\ndata: done\n\n')
        })
        const t = run(url)
        t.client.start()
        await t.until(() => t.names().includes('ended'))

        expect(seenHeader).toEqual([undefined, '42'])
        const connects = t.ofKind('connect')
        expect(connects.map((c) => c.sentLastEventId)).toEqual(['', '42'])
        expect(t.ofKind('reconnect')).toMatchObject([{ attempt: 1, lastEventIdSent: '42', serverRetryMs: 5, reason: 'Stream closed by server' }])
        // connection index: records before the second connect are 0, after it 1
        const secondConnectSeq = connects[1]!.seq
        expect(t.observations.filter((o) => o.seq < secondConnectSeq).every((o) => o.conn === 0)).toBe(true)
        expect(t.observations.filter((o) => o.seq >= secondConnectSeq).every((o) => o.conn === 1)).toBe(true)
        expect(t.ofKind('event').map((e) => e.sseId)).toEqual(['41', '42', '43', '43'])
    })

    it('never records a secret from the URL, but keeps the parameter names', async () => {
        const url = await serve((_req, res) => { res.writeHead(200, SSE); res.end('event: end\ndata: x\n\n') })
        const t = run(url, { request: () => ({ url: `${url}?access_token=SUPERSECRET&since=9` }) })
        t.client.start()
        await t.until(() => t.names().includes('ended'))
        const recorded = t.ofKind('connect')[0]!.url
        expect(recorded).toContain('access_token=[redacted]')
        expect(recorded).not.toContain('SUPERSECRET')
        expect(JSON.stringify(t.observations)).not.toContain('SUPERSECRET')
    })

    it('reports a wrong content type and a non-200 status as errors, and still fails fast', async () => {
        const wrongType = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') })
        const a = run(wrongType)
        a.client.start()
        await a.until(() => a.names().includes('failed'))
        expect(a.ofKind('violation')).toMatchObject([{ code: 'BAD_CONTENT_TYPE', severity: 'error' }])

        const notFound = await serve((_req, res) => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('nope') })
        const b = run(notFound)
        b.client.start()
        await b.until(() => b.names().includes('failed'))
        expect(b.ofKind('response')).toMatchObject([{ status: 404 }])
        expect(b.ofKind('violation')).toMatchObject([{ code: 'HTTP_STATUS_NOT_200', severity: 'error' }])
    })

    it('surfaces parser findings as violation records with their severity and chunk', async () => {
        const url = await serve((_req, res) => {
            res.writeHead(200, SSE)
            res.write('Data: lost\nretry: soon\ndata: kept\n\n')
            res.end('event: end\ndata: x\n\n')
        })
        const t = run(url)
        t.client.start()
        await t.until(() => t.names().includes('ended'))
        expect(t.ofKind('violation').map((v) => [v.code, v.severity])).toEqual([['WRONG_CASE_FIELD', 'warning'], ['INVALID_RETRY', 'info']])
        expect(t.messages[0]?.data).toBe('kept')
    })

    it('reports an event cut off by the server, but not one cut off because the client stopped', async () => {
        const cut = await serve((_req, res) => { res.writeHead(200, SSE); res.write('data: whole\n\ndata: ha'); setTimeout(() => res.destroy(), 20) })
        const a = run(cut, { maxRetries: 0 })
        a.client.start()
        await a.until(() => a.names().includes('failed'))
        expect(a.ofKind('violation').map((v) => v.code)).toContain('UNTERMINATED_FRAME')

        const open = await serve((_req, res) => { res.writeHead(200, SSE); res.write('data: whole\n\ndata: ha') })
        const b = run(open)
        b.client.start()
        await b.until(() => b.messages.length === 1)
        await wait(20)
        b.client.stop()
        await wait(30)
        expect(b.ofKind('violation').map((v) => v.code)).not.toContain('UNTERMINATED_FRAME')
    })

    it('an observer that throws changes nothing about the stream', async () => {
        const url = await serve((_req, res) => { res.writeHead(200, SSE); res.end('id: 1\ndata: a\n\nevent: end\ndata: b\n\n') })
        const t = run(url, { onObservation: () => { throw new Error('observer exploded') } })
        t.client.start()
        await t.until(() => t.names().includes('ended'))
        expect(t.messages.map((m) => m.data)).toEqual(['a', 'b'])
    })
})

describe('observing must not change what the client does', () => {
    const scenario = async () => {
        const url = await serve((req, res, n) => {
            res.writeHead(200, SSE)
            const last = req.headers['last-event-id']
            if (n === 1) res.end(': hi\nretry: 5\nid: 1\ndata: one\n\nid: 2\nevent: named\ndata: two\n\nBad: field\n')
            else if (n === 2) res.end(`id: 3\ndata: after-${last}\n\n`)
            else res.end('event: end\ndata: done\n\n')
        })
        return url
    }

    it('delivers the same messages and goes through the same phases with and without an observer', async () => {
        const watched = run(await scenario(), {}, true)
        watched.client.start()
        await watched.until(() => watched.names().includes('ended'))

        const plain = run(await scenario(), {}, false)
        plain.client.start()
        await plain.until(() => plain.names().includes('ended'))

        expect(watched.messages).toEqual(plain.messages)
        expect(watched.phases).toEqual(plain.phases)
        expect(watched.client.lastId).toBe(plain.client.lastId)
        expect(watched.observations.length).toBeGreaterThan(0)
        expect(plain.observations).toHaveLength(0)
    })
})

// Spike for the CLI (Node 20+ fetch is undici): do the chunk records follow what the server wrote? Observed on this
// setup (loopback): a write that is flushed on its own arrives as its own chunk, and several frames written back to back
// arrive as ONE chunk. That is exactly the signature the "bursty / buffered delivery" rule looks for, so a CLI capture
// can be trusted to show chunk boundaries at least as faithfully as a browser one.
describe('chunk boundaries as seen through Node fetch (undici)', () => {
    it('keeps separately flushed writes separate, and merges writes made in the same tick', async () => {
        const frame = 'data: x\n\n'
        const url = await serve(async (_req, res) => {
            res.writeHead(200, SSE)
            for (let i = 0; i < 3; i++) { res.write(frame); await wait(60) }   // three separate flushes
            res.write(frame); res.write(frame); res.write(frame)                // three frames in one tick
            await wait(60)
            res.end('event: end\ndata: x\n\n')
        })
        const t = run(url)
        t.client.start()
        await t.until(() => t.names().includes('ended'))
        const sizes = t.ofKind('chunk').map((c) => c.bytes)
        expect(sizes.slice(0, 3)).toEqual([9, 9, 9])
        expect(sizes[3]).toBe(27)
    })
})
