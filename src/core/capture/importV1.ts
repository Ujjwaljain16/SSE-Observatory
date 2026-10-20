/**
 * Reads a v1 `.sse-record` (the app's old export) as a capture.
 *
 * A v1 recording kept only parsed events and the gap since the previous one, so the timeline is rebuilt from `deltaMs`
 * and marked synthetic. There are no chunks, comments, response headers or reconnects: rules that need them report
 * "not evaluated" instead of looking healthy. The SSE event name is the recording's `type` (the field `parsedType`
 * is the `type` value found inside a JSON payload, which is not an SSE field).
 */

import { newHeader, type Capture, type CaptureRecord } from './format'

export interface V1Event {
    type?: string
    data?: string
    sseId?: string
    id?: string
    deltaMs?: number
}

export interface V1Recording {
    version: string
    createdAt?: string
    events: V1Event[]
}

export class V1ImportError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'V1ImportError'
    }
}

export const isV1Recording = (value: unknown): value is V1Recording =>
    typeof value === 'object' && value !== null && typeof (value as V1Recording).version === 'string' && Array.isArray((value as V1Recording).events)

const utf8Length = (text: string): number => new TextEncoder().encode(text).length

export function importV1(recording: unknown): Capture {
    if (!isV1Recording(recording)) throw new V1ImportError('this is not an .sse-record file (expected { version, events: [...] })')
    if (recording.version.split('.')[0] !== '1') throw new V1ImportError(`unsupported .sse-record version "${recording.version}"`)

    const records: CaptureRecord[] = []
    let t = 0
    recording.events.forEach((e, i) => {
        t += Math.max(0, Number(e.deltaMs) || 0)
        const data = typeof e.data === 'string' ? e.data : ''
        records.push({ seq: i, t, conn: 0, kind: 'event', event: e.type || 'message', sseId: e.sseId ?? '', dataBytes: utf8Length(data), data })
    })

    return {
        header: newHeader({
            kind: 'local-full',
            createdAt: recording.createdAt ?? new Date().toISOString(),
            source: { kind: 'import-v1', synthetic: true },
            capabilities: ['events', 'timing:event'],
        }),
        records,
        footer: { endReason: 'import', counts: { event: records.length } },
    }
}
