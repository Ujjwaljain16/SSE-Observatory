// @vitest-environment node
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startFixtureServer, type FixtureServer } from '../server'
import { seededRandom, startFaultProxy, type FaultPlan, type FaultProxy } from '../faultProxy'
import { h01Offset } from './faultHarness'

// The proxy is test infrastructure, and a fault test is only as good as the fault. These tests talk to it with a raw socket (no SSE client in the
// way) and check that each fault does exactly what it says: where it cuts, how it splits, whether it keeps the connection open, and that it is
// repeatable. Timing assertions are lower bounds only (a delay is never shorter than asked); nothing here depends on a machine being fast.

let server: FixtureServer
const proxies: FaultProxy[] = []
beforeAll(async () => { server = await startFixtureServer({ port: 0 }) })
afterAll(async () => { await server.close() })
afterEach(async () => { await Promise.all(proxies.splice(0).map((p) => p.close())) })

async function proxy(plan: FaultPlan | ((index: number, request: string) => FaultPlan) = {}): Promise<FaultProxy> {
    const p = await startFaultProxy({ target: { port: server.port }, plan })
    proxies.push(p)
    return p
}

interface Raw {
    /** Everything received, in order. */
    wire: Buffer
    reads: Array<{ at: number; bytes: number }>
    /** How it ended: `complete` (the whole response arrived; the keep-alive socket is left open), `end` (FIN), `reset` (ECONNRESET), `open` (still open when the wait was over), `refused`. */
    ended: 'end' | 'reset' | 'open' | 'refused' | 'complete'
    elapsedMs: number
    socket: net.Socket
}

