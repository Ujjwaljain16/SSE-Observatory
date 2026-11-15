/**
 * The stream profile the Doctor uses, kept in this browser. One profile applies to every stream the app runs (the main
 * stream and each lane); per-stream profiles come with a saved-streams list.
 *
 * Small on purpose: the stream hooks read it when a connection starts, and the Doctor reads it for the rules, so it must
 * not pull the diagnostics in. Anything stored that does not pass `parseProfile` is ignored, so a hand-edited or old value
 * cannot reach the recorder.
 */

import { parseProfile } from '../core/diagnostics/profile'
import type { StreamProfile } from '../core/diagnostics/thresholds'

const KEY = 'sse.doctor.profile'

let memory: string | null = null // where it lives when the browser will not store it (private windows)
let cache: { raw: string | null; profile: StreamProfile | undefined } = { raw: null, profile: undefined }
const listeners = new Set<() => void>()

function read(): string | null {
    try { return localStorage.getItem(KEY) } catch { return memory }
}

/** The saved profile, or undefined. The same object is returned until the stored text changes. */
export function getProfile(): StreamProfile | undefined {
    const raw = read()
    if (raw === cache.raw) return cache.profile
    let profile: StreamProfile | undefined
    if (raw) {
        try {
            const checked = parseProfile(JSON.parse(raw))
            profile = checked.ok && Object.keys(checked.profile).length > 0 ? checked.profile : undefined
        } catch { profile = undefined }
    }
    cache = { raw, profile }
    return profile
}

/** Save a profile (already checked by the caller), or clear it with undefined. */
export function setProfile(profile: StreamProfile | undefined): void {
    const raw = profile && Object.keys(profile).length > 0 ? JSON.stringify(profile) : null
    memory = raw
    try { if (raw) localStorage.setItem(KEY, raw); else localStorage.removeItem(KEY) } catch { /* kept in memory for this tab */ }
    for (const listener of listeners) listener()
}

export function subscribeProfile(listener: () => void): () => void {
    listeners.add(listener)
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) listener() } // another tab changed it
    window.addEventListener('storage', onStorage)
    return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage) }
}
