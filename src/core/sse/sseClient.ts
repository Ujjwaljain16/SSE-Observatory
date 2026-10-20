/**
 * Fetch-based SSE client (works in windows and workers).
 *
 * Compared to EventSource it can: send an Authorization header, receive *named* events, resume with
 * Last-Event-ID, honour the server's `retry:` hint, apply exponential backoff with jitter, tell fatal errors
 * (401/403/404, wrong content type) from retryable ones, and report every state change.
 */

import { SSEParser, SSEParserError, type SSEMessage } from './sseParser'
import { performanceClock, type Clock } from '../clock'
import { DIAGNOSTIC_RESPONSE_HEADERS, type ObservationDraft } from '../observe/observation'
import { redactUrl } from '../observe/redactUrl'
import { utf8Length } from './utf8'
import { violationSeverity, type ViolationCode } from './violations'

export type SSEPhase = 'connecting' | 'open' | 'reconnecting' | 'ended' | 'failed' | 'stopped'

export interface SSEPhaseInfo {
    /** Consecutive failed attempts so far (reset once a connection opens). */
    attempt: number
    /** Delay before the next attempt (reconnecting only). */
    delayMs?: number
    /** Human-readable reason for reconnecting / failing / ending. */
    reason?: string
    /** HTTP status when the failure was an HTTP response. */
    status?: number
}

export interface SSERequestInit {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    credentials?: 'omit' | 'same-origin' | 'include'
}

export interface SSEClientOptions {
    /** Builds the request for every (re)connection. `lastEventId` is '' until the server sent an id. */
    request: (lastEventId: string) => SSERequestInit
    onMessage: (message: SSEMessage) => void
    onPhase?: (phase: SSEPhase, info: SSEPhaseInfo) => void
    fetchImpl?: typeof fetch
    /** Consecutive failed attempts before giving up. Default 8. */
    maxRetries?: number
    initialDelayMs?: number
    maxDelayMs?: number
    /** ± fraction of random jitter applied to each delay. Default 0.3. */
    jitter?: number
    random?: () => number
    /** Named events that end the stream for good (a common convention for finite streams). Default ['end']. */
    stopEvents?: string[]
    /**
     * Receives a draft record for everything noticed on the wire and in the client: requests, responses, chunks,
     * comments, retry hints, violations, events, phases and reconnects. Wire it to a Recorder to stamp and keep them.
     * Optional, and an exception thrown by it never affects the stream.
     */
    onObservation?: ((draft: ObservationDraft) => void) | undefined
    /** Time source for measurements (time to response headers). Defaults to the real monotonic clock. */
    clock?: Clock | undefined
    /**
     * The last event id to resume from on the FIRST request. Use it when this client takes over a stream that
     * another client was already reading, so the server can continue where that one stopped.
     */
    initialLastEventId?: string | undefined
}

class HttpError extends Error {
    constructor(public status: number, message: string, public fatal: boolean) { super(message) }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

export class SSEClient {
    private controller: AbortController | null = null
    private lastEventId: string
    private serverRetryMs: number | null = null
    private running = false

    constructor(private readonly opts: SSEClientOptions) {
        this.lastEventId = opts.initialLastEventId ?? ''
    }

    get lastId() { return this.lastEventId }
    get isRunning() { return this.running }

    start(): void {
        if (this.running) return
        this.running = true
        this.controller = new AbortController()
        void this.run(this.controller.signal)
    }

    stop(): void {
        if (!this.running) return
        this.running = false
        this.controller?.abort()
        this.controller = null
        this.emit('stopped', { attempt: 0 })
    }

    private emit(phase: SSEPhase, info: SSEPhaseInfo) {
        this.observe({ kind: 'phase', phase, info })
        this.opts.onPhase?.(phase, info)
    }

    /** Hands a draft to the observer, if there is one. Never lets it affect the stream. */
    private observe(draft: ObservationDraft) {
        const observer = this.opts.onObservation
        if (!observer) return
        try { observer(draft) } catch { /* an observer must never change what the client does */ }
    }

