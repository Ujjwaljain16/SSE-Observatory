import { getJsonPath } from '../core/observe/jsonPath'
import type { DisplayMapping } from '../core/diagnostics/thresholds'
import type { EventMessage } from '../types'
import { getParsedData } from '../utils/eventUtils'

/** What the profile's display mapping reads out of one event. Each part is absent when the path is not declared or finds nothing. */
export interface Shown {
    type?: string
    summary?: string
    id?: string
}

const MAX_CHARS = 200

function textOf(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined
    let text: string | undefined
    if (typeof value === 'string') text = value
    else if (typeof value === 'number' || typeof value === 'boolean') text = String(value)
    else { try { text = JSON.stringify(value) } catch { text = undefined } }
    if (text === undefined || text.trim() === '') return undefined
    return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text
}

/** Reads the mapped parts from the event's JSON payload. An event that is not JSON, or a path that is not in it, gives nothing for that part. */
export function shownFor(event: EventMessage, display: DisplayMapping | undefined): Shown {
    if (!display) return {}
    const payload = getParsedData(event)
    if (payload === undefined) return {}
    const out: Shown = {}
    for (const key of ['type', 'summary', 'id'] as const) {
        const path = display[key]
        if (!path) continue
        const text = textOf(getJsonPath(payload, path))
        if (text !== undefined) out[key] = text
    }
    return out
}

/** The type a person sees for an event: the mapped one when the profile maps it and the event has it, else the usual one. */
export function typeShown(event: EventMessage, display: DisplayMapping | undefined): string {
    const path = display?.type
    return (path ? shownFor(event, { type: path }).type : undefined) ?? (event.parsedType || event.type)
}
