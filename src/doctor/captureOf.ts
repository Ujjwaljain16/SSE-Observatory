import { localCapture } from '../core/capture/build'
import type { Capture, CaptureRecord } from '../core/capture/format'
import { observationRegistry } from './observationRegistry'

export interface CaptureSnapshot {
    capture: Capture
    /** The recording holds a bounded amount; when it had to drop detail the capture says so. */
    truncated: boolean
    takenAt: number
}

/**
 * The stream's recording as a capture file, as of now. It is a `local-full` capture: it holds what the recorder kept,
 * unredacted, and must go through `redactCapture` before it is shared. Page-domain consumer samples are left out: they
 * are measured in another clock with their own numbering, so they do not belong in the transport's record order.
 * `endT` is when the recording stops, in the recording's clock (the Doctor view's `nowT`).
 */
export function captureOf(streamId: string, endT?: number): CaptureSnapshot | undefined {
    const entry = observationRegistry.get(streamId)
    if (!entry) return undefined
    const records = entry.store.snapshot() as CaptureRecord[]
    if (records.length === 0) return undefined
    const stats = entry.store.stats
    const connect = records.find((r) => r.kind === 'connect') as { url?: string; method?: string } | undefined
    const truncated = stats.dropped.chunk + stats.dropped.event + stats.dropped.heartbeat + stats.dropped.violation > 0
    const capture = localCapture(records, {
        source: { kind: 'browser-app', client: 'browser-fetch' },
        ...(connect?.url ? { request: { url: connect.url, method: connect.method ?? 'GET' } } : {}),
        ...(entry.captureId ? { captureId: entry.captureId } : {}),
        truncated,
        capBytes: stats.capBytes,
        endReason: 'stopped',
    })
    // A stream still open has not ended at its last record: whatever silence followed it is part of the capture.
    if (endT !== undefined) capture.footer = { ...(capture.footer ?? { endReason: 'stopped', counts: {} }), endT }
    return { capture, truncated, takenAt: Date.now() }
}
