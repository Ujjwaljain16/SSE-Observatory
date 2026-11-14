import { libraryRetentionDays } from './recordingConfig'

/**
 * Deletes saved captures older than the time the person chose, when the app starts. The library is fetched only when there is
 * something to enforce, so a person who never chose a time pays nothing for it. A failure (no IndexedDB, a blocked database) is
 * ignored: it is retried at the next start, and the Captures tab shows the real state.
 */
export function applyRetention(): Promise<number> {
    const days = libraryRetentionDays()
    if (days === 0) return Promise.resolve(0)
    return import('./captureLibrary').then((library) => library.pruneOlderThan(days)).catch(() => 0)
}
