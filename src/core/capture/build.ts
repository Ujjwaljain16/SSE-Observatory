/**
 * Assembling a capture from the records a stream produced. The result is a `local-full` capture: unredacted, possibly
 * with wire bytes, and never to be shared as it is (only `redactCapture()` makes something shareable).
 */

import { capabilitiesOf, countByKind, newHeader, type Capture, type CaptureFooter, type CaptureHeader, type CaptureRecord } from './format'
import { redactUrl } from '../observe/redactUrl'

export interface LocalCaptureInit {
    source: CaptureHeader['source']
    request?: { url: string; method?: string; headers?: Record<string, string>; viaProxy?: boolean | undefined } | undefined
    profile?: CaptureHeader['profile']
    captureId?: string | undefined
    /** True when the memory cap made the store drop detail; the capture then says it is incomplete. */
    truncated?: boolean | undefined
    capBytes?: number | undefined
    endReason?: CaptureFooter['endReason'] | undefined
    startedAtEpochMs?: number | undefined
}

export function localCapture(records: readonly CaptureRecord[], init: LocalCaptureInit): Capture {
    const header = newHeader({
        kind: 'local-full',
        source: init.source,
        capabilities: capabilitiesOf(records),
        ...(init.request ? { request: { url: redactUrl(init.request.url), method: init.request.method ?? 'GET', headers: init.request.headers ?? {}, ...(init.request.viaProxy !== undefined ? { viaProxy: init.request.viaProxy } : {}) } } : {}),
        ...(init.profile ? { profile: init.profile } : {}),
        ...(init.captureId ? { captureId: init.captureId } : {}),
        ...(init.truncated !== undefined || init.capBytes !== undefined ? { limits: { ...(init.capBytes !== undefined ? { capBytes: init.capBytes } : {}), ...(init.truncated ? { truncated: true } : {}) } } : {}),
        ...(init.startedAtEpochMs !== undefined ? { clock: { origin: 'monotonic' as const, startedAtEpochMs: init.startedAtEpochMs } } : {}),
    })
    return { header, records: [...records], footer: { endReason: init.endReason ?? 'completed', counts: countByKind(records) } }
}
