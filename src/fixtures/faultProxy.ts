/**
 * A TCP fault-injection proxy, for tests only.
 *
 * It sits between a client and a fixture server (or any HTTP server on a port) and shapes what the server sends back, one response at a time,
 * according to a plan. Everything is a node `net` socket pair on 127.0.0.1, so what the client meets is a real TCP peer behaving badly: bytes
 * dribbled one at a time, a connection reset in the middle of an event, a connection that goes silent without closing, a port that refuses.
 * It is a simulation of the TCP level only: no TLS, no HTTP/2, no CDN, no packet loss or reordering (TCP hides those from an application anyway).
 *
 * Not part of the product: nothing under `src/core` or `src/cli` imports it, and `scripts/build-check.mjs` asserts the built package does not contain it.
 *
 * How a response is shaped. The proxy reads the response head and body as they arrive and keeps a count of `wire` bytes (everything the server
 * sent, headers and chunk framing included) and of `payload` bytes (the decoded body: what the SSE parser is fed). It then writes them to the client
 * in pieces, each after the delays and within the limits of the plan:
 *
 *   responseDelayMs   wait this long after the first response byte reached the proxy, then send the headers (a slow server, or a slow first hop)
 *   bodyDelayMs       send the headers at once, hold the first body byte this long (headers on time, no flush)
 *   chunking          every write is `bytes` long, or a length drawn from [minBytes, maxBytes] by a seeded generator (the parser must not care)
 *   chunkDelayMs      wait before every write: a fixed time, or one drawn from [minMs, maxMs] by a seeded generator
 *   bytesPerSecond    never run ahead of this rate (a time budget, so it does not drift with the timers)
 *   headersIntact     the head is sent whole and unshaped; chunking, per-write delay and the rate apply to the body only
 *   fault             at a byte count: `rst` (TCP reset), `fin` (an orderly close, in the middle of whatever was being sent) or `blackhole`
 *                     (stop forwarding and discard everything, but keep the connection open: a half-open peer)
 *   thenRefuse        when the response ends (by the fault, or by completing) the listener is closed and the connection dropped, so the next
 *                     attempt meets "connection refused"
 *
 * Every plan is deterministic: counts are explicit and jitter comes from a seeded generator, so a test that fails fails the same way again.
 * The plan is chosen per RESPONSE (the n-th request the proxy saw, counting from 0), which matches the n-th connection record the client
 * makes and the n-th entry in the fixture server's ground-truth log, even when the client reuses one keep-alive socket for several requests.
 */

import net from 'node:net'
import type { AddressInfo } from 'node:net'

/** Where a fault fires: after this many decoded body bytes (`payloadBytes: 0` is right after the headers) or after this many bytes on the wire. */
export type FaultAt = { payloadBytes: number } | { wireBytes: number }
export type FaultKind = 'rst' | 'fin' | 'blackhole'
export interface Jitter { minMs: number; maxMs: number; seed: number }

export interface FaultPlan {
    responseDelayMs?: number
    bodyDelayMs?: number
    chunking?: { bytes: number } | { minBytes: number; maxBytes: number; seed: number }
    chunkDelayMs?: number | Jitter
    bytesPerSecond?: number
    /** The response head goes out in one write, with no delay and outside the rate: chunking, `chunkDelayMs` and `bytesPerSecond` shape the body only. Without it the head (about 500 bytes) is shaped like everything else, which on a slow plan takes seconds. */
    headersIntact?: boolean
    /** `settleMs` (default 30, `rst` only): how long to let the bytes already written reach the receiver before the reset, because a reset throws away what the receiver has not read yet (so without it the cut would land earlier than asked, by an amount that depends on the machine). */
    fault?: { kind: FaultKind; at: FaultAt; settleMs?: number }
    thenRefuse?: boolean
}

