import type { EventMessage } from '../types'
import { getParsedData } from './eventUtils'

/** Display text is capped: pretty-printing and laying out multi-megabyte payloads on every render freezes the page. */
export const MAX_DISPLAY_CHARS = 20_000

const cache = new WeakMap<EventMessage, string>()

/** Pretty-printed payload for the event list. Computed once per event object. */
export function prettyPayload(event: EventMessage): string {
    const hit = cache.get(event)
    if (hit !== undefined) return hit

    const parsed = getParsedData(event)
    let text: string
    if (parsed !== undefined) {
        try { text = JSON.stringify(parsed, null, 2) } catch { text = String(event.data) }
    } else {
        text = typeof event.data === 'string' ? event.data : String(event.data)
    }
    if (text.length > MAX_DISPLAY_CHARS) {
        text = `${text.slice(0, MAX_DISPLAY_CHARS)}\n… ${(text.length - MAX_DISPLAY_CHARS).toLocaleString()} more characters (use Copy for the full payload)`
    }
    cache.set(event, text)
    return text
}

/** The parsed payload for diffing, falling back to the raw string. */
export function diffPayload(event: EventMessage): unknown {
    const parsed = getParsedData(event)
    return parsed !== undefined ? parsed : event.data
}
