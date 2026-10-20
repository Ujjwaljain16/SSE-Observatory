/**
 * Observations: what happened on the wire and in the client, as small typed records. They are the evidence every
 * diagnosis is built from. Event payload text is NOT in here (it lives in the existing event pipeline); an event
 * record carries only metadata such as its size.
 *
 * The client emits a draft (no stamp); a Recorder adds `seq`, `t` and `conn`.
 */

import type { SSEPhase, SSEPhaseInfo } from '../sse/sseClient'
import type { ViolationCode, ViolationSeverity } from '../sse/violations'

/** Milliseconds since the start of the capture, from the monotonic clock. */
export type Mono = number

/** Added by the Recorder. */
export interface Stamp {
    /** Strictly +1 per capture: a total order even when two records share a timestamp. */
    seq: number
    /** Monotonic milliseconds since the capture started. Never decreases. */
    t: Mono
    /** Index of the connection attempt this record belongs to (0 for the first request). */
    conn: number
    /** Where the record was taken. Records stamped in the page rather than the transport say so. */
    domain?: 'transport' | 'page' | undefined
}

export type ObservationBody =
    | { kind: 'connect'; attempt: number; url: string; method: string; headerNames: string[]; sentLastEventId: string }
    | { kind: 'response'; status: number; contentType: string; redirected: boolean; headers: Record<string, string>; ttfbMs: number }
    | { kind: 'chunk'; bytes: number }
    | { kind: 'comment'; text: string; source: 'proxy' | 'upstream' }
    | { kind: 'retry'; ms: number }
    | { kind: 'event'; event: string; sseId: string; dataBytes: number }
    | { kind: 'violation'; code: ViolationCode; severity: ViolationSeverity; detail: string; chunk?: number | undefined }
    | { kind: 'phase'; phase: SSEPhase; info: SSEPhaseInfo }
    | { kind: 'reconnect'; attempt: number; delayMs: number; reason: string; lastEventIdSent: string; serverRetryMs?: number | undefined; status?: number | undefined }

export type Observation = Stamp & ObservationBody

export type ObservationKind = ObservationBody['kind']

/** What an emitter hands over: the body without the stamp. */
export type ObservationDraft = ObservationBody

/** Response headers worth keeping: the ones that explain buffering, caching and proxy behaviour. Values are not secrets. */
export const DIAGNOSTIC_RESPONSE_HEADERS = [
    'content-type', 'cache-control', 'content-encoding', 'transfer-encoding', 'content-length', 'via', 'age',
    'x-accel-buffering', 'x-cache', 'cf-cache-status',
    'x-sse-proxy', 'x-sse-proxy-heartbeat-ms', 'x-sse-proxy-max-duration',
    'x-sse-upstream-status', 'x-sse-upstream-content-type', 'x-sse-upstream-encoding', 'x-sse-upstream-ttfb-ms',
] as const