/** What the proxy did with one response (for the test to check that the fault it asked for really happened). */
export interface ResponseLog {
    index: number
    /** The request line, for example `GET /h01?scale=0.05 HTTP/1.1`. */
    request: string
    /** The size of every write made to the client, in order. */
    writes: number[]
    wireBytes: number
    /** Decoded body bytes: exactly the fault's offset when a payload fault fired, otherwise what the proxy counted when the response ended or the fault fired. */
    payloadBytes: number
    /** Set when the plan's fault fired: which, and after how many wire bytes. */
    fired: { kind: FaultKind; atWireBytes: number } | undefined
    /** The server's response ended (the terminal chunk, or the length) and every byte was forwarded. */
    completed: boolean
}

export interface FaultProxy {
    /** `http://127.0.0.1:<port>` */
    url: string
    port: number
    responses: ResponseLog[]
    /** TCP connections accepted so far. */
    connections: number
    /** Closes the listener now: the next connection attempt is refused. Connections already made stay up. */
    stopListening(): void
    /** Turns a fixture URL (`http://127.0.0.1:<server port>/h01?scale=0.05`) into the same path and query on the proxy. */
    through(fixtureUrl: string): string
    close(): Promise<void>
}

export interface FaultProxyOptions {
    /** The server to forward to. */
    target: { host?: string; port: number }
    /** One plan for every response, or a function of the response's index and request line. Default: no fault (a transparent proxy: the control). */
    plan?: FaultPlan | ((index: number, request: string) => FaultPlan)
    port?: number
    host?: string
}

/** A small seeded generator (mulberry32): the same seed gives the same sequence on every machine. */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const CRLFCRLF = Buffer.from('\r\n\r\n')

/**
 * Follows one response through the bytes the server sends: where the head ends, how many body bytes there are and where the response completes.
 * Handles chunked and content-length bodies, a body that runs to the close, and the statuses that have no body.
 */
class ResponseTracker {
    wire = 0
    payload = 0
    headEnd = -1
    done = false
    /** The wire offset right after the n-th payload byte, once it has been seen. */
    private watch: number | undefined
    private watchWire: number | undefined
    private head = Buffer.alloc(0)
    private mode: 'head' | 'chunked' | 'length' | 'close' = 'head'
    private remaining = 0
    private chunk: 'size' | 'data' | 'data-crlf' | 'trailer' = 'size'
    private sizeText = ''
    private crlfSeen = 0
    private line = 0

    /** Ask to be told the wire offset right after `payloadBytes` body bytes (0 means the end of the head). */
    watchPayload(payloadBytes: number): void { this.watch = payloadBytes }
    get payloadReachedAt(): number | undefined { return this.watchWire }

    /** Consumes bytes up to the end of the response and returns how many it used (the rest belongs to the next response). */
    feed(buf: Buffer): number {
        let i = 0
        while (i < buf.length && !this.done) {
            if (this.mode === 'head') {
                this.head = Buffer.concat([this.head, buf.subarray(i, i + 1)])
                this.wire++
                i++
                if (this.head.length >= 4 && this.head.subarray(this.head.length - 4).equals(CRLFCRLF)) this.endOfHead()
                continue
            }
            if (this.mode === 'close') { this.addPayload(buf.length - i); i = buf.length; continue }
            if (this.mode === 'length') {
                const n = Math.min(this.remaining, buf.length - i)
                this.addPayload(n); this.remaining -= n; i += n
                if (this.remaining === 0) this.done = true
                continue
            }
            // chunked
            const byte = buf[i]!
            if (this.chunk === 'data') {
                const n = Math.min(this.remaining, buf.length - i)
                this.addPayload(n); this.remaining -= n; i += n
                if (this.remaining === 0) { this.chunk = 'data-crlf'; this.crlfSeen = 0 }
                continue
            }
            this.wire++; i++
            if (this.chunk === 'size') {
                if (byte === 0x0a) {
                    const size = parseInt(this.sizeText.split(';')[0]!.trim(), 16)
                    this.sizeText = ''
                    if (!Number.isFinite(size) || size < 0) { this.done = true; continue }
                    if (size === 0) { this.chunk = 'trailer'; this.line = 0 } else { this.chunk = 'data'; this.remaining = size }
                } else if (byte !== 0x0d) this.sizeText += String.fromCharCode(byte)
            } else if (this.chunk === 'data-crlf') {
                if (++this.crlfSeen === 2) this.chunk = 'size'
            } else { // trailer: an empty line ends the response
                if (byte === 0x0a) { if (this.line === 0) this.done = true; this.line = 0 } else if (byte !== 0x0d) this.line++
            }
        }
        return i
    }

