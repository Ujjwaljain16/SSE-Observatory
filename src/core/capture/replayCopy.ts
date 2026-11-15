/**
 * The app records what happened on the wire (times, sizes, ids, event names, comments, reconnects), not what the events
 * said, so an exported capture has no event bodies. The mock server will not replay a capture that has none, because a
 * replay that quietly invents data would mislead.
 *
 * For reproducing the behaviour the Doctor diagnoses (a stall, a gap, a reconnect that resumed from the wrong id) the
 * bodies do not matter, so this makes a copy for the mock server in which each event body is a placeholder of the
 * original size, carrying only the numbers the profile asked the recorder to read. The copy says it is synthetic, and the
 * replay is labelled as one wherever it is shown.
 *
 * Shared by the app (its Replay button) and the command line (`sse-doctor replay`), so both make the same copy. It only
 * returns a new text: the capture it was given is never changed.
 */

import { parseCapture, serializeCapture, type Capture, type CaptureRecord } from './format'

type EventRecord = CaptureRecord & { kind: 'event'; data?: string; dataBytes?: unknown; extracted?: { seq?: number | string | undefined; ts?: number | undefined } }

/** The most placeholder text one copy may hold. A recorded size is a claim in a file; this keeps a hostile or damaged one from exhausting memory. */
export const MAX_PLACEHOLDER_BYTES = 16 * 1024 * 1024

export class ReplayCopyError extends Error {
    constructor(message: string) { super(message); this.name = 'ReplayCopyError' }
}

/** A recorded size is usable when it is a whole, non-negative number. */
export const isRecordedSize = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** `{ a: { b: value } }` for the path `$.a.b`. Only plain dotted names; anything else yields nothing. */
function objectAt(path: string | undefined, value: unknown): Record<string, unknown> | undefined {
    if (!path || value === undefined) return undefined
    const names = path.replace(/^\$\.?/, '').split('.')
    if (names.length === 0 || names.some((n) => !/^[A-Za-z0-9_-]+$/.test(n))) return undefined
    const root: Record<string, unknown> = {}
    let at = root
    names.forEach((name, i) => {
        if (i === names.length - 1) at[name] = value
        else { const next: Record<string, unknown> = {}; at[name] = next; at = next }
    })
    return root
}

const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    for (const [k, v] of Object.entries(b)) {
        const existing = a[k]
        a[k] = typeof v === 'object' && v !== null && typeof existing === 'object' && existing !== null ? merge(existing as Record<string, unknown>, v as Record<string, unknown>) : v
    }
    return a
}

/** A body of `bytes` characters that is valid JSON: the numbers the profile reads, padded to the size. With no usable size, the smallest valid body. */
function placeholder(e: EventRecord, capture: Capture): string {
    const profile = capture.header.profile
    const fields: Record<string, unknown> = {}
    const seq = e.extracted?.seq
    const seqObject = objectAt(profile?.sequence?.field, typeof seq === 'string' && /^-?\d+$/.test(seq) ? Number(seq) : seq)
    if (seqObject) merge(fields, seqObject)
    const tsObject = objectAt(profile?.timestampField, e.extracted?.ts)
    if (tsObject) merge(fields, tsObject)
    const base = Object.keys(fields).length > 0 ? JSON.stringify(fields) : '{}'
    if (!isRecordedSize(e.dataBytes) || e.dataBytes <= base.length) return base
    // pad inside a string property so the size matches and the body stays valid JSON
    const empty = JSON.stringify({ ...fields, '': '' }).length
    return JSON.stringify({ ...fields, '': 'x'.repeat(Math.max(0, e.dataBytes - empty)) })
}

/**
 * The capture as NDJSON for the mock server, with a body for every event that has none.
 *   filled   how many events got a placeholder body
 *   unsized  how many of those had no recorded size, and so got the smallest valid body (an empty object, or the profile's numbers)
 * Throws ReplayCopyError when the recorded sizes add up to more than MAX_PLACEHOLDER_BYTES; a file that is not a capture throws what `parseCapture` throws.
 */
export function replayCopy(text: string): { text: string; filled: number; unsized: number } {
    const { capture } = parseCapture(text)
    let wanted = 0
    for (const r of capture.records) {
        const e = r as EventRecord
        if (r.kind === 'event' && e.data === undefined && isRecordedSize(e.dataBytes)) wanted += e.dataBytes
    }
    if (wanted > MAX_PLACEHOLDER_BYTES) throw new ReplayCopyError(`the recorded event sizes add up to ${wanted} bytes, which is too large to build a replay from (the limit is ${MAX_PLACEHOLDER_BYTES}); the file may be damaged`)
    let filled = 0
    let unsized = 0
    const records = capture.records.map((r) => {
        if (r.kind !== 'event') return r
        const e = r as EventRecord
        if (e.data !== undefined) return r
        filled++
        if (!isRecordedSize(e.dataBytes)) unsized++
        return { ...e, data: placeholder(e, capture) } as CaptureRecord
    })
    const header = { ...capture.header, source: { ...capture.header.source, synthetic: filled > 0 ? true : capture.header.source.synthetic } }
    const { footer } = capture
    return { text: serializeCapture({ header, records, footer: footer ? { ...footer } : undefined }), filled, unsized }
}
