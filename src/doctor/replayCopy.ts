/**
 * The app records what happened on the wire (times, sizes, ids, event names, comments, reconnects), not what the events
 * said, so an exported capture has no event bodies. The mock server will not replay a capture that has none, because a
 * replay that quietly invents data would mislead.
 *
 * For reproducing the behaviour the Doctor diagnoses (a stall, a gap, a reconnect that resumed from the wrong id) the
 * bodies do not matter, so this makes a copy for the mock server in which each event body is a placeholder of the
 * original size, carrying only the numbers the profile asked the recorder to read. The copy says it is synthetic, and the
 * replay is labelled as one wherever it is shown.
 */

import { parseCapture, serializeCapture, type Capture, type CaptureRecord } from '../core/capture/format'

type EventRecord = CaptureRecord & { kind: 'event'; data?: string; dataBytes: number; extracted?: { seq?: number | string | undefined; ts?: number | undefined } }

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

/** A body of `bytes` characters that is valid JSON: the numbers the profile reads, padded to the size. */
function placeholder(e: EventRecord, capture: Capture): string {
    const profile = capture.header.profile
    const fields: Record<string, unknown> = {}
    const seq = e.extracted?.seq
    const seqObject = objectAt(profile?.sequence?.field, typeof seq === 'string' && /^-?\d+$/.test(seq) ? Number(seq) : seq)
    if (seqObject) merge(fields, seqObject)
    const tsObject = objectAt(profile?.timestampField, e.extracted?.ts)
    if (tsObject) merge(fields, tsObject)
    const base = Object.keys(fields).length > 0 ? JSON.stringify(fields) : '{}'
    if (e.dataBytes <= base.length) return base
    // pad inside a string property so the size matches and the body stays valid JSON
    const empty = JSON.stringify({ ...fields, '': '' }).length
    return JSON.stringify({ ...fields, '': 'x'.repeat(Math.max(0, e.dataBytes - empty)) })
}

/** The capture as NDJSON for the mock server, with a body for every event that has none. */
export function replayCopy(text: string): { text: string; filled: number } {
    const { capture } = parseCapture(text)
    let filled = 0
    const records = capture.records.map((r) => {
        if (r.kind !== 'event') return r
        const e = r as EventRecord
        if (e.data !== undefined) return r
        filled++
        return { ...e, data: placeholder(e, capture) } as CaptureRecord
    })
    const header = { ...capture.header, source: { ...capture.header.source, synthetic: filled > 0 ? true : capture.header.source.synthetic } }
    const { footer } = capture
    return { text: serializeCapture({ header, records, footer: footer ? { ...footer } : undefined }), filled }
}