    /** The server closed: a body that runs to the close is complete, anything else was cut. */
    upstreamClosed(): void { if (this.mode === 'close') this.done = true }

    private addPayload(n: number): void {
        if (n <= 0) return
        const before = this.payload
        this.payload += n
        this.wire += n
        // the wire offset after the watched byte: it lies inside this run of `n` bytes
        if (this.watch !== undefined && this.watchWire === undefined && before < this.watch && this.payload >= this.watch) this.watchWire = this.wire - (this.payload - this.watch)
    }

    private endOfHead(): void {
        this.headEnd = this.wire
        const text = this.head.toString('latin1')
        const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(text)?.[1] ?? 0)
        if (this.watch === 0) this.watchWire = this.wire
        if (status === 204 || status === 304 || (status >= 100 && status < 200)) { this.done = true; return }
        if (/^transfer-encoding:\s*chunked/im.test(text)) { this.mode = 'chunked'; this.chunk = 'size'; return }
        const length = /^content-length:\s*(\d+)/im.exec(text)?.[1]
        if (length !== undefined) { this.mode = 'length'; this.remaining = Number(length); if (this.remaining === 0) this.done = true; return }
        this.mode = 'close'
    }
}

interface Controls {
    write(buf: Buffer): void
    reset(): void
    finish(): void
    refuse(): void
    isClosed(): boolean
}

/** One response on its way to the client. */
class Shaper {
    readonly log: ResponseLog
    private readonly tracker = new ResponseTracker()
    private queue: Buffer[] = []
    private queued = 0
    private sent = 0
    private running = false
    private upstreamEnded = false
    private silent = false
    private finished = false
    private firstDelayDone = false
    private bodyDelayDone = false
    private rate: { t0: number } | undefined
    /** Bytes counted against the rate: everything written, except a head sent whole (`headersIntact`). */
    private paced = 0
    private readonly sizes: () => number
    private readonly delays: () => number
    private cut: number | undefined

    constructor(index: number, request: string, private readonly plan: FaultPlan, private readonly controls: Controls, private readonly sleep: (ms: number) => Promise<boolean>) {
        this.log = { index, request, writes: [], wireBytes: 0, payloadBytes: 0, fired: undefined, completed: false }
        const fault = plan.fault
        if (fault && 'payloadBytes' in fault.at) this.tracker.watchPayload(fault.at.payloadBytes)
        else if (fault) this.cut = (fault.at as { wireBytes: number }).wireBytes
        const chunking = plan.chunking
        if (!chunking) this.sizes = () => Infinity
        else if ('bytes' in chunking) { const n = Math.max(1, chunking.bytes); this.sizes = () => n }
        else { const rnd = seededRandom(chunking.seed); const lo = Math.max(1, chunking.minBytes); const hi = Math.max(lo, chunking.maxBytes); this.sizes = () => lo + Math.floor(rnd() * (hi - lo + 1)) }
        const delay = plan.chunkDelayMs
        if (delay === undefined) this.delays = () => 0
        else if (typeof delay === 'number') this.delays = () => delay
        else { const rnd = seededRandom(delay.seed); this.delays = () => delay.minMs + rnd() * (delay.maxMs - delay.minMs) }
    }

    get isDone(): boolean { return this.finished }
    /** The connection was cut (reset or closed) by this plan: whatever the server still sends is dropped, not passed on. */
    get cutOff(): boolean { return this.log.fired !== undefined && this.log.fired.kind !== 'blackhole' }

    /** Takes bytes from the server; returns how many belonged to this response. */
    feed(buf: Buffer): number {
        const used = this.tracker.feed(buf)
        if (!this.silent && used > 0) { const part = Buffer.from(buf.subarray(0, used)); this.queue.push(part); this.queued += part.length }
        void this.run()
        return used
    }

