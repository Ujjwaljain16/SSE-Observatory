// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SSEClient, type SSEPhase, type SSEClientOptions } from '../sseClient'
import { Recorder } from '../../observe/recorder'
import type { Observation } from '../../observe/observation'

const servers: http.Server[] = []
afterEach(() => { servers.splice(0).forEach((s) => { s.closeAllConnections(); s.close() }) })

async function endpoint() {
    const seen: Array<string | undefined> = []
    const server = http.createServer((req, res) => {
        seen.push(req.headers['last-event-id'] as string | undefined)
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(`data: after ${req.headers['last-event-id'] ?? 'nothing'}\n\nevent: end\ndata: done\n\n`)
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen }
}

async function finish(url: string, extra: Partial<SSEClientOptions>) {
    const data: string[] = []
    const phases: SSEPhase[] = []
    const observations: Observation[] = []
    const recorder = new Recorder({ onRecord: (o) => observations.push(o) })
    const client = new SSEClient({
        request: () => ({ url }),
        onMessage: (m) => data.push(m.data),
        onPhase: (p) => phases.push(p),
        onObservation: (d) => recorder.record(d),
        ...extra,
    })
    client.start()
    const t0 = Date.now()
    while (!phases.includes('ended')) { if (Date.now() - t0 > 3000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)) }
    return { data, observations }
}

describe('SSEClient initialLastEventId (taking over a stream another client was reading)', () => {
    it('sends Last-Event-ID on the very first request, so the server can continue where the other client stopped', async () => {
        const { url, seen } = await endpoint()
        const { data, observations } = await finish(url, { initialLastEventId: '41' })
        expect(seen).toEqual(['41'])
        expect(data[0]).toBe('after 41')
        expect(observations.find((o) => o.kind === 'connect')).toMatchObject({ sentLastEventId: '41' })
    })

    it('sends nothing on the first request without it (a fresh stream starts fresh)', async () => {
        const { url, seen } = await endpoint()
        await finish(url, {})
        expect(seen).toEqual([undefined])
    })

    it('treats an empty id like no id', async () => {
        const { url, seen } = await endpoint()
        await finish(url, { initialLastEventId: '' })
        expect(seen).toEqual([undefined])
    })
})
