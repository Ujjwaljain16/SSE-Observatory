/**
 * A small fluent builder of stamped observation records on virtual time, so rules can be tested without sockets:
 *
 *   capture().connect().response().at(500).frame('tick', '1').silence(20_000).build()
 *
 * It mirrors what SSEClient + Recorder emit: the first `connect()` is preceded by a `connecting` phase, `response()`
 * adds the client's own violation records for a non-200 status or a wrong content type and then the `open` phase,
 * `frame()` is a chunk followed by the event parsed from it. Time only moves forward, via `at()` or `silence()`.
 */

import type { EngineInput } from '../diagnostics/streamModel'
import type { Observation, ObservationBody } from '../observe/observation'
import type { SSEPhase, SSEPhaseInfo } from '../sse/sseClient'
import { violationSeverity, type ViolationCode } from '../sse/violations'

export interface ConnectOptions { url?: string; method?: string; headerNames?: string[]; sentLastEventId?: string }
export interface ResponseOptions {
    status?: number
    contentType?: string
    /** Merged over a healthy default (Cache-Control: no-cache, X-Accel-Buffering: no); 'none' for a response whose headers were not readable. */
    headers?: Record<string, string | undefined> | 'none'
    redirected?: boolean
    ttfbMs?: number
    /** Emit the `open` phase after an OK event-stream response (default true). */
    open?: boolean
}

const HEALTHY_HEADERS: Record<string, string> = { 'cache-control': 'no-cache', 'x-accel-buffering': 'no' }

export class CaptureBuilder {
    private readonly records: EngineInput[] = []
    private t = 0
    private seq = 0
    private conn = -1

    /** Virtual time now, in milliseconds since the capture started. */
    get now(): number { return this.t }

    /** Jump to an absolute virtual time (never backwards). */
    at(t: number): this {
        if (t < this.t) throw new Error(`capture time cannot go backwards (${t} < ${this.t})`)
        this.t = t
        return this
    }

    /** Let time pass with nothing arriving. */
    silence(ms: number): this { return this.at(this.t + ms) }
    wait(ms: number): this { return this.silence(ms) }

    private push(body: ObservationBody | { kind: 'clock.discontinuity'; gapMs?: number; reason?: string }): this {
        if (body.kind === 'connect') this.conn++
        this.records.push({ seq: this.seq++, t: this.t, conn: Math.max(this.conn, 0), ...body } as EngineInput)
        return this
    }

    connect(o: ConnectOptions = {}): this {
        if (this.conn < 0) this.phase('connecting', { attempt: 0 })
        return this.push({ kind: 'connect', attempt: Math.max(this.conn + 1, 0), url: o.url ?? 'http://stream.test/events', method: o.method ?? 'GET', headerNames: o.headerNames ?? ['accept', 'cache-control'], sentLastEventId: o.sentLastEventId ?? '' })
    }

    response(o: ResponseOptions = {}): this {
        const status = o.status ?? 200
        const contentType = o.contentType ?? 'text/event-stream'
        const headers: Record<string, string> = {}
        if (o.headers !== 'none') {
            for (const [name, value] of Object.entries({ ...(contentType ? { 'content-type': contentType } : {}), ...HEALTHY_HEADERS, ...o.headers })) if (value !== undefined) headers[name] = value
        }
        this.push({ kind: 'response', status, contentType, redirected: o.redirected ?? false, headers, ttfbMs: o.ttfbMs ?? 0 })
        if (status !== 200 && status !== 204) this.violation('HTTP_STATUS_NOT_200', `The response status was ${status}.`)
        else if (!/text\/event-stream/i.test(contentType)) this.violation('BAD_CONTENT_TYPE', `The Content-Type was "${contentType || 'none'}".`)
        else if (o.open !== false) this.phase('open', { attempt: 0 })
        return this
    }

    chunk(bytes = 40): this { return this.push({ kind: 'chunk', bytes }) }

    comment(text = ' heartbeat', source: 'proxy' | 'upstream' = 'upstream'): this { return this.push({ kind: 'comment', text, source }) }

    /** A chunk carrying one comment: what a heartbeat looks like on the wire. */
    beat(source: 'proxy' | 'upstream' = 'upstream', text?: string): this {
        return this.chunk(source === 'proxy' ? 30 : 14).comment(text ?? (source === 'proxy' ? 'sse-proxy hb up_idle=0 n=1' : ' keep-alive'), source)
    }

    event(name = 'message', sseId = '', dataBytes = 10): this { return this.push({ kind: 'event', event: name, sseId, dataBytes }) }

    /** A chunk carrying one complete event. */
    frame(name = 'message', sseId = '', dataBytes = 10): this { return this.chunk(20 + dataBytes).event(name, sseId, dataBytes) }

    retry(ms: number): this { return this.push({ kind: 'retry', ms }) }

    violation(code: ViolationCode, detail?: string, chunk?: number): this {
        return this.push({ kind: 'violation', code, severity: violationSeverity(code), detail: detail ?? code, ...(chunk !== undefined ? { chunk } : {}) })
    }

    phase(phase: SSEPhase, info: SSEPhaseInfo = { attempt: 0 }): this { return this.push({ kind: 'phase', phase, info }) }

    reconnect(o: { attempt?: number; delayMs?: number; reason?: string; lastEventIdSent?: string; status?: number } = {}): this {
        const attempt = o.attempt ?? 1
        const delayMs = o.delayMs ?? 1000
        this.push({ kind: 'reconnect', attempt, delayMs, reason: o.reason ?? 'Stream closed by server', lastEventIdSent: o.lastEventIdSent ?? '', ...(o.status !== undefined ? { status: o.status } : {}) })
        return this.phase('reconnecting', { attempt, delayMs, reason: o.reason ?? 'Stream closed by server' })
    }

    /** The server ended the stream for good. */
    end(): this { return this.phase('ended', { attempt: 0, reason: 'The server ended the stream' }) }

    discontinuity(gapMs?: number, reason?: string): this {
        return this.push({ kind: 'clock.discontinuity', ...(gapMs !== undefined ? { gapMs } : {}), ...(reason !== undefined ? { reason } : {}) })
    }

    /** Run `fn` `count` times, letting `everyMs` pass before each. */
    repeat(count: number, everyMs: number, fn: (b: this, index: number) => void): this {
        for (let i = 0; i < count; i++) { this.silence(everyMs); fn(this, i) }
        return this
    }

    build(): EngineInput[] { return [...this.records] }

    /** Only the engine-independent records, typed as Observation (for code that does not accept the clock marker). */
    observations(): Observation[] { return this.records.filter((r): r is Observation => r.kind !== 'clock.discontinuity') }
}

export const capture = (): CaptureBuilder => new CaptureBuilder()

/** A healthy start: connect, 200 event-stream response, open phase. */
export const healthyStart = (): CaptureBuilder => capture().connect().response()
