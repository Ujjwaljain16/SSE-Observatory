/**
 * Fetch-based SSE client (works in windows and workers).
 *
 * Compared to EventSource it can: send an Authorization header, receive *named* events, resume with
 * Last-Event-ID, honour the server's `retry:` hint, apply exponential backoff with jitter, tell fatal errors
 * (401/403/404, wrong content type) from retryable ones, and report every state change.
 */

import { SSEParser, SSEParserError, type SSEMessage } from './sseParser'

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
}

class HttpError extends Error {
    constructor(public status: number, message: string, public fatal: boolean) { super(message) }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

export class SSEClient {
    private controller: AbortController | null = null
    private lastEventId = ''
    private serverRetryMs: number | null = null
    private running = false

    constructor(private readonly opts: SSEClientOptions) {}

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
        this.opts.onPhase?.(phase, info)
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
                const res = await doFetch(req.url, {
                    method: req.method ?? 'GET',
                    headers,
                    ...(req.body !== undefined ? { body: req.body } : {}),
                    credentials: req.credentials ?? 'same-origin',
                    cache: 'no-store',
                    signal,
                })

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
                    throw new HttpError(res.status, `Server did not return an event stream (Content-Type: ${type || 'none'})`, true)
                }
                if (!res.body) throw new Error('Streaming responses are not supported in this environment')

                // Connected.
                attempt = 0
                this.emit('open', { attempt: 0 })
                const parser = new SSEParser({
                    onMessage: (m) => {
                        this.opts.onMessage(m)
                        if (stopEvents.has(m.event)) ended = true
                    },
                    onRetry: (ms) => { this.serverRetryMs = ms },
                })
                parser.setLastEventId(this.lastEventId)
                const reader = res.body.getReader()
                try {
                    for (;;) {
                        const { done, value } = await reader.read()
                        if (done) break
                        parser.feed(value)
                        this.lastEventId = parser.lastId
                        if (ended) break
                    }
                } finally {
                    parser.end()
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve()
        const t = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
}
