/**
 * Rebuilding what was sent from a capture: the decoded stream text and its frames. Reports, comparisons and the
 * redactor all need payload text, and a capture keeps it in one of three places (Base64 chunks in a local capture,
 * redacted chunk text in a sanitized one, `data` on the event records of an imported v1 recording).
 */

import { SSEParser } from '../sse/sseParser'
import { base64ToBytes } from './base64'
import type { Capture, CaptureRecord } from './format'

export interface Frame {
    /** Sequence number of the event record this frame corresponds to, when the capture has one in the same order. */
    obsSeq?: number | undefined
    event: string
    id: string
    data: string
}

/** The text of every connection, in order. Connections are separate because a frame never continues across a reconnect. */
export function connectionTexts(records: readonly CaptureRecord[]): Map<number, string> {
    const decoders = new Map<number, TextDecoder>()
    const texts = new Map<number, string>()
    for (const r of records) {
        if (r.kind !== 'chunk') continue
        const chunk = r as { conn: number; b64?: string; text?: string }
        let piece = ''
        if (typeof chunk.text === 'string') piece = chunk.text
        else if (typeof chunk.b64 === 'string') {
            let decoder = decoders.get(chunk.conn)
            if (!decoder) { decoder = new TextDecoder('utf-8'); decoders.set(chunk.conn, decoder) }
            piece = decoder.decode(base64ToBytes(chunk.b64), { stream: true })
        } else continue
        texts.set(chunk.conn, (texts.get(chunk.conn) ?? '') + piece)
    }
    return texts
}

/** True when payload text can be recovered from the capture at all. */
export function hasPayloadText(capture: Capture): boolean {
    return capture.records.some((r) => (r.kind === 'chunk' && (typeof (r as { b64?: unknown }).b64 === 'string' || typeof (r as { text?: unknown }).text === 'string')) || (r.kind === 'event' && typeof (r as { data?: unknown }).data === 'string'))
}

/** The events with their payload text, in order; frames are re-parsed from chunk text when the event records carry no data. */
export function framesOf(capture: Capture): Frame[] {
    const events = capture.records.filter((r) => r.kind === 'event') as Array<{ seq: number; event: string; sseId: string; data?: string }>
    if (events.length > 0 && events.every((e) => typeof e.data === 'string')) {
        return events.map((e) => ({ obsSeq: e.seq, event: e.event, id: e.sseId, data: e.data as string }))
    }
    const frames: Frame[] = []
    for (const text of connectionTexts(capture.records).values()) {
        const parser = new SSEParser({ onMessage: (m) => frames.push({ event: m.event, id: m.id, data: m.data }) })
        parser.feed(text)
        parser.end(false)
    }
    // line the frames up with event records when the counts agree (they do unless the capture was truncated)
    if (frames.length === events.length) frames.forEach((f, i) => { f.obsSeq = events[i]!.seq })
    return frames
}
