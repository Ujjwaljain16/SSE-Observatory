import { z } from 'zod'

// Wire contracts between the main thread and the workers.
//
// Hot-path messages (ADD_EVENTS, FILTERED_EVENTS) carry up to thousands of events; they are NOT
// validated element by element at runtime — the schemas below are used by tests and tooling, and the
// workers use the cheap `isFilterWorkerRequest` guard.

export const EventMessageSchema = z.object({
    id: z.string(),
    type: z.string(),
    timestamp: z.string(),
    data: z.any(),
    raw: z.string(),
    parsedType: z.string().optional(),
    arrivalTime: z.number().optional(),
    _searchIndex: z.string().optional()
})

// shared sse worker contracts (the SharedWorker validates nothing per event either)

export const SSEWorkerRequestSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('connect'), url: z.string(), token: z.string().optional(), useProxy: z.boolean().optional() }),
    z.object({ type: z.literal('disconnect') }),
    z.object({ type: z.literal('ping') })
])

export type SSEWorkerRequest = z.infer<typeof SSEWorkerRequestSchema>

export const SSEWorkerResponseSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('connected') }),
    z.object({ type: z.literal('disconnected') }),
    z.object({ type: z.literal('event'), payload: z.object({ raw: z.string(), arrivalTime: z.number(), seq: z.number().optional() }) }),
    z.object({ type: z.literal('catchup'), events: z.array(z.object({ raw: z.string(), arrivalTime: z.number(), seq: z.number().optional() })) }),
    z.object({ type: z.literal('error'), message: z.string() })
])

export type SSEWorkerResponse = z.infer<typeof SSEWorkerResponseSchema>

// filter worker contracts

export const FilterWorkerRequestSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('QUERY_UPDATE'), query: z.any().nullable(), search: z.string() }),
    z.object({ type: z.literal('CUSTOM_FILTERS_UPDATE'), filters: z.any() }),
    z.object({ type: z.literal('ADD_EVENTS'), events: z.array(EventMessageSchema) }),
    z.object({ type: z.literal('CONFIG'), maxEvents: z.number().int().positive() }),
    z.object({ type: z.literal('CLEAR') }),
    z.object({ type: z.literal('PING') })
])

export type FilterWorkerRequest = z.infer<typeof FilterWorkerRequestSchema>

export const FilterWorkerResponseSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('FILTERED_EVENTS'), events: z.array(EventMessageSchema), execMs: z.number() }),
    z.object({ type: z.literal('READY') })
])

export type FilterWorkerResponse = z.infer<typeof FilterWorkerResponseSchema>

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

export function createMessageEncoder<T>(schema: z.ZodType<T>) {
    return (data: T): T => {
        return schema.parse(data)
    }
}

export function createMessageDecoder<T>(schema: z.ZodType<T>) {
    return (data: unknown): T => {
        return schema.parse(data)
    }
}

export const encodeSSEWorkerRequest = createMessageEncoder(SSEWorkerRequestSchema)
export const decodeSSEWorkerRequest = createMessageDecoder(SSEWorkerRequestSchema)

export const encodeSSEWorkerResponse = createMessageEncoder(SSEWorkerResponseSchema)
export const decodeSSEWorkerResponse = createMessageDecoder(SSEWorkerResponseSchema)

export const encodeFilterWorkerRequest = createMessageEncoder(FilterWorkerRequestSchema)
export const decodeFilterWorkerRequest = createMessageDecoder(FilterWorkerRequestSchema)

export const encodeFilterWorkerResponse = createMessageEncoder(FilterWorkerResponseSchema)
export const decodeFilterWorkerResponse = createMessageDecoder(FilterWorkerResponseSchema)
