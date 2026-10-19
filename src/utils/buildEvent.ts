import type { EventMessage } from '../types'
import { cacheParsedData } from './eventUtils'

/** What a transport hands to the UI for every SSE message. */
export interface IncomingSSE {
    /** SSE event name ("message" when unnamed). */
    event: string
    data: string
    /** Server-sent event id in effect ('' when none). */
    id: string
    /** Wire form of the event. */
    raw: string
    arrivalTime: number
    /** Monotonic sequence assigned by the SharedWorker (used to drop duplicates on catch-up). */
    seq?: number
}

const timeFormat = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** crypto.randomUUID exists only in secure contexts; fall back so plain-HTTP self-hosting keeps working. */
export function uuid(): string {
    const c = (globalThis as { crypto?: Crypto }).crypto
    if (c?.randomUUID) return c.randomUUID()
    const b = new Uint8Array(16)
    if (c?.getRandomValues) c.getRandomValues(b)
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function buildEvent(p: IncomingSSE, extra: Partial<EventMessage> = {}): EventMessage {
    const event: EventMessage = {
        id: uuid(),
        timestamp: timeFormat.format(new Date(p.arrivalTime)),
        arrivalTime: p.arrivalTime,
        type: p.event || 'message',
        data: p.data,
        raw: p.raw,
        ...(p.id ? { sseId: p.id } : {}),
        ...extra,
    }
    // Parse the payload once: parsedType here, and the field reader reuses the result later.
    try {
        const parsed: unknown = JSON.parse(p.data)
        cacheParsedData(event, parsed)
        if (parsed && typeof parsed === 'object' && 'type' in parsed) event.parsedType = String((parsed as { type: unknown }).type)
    } catch { /* not JSON */ }
    return event
}

/** Adds the lowercase search index; call after interceptors have had their say. */
export function finalizeEvent(event: EventMessage): EventMessage {
    event._searchIndex = (typeof event.data === 'string' ? event.data : JSON.stringify(event.data)).toLowerCase()
    return event
}
