import type { EventMessage } from '../types'

export const colorMap: Record<string, string> = {
    'AUTH_LOGIN': 'bg-blue-600 hover:bg-blue-700',
    'AUTH_LOGOUT': 'bg-red-600 hover:bg-red-700',
    'AUTH_TOKEN_REFRESH': 'bg-cyan-600 hover:bg-cyan-700',
    'USER_CREATE': 'bg-green-600 hover:bg-green-700',
    'USER_UPDATE': 'bg-amber-600 hover:bg-amber-700',
    'USER_DELETE': 'bg-red-700 hover:bg-red-800',
    'ROLE_ASSIGN': 'bg-purple-600 hover:bg-purple-700',
    'PERMISSION_GRANT': 'bg-indigo-600 hover:bg-indigo-700',
    'PERMISSION_REVOKE': 'bg-pink-600 hover:bg-pink-700',
}

export const getColorForType = (type: string): string => {
    return colorMap[type] || 'bg-slate-600 hover:bg-slate-700'
}

export const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

const NOT_JSON = Symbol('not-json')
const parseCache = new WeakMap<object, unknown>()

/**
 * Returns the event payload as a parsed value. JSON strings are parsed once per event
 * object (cached), objects are returned as-is, anything else yields undefined.
 */
export const getParsedData = (event: EventMessage): unknown => {
    const raw = event.data as unknown
    if (raw !== null && typeof raw === 'object') return raw
    if (typeof raw !== 'string') return undefined
    const hit = parseCache.get(event)
    if (hit !== undefined) return hit === NOT_JSON ? undefined : hit
    try {
        const value = JSON.parse(raw)
        parseCache.set(event, value)
        return value
    } catch {
        parseCache.set(event, NOT_JSON)
        return undefined
    }
}

/** Lets the code that already parsed a payload (e.g. to read its type) share the result with the field reader. */
export const cacheParsedData = (event: EventMessage, value: unknown): void => {
    parseCache.set(event, value === undefined ? NOT_JSON : value)
}

const ROOT_FIELDS = new Set(['id', 'type', 'timestamp', 'parsedType', 'streamId', 'streamColor', 'arrivalTime'])
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

const stringify = (value: unknown): string | null => {
    if (value === null || value === undefined) return null
    if (typeof value === 'object') {
        try { return JSON.stringify(value) } catch { return null }
    }
    return String(value)
}

/**
 * Single source of truth for reading a field from an event (used by the filter worker,
 * the query language and the UI). Root fields are read directly; everything else is a
 * path into the JSON payload, with or without a leading "data." (array indexes work: items.0.id).
 */
export const getFieldValue = (event: EventMessage, fieldPath: string): string | null => {
    if (fieldPath === 'data') {
        const d = event.data as unknown
        return typeof d === 'string' ? d : stringify(d)
    }
    if (ROOT_FIELDS.has(fieldPath)) return stringify((event as unknown as Record<string, unknown>)[fieldPath])

    let value: unknown = getParsedData(event)
    if (value === undefined) return null
    const path = fieldPath.startsWith('data.') ? fieldPath.slice(5) : fieldPath
    for (const key of path.split('.')) {
        if (value !== null && typeof value === 'object' && hasOwn(value as object, key)) {
            value = (value as Record<string, unknown>)[key]
        } else {
            return null
        }
    }
    return stringify(value)
}
