/**
 * Whether the app records what each stream observes (the data the diagnostics read). On by default. Setting
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
