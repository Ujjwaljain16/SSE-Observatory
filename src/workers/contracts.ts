// Wire contracts between the main thread and the workers: plain types plus cheap guards.
//
// Hot-path messages (ADD_EVENTS, FILTERED_EVENTS) carry up to thousands of events, so they are not validated
// element by element at runtime. The zod schemas that describe the same shapes live in contractSchemas.ts
// (tests and tooling only; zod is too heavy to ship inside a worker).

import type { EventMessage } from '../types'
import type { Observation } from '../core/observe/observation'
import type { PayloadProbeConfig } from '../core/observe/payloadProbe'

export type SSEWorkerRequest =
    | { type: 'connect'; url: string; token?: string | undefined; useProxy?: boolean | undefined; recording?: boolean | undefined; profile?: PayloadProbeConfig | undefined }
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

/**
 * The fields to read out of each payload, as sent by a page. Copied key by key with a type check each: a worker takes
 * nothing from a message that it has not looked at.
 */
export function asProbeConfig(value: unknown): PayloadProbeConfig | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const v = value as Record<string, unknown>
    const out: PayloadProbeConfig = {}
    const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200
    if (typeof v['sequence'] === 'object' && v['sequence'] !== null) {
        const s = v['sequence'] as Record<string, unknown>
        out.sequence = { ...(text(s['field']) ? { field: s['field'] } : {}), ...(s['useSseId'] === true ? { useSseId: true } : {}) }
    }
    if (text(v['timestampField'])) out.timestampField = v['timestampField']
    if (text(v['partitionBy'])) out.partitionBy = v['partitionBy']
    return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The identity of a shared connection. Tabs that ask for the same stream share one connection, but only when they would record it
 * the same way: a different profile (the fields read from payloads), recording on or off, or proxy on or off is a different
 * connection. Without that, saving a profile and reconnecting inside the worker's idle grace kept the old connection, whose recorder
 * still read the old fields while the rules used the new profile. The page and the worker both call this, so they agree.
 */
export function streamKey(url: string, token: string | undefined, options: { recording: boolean; useProxy: boolean; probe?: PayloadProbeConfig | undefined }): string {
    const variant = options.recording && options.useProxy && !options.probe ? '' : `#${options.recording ? 'r' : 'n'}${options.useProxy ? 'p' : 'd'}${options.probe ? JSON.stringify(options.probe) : ''}`
    return `${url}::${token ?? ''}${variant}`
}