    serverClosed(): void {
        this.upstreamEnded = true
        this.tracker.upstreamClosed()
        void this.run()
    }

    private take(max: number): Buffer {
        const first = this.queue[0]!
        if (first.length <= max) { this.queue.shift(); this.queued -= first.length; return first }
        this.queue[0] = first.subarray(max)
        this.queued -= max
        return first.subarray(0, max)
    }

    private async run(): Promise<void> {
        if (this.running || this.finished) return
        this.running = true
        try {
            for (;;) {
                if (this.controls.isClosed()) return
                const reachedAt = this.cut ?? this.tracker.payloadReachedAt
                if (this.plan.fault && !this.log.fired && reachedAt !== undefined && this.sent >= reachedAt) { this.fire(); return }
                if (this.silent) return
                if (this.queued === 0) {
                    if (this.tracker.done) { this.complete(); return }
                    if (this.upstreamEnded) { this.finished = true; this.controls.finish(); return }
                    return // wait for more bytes
                }
                if (!this.firstDelayDone) { this.firstDelayDone = true; if ((this.plan.responseDelayMs ?? 0) > 0 && !(await this.sleep(this.plan.responseDelayMs!))) return }
                let max = this.sizes()
                if (reachedAt !== undefined && this.plan.fault && !this.log.fired) max = Math.min(max, reachedAt - this.sent)
                const headEnd = this.tracker.headEnd
                const intact = this.plan.headersIntact === true
                if (intact && headEnd < 0 && !this.upstreamEnded) return // the head is still arriving: it goes out whole, so wait for the rest of it
                const inHead = intact && headEnd >= 0 && this.sent < headEnd
                if (inHead) max = Math.min(headEnd - this.sent, reachedAt !== undefined && this.plan.fault && !this.log.fired ? reachedAt - this.sent : Infinity)
                if (this.plan.bodyDelayMs !== undefined && headEnd >= 0 && !this.bodyDelayDone) {
                    if (this.sent < headEnd) max = Math.min(max, headEnd - this.sent)
                    else { this.bodyDelayDone = true; if (!(await this.sleep(this.plan.bodyDelayMs))) return; continue }
                }
                if (this.plan.bodyDelayMs !== undefined && headEnd < 0) max = Math.min(max, this.queued) // the head is still arriving
                const wait = inHead ? 0 : this.delays()
                if (wait > 0 && !(await this.sleep(wait))) return
                const piece = this.take(Math.max(1, Math.min(max, this.queued)))
                this.controls.write(piece)
                this.sent += piece.length
                this.log.wireBytes = this.sent
                this.log.writes.push(piece.length)
                if (inHead || (this.queued === 0 && this.tracker.done)) continue // the head is not paced; and with nothing left to pace, the top of the loop completes the response
                const rate = this.plan.bytesPerSecond
                if (rate !== undefined && rate > 0) {
                    this.paced += piece.length
                    this.rate ??= { t0: Date.now() - (piece.length / rate) * 1000 }
                    const due = this.rate.t0 + (this.paced / rate) * 1000
                    const ahead = due - Date.now()
                    if (ahead > 0 && !(await this.sleep(ahead))) return
                } else await new Promise<void>((resolve) => setImmediate(resolve)) // let the receiver see this write before the next
            }
        } finally { this.running = false }
    }

    private fire(): void {
        const kind = this.plan.fault!.kind
        this.log.fired = { kind, atWireBytes: this.sent }
        const at = this.plan.fault!.at
        this.log.payloadBytes = 'payloadBytes' in at ? at.payloadBytes : this.tracker.payload
        if (this.plan.thenRefuse) this.controls.refuse()
        if (kind === 'blackhole') { this.silent = true; this.queue = []; this.queued = 0; return }
        this.finished = true
        if (kind === 'rst') void this.sleep(this.plan.fault!.settleMs ?? 30).then((alive) => { if (alive) this.controls.reset() })
        else this.controls.finish()
    }

