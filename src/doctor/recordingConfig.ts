/**
 * What the app keeps, and for how long. Whether the app records what each stream observes (the data the diagnostics read). On by default. Setting
 * `localStorage['sse.recording']` to `off` turns it off for streams started afterwards, which removes the memory the
 * records take and the work of making them; the viewer itself is unaffected.
 */

const KEY = 'sse.recording'

export function recordingEnabled(): boolean {
    try { return localStorage.getItem(KEY) !== 'off' } catch { return true }
}

export function setRecordingEnabled(on: boolean): void {
    try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, 'off') } catch { /* private mode: the setting just does not stick */ }
}

const RETENTION_KEY = 'sse.library.retentionDays'
/** How long a saved capture is kept: 0 means until it is deleted. These are the only choices, so a stored value outside them is ignored. */
export const RETENTION_CHOICES = [0, 1, 7, 30, 90] as const

export function libraryRetentionDays(): number {
    try {
        const n = Number(localStorage.getItem(RETENTION_KEY))
        return (RETENTION_CHOICES as readonly number[]).includes(n) ? n : 0
    } catch { return 0 }
}

export function setLibraryRetentionDays(days: number): void {
    if (!(RETENTION_CHOICES as readonly number[]).includes(days)) return
    try { if (days === 0) localStorage.removeItem(RETENTION_KEY); else localStorage.setItem(RETENTION_KEY, String(days)) } catch { /* private mode: the setting just does not stick */ }
}
