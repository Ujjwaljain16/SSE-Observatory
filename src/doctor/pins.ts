/**
 * Fields a person pinned: they stay at the top of the profile editor's suggestions and are followed in the Stats panel, where each is
 * shown across the events held. Kept in this browser.
 */

const KEY = 'sse.doctor.pins'
const MAX = 50

let memory: string | null = null // where they live when the browser will not store them (private windows)
let cache: { raw: string | null; pins: string[] } = { raw: null, pins: [] }
const listeners = new Set<() => void>()

function read(): string | null {
    try { return localStorage.getItem(KEY) } catch { return memory }
}

/** The pinned paths. The same array is returned until the stored text changes, so it can feed useSyncExternalStore. */
export function getPins(): string[] {
    const raw = read()
    if (raw === cache.raw) return cache.pins
    let pins: string[] = []
    try {
        const parsed: unknown = JSON.parse(raw ?? '[]')
        pins = Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string' && p.length <= 200).slice(0, MAX) : []
    } catch { pins = [] }
    cache = { raw, pins }
    return pins
}

export function setPins(pins: string[]): void {
    const raw = JSON.stringify([...new Set(pins)].slice(0, MAX))
    memory = raw
    try { localStorage.setItem(KEY, raw) } catch { /* private mode: pins last for this tab only */ }
    for (const listener of listeners) listener()
}

export function subscribePins(listener: () => void): () => void {
    listeners.add(listener)
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) listener() } // another tab changed them
    window.addEventListener('storage', onStorage)
    return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage) }
}

export const MAX_PINS = MAX
