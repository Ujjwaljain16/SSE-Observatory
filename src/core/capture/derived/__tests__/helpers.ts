import { newHeader, type Capture, type CaptureHeader, type CaptureRecord } from '../../format'
import { markRedacted, type RedactedCapture } from '../../redacted'
import type { CaptureBuilder } from '../../../testing/captureBuilder'

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
