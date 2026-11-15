import { newHeader, type Capture, type CaptureHeader, type CaptureRecord } from '../../format'
import { markRedacted, type RedactedCapture } from '../../redacted'
import { capture, type CaptureBuilder } from '../../../testing/captureBuilder'

/** A secret planted where a proxied request keeps it: in header values. No output may print it. */
export const PROXY_CANARY = 'canary-upstream-secret-7731'

/**
 * What the app records when "Use Server Proxy" is on: the app asked its own `POST /api/sse`, so the request is that relative path and the
 * stream's address is nowhere in it. The response carries the proxy's `X-SSE-Proxy` header unless `viaHeader` is false.
 */
export function proxiedCapture(opts: { url?: string; viaHeader?: boolean } = {}): RedactedCapture {
    const url = opts.url ?? '/api/sse'
    const b = capture().connect({ url, method: 'POST', headerNames: ['content-type', 'authorization'] })
        .response({ headers: opts.viaHeader === false ? {} : { 'x-sse-proxy': 'observatory/1', 'x-sse-upstream-status': '200' } })
        .at(300).frame('message', '1').silence(100).frame('message', '2')
    const header = newHeader({
        kind: 'sanitized', source: { kind: 'browser-app', client: 'browser-fetch' },
        request: { url, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROXY_CANARY}`, 'X-Trace': PROXY_CANARY } },
    })
    return markRedacted({ header, records: b.build() })
}

export function captureOf(b: CaptureBuilder, header: Partial<CaptureHeader> = {}): Capture {
    return { header: newHeader({ kind: 'sanitized', source: { kind: 'fixture' }, ...header }), records: b.build() }
}

/** Tests stand in for the redactor, which does not exist yet. */
export const redacted = (c: Capture): RedactedCapture => markRedacted(c)

export interface TextEvent { event?: string; id?: string; data: string; dataHash?: string; extractedSeq?: number }

/**
 * A sanitized-style capture: every event arrives in a chunk that carries its decoded text, as a redacted capture
 * does, so `framesOf` can rebuild the payloads. `everyMs` spaces the events.
 */
export function textCapture(events: TextEvent[], opts: { everyMs?: number; startMs?: number; headers?: Record<string, string> } = {}): Capture {
    const records: CaptureRecord[] = []
    let seq = 0
    let t = 0
    const push = (r: Record<string, unknown>): void => { records.push({ seq: seq++, t, conn: 0, ...r } as unknown as CaptureRecord) }
    push({ kind: 'connect', attempt: 0, url: 'http://stream.test/events', method: 'GET', headerNames: ['accept'], sentLastEventId: '' })
    push({ kind: 'response', status: 200, contentType: 'text/event-stream', redirected: false, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', ...opts.headers }, ttfbMs: 0 })
    t += opts.startMs ?? 100
    for (const e of events) {
        const name = e.event ?? 'message'
        const text = `${name === 'message' ? '' : `event: ${name}\n`}${e.id ? `id: ${e.id}\n` : ''}data: ${e.data}\n\n`
        push({ kind: 'chunk', bytes: text.length, text })
        push({ kind: 'event', event: name, sseId: e.id ?? '', dataBytes: e.data.length, dataHash: e.dataHash, ...(e.extractedSeq !== undefined ? { extracted: { seq: e.extractedSeq } } : {}) })
        t += opts.everyMs ?? 1000
    }
    return { header: newHeader({ kind: 'sanitized', source: { kind: 'fixture' } }), records }
}
