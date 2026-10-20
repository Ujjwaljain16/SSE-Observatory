import { z } from 'zod'

// zod schemas for the worker wire contracts. Used by tests and tooling only: importing zod into a worker
// costs ~100 kB, so the workers themselves use the plain guards in contracts.ts.

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
    z.object({ type: z.literal('connect'), url: z.string(), token: z.string().optional(), useProxy: z.boolean().optional(), recording: z.boolean().optional() }),
    z.object({ type: z.literal('disconnect') }),
    z.object({ type: z.literal('ping') })
])

export const SSEWorkerResponseSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('connected') }),
    z.object({ type: z.literal('disconnected') }),
    z.object({ type: z.literal('event'), payload: z.object({ raw: z.string(), arrivalTime: z.number(), seq: z.number().optional() }) }),
    z.object({ type: z.literal('catchup'), events: z.array(z.object({ raw: z.string(), arrivalTime: z.number(), seq: z.number().optional() })) }),
    z.object({ type: z.literal('observations'), key: z.string(), captureId: z.string(), batch: z.array(z.any()), replace: z.boolean().optional() }),
    z.object({ type: z.literal('error'), message: z.string() })
])

// filter worker contracts

export const FilterWorkerRequestSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('QUERY_UPDATE'), query: z.any().nullable(), search: z.string() }),
    z.object({ type: z.literal('CUSTOM_FILTERS_UPDATE'), filters: z.any() }),
    z.object({ type: z.literal('ADD_EVENTS'), events: z.array(EventMessageSchema) }),
    z.object({ type: z.literal('CONFIG'), maxEvents: z.number().int().positive() }),
    z.object({ type: z.literal('CLEAR') }),
    z.object({ type: z.literal('PING') })
])

export const FilterWorkerResponseSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('FILTERED_EVENTS'), events: z.array(EventMessageSchema), execMs: z.number() }),
    z.object({ type: z.literal('READY') })
])

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

// Compile-time drift check: the hand-written types in contracts.ts must accept everything the schemas describe.
import type { FilterWorkerRequest, FilterWorkerResponse, SSEWorkerRequest, SSEWorkerResponse } from './contracts'
export const _contractTypesMatchSchemas = (
    a: z.infer<typeof FilterWorkerRequestSchema>, b: z.infer<typeof FilterWorkerResponseSchema>,
    c: z.infer<typeof SSEWorkerRequestSchema>, d: z.infer<typeof SSEWorkerResponseSchema>,
): [FilterWorkerRequest, FilterWorkerResponse, SSEWorkerRequest, SSEWorkerResponse] => [a, b, c, d]
