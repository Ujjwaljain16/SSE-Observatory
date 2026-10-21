/**
 * Reads a file a person opened into a capture: an `.sse-capture` (NDJSON) or an older `.sse-record` recording (JSON).
 * Anything else is refused with a reason, and a damaged file is read as far as it goes with the damage reported; a
 * capture is never made to look healthy by dropping what could not be read.
 */

import { CaptureFormatError, parseCapture, type Capture, type IntegrityStatus } from '../core/capture/format'
import { importV1, isV1Recording, V1ImportError } from '../core/capture/importV1'

export const MAX_OPEN_BYTES = 20 * 1024 * 1024

export type LoadedCapture =
    | { ok: true; capture: Capture; warnings: string[]; integrity: IntegrityStatus | 'not-applicable'; format: 'sse-capture' | 'sse-record' }
    | { ok: false; error: string }

export function loadCaptureText(text: string, size: number = text.length): LoadedCapture {
    if (size > MAX_OPEN_BYTES) return { ok: false, error: `That file is ${(size / 1048576).toFixed(1)} MB; captures up to ${MAX_OPEN_BYTES / 1048576} MB can be opened here. The command line has no such limit.` }
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    if (body.trim() === '') return { ok: false, error: 'The file is empty.' }

    const firstLine = body.split('\n', 1)[0]!.trim()
    let isCapture = false
    try { isCapture = (JSON.parse(firstLine) as { format?: unknown }).format === 'sse-capture' } catch { /* not NDJSON: maybe a v1 recording */ }

    try {
        if (isCapture) {
            const parsed = parseCapture(body)
            return { ok: true, capture: parsed.capture, warnings: parsed.warnings, integrity: parsed.integrity, format: 'sse-capture' }
        }
        let value: unknown
        try { value = JSON.parse(body) } catch { return { ok: false, error: 'This is not a capture: it is neither an .sse-capture file (one JSON object per line, starting with a header) nor an .sse-record recording (one JSON document).' } }
        if (isV1Recording(value)) {
            return { ok: true, capture: importV1(value), warnings: ['An older .sse-record recording has event times only, so checks that need chunks, headers or reconnects are reported as not evaluated.'], integrity: 'not-applicable', format: 'sse-record' }
        }
        return { ok: false, error: 'This JSON file is not a capture or a recording: it has no "events" list and no capture header.' }
    } catch (err) {
        if (err instanceof CaptureFormatError || err instanceof V1ImportError) return { ok: false, error: err.message }
        return { ok: false, error: 'The file could not be read as a capture.' }
    }
}
