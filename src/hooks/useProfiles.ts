import { useState, useEffect } from 'react'
import type { Profile } from '../types'

export const useProfiles = () => {
    const [profiles, setProfiles] = useState<Profile[]>([])
    const [activeProfileTab, setActiveProfileTab] = useState<string | null>(null)

    useEffect(() => {
        const saved = localStorage.getItem('sse-profiles')
        if (saved) {
            try {
                const loadedProfiles = JSON.parse(saved)
                setProfiles(loadedProfiles)
                if (loadedProfiles.length > 0) {
                    setActiveProfileTab(loadedProfiles[0].name)
                }
            } catch (e) {
                console.error('Error loading profiles:', e)
            }
        }
    }, [])

    useEffect(() => {
        localStorage.setItem('sse-profiles', JSON.stringify(profiles))
    }, [profiles])

    const saveProfile = (name: string, url: string, token: string) => {
        const existingIndex = profiles.findIndex(p => p.name === name)
        if (existingIndex >= 0) {
            const newProfiles = [...profiles]
            newProfiles[existingIndex] = { name, url, token }
            setProfiles(newProfiles)
            setActiveProfileTab(name)
        } else {
            const newProfile = { name, url, token }
            setProfiles([...profiles, newProfile])
            setActiveProfileTab(name)
        }
    }

    const deleteProfile = (name: string) => {
        const newProfiles = profiles.filter(p => p.name !== name)
        setProfiles(newProfiles)
        
        if (activeProfileTab === name) {
            if (newProfiles.length > 0) {
                setActiveProfileTab(newProfiles[0].name)
            } else {
                setActiveProfileTab(null)
            }
        }
    }

    return {
        profiles,
        activeProfileTab,
        setActiveProfileTab,
        saveProfile,
        deleteProfile
    }
}
