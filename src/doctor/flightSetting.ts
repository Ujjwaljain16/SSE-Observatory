import { useEffect, useSyncExternalStore } from 'react'
import { doctorStore } from './doctorStore'
import type { FlightNotice } from './flightRecorder'

/**
 * The flight recorder's switch, what it has said, and the hook that runs it. Small on purpose, so the main bundle holds only this: the
 * recorder itself (it saves to the library) is fetched the first time the switch is on.
 */

const KEY = 'sse.flight.keep'
const NOTICES = 5

let memory = false // where the switch lives when the browser will not store it (private windows)
const settingListeners = new Set<() => void>()

/** Off unless the person turned it on: copies are made of recordings that may hold secrets, so it never starts by itself. */
export function flightRecorderEnabled(): boolean {
    try { return localStorage.getItem(KEY) === '1' } catch { return memory }
}

export function setFlightRecorderEnabled(on: boolean): void {
    memory = on
    try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY) } catch { /* kept for this tab only */ }
    for (const l of settingListeners) l()
}

export function subscribeFlightSetting(listener: () => void): () => void {
    settingListeners.add(listener)
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) listener() }
    window.addEventListener('storage', onStorage)
    return () => { settingListeners.delete(listener); window.removeEventListener('storage', onStorage) }
}

// ---- what it has said

let notices: readonly FlightNotice[] = []
const noticeListeners = new Set<() => void>()

export function pushFlightNotice(notice: FlightNotice): void {
    notices = [...notices, notice].slice(-NOTICES)
    for (const l of noticeListeners) l()
}

export function clearFlightNotices(): void {
    notices = []
    for (const l of noticeListeners) l()
}

export const getFlightNotices = (): readonly FlightNotice[] => notices
export function subscribeFlightNotices(listener: () => void): () => void {
    noticeListeners.add(listener)
    return () => { noticeListeners.delete(listener) }
}

export function useFlightNotices(): readonly FlightNotice[] {
    return useSyncExternalStore(subscribeFlightNotices, getFlightNotices, () => [])
}

// ---- running it

/** While the switch is on, watches the Doctor's findings and keeps a copy when one is first reported as an error. Mount once, near the top. */
export function useFlightRecorder(): void {
    const enabled = useSyncExternalStore(subscribeFlightSetting, flightRecorderEnabled, () => false)
    useEffect(() => {
        if (!enabled) return
        let stop = () => {}
        let cancelled = false
        void import('./flightRecorder').then(({ flight }) => {
            if (cancelled) return
            const check = () => flight.observe(doctorStore.getViews())
            stop = doctorStore.subscribe(check)
            check()
        })
        return () => { cancelled = true; stop() }
    }, [enabled])
}