/** One GET on a fresh socket, read for at most `waitMs` (or until the peer ends it). The socket is left for the caller to destroy. */
function rawGet(port: number, path: string, waitMs = 3000, requests = 1): Promise<Raw> {
    return new Promise((resolve) => {
        const t0 = Date.now()
        const reads: Raw['reads'] = []
        const parts: Buffer[] = []
        const socket = net.connect({ host: '127.0.0.1', port })
        let settled = false
        const finish = (ended: Raw['ended']) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ wire: Buffer.concat(parts), reads, ended, elapsedMs: Date.now() - t0, socket }) }
        const timer = setTimeout(() => finish('open'), waitMs)
        socket.on('connect', () => { for (let i = 0; i < requests; i++) socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n`) })
        socket.on('data', (d: Buffer) => {
            reads.push({ at: Date.now() - t0, bytes: d.length }); parts.push(d)
            const text = Buffer.concat(parts).toString('latin1')
            if ((text.match(/\r\n0\r\n\r\n/g) ?? []).length >= requests) finish('complete')
        })
        socket.on('end', () => finish('end'))
        socket.on('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ECONNREFUSED' ? 'refused' : 'reset'))
        socket.on('close', () => finish('end'))
    })
}

/** The body of the response as a client would decode it, tolerating a cut anywhere. */
function decode(wire: Buffer): { head: string; body: Buffer; complete: boolean } {
    const at = wire.indexOf('\r\n\r\n')
    if (at < 0) return { head: wire.toString('latin1'), body: Buffer.alloc(0), complete: false }
    const head = wire.subarray(0, at).toString('latin1')
    let rest = wire.subarray(at + 4)
    const out: Buffer[] = []
    for (;;) {
        const nl = rest.indexOf('\r\n')
        if (nl < 0) return { head, body: Buffer.concat(out), complete: false }
        const size = parseInt(rest.subarray(0, nl).toString('latin1'), 16)
        if (size === 0) return { head, body: Buffer.concat(out), complete: rest.length >= nl + 4 }
        const data = rest.subarray(nl + 2, nl + 2 + size)
        out.push(data)
        if (data.length < size) return { head, body: Buffer.concat(out), complete: false }
        rest = rest.subarray(nl + 2 + size + 2)
    }
}

/** Waits (up to a second) for the proxy's own bookkeeping, which runs a moment after the client has read the last byte. */
const settled = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10)) }

const H01 = '/h01?scale=0.02&n=4'
const direct = async (path = H01) => { const r = await rawGet(server.port, path, 5000); r.socket.destroy(); return r }

describe('a proxy with no plan is transparent (the control for every fault)', () => {
    it('delivers the same decoded body as the server alone, and ends it the same way', async () => {
        const alone = await direct()
        const p = await proxy()
        const through = await rawGet(p.port, H01, 5000)
        through.socket.destroy()
        await settled(() => p.responses[0]?.completed === true)
        const a = decode(alone.wire)
        const b = decode(through.wire)
        expect(a.complete).toBe(true)
        expect(b.complete).toBe(true)
        expect(b.body.toString()).toBe(a.body.toString())
        expect(b.body.toString()).toContain('event: end')
        expect(p.responses).toHaveLength(1)
        expect(p.responses[0]!.completed).toBe(true)
        expect(p.responses[0]!.request).toBe(`GET ${H01} HTTP/1.1`)
        expect(p.responses[0]!.payloadBytes).toBe(a.body.length)
    })

    it('counts the n-th response even when the client reuses one socket for two requests', async () => {
        const plans: string[] = []
        const p = await proxy((index, request) => { plans.push(`${index} ${request}`); return {} })
        const r = await rawGet(p.port, '/h01?scale=0.02&n=2', 3000, 2)
        r.socket.destroy()
        await settled(() => p.responses.length === 2 && p.responses.every((x) => x.completed))
        expect(p.connections).toBe(1)
        expect(plans).toEqual(['0 GET /h01?scale=0.02&n=2 HTTP/1.1', '1 GET /h01?scale=0.02&n=2 HTTP/1.1'])
        expect(p.responses.every((x) => x.completed)).toBe(true)
        expect(r.wire.toString('latin1').match(/HTTP\/1\.1 200/g)).toHaveLength(2)
    })
})

describe('re-chunking', () => {
    it('chunking { bytes: 1 } writes the whole response one byte at a time and loses nothing', async () => {
        const alone = decode((await direct()).wire)
        const p = await proxy({ chunking: { bytes: 1 } })
        const r = await rawGet(p.port, H01, 8000)
        r.socket.destroy()
        const log = p.responses[0]!
        expect(log.writes.length).toBe(log.wireBytes)
        expect(new Set(log.writes)).toEqual(new Set([1]))
        expect(decode(r.wire).body.toString()).toBe(alone.body.toString())
        // the fault really reached the receiver as many small reads (a loopback may merge some; most of them must still be tiny)
        expect(r.reads.filter((x) => x.bytes <= 8).length).toBeGreaterThan(r.reads.length / 2)
    })

    it('headersIntact sends the head whole and shapes only the body', async () => {
        const p = await proxy({ chunking: { bytes: 1 }, headersIntact: true })
        const r = await rawGet(p.port, '/h01?scale=0.02&n=2', 8000)
        r.socket.destroy()
        await settled(() => p.responses[0]!.completed)
        const writes = p.responses[0]!.writes
        expect(writes[0]).toBeGreaterThan(100)
        expect(writes[0]).toBe(r.wire.indexOf('\r\n\r\n') + 4)
        expect(new Set(writes.slice(1))).toEqual(new Set([1]))
        expect(decode(r.wire).complete).toBe(true)
    })

    it('random split points come from the seed: the same seed gives the same writes, another seed other writes, all inside the bounds', async () => {
        const run = async (seed: number) => {
            const p = await proxy({ chunking: { minBytes: 2, maxBytes: 9, seed } })
            const r = await rawGet(p.port, H01, 5000)
            r.socket.destroy()
            return p.responses[0]!.writes
        }
        const [a, b, c] = [await run(7), await run(7), await run(8)]
        // The last write of a piece can be shorter than the minimum (the data ran out), and a write never spans a response; everything else is in bounds.
        expect(a.slice(0, -1).every((n) => n >= 2 && n <= 9)).toBe(true)
        expect(a.length).toBeGreaterThan(10)
        expect(b.slice(0, 8)).toEqual(a.slice(0, 8))
        expect(c.slice(0, 8)).not.toEqual(a.slice(0, 8))
    })

    it('the seeded generator is repeatable and spread over [0, 1)', () => {
        const x = seededRandom(42)
        const y = seededRandom(42)
        const xs = Array.from({ length: 5 }, () => x())
        expect(Array.from({ length: 5 }, () => y())).toEqual(xs)
        expect(xs.every((v) => v >= 0 && v < 1)).toBe(true)
        expect(new Set(xs).size).toBe(5)
    })
})

describe('delay and throttle', () => {
    it('responseDelayMs holds the headers back (never less than asked)', async () => {
        const p = await proxy({ responseDelayMs: 350 })
        const r = await rawGet(p.port, '/h01?scale=0.02&n=1', 5000)
        r.socket.destroy()
        expect(r.reads[0]!.at).toBeGreaterThanOrEqual(330)
    })

    it('bodyDelayMs sends the headers at once and holds the first body byte', async () => {
        const p = await proxy({ bodyDelayMs: 400 })
        const r = await rawGet(p.port, '/h01?scale=0.02&n=1', 5000)
        r.socket.destroy()
        const headsAt = r.reads[0]!.at
        expect(r.wire.subarray(0, r.reads[0]!.bytes).toString('latin1')).toMatch(/^HTTP\/1\.1 200[\s\S]*\r\n\r\n$/)
        const bodyAt = r.reads[1]!.at
        expect(bodyAt - headsAt).toBeGreaterThanOrEqual(370)
    })

    it('bytesPerSecond never runs ahead of the rate', async () => {
        const p = await proxy({ bytesPerSecond: 1200, chunking: { bytes: 40 } })
        const r = await rawGet(p.port, '/h01?scale=0.02&n=4', 8000)
        r.socket.destroy()
        await settled(() => p.responses[0]!.completed)
        const total = p.responses[0]!.wireBytes
        expect(r.elapsedMs).toBeGreaterThanOrEqual((total / 1200) * 1000 * 0.8)
        expect(p.responses[0]!.completed).toBe(true)
    })

    it('a delay before every write adds up (jitter drawn from a seeded generator)', async () => {
        const run = async () => {
            const p = await proxy({ chunking: { bytes: 60 }, chunkDelayMs: { minMs: 5, maxMs: 15, seed: 3 } })
            const r = await rawGet(p.port, '/h01?scale=0.02&n=3', 5000)
            r.socket.destroy()
            return r.elapsedMs
        }
        const t = await run()
        expect(t).toBeGreaterThanOrEqual(5 * 4)
    })
})

describe('faults', () => {
    it('rst after N payload bytes: the receiver gets exactly N body bytes and then a reset', async () => {
        const cut = h01Offset(2, 10) // ten bytes into the third event
        const p = await proxy({ fault: { kind: 'rst', at: { payloadBytes: cut } } })
        const r = await rawGet(p.port, '/h01?scale=0.02&n=6', 5000)
        expect(r.ended).toBe('reset')
        const got = decode(r.wire)
        expect(got.body.length).toBe(cut)
        expect(got.complete).toBe(false)
        expect(p.responses[0]!.fired).toMatchObject({ kind: 'rst' })
        expect(p.responses[0]!.payloadBytes).toBe(cut)
    })

    it('fin after N payload bytes: an orderly close with the response unfinished (no terminal chunk)', async () => {
        const cut = h01Offset(2, 10)
        const p = await proxy({ fault: { kind: 'fin', at: { payloadBytes: cut } } })
        const r = await rawGet(p.port, '/h01?scale=0.02&n=6', 5000)
        expect(r.ended).toBe('end')
        const got = decode(r.wire)
        expect(got.body.length).toBe(cut)
        expect(got.complete).toBe(false)
        expect(p.responses[0]!.completed).toBe(false)
    })

    it('a fault at a wire offset can cut inside the headers', async () => {
        const p = await proxy({ fault: { kind: 'fin', at: { wireBytes: 20 } } })
        const r = await rawGet(p.port, '/h01?scale=0.02&n=3', 5000)
        expect(r.wire.length).toBe(20)
        expect(r.wire.toString('latin1')).toBe('HTTP/1.1 200 OK\r\nAcc'.slice(0, 20))
        expect(r.ended).toBe('end')
    })

    it('blackhole after the headers (slow loris): the headers arrive, then nothing, and the connection stays open', async () => {
        const p = await proxy({ fault: { kind: 'blackhole', at: { payloadBytes: 0 } } })
        const r = await rawGet(p.port, '/h01?scale=0.02&n=6', 700)
        r.socket.destroy()
        expect(r.ended).toBe('open')
        expect(decode(r.wire).head).toMatch(/^HTTP\/1\.1 200 OK/)
        expect(decode(r.wire).body.length).toBe(0)
        expect(p.responses[0]!.fired).toMatchObject({ kind: 'blackhole' })
    })

    it('blackhole mid-event: the bytes before the cut arrive, the rest never does, and the socket is not closed', async () => {
        const cut = h01Offset(3, 5)
        const p = await proxy({ fault: { kind: 'blackhole', at: { payloadBytes: cut } } })
        const r = await rawGet(p.port, '/h01?scale=0.02&n=8', 900)
        r.socket.destroy()
        expect(r.ended).toBe('open')
        expect(decode(r.wire).body.length).toBe(cut)
    })

    it('a fault that is never reached does not fire, and the response completes', async () => {
        const p = await proxy({ fault: { kind: 'rst', at: { payloadBytes: 100_000 } } })
        const r = await rawGet(p.port, '/h01?scale=0.02&n=2', 3000)
        r.socket.destroy()
        expect(p.responses[0]!.fired).toBeUndefined()
        expect(p.responses[0]!.completed).toBe(true)
    })

    it('thenRefuse closes the listener once the response is over: the next connection is refused', async () => {
        const p = await proxy({ thenRefuse: true })
        const first = await rawGet(p.port, '/h01?scale=0.02&n=2', 3000)
        first.socket.destroy()
        expect(decode(first.wire).complete).toBe(true)
        await new Promise((r) => setTimeout(r, 50))
        const second = await rawGet(p.port, '/h01?scale=0.02&n=2', 2000)
        expect(second.ended).toBe('refused')
    })

    it('the plan is chosen per response: a function sees the index, so the first can be cut and the second left alone', async () => {
        const p = await proxy((index) => (index === 0 ? { fault: { kind: 'fin', at: { payloadBytes: 30 } } } : {}))
        const a = await rawGet(p.port, '/h01?scale=0.02&n=3', 3000)
        const b = await rawGet(p.port, '/h01?scale=0.02&n=3', 3000)
        a.socket.destroy(); b.socket.destroy()
        expect(decode(a.wire).complete).toBe(false)
        expect(decode(b.wire).complete).toBe(true)
        expect(p.responses.map((x) => x.index)).toEqual([0, 1])
    })
})

describe('the proxy is test infrastructure and is not shipped', () => {
    it('nothing under src/core or src/cli (outside __tests__) refers to it, so the CLI bundle and the package cannot contain it', () => {
        const offenders: string[] = []
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(full) } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && /faultProxy/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full)
            }
        }
        for (const dir of ['src/core', 'src/cli']) walk(path.resolve(process.cwd(), dir))
        expect(offenders).toEqual([])
    })
})
