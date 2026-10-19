// Shared by the timeline worker and the main-thread fallback so both draw identical pictures.

export const TYPE_DEFAULT = 0
export const TYPE_ERROR = 1
export const TYPE_PING = 2
export const TYPE_UPDATE = 3

const COLORS_DARK = {
    default: '#475569',
    error: '#ef4444',
    ping: '#f59e0b',
    update: '#0ea5e9',
    selected: '#6366f1',
}
const COLORS_LIGHT = {
    default: '#cbd5e1',
    error: '#f87171',
    ping: '#fbbf24',
    update: '#38bdf8',
    selected: '#818cf8',
}

/** Slot type code for an event: the SSE event name or the JSON `type` decides. */
export function typeCode(e: { type: string; parsedType?: string | undefined }): number {
    const t = e.parsedType ?? e.type
    if (e.type === 'error' || t === 'error') return TYPE_ERROR
    if (e.type === 'ping' || t === 'ping') return TYPE_PING
    if (e.type === 'update' || t === 'update') return TYPE_UPDATE
    return TYPE_DEFAULT
}

export function colorFor(code: number, isDark: boolean, selected = false): string {
    const p = isDark ? COLORS_DARK : COLORS_LIGHT
    if (selected) return p.selected
    switch (code & 0x0f) {
        case TYPE_ERROR: return p.error
        case TYPE_PING: return p.ping
        case TYPE_UPDATE: return p.update
        default: return p.default
    }
}

/** Bar height as a fraction of the lane height. */
export function barHeightFraction(code: number, selected: boolean): number {
    if (selected) return 0.9
    return (code & 0x0f) === TYPE_ERROR ? 0.8 : 0.6
}
