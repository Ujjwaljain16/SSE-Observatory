// Wire contracts between the main thread and the workers: plain types plus cheap guards.
//
// Hot-path messages (ADD_EVENTS, FILTERED_EVENTS) carry up to thousands of events, so they are not validated
// element by element at runtime. The zod schemas that describe the same shapes live in contractSchemas.ts
// (tests and tooling only; zod is too heavy to ship inside a worker).

import type { EventMessage } from '../types'
import type { Observation } from '../core/observe/observation'

export type SSEWorkerRequest =
    | { type: 'connect'; url: string; token?: string | undefined; useProxy?: boolean | undefined; recording?: boolean | undefined }
    | { type: 'disconnect' }
    | { type: 'ping' }

interface RawFrame { raw: string; arrivalTime: number; seq?: number | undefined }

export type SSEWorkerResponse =
    | { type: 'connected' }
    | { type: 'disconnected' }
    | { type: 'event'; payload: RawFrame }
    | { type: 'catchup'; events: RawFrame[] }
    /** Observation records for the connection. `replace` means the batch is the whole retained history (sent to a late joiner). */
    | { type: 'observations'; key: string; captureId: string; batch: Observation[]; replace?: boolean | undefined }
    | { type: 'error'; message: string }

export type FilterWorkerRequest =
    | { type: 'QUERY_UPDATE'; query: unknown; search: string }
    | { type: 'CUSTOM_FILTERS_UPDATE'; filters: unknown }
    | { type: 'ADD_EVENTS'; events: EventMessage[] }
    | { type: 'CONFIG'; maxEvents: number }
    | { type: 'CLEAR' }
    | { type: 'PING' }

export type FilterWorkerResponse =
    | { type: 'FILTERED_EVENTS'; events: EventMessage[]; execMs: number }
    | { type: 'READY' }

const REQUEST_TYPES = new Set(['QUERY_UPDATE', 'CUSTOM_FILTERS_UPDATE', 'ADD_EVENTS', 'CONFIG', 'CLEAR', 'PING'])

/** O(1) structural guard for the worker hot path. */
export function isFilterWorkerRequest(data: unknown): data is FilterWorkerRequest {
    if (!data || typeof data !== 'object') return false
    const m = data as { type?: unknown; events?: unknown; maxEvents?: unknown }
    if (typeof m.type !== 'string' || !REQUEST_TYPES.has(m.type)) return false
    if (m.type === 'ADD_EVENTS') return Array.isArray(m.events)
    if (m.type === 'CONFIG') return typeof m.maxEvents === 'number' && m.maxEvents > 0
    return true
}