    private complete(): void {
        this.finished = true
        this.log.completed = true
        this.log.payloadBytes = this.tracker.payload
        if (this.plan.thenRefuse) { this.controls.refuse(); this.controls.finish() }
    }
}

export async function startFaultProxy(options: FaultProxyOptions): Promise<FaultProxy> {
    const host = options.host ?? '127.0.0.1'
    const targetHost = options.target.host ?? '127.0.0.1'
    const responses: ResponseLog[] = []
    const sockets = new Set<net.Socket>()
    const timers = new Set<NodeJS.Timeout>()
    const wakers = new Set<() => void>()
    let accepted = 0
    let requestCount = 0
    let shutting = false

    const sleep = (ms: number): Promise<boolean> => new Promise((resolve) => {
        if (shutting) return resolve(false)
        const wake = () => { wakers.delete(wake); resolve(false) }
        wakers.add(wake)
        const t = setTimeout(() => { timers.delete(t); wakers.delete(wake); resolve(!shutting) }, Math.max(0, ms))
        timers.add(t)
    })

    const planFor = (index: number, request: string): FaultPlan => typeof options.plan === 'function' ? options.plan(index, request) : options.plan ?? {}

    const server = net.createServer((client) => {
        accepted++
        sockets.add(client)
        client.setNoDelay(true)
        const upstream = net.connect({ host: targetHost, port: options.target.port })
        sockets.add(upstream)
        upstream.setNoDelay(true)
        let closed = false
        const closeBoth = () => { closed = true; client.destroy(); upstream.destroy() }
        client.on('close', closeBoth)
        upstream.on('close', () => { for (const s of shapers) s.serverClosed(); if (!shapers.some((s) => !s.isDone) && !client.destroyed) client.end() })
        client.on('error', () => undefined)
        upstream.on('error', () => undefined)

        const shapers: Shaper[] = []
        const controls: Controls = {
            write: (buf) => { if (!client.destroyed) client.write(buf) },
            reset: () => { upstream.destroy(); client.resetAndDestroy() },
            finish: () => { upstream.destroy(); client.end() },
            refuse: () => stopListening(),
            isClosed: () => closed || client.destroyed,
        }

        // Requests: one head per request (the fixtures only serve GET), forwarded as it is.
        let requestBuf = Buffer.alloc(0)
        client.on('data', (data: Buffer) => {
            if (!upstream.destroyed) upstream.write(data)
            requestBuf = Buffer.concat([requestBuf, data])
            for (;;) {
                const end = requestBuf.indexOf(CRLFCRLF)
                if (end < 0) break
                const request = requestBuf.subarray(0, requestBuf.indexOf('\r\n')).toString('latin1')
                requestBuf = requestBuf.subarray(end + 4)
                const index = requestCount++
                const shaper = new Shaper(index, request, planFor(index, request), controls, sleep)
                responses.push(shaper.log)
                shapers.push(shaper)
            }
        })

        upstream.on('data', (data: Buffer) => {
            if (shapers.some((s) => s.cutOff)) return
            let rest: Buffer = data
            while (rest.length > 0) {
                const current = shapers.find((s) => !s.isDone)
                if (!current) { controls.write(rest); return } // nothing asked for it: pass it on
                const used = current.feed(rest)
                rest = rest.subarray(used)
                if (used === 0) break
            }
        })
    })

    let listening = true
    const stopListening = () => { if (listening) { listening = false; server.close() } }

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port ?? 0, host, () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    const base = `http://${host}:${port}`

    return {
        url: base,
        port,
        responses,
        get connections() { return accepted },
        stopListening,
        through(fixtureUrl) { const u = new URL(fixtureUrl); return `${base}${u.pathname}${u.search}` },
        async close() {
            shutting = true
            timers.forEach(clearTimeout)
            wakers.forEach((w) => w())
            sockets.forEach((s) => s.destroy())
            if (listening) { listening = false; await new Promise<void>((resolve) => server.close(() => resolve())) }
        },
    }
}