    private backoff(attempt: number): number {
        const initial = this.opts.initialDelayMs ?? 1000
        const max = this.opts.maxDelayMs ?? 30_000
        const jitter = this.opts.jitter ?? 0.3
        const rand = (this.opts.random ?? Math.random)()
        const base = Math.min(max, initial * 2 ** (attempt - 1))
        const jittered = base * (1 + (rand * 2 - 1) * jitter)
        return Math.round(Math.max(this.serverRetryMs ?? 0, jittered))
    }

    private async run(signal: AbortSignal) {
        const maxRetries = this.opts.maxRetries ?? 8
        const doFetch = this.opts.fetchImpl ?? fetch
        const stopEvents = new Set(this.opts.stopEvents ?? ['end'])
        const clock = this.opts.clock ?? performanceClock
        const watching = this.opts.onObservation !== undefined
        let attempt = 0
        let first = true

        while (!signal.aborted) {
            if (first) this.emit('connecting', { attempt })
            first = false
            let reason = 'Connection lost'
            let status: number | undefined
            let ended = false

            try {
                const req = this.opts.request(this.lastEventId)
                const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...req.headers }
                if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId
                const requestedAt = clock.now()
                if (watching) {
                    this.observe({ kind: 'connect', attempt, url: redactUrl(req.url), method: req.method ?? 'GET', headerNames: Object.keys(headers).map((name) => name.toLowerCase()), sentLastEventId: this.lastEventId })
                }
                const res = await doFetch(req.url, {
                    method: req.method ?? 'GET',
                    headers,
                    ...(req.body !== undefined ? { body: req.body } : {}),
                    credentials: req.credentials ?? 'same-origin',
                    cache: 'no-store',
                    signal,
                })

                if (watching) {
                    const kept: Record<string, string> = {}
                    for (const name of DIAGNOSTIC_RESPONSE_HEADERS) {
                        const value = res.headers.get(name)
                        if (value !== null) kept[name] = value
                    }
                    // "ttfbMs" is the time until the response headers arrived (the usual meaning of time to first byte).
                    this.observe({ kind: 'response', status: res.status, contentType: res.headers.get('content-type') ?? '', redirected: Boolean(res.redirected), headers: kept, ttfbMs: Math.round(clock.now() - requestedAt) })
                    if (res.status !== 200 && res.status !== 204) {
                        this.observe({ kind: 'violation', code: 'HTTP_STATUS_NOT_200', severity: violationSeverity('HTTP_STATUS_NOT_200'), detail: `The response status was ${res.status}.` })
                    }
                }
                if (res.status === 204) { this.finish('ended', { attempt, reason: 'Server responded 204 (no content): it asked the client not to reconnect', status: 204 }); return }
                if (!res.ok) {
                    let detail = ''
                    try { detail = (await res.text()).slice(0, 200) } catch { /* ignore */ }
                    let message = `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`
                    try { const j = JSON.parse(detail); if (j?.error) message += ` – ${j.error}` } catch { if (detail) message += ` – ${detail}` }
                    throw new HttpError(res.status, message, !RETRYABLE_STATUS.has(res.status))
                }
                const type = res.headers.get('content-type') || ''
                if (!/text\/event-stream/i.test(type)) {
                    if (watching) this.observe({ kind: 'violation', code: 'BAD_CONTENT_TYPE', severity: violationSeverity('BAD_CONTENT_TYPE'), detail: `The Content-Type was "${type || 'none'}".` })
                    throw new HttpError(res.status, `Server did not return an event stream (Content-Type: ${type || 'none'})`, true)
                }
                if (!res.body) throw new Error('Streaming responses are not supported in this environment')

                // Connected.
                attempt = 0
                this.emit('open', { attempt: 0 })
                const parser = new SSEParser({
                    onMessage: (m) => {
                        if (watching) this.observe({ kind: 'event', event: m.event, sseId: m.id, dataBytes: utf8Length(m.data) })
                        this.opts.onMessage(m)
                        if (stopEvents.has(m.event)) ended = true
                    },
                    onRetry: (ms) => {
                        this.serverRetryMs = ms
                        if (watching) this.observe({ kind: 'retry', ms })
                    },
                    // Only attach the diagnostics handlers when someone is watching: they make the parser do extra work.
                    ...(watching ? {
                        onComment: (text: string) => this.observe({ kind: 'comment', text, source: text.startsWith('sse-proxy') ? 'proxy' : 'upstream' }),
                        onViolation: (v: { code: ViolationCode; detail: string; chunk: number }) =>
                            this.observe({ kind: 'violation', code: v.code, severity: violationSeverity(v.code), detail: v.detail, chunk: v.chunk }),
                    } : {}),
                })
                parser.setLastEventId(this.lastEventId)
                const reader = res.body.getReader()
                let parseMs = 0
                let chunkIndex = 0
                try {
                    for (;;) {
                        const { done, value } = await reader.read()
                        if (done) break
                        const chunk = chunkIndex++
                        if (watching) this.observe({ kind: 'chunk', bytes: value.length })
                        // A burst can arrive as one multi-megabyte chunk. Parse it in pieces and give the page a
                        // turn whenever the budget is used up, instead of blocking it for the whole chunk.
                        // The budget counts parse time only, across reads: chunks that are already buffered resolve as
                        // microtasks, so without this the page would never get a turn while a backlog drains.
                        for (let offset = 0; offset < value.length; offset += FEED_PIECE_BYTES) {
                            const t0 = performance.now()
                            parser.feed(value.length <= FEED_PIECE_BYTES ? value : value.subarray(offset, offset + FEED_PIECE_BYTES), chunk)
                            parseMs += performance.now() - t0
                            if (ended) break
                            if (parseMs > FEED_BUDGET_MS) {
                                parseMs = 0
                                await yieldToMain()
                                if (signal.aborted) return
                            }
                        }
                        this.lastEventId = parser.lastId
                        if (ended) break
                    }
                } finally {
                    parser.end(!signal.aborted) // an event cut off because WE stopped is not the server's fault
                    reader.cancel().catch(() => undefined)
                }
                if (ended) { this.finish('ended', { attempt, reason: 'The server ended the stream' }); return }
                reason = 'Stream closed by server'
            } catch (err) {
                if (signal.aborted) return
                if (err instanceof HttpError) {
                    status = err.status
                    reason = err.message
                    if (err.fatal) { this.finish('failed', { attempt, reason, status }); return }
                } else if (err instanceof SSEParserError) {
                    this.finish('failed', { attempt, reason: err.message }); return
                } else {
                    reason = err instanceof Error && err.message ? `Network error: ${err.message}` : 'Network error'
                }
            }

            attempt++
            if (attempt > maxRetries) {
                this.finish('failed', { attempt: attempt - 1, reason: `Gave up after ${maxRetries} attempts. Last error: ${reason}`, ...(status !== undefined ? { status } : {}) })
                return
            }
            const delayMs = this.backoff(attempt)
            if (watching) {
                this.observe({ kind: 'reconnect', attempt, delayMs, reason, lastEventIdSent: this.lastEventId, serverRetryMs: this.serverRetryMs ?? undefined, status })
            }
            this.emit('reconnecting', { attempt, delayMs, reason, ...(status !== undefined ? { status } : {}) })
            await sleep(delayMs, signal)
        }
    }

    private finish(phase: 'ended' | 'failed', info: SSEPhaseInfo) {
        this.running = false
        this.controller = null
        this.emit(phase, info)
    }
}

const FEED_PIECE_BYTES = 32 * 1024
const FEED_BUDGET_MS = 8

function yieldToMain(): Promise<void> {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
    return sched?.yield ? sched.yield() : new Promise((resolve) => setTimeout(resolve, 0))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve()
        const t = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
}
