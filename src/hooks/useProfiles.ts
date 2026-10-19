import { useState, useEffect, useCallback } from 'react'
import type { Profile } from '../types'

const STORAGE_KEY = 'sse-profiles'

function loadProfiles(): Profile[] {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
        if (!Array.isArray(parsed)) return []
        return parsed.filter((p): p is Profile =>
            !!p && typeof p.name === 'string' && typeof p.url === 'string').map((p) => ({
            name: p.name, url: p.url, token: typeof p.token === 'string' ? p.token : '',
        }))
    } catch {
        return []
    }
}

/**
 * Saved connection profiles. A token is only stored when the user explicitly asks for it:
 * credentials do not belong in localStorage by default.
 */
export const useProfiles = () => {
    // Loaded synchronously: an effect that loads AND an effect that saves race each other (and under StrictMode
    // the save of the empty initial state wipes what was just loaded).
    const [profiles, setProfiles] = useState<Profile[]>(loadProfiles)
    const [activeProfileTab, setActiveProfileTab] = useState<string | null>(() => loadProfiles()[0]?.name ?? null)

    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles)) } catch { /* storage unavailable or full */ }
    }, [profiles])

    const saveProfile = useCallback((name: string, url: string, token: string) => {
        setProfiles((prev) => {
            const i = prev.findIndex((p) => p.name === name)
            const next = { name, url, token }
            return i >= 0 ? prev.map((p, idx) => (idx === i ? next : p)) : [...prev, next]
        })
        setActiveProfileTab(name)
    }, [])

    const deleteProfile = useCallback((name: string) => {
        setProfiles((prev) => prev.filter((p) => p.name !== name))
        setActiveProfileTab((active) => {
            if (active !== name) return active
            return null
        })
    }, [])

    return { profiles, activeProfileTab, setActiveProfileTab, saveProfile, deleteProfile }
}
