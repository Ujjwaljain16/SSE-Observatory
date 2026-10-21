/** Fields a person pinned in the profile editor, so they stay at the top of the suggestions. Kept in this browser. */

const KEY = 'sse.doctor.pins'
const MAX = 50

export function getPins(): string[] {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
        return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string' && p.length <= 200).slice(0, MAX) : []
    } catch { return [] }
}

export function setPins(pins: string[]): void {
    try { localStorage.setItem(KEY, JSON.stringify(pins.slice(0, MAX))) } catch { /* private mode: pins last for this tab only */ }
}
